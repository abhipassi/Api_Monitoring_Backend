import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { startApi, call, DEAD_REDIS } from "./helpers/app.js";
import { createSmtpSink } from "./helpers/smtpSink.js";
import { connectDb, disconnectDb, cleanup, models, testEmail } from "./helpers/db.js";

const TAG = "reg";
const sink = createSmtpSink();
let api;

before(async () => {
  await connectDb();
  await cleanup(TAG);
  await sink.start();
  api = await startApi({ ...sink.env(), REDIS_URL: DEAD_REDIS });
});

after(async () => {
  await api?.stop();
  await cleanup(TAG);
  await sink.stop();
  await disconnectDb();
});

const signUp = (name, body = {}) =>
  call(api.url, "POST", "/api/client/auth/register", {
    name: "Pat Owner", email: testEmail(TAG, name), companyName: "Pat Co", ...body,
  });

describe("client sign-up (works on a standalone MongoDB)", () => {
  test("creates the company and its owner, and emails a random password", async () => {
    const r = await signUp("first");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.user.role, "OWNER");
    assert.equal(r.body.client.plan, "FREE");
    assert.equal(r.body.token, undefined, "no token before the password was used");

    const mail = sink.to(testEmail(TAG, "first"))[0];
    assert.ok(mail, "credentials email sent");
    const password = sink.passwordIn(mail);
    assert.ok(password && password.length >= 12);

    const login = await call(api.url, "POST", "/api/client/auth/login", { email: testEmail(TAG, "first"), password });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.mustChangePassword, true);
  });

  test("a password in the request body is ignored", async () => {
    const r = await signUp("ignored", { password: "my-own-password-1" });
    assert.equal(r.status, 201);
    const login = await call(api.url, "POST", "/api/client/auth/login", { email: testEmail(TAG, "ignored"), password: "my-own-password-1" });
    assert.equal(login.status, 401);
  });

  test("the same email twice -> 409, and no half-created company is left behind", async () => {
    const before = await models.Client.countDocuments({ email: testEmail(TAG, "first") });
    const r = await signUp("first", { companyName: "Another Co" });
    assert.equal(r.status, 409);
    assert.equal(await models.Client.countDocuments({ email: testEmail(TAG, "first") }), before);
  });

  test("email is case-insensitive", async () => {
    const r = await signUp("first", { email: testEmail(TAG, "FIRST").toUpperCase() });
    assert.equal(r.status, 409);
  });

  test("simultaneous sign-ups with one email: exactly one wins, no orphan company", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => signUp("race")));
    const statuses = results.map((r) => r.status).sort();
    assert.equal(statuses.filter((s) => s === 201).length, 1, statuses.join());
    assert.ok(statuses.every((s) => s === 201 || s === 409), statuses.join());
    assert.equal(await models.Client.countDocuments({ email: testEmail(TAG, "race") }), 1);
    assert.equal(await models.ClientUser.countDocuments({ email: testEmail(TAG, "race") }), 1);
  });

  test("missing fields -> 400", async () => {
    for (const body of [{ name: "" }, { email: "" }, { companyName: " " }]) {
      assert.equal((await signUp("bad", body)).status, 400);
    }
  });

  test("if the email can't be sent, nothing is created", async () => {
    await sink.stop();
    const r = await signUp("nomail");
    await sink.start();
    assert.equal(r.status, 502);
    assert.equal(await models.Client.countDocuments({ email: testEmail(TAG, "nomail") }), 0);
    assert.equal(await models.ClientUser.countDocuments({ email: testEmail(TAG, "nomail") }), 0);
  });
});
