import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { startApi, call, DEAD_REDIS } from "./helpers/app.js";
import { createSmtpSink } from "./helpers/smtpSink.js";
import {
  connectDb, disconnectDb, cleanup, models, testEmail,
  createClient, addClientUser, TEST_PASSWORD,
} from "./helpers/db.js";

const TAG = "team";
const sink = createSmtpSink();
let api;
let A;       // FREE customer: 2 seats
let other;   // a different customer

before(async () => {
  await connectDb();
  await cleanup(TAG);
  await sink.start();
  api = await startApi({ ...sink.env(), REDIS_URL: DEAD_REDIS });
  A = await createClient(api, TAG, "a", { ownerName: "Olivia Owner" });
  other = await createClient(api, TAG, "other", { plan: "STARTER" });
});

after(async () => {
  await api?.stop();
  await cleanup(TAG);
  await sink.stop();
  await disconnectDb();
});

const team = (token, method = "GET", route = "", body) => call(api.url, method, `/api/client/team${route}`, body, token);

describe("team invites", () => {
  test("anyone can see the team, with seat usage from the plan", async () => {
    const r = await team(A.token);
    assert.equal(r.status, 200);
    assert.equal(r.body.members.length, 1);
    assert.equal(r.body.members[0].role, "OWNER");
    assert.deepEqual(r.body.seats, { plan: "FREE", used: 1, max: 2 });
  });

  test("no token -> 401", async () => {
    assert.equal((await team(undefined)).status, 401);
  });

  let invited;
  test("owner adds a teammate: random password is emailed, mentioning who added them", async () => {
    const r = await team(A.token, "POST", "", { name: "Mia Member", email: testEmail(TAG, "Mia"), role: "MEMBER" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.member.role, "MEMBER");
    assert.equal(r.body.member.pendingFirstLogin, true);
    assert.equal(r.body.member.email, testEmail(TAG, "mia"), "email lowercased");
    invited = r.body.member;

    const mail = sink.to(testEmail(TAG, "mia"))[0];
    assert.ok(mail);
    assert.match(mail.raw, /Olivia Owner added you to their/);
    assert.ok(sink.passwordIn(mail));
  });

  test("the teammate logs in with the emailed password and must change it first", async () => {
    const password = sink.passwordIn(sink.to(testEmail(TAG, "mia"))[0]);
    const login = await call(api.url, "POST", "/api/client/auth/login", { email: testEmail(TAG, "mia"), password });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.mustChangePassword, true);

    const blocked = await call(api.url, "GET", "/api/client/monitors", undefined, login.body.token);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, "PASSWORD_CHANGE_REQUIRED");

    const changed = await call(api.url, "POST", "/api/client/auth/change-password", { currentPassword: password, newPassword: "mia-new-pass-1" }, login.body.token);
    assert.equal(changed.status, 200);
    const ok = await call(api.url, "GET", "/api/client/monitors", undefined, changed.body.token);
    assert.equal(ok.status, 200);
  });

  test("the list now shows two people and a full plan", async () => {
    const r = await team(A.token);
    assert.equal(r.body.members.length, 2);
    assert.deepEqual(r.body.seats, { plan: "FREE", used: 2, max: 2 });
    const mia = r.body.members.find((m) => m.email === testEmail(TAG, "mia"));
    assert.equal(mia.pendingFirstLogin, false);
    assert.ok(mia.lastLoginAt);
  });

  test("seat limit: a third person is refused on FREE (2 seats), allowed after an upgrade", async () => {
    const body = { name: "Third", email: testEmail(TAG, "third") };
    const refused = await team(A.token, "POST", "", body);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "PLAN_LIMIT_REACHED");
    assert.match(refused.body.message, /FREE plan allows up to 2 team members/);
    assert.equal(await models.ClientUser.countDocuments({ email: testEmail(TAG, "third") }), 0);

    await models.Client.updateOne({ _id: A.client._id }, { plan: "STARTER" });
    assert.equal((await team(A.token, "POST", "", body)).status, 201);
  });

  test("simultaneous invites never exceed the seat limit", async () => {
    await models.Client.updateOne({ _id: A.client._id }, { plan: "FREE" });
    await models.ClientUser.deleteMany({ clientId: A.client._id, role: "MEMBER" });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => team(A.token, "POST", "", { name: `Racer ${i}`, email: testEmail(TAG, `racer${i}`) }))
    );
    const seats = await models.ClientUser.countDocuments({ clientId: A.client._id, status: "ACTIVE" });
    assert.ok(seats <= 2, `seats=${seats}`);
    assert.equal(results.filter((r) => r.status === 201).length, seats - 1);
    assert.ok(results.every((r) => [201, 403].includes(r.status)));
  });

  test("validation: missing name/email, bad email, bad role, duplicate email", async () => {
    await models.ClientUser.deleteMany({ clientId: A.client._id, role: "MEMBER" });
    for (const body of [{ email: testEmail(TAG, "x") }, { name: "X" }, { name: "X", email: "nope" }, { name: "X", email: testEmail(TAG, "x"), role: "GOD" }]) {
      assert.equal((await team(A.token, "POST", "", body)).status, 400, JSON.stringify(body));
    }
    const dup = await team(A.token, "POST", "", { name: "Dup", email: A.email });
    assert.equal(dup.status, 409);
    const crossTenant = await team(A.token, "POST", "", { name: "Dup", email: other.email });
    assert.equal(crossTenant.status, 409, "an email used by another customer is refused too");
  });

  test("if the email can't be sent, the teammate is not added", async () => {
    await sink.stop();
    const r = await team(A.token, "POST", "", { name: "Nomail", email: testEmail(TAG, "nomail") });
    await sink.start();
    assert.equal(r.status, 502);
    assert.equal(await models.ClientUser.countDocuments({ email: testEmail(TAG, "nomail") }), 0);
  });
});

