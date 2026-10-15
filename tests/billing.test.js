import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { startApi, call, DEAD_REDIS } from "./helpers/app.js";
import { createSmtpSink } from "./helpers/smtpSink.js";
import {
  connectDb, disconnectDb, cleanup, models, testEmail, ObjectId,
  createClient, addClientUser, createEmployee, addMonitor,
} from "./helpers/db.js";

const TAG = "billing";
const sink = createSmtpSink();
const SALES = testEmail(TAG, "sales");
let api;
let sa, reqMgr, reader, plain;
let A, B;

const billing = (token, method = "GET", route = "", body) => call(api.url, method, `/api/client/billing${route}`, body, token);
const admin = (token, method, route, body) => call(api.url, method, `/api/admin${route}`, body, token);

before(async () => {
  await connectDb();
  await cleanup(TAG);
  await sink.start();
  api = await startApi({ ...sink.env(), REDIS_URL: DEAD_REDIS, SALES_EMAIL: SALES });

  sa = await createEmployee(api, TAG, "sa", { role: "SUPER_ADMIN" });
  reqMgr = await createEmployee(api, TAG, "reqmgr", { permissions: ["plan-requests.manage"] });
  reader = await createEmployee(api, TAG, "reader", { permissions: ["clients.read"] });
  plain = await createEmployee(api, TAG, "plain", { permissions: [] });
  A = await createClient(api, TAG, "a", { ownerName: "Alma Owner" });
  B = await createClient(api, TAG, "b", { plan: "STARTER" });
});

after(async () => {
  await api?.stop();
  await cleanup(TAG);
  await sink.stop();
  await disconnectDb();
});

describe("config for the website (GET /api/meta)", () => {
  test("is public and lists plans, prices, allowed values and limits", async () => {
    const r = await call(api.url, "GET", "/api/meta");
    assert.equal(r.status, 200);
    const m = r.body.meta;
    assert.deepEqual(m.plans.map((p) => p.key), ["FREE", "STARTER", "ENTERPRISE"]);
    assert.ok(m.plans.every((p) => p.name && typeof p.priceMonthly === "number" && p.limits.maxMonitors && p.limits.maxTeamMembers));
    assert.equal(m.plans[0].priceMonthly, 0);
    assert.equal(m.currency, "USD");
    assert.equal(m.pricesAreSample, true, "prices are flagged as samples until confirmed");
    assert.equal(m.paymentsEnabled, false);
    assert.ok(m.enums.httpMethods.includes("GET") && m.enums.checkErrorTypes.includes("TIMEOUT") && m.enums.statRanges.includes("30d"));
    assert.ok(m.limits.maxHeaders > 0 && m.limits.maxUrlLength > 0);
    assert.equal(m.limits.minPasswordLength, 8);
    assert.ok(m.permissions.some((p) => p.key === "clients.manage" && p.description));
  });

  test("prices and currency come from .env, not from code", async () => {
    const other = await startApi({
      ...sink.env(), REDIS_URL: DEAD_REDIS,
      PLAN_PRICE_STARTER: "25", PLAN_PRICE_ENTERPRISE: "not-a-number",
      BILLING_CURRENCY: "inr", PLAN_PRICES_CONFIRMED: "true", APP_NAME: "Watchtower",
    });
    try {
      const m = (await call(other.url, "GET", "/api/meta")).body.meta;
      assert.equal(m.plans.find((p) => p.key === "STARTER").priceMonthly, 25);
      assert.equal(m.plans.find((p) => p.key === "ENTERPRISE").priceMonthly, 99, "an invalid price falls back to the default");
      assert.equal(m.currency, "INR");
      assert.equal(m.pricesAreSample, false);
      assert.equal(m.appName, "Watchtower");
    } finally {
      await other.stop();
    }
  });
});

describe("a customer's billing page", () => {
  test("shows the plan, usage and whether payments are on", async () => {
    await addMonitor(A.client, "a1");
    await addMonitor(A.client, "a2");
    const r = await billing(A.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body.billing;
    assert.equal(b.plan.key, "FREE");
    assert.equal(b.plan.name, "Free");
    assert.equal(b.plan.priceMonthly, 0);
    assert.deepEqual(b.usage, { monitors: { used: 2, max: 5 }, teamMembers: { used: 1, max: 2 } });
    assert.equal(b.paymentsEnabled, false);
    assert.equal(b.pricesAreSample, true);
    assert.equal(b.pendingRequest, null);
    assert.equal(b.subscription.status, "NONE");
  });

  test("only owners; members and signed-out visitors are refused", async () => {
    const member = await addClientUser(api, A.client, TAG, "amember");
    assert.equal((await billing(member.token)).status, 403);
    assert.equal((await billing(undefined)).status, 401);
    await models.ClientUser.deleteOne({ _id: member.user._id });
  });

  test("online checkout says payments aren't available yet", async () => {
    const r = await billing(A.token, "POST", "/checkout", { plan: "STARTER" });
    assert.equal(r.status, 501);
    assert.equal(r.body.code, "PAYMENTS_NOT_ENABLED");
  });
});

describe("asking for a different plan", () => {
  let request;

  test("validation", async () => {
    for (const body of [{}, { plan: "GOLD" }, { plan: "FREE" }, { plan: "STARTER", note: "x".repeat(1001) }, { plan: "STARTER", note: 5 }]) {
      assert.equal((await billing(A.token, "POST", "/plan-requests", body)).status, 400, JSON.stringify(body).slice(0, 60));
    }
  });

  test("a request goes to the sales address with the customer's details", async () => {
    const r = await billing(A.token, "POST", "/plan-requests", { plan: "STARTER", note: "We need more monitors" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.request.status, "PENDING");
    assert.equal(r.body.request.direction, "UPGRADE");
    assert.equal(r.body.request.fromPlan, "FREE");
    assert.deepEqual(r.body.warnings, []);
    request = r.body.request;

    const mail = sink.to(SALES)[0];
    assert.ok(mail, "sales were told");
    assert.equal(sink.subject(mail), "Plan request: a Co wants Starter");
    assert.match(mail.raw, /We need more monitors/);
    assert.match(mail.raw, /Alma Owner/);
  });

  test("the billing page shows it as waiting, and a second request is refused", async () => {
    const b = (await billing(A.token)).body.billing;
    assert.equal(b.pendingRequest.id, request.id);
    assert.equal(b.recentRequests.length, 1);
    const again = await billing(A.token, "POST", "/plan-requests", { plan: "ENTERPRISE" });
    assert.equal(again.status, 409);
    assert.match(again.body.message, /already have a plan request/);
  });

  test("only one waiting request is allowed even when sent at the same moment", async () => {
    const C = await createClient(api, TAG, "c");
    const results = await Promise.all(Array.from({ length: 5 }, () => billing(C.token, "POST", "/plan-requests", { plan: "STARTER" })));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(results.filter((r) => r.status === 409).length, 4);
    assert.equal(await models.PlanRequest.countDocuments({ clientId: C.client._id, status: "PENDING" }), 1);
  });

  test("another customer can't cancel it; the owner can, then ask again", async () => {
    assert.equal((await billing(B.token, "DELETE", `/plan-requests/${request.id}`)).status, 404);
    assert.equal((await billing(A.token, "DELETE", "/plan-requests/nope")).status, 404);
    const canceled = await billing(A.token, "DELETE", `/plan-requests/${request.id}`);
    assert.equal(canceled.status, 200);
    assert.equal(canceled.body.request.status, "CANCELED");
    assert.equal((await billing(A.token, "DELETE", `/plan-requests/${request.id}`)).status, 404, "already canceled");
    assert.equal((await billing(A.token, "POST", "/plan-requests", { plan: "ENTERPRISE" })).status, 201);
    const cancelAgain = await billing(A.token, "DELETE", `/plan-requests/${(await billing(A.token)).body.billing.pendingRequest.id}`);
    assert.equal(cancelAgain.status, 200);
  });

  test("a downgrade warns what won't fit", async () => {
    for (let i = 0; i < 7; i++) await addMonitor(B.client, `b${i}`, { intervalSeconds: 60 });
    const r = await billing(B.token, "POST", "/plan-requests", { plan: "FREE" });
    assert.equal(r.status, 201);
    assert.equal(r.body.request.direction, "DOWNGRADE");
    assert.equal(r.body.warnings.length, 2);
    assert.match(r.body.warnings[0], /7 monitors exist but the Free plan allows 5/);
    assert.match(r.body.warnings[1], /7 monitors check more often/);
    await billing(B.token, "DELETE", `/plan-requests/${r.body.request.id}`);
  });
});

describe("staff deal with requests", () => {
  let first, second;
  before(async () => {
    await models.PlanRequest.deleteMany({ clientId: { $in: [A.client._id, B.client._id] } });
    first = (await billing(A.token, "POST", "/plan-requests", { plan: "STARTER", note: "please" })).body.request;
    second = (await billing(B.token, "POST", "/plan-requests", { plan: "ENTERPRISE" })).body.request;
    sink.clear();
  });

  test("only staff allowed to manage requests can see or decide them", async () => {
    for (const t of [undefined, A.token, plain.token, reader.token]) {
      const expected = t === undefined ? 401 : 403;
      assert.equal((await admin(t, "GET", "/plan-requests")).status, expected);
      assert.equal((await admin(t, "POST", `/plan-requests/${first.id}/approve`)).status, expected);
    }
  });

  test("list, filtered by status, with the waiting count", async () => {
    const r = await admin(reqMgr.token, "GET", `/plan-requests?status=PENDING&limit=100`);
    assert.equal(r.status, 200);
    assert.ok(r.body.requests.some((x) => x.id === first.id && x.requestedBy.email === A.email));
    assert.ok(r.body.pendingCount >= 2);
    assert.ok(r.body.requests.every((x) => x.status === "PENDING"));
    assert.equal((await admin(reqMgr.token, "GET", "/plan-requests?status=NOPE")).status, 400);
    assert.equal((await admin(reqMgr.token, "GET", "/plan-requests?clientId=nope")).status, 400);
    const byClient = await admin(reqMgr.token, "GET", `/plan-requests?clientId=${A.client._id}`);
    assert.ok(byClient.body.requests.every((x) => x.clientId === String(A.client._id)));
  });

  test("approve: plan changes, customer is told, request and audit are recorded", async () => {
    const r = await admin(reqMgr.token, "POST", `/plan-requests/${first.id}/approve`, { note: "Welcome aboard" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.request.status, "APPROVED");
    assert.equal(r.body.request.decidedByName, "reqmgr");
    assert.equal(r.body.request.decisionNote, "Welcome aboard");
    assert.equal((await models.Client.findById(A.client._id)).plan, "STARTER");

    const mail = sink.to(A.email).find((m) => /plan was changed/.test(sink.subject(m)));
    assert.ok(mail, "owner emailed");
    assert.match(mail.raw, /now on the Starter plan/);
    assert.match(mail.raw, /Welcome aboard/);

    const actions = (await models.AuditLog.find({ actorId: reqMgr.employee._id }).sort({ createdAt: 1 })).map((l) => l.action);
    assert.deepEqual(actions, ["client.update", "plan-request.approve"]);
    const page = (await billing(A.token)).body.billing;
    assert.equal(page.plan.key, "STARTER");
    assert.equal(page.pendingRequest, null);
    assert.equal(page.recentRequests[0].status, "APPROVED");
  });

  test("deciding twice -> 409; unknown or malformed id -> 404", async () => {
    assert.equal((await admin(reqMgr.token, "POST", `/plan-requests/${first.id}/approve`)).status, 409);
    assert.equal((await admin(reqMgr.token, "POST", `/plan-requests/${first.id}/reject`)).status, 409);
    assert.equal((await admin(reqMgr.token, "POST", `/plan-requests/${new ObjectId()}/approve`)).status, 404);
    assert.equal((await admin(reqMgr.token, "POST", `/plan-requests/nope/reject`)).status, 404);
    assert.equal((await admin(reqMgr.token, "POST", `/plan-requests/${second.id}/reject`, { note: "x".repeat(1001) })).status, 400);
  });

  test("reject: plan stays, customer gets the reason", async () => {
    const r = await admin(sa.token, "POST", `/plan-requests/${second.id}/reject`, { note: "Please talk to sales first" });
    assert.equal(r.status, 200);
    assert.equal(r.body.request.status, "REJECTED");
    assert.equal((await models.Client.findById(B.client._id)).plan, "STARTER");
    const mail = sink.to(B.email).find((m) => /not approved/.test(sink.subject(m)));
    assert.ok(mail);
    assert.match(mail.raw, /Please talk to sales first/);
    assert.match(mail.raw, /Starter to Enterprise/);
  });

  test("two staff deciding at once: exactly one decision is applied", async () => {
    const request = (await billing(A.token, "POST", "/plan-requests", { plan: "ENTERPRISE" })).body.request;
    const [one, two] = await Promise.all([
      admin(reqMgr.token, "POST", `/plan-requests/${request.id}/approve`),
      admin(sa.token, "POST", `/plan-requests/${request.id}/reject`),
    ]);
    assert.deepEqual([one.status, two.status].sort(), [200, 409]);
    const final = await models.PlanRequest.findById(request.id);
    const plan = (await models.Client.findById(A.client._id)).plan;
    assert.equal(plan, final.status === "APPROVED" ? "ENTERPRISE" : "STARTER");
  });
});

describe("who hears about a new request when SALES_EMAIL isn't set", () => {
  test("super admins and staff who can decide it, not other staff", async () => {
    const other = await startApi({ ...sink.env(), REDIS_URL: DEAD_REDIS, SALES_EMAIL: "" });
    try {
      sink.clear();
      const C = await createClient(other, TAG, "d");
      const r = await call(other.url, "POST", "/api/client/billing/plan-requests", { plan: "STARTER" }, C.token);
      assert.equal(r.status, 201);
      const got = (address) => sink.to(address).some((m) => /Plan request/.test(sink.subject(m)));
      assert.ok(got(sa.email), "super admin told");
      assert.ok(got(reqMgr.email), "staff with plan-requests.manage told");
      assert.equal(got(plain.email), false);
      assert.equal(got(reader.email), false);
    } finally {
      await other.stop();
    }
  });

  test("a failed notification email doesn't lose the request", async () => {
    const C = await createClient(api, TAG, "e");
    await sink.stop();
    const r = await billing(C.token, "POST", "/plan-requests", { plan: "STARTER" });
    await sink.start();
    assert.equal(r.status, 201);
    assert.equal(await models.PlanRequest.countDocuments({ clientId: C.client._id, status: "PENDING" }), 1);
  });
});