describe("what members can and can't do", () => {
  let member;
  before(async () => {
    await models.ClientUser.deleteMany({ clientId: A.client._id, role: "MEMBER" });
    await models.Client.updateOne({ _id: A.client._id }, { plan: "STARTER" });
    member = await addClientUser(api, A.client, TAG, "Member Mo");
  });

  test("a member can view the team", async () => {
    assert.equal((await team(member.token)).status, 200);
  });

  test("but cannot add, edit, remove or resend", async () => {
    const ownerId = String(A.owner._id);
    assert.equal((await team(member.token, "POST", "", { name: "X", email: testEmail(TAG, "nope") })).status, 403);
    assert.equal((await team(member.token, "PATCH", `/${ownerId}`, { role: "MEMBER" })).status, 403);
    assert.equal((await team(member.token, "DELETE", `/${ownerId}`)).status, 403);
    assert.equal((await team(member.token, "POST", `/${ownerId}/resend-credentials`)).status, 403);
    assert.equal((await call(api.url, "GET", "/api/client/billing", undefined, member.token)).status, 403, "billing is owner-only");
  });
});

describe("changing the team", () => {
  let mo;
  before(async () => {
    await models.ClientUser.deleteMany({ clientId: A.client._id, role: "MEMBER" });
    await models.Client.updateOne({ _id: A.client._id }, { plan: "STARTER" });
    mo = await addClientUser(api, A.client, TAG, "Mo");
  });

  test("rename and change role", async () => {
    const r = await team(A.token, "PATCH", `/${mo.user._id}`, { name: "Mo Renamed", role: "OWNER" });
    assert.equal(r.status, 200);
    assert.equal(r.body.member.name, "Mo Renamed");
    assert.equal(r.body.member.role, "OWNER");
    assert.equal((await team(A.token, "PATCH", `/${mo.user._id}`, { role: "MEMBER" })).status, 200);
  });

  test("invalid values and empty updates -> 400", async () => {
    for (const body of [{ role: "GOD" }, { status: "INVITED" }, { name: "  " }, {}, { unknown: 1 }]) {
      assert.equal((await team(A.token, "PATCH", `/${mo.user._id}`, body)).status, 400, JSON.stringify(body));
    }
  });

  test("you can't change your own role or status", async () => {
    assert.equal((await team(A.token, "PATCH", `/${A.owner._id}`, { role: "MEMBER" })).status, 400);
    assert.equal((await team(A.token, "PATCH", `/${A.owner._id}`, { status: "DISABLED" })).status, 400);
    assert.equal((await team(A.token, "DELETE", `/${A.owner._id}`)).status, 400);
    assert.equal((await team(A.token, "PATCH", `/${A.owner._id}`, { name: "Olivia Renamed" })).status, 200, "renaming yourself is fine");
  });

  test("disabling someone locks them out immediately, enabling brings them back", async () => {
    assert.equal((await call(api.url, "GET", "/api/client/monitors", undefined, mo.token)).status, 200);
    assert.equal((await team(A.token, "PATCH", `/${mo.user._id}`, { status: "DISABLED" })).status, 200);
    assert.equal((await call(api.url, "GET", "/api/client/monitors", undefined, mo.token)).status, 401, "existing token stops working");
    const login = await call(api.url, "POST", "/api/client/auth/login", { email: mo.email, password: TEST_PASSWORD });
    assert.equal(login.status, 401, "can't log in while disabled");
    assert.equal((await team(A.token, "PATCH", `/${mo.user._id}`, { status: "ACTIVE" })).status, 200);
    assert.equal((await call(api.url, "GET", "/api/client/monitors", undefined, mo.token)).status, 200);
  });

  test("a disabled member doesn't use a seat, but re-enabling needs a free one", async () => {
    await models.Client.updateOne({ _id: A.client._id }, { plan: "FREE" }); // 2 seats: owner + mo
    await team(A.token, "PATCH", `/${mo.user._id}`, { status: "DISABLED" });
    assert.equal((await team(A.token)).body.seats.used, 1);
    const filler = await team(A.token, "POST", "", { name: "Filler", email: testEmail(TAG, "filler") });
    assert.equal(filler.status, 201, "the freed seat can be used");
    const back = await team(A.token, "PATCH", `/${mo.user._id}`, { status: "ACTIVE" });
    assert.equal(back.status, 403);
    assert.equal(back.body.code, "PLAN_LIMIT_REACHED");
    await models.ClientUser.deleteOne({ email: testEmail(TAG, "filler") });
    await models.Client.updateOne({ _id: A.client._id }, { plan: "STARTER" });
  });

  test("an owner can demote another owner while one remains", async () => {
    await team(A.token, "PATCH", `/${mo.user._id}`, { status: "ACTIVE", role: "OWNER" });
    const r = await team(A.token, "PATCH", `/${mo.user._id}`, { role: "MEMBER" });
    assert.equal(r.status, 200);
  });

  test("remove a teammate: their token stops working", async () => {
    const r = await team(A.token, "DELETE", `/${mo.user._id}`);
    assert.equal(r.status, 200);
    assert.equal(await models.ClientUser.countDocuments({ _id: mo.user._id }), 0);
    assert.equal((await call(api.url, "GET", "/api/client/monitors", undefined, mo.token)).status, 401);
    assert.equal((await team(A.token, "DELETE", `/${mo.user._id}`)).status, 404);
  });
});

describe("resending login details", () => {
  test("works until the person has set their own password", async () => {
    const added = await team(A.token, "POST", "", { name: "Rae", email: testEmail(TAG, "rae") });
    assert.equal(added.status, 201);
    const firstPassword = sink.passwordIn(sink.to(testEmail(TAG, "rae"))[0]);

    const resent = await team(A.token, "POST", `/${added.body.member.id}/resend-credentials`);
    assert.equal(resent.status, 200);
    const mails = sink.to(testEmail(TAG, "rae"));
    assert.equal(mails.length, 2);
    const newPassword = sink.passwordIn(mails[1]);
    assert.notEqual(newPassword, firstPassword);

    const oldLogin = await call(api.url, "POST", "/api/client/auth/login", { email: testEmail(TAG, "rae"), password: firstPassword });
    assert.equal(oldLogin.status, 401, "the old emailed password stops working");
    const newLogin = await call(api.url, "POST", "/api/client/auth/login", { email: testEmail(TAG, "rae"), password: newPassword });
    assert.equal(newLogin.status, 200);

    await call(api.url, "POST", "/api/client/auth/change-password", { currentPassword: newPassword, newPassword: "rae-own-pass-1" }, newLogin.body.token);
    const again = await team(A.token, "POST", `/${added.body.member.id}/resend-credentials`);
    assert.equal(again.status, 400, "already set their own password");
  });

  test("if the email fails, the password they already have keeps working", async () => {
    const added = await team(A.token, "POST", "", { name: "Sol", email: testEmail(TAG, "sol") });
    const password = sink.passwordIn(sink.to(testEmail(TAG, "sol"))[0]);
    await sink.stop();
    const resent = await team(A.token, "POST", `/${added.body.member.id}/resend-credentials`);
    await sink.start();
    assert.equal(resent.status, 502);
    const login = await call(api.url, "POST", "/api/client/auth/login", { email: testEmail(TAG, "sol"), password });
    assert.equal(login.status, 200);
  });
});

describe("customers can't see each other", () => {
  test("other customer's team is separate and its ids are 404", async () => {
    const mine = await team(A.token);
    const theirs = await team(other.token);
    assert.ok(theirs.body.members.every((m) => m.email === other.email));
    assert.ok(!mine.body.members.some((m) => m.email === other.email));

    const id = other.owner._id;
    assert.equal((await team(A.token, "PATCH", `/${id}`, { name: "Hacked" })).status, 404);
    assert.equal((await team(A.token, "DELETE", `/${id}`)).status, 404);
    assert.equal((await team(A.token, "POST", `/${id}/resend-credentials`)).status, 404);
    assert.equal((await team(A.token, "PATCH", `/not-an-id`, { name: "x" })).status, 404);
    assert.equal((await models.ClientUser.findById(id)).name, other.owner.name);
  });

  test("a made-up token is rejected", async () => {
    const r = await call(api.url, "GET", "/api/client/team", undefined, "garbage");
    assert.equal(r.status, 401);
  });
});
