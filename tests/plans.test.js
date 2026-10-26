import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { startApi, call, DEAD_REDIS } from "./helpers/app.js";
import { createSmtpSink } from "./helpers/smtpSink.js";
import {
  connectDb, disconnectDb, cleanup, models, testEmail, ObjectId,
  createClient, createEmployee, addMonitor,
} from "./helpers/db.js";

const TAG = "plans";
const KEY_PREFIX = "ZTP_";
const sink = createSmtpSink();
let api;
let sa, manager, reader, plain;

const admin = (token, method, route, body) => call(api.url, method, `/api/admin${route}`, body, token);
const billing = (token, method = "GET", route = "", body) => call(api.url, method, `/api/client/billing${route}`, body, token);

const validPlan = (suffix, extra = {}) => ({
  key: `${KEY_PREFIX}${suffix}`,
  name: `Test ${suffix}`,
  description: "A plan made by a test",
  features: ["Email alerts", "Priority support"],
  priceMonthly: 29.5,
  limits: { maxMonitors: 3, minIntervalSeconds: 60, maxTimeoutSeconds: 20, maxTeamMembers: 4, retentionDays: 30 },
  ...extra,
});

const removeTestPlans = () => models.Plan.deleteMany({ key: new RegExp(`^${KEY_PREFIX}`) });

before(async () => {
  await connectDb();
  await cleanup(TAG);
  await sink.start();
  api = await startApi({ ...sink.env(), REDIS_URL: DEAD_REDIS });
  await removeTestPlans();

  sa = await createEmployee(api, TAG, "sa", { role: "SUPER_ADMIN" });
  manager = await createEmployee(api, TAG, "manager", { permissions: ["plans.manage"] });
  reader = await createEmployee(api, TAG, "reader", { permissions: ["clients.read", "clients.manage", "plan-requests.manage"] });
  plain = await createEmployee(api, TAG, "plain", { permissions: [] });
});

after(async () => {
  // The default plan must be one of the starting plans again for the other suites
  await models.Plan.updateMany({}, { isDefault: false });
  await models.Plan.updateOne({ key: "FREE" }, { isDefault: true, isActive: true });
  await api?.stop();
  await removeTestPlans();
  await cleanup(TAG);
  await sink.stop();
  await disconnectDb();
});

describe("who may manage plans", () => {
  test("only the plans.manage permission (and super admins) can list or change plans", async () => {
    assert.equal((await admin(plain.token, "GET", "/plans")).status, 403);
    assert.equal((await admin(reader.token, "GET", "/plans")).status, 403, "other permissions are not enough");
    assert.equal((await admin(reader.token, "POST", "/plans", validPlan("DENIED"))).status, 403);
    assert.equal((await admin(undefined, "GET", "/plans")).status, 401);
    assert.equal((await admin(manager.token, "GET", "/plans")).status, 200);
    assert.equal((await admin(sa.token, "GET", "/plans")).status, 200);
  });

  test("a customer's token can't reach the plan screens", async () => {
    const C = await createClient(api, TAG, "cust");
    assert.ok([401, 403].includes((await admin(C.token, "GET", "/plans")).status));
  });

  test("the permission is offered when adding staff", async () => {
    const meta = (await admin(sa.token, "GET", "/meta")).body.meta;
    assert.ok(meta.permissions.some((p) => p.key === "plans.manage" && p.description));
  });
});

describe("the starting plans", () => {
  test("Free, Starter and Enterprise exist with their customer counts, lowest first", async () => {
    const r = await admin(manager.token, "GET", "/plans");
    const keys = r.body.plans.map((p) => p.key);
    assert.ok(["FREE", "STARTER", "ENTERPRISE"].every((k) => keys.includes(k)));
    assert.ok(keys.indexOf("FREE") < keys.indexOf("STARTER") && keys.indexOf("STARTER") < keys.indexOf("ENTERPRISE"));
    const free = r.body.plans.find((p) => p.key === "FREE");
    assert.equal(free.isDefault, true);
    assert.equal(free.limits.retentionDays, 30);
    assert.equal(typeof free.customerCount, "number");
  });
});

describe("creating a plan", () => {
  test("a valid plan is saved, shows up in the website config, and is written to the audit log", async () => {
    const r = await admin(manager.token, "POST", "/plans", validPlan("ONE"));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.plan.key, "ZTP_ONE");
    assert.equal(r.body.plan.priceMonthly, 29.5);
    assert.deepEqual(r.body.plan.features, ["Email alerts", "Priority support"]);
    assert.equal(r.body.plan.isActive, true);
    assert.equal(r.body.plan.customerCount, 0);

    const meta = (await call(api.url, "GET", "/api/meta")).body.meta;
    assert.ok(meta.plans.some((p) => p.key === "ZTP_ONE" && p.name === "Test ONE"), "visible without signing in");

    const log = await models.AuditLog.findOne({ action: "plan.create", targetLabel: "Test ONE" });
    assert.ok(log, "audit entry");
    assert.equal(log.actorId.toString(), manager.employee._id.toString());
    assert.deepEqual(log.changes.priceMonthly, { from: null, to: 29.5 });
  });

  test("the key is made upper-case and can't be used twice", async () => {
    const r = await admin(manager.token, "POST", "/plans", validPlan("TWO", { key: "ztp_two" }));
    assert.equal(r.status, 201);
    assert.equal(r.body.plan.key, "ZTP_TWO");
    assert.equal((await admin(manager.token, "POST", "/plans", validPlan("TWO"))).status, 409);
  });

  test("mistakes are refused with a reason", async () => {
    const bad = async (overrides, pattern) => {
      const r = await admin(manager.token, "POST", "/plans", validPlan("BAD", overrides));
      assert.equal(r.status, 400, JSON.stringify(overrides));
      assert.match(r.body.message, pattern);
    };
    await bad({ key: "1abc" }, /Key must be/);
    await bad({ key: "has space" }, /Key must be/);
    await bad({ name: "  " }, /Name is required/);
    await bad({ name: "x".repeat(41) }, /at most 40/);
    await bad({ description: "x".repeat(161) }, /Description/);
    await bad({ features: Array.from({ length: 11 }, (_, i) => `f${i}`) }, /Features/);
    await bad({ features: [""] }, /Features/);
    await bad({ priceMonthly: -1 }, /Price/);
    await bad({ priceMonthly: "free" }, /Price/);
    await bad({ limits: { ...validPlan("x").limits, maxMonitors: 0 } }, /Monitors must be a whole number/);
    await bad({ limits: { ...validPlan("x").limits, maxMonitors: 2.5 } }, /Monitors must be a whole number/);
    await bad({ limits: { ...validPlan("x").limits, minIntervalSeconds: 1 } }, /Fastest check interval/);
    await bad({ limits: { ...validPlan("x").limits, retentionDays: 400 } }, /History kept/);
    await bad({ limits: { maxMonitors: 3 } }, /Fastest check interval|Longest timeout|Team members|History kept/);
    await bad({ isDefault: true, isActive: false }, /default plan must be active/);
    assert.equal(await models.Plan.countDocuments({ key: "ZTP_BAD" }), 0, "nothing was saved");
  });
});

describe("editing a plan", () => {
  test("only the fields sent change, the key never does, and the change is audited", async () => {
    const r = await admin(manager.token, "PATCH", "/plans/ZTP_ONE", { name: "Renamed", priceMonthly: 35, limits: { maxMonitors: 7 }, key: "OTHER" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.plan.key, "ZTP_ONE");
    assert.equal(r.body.plan.name, "Renamed");
    assert.equal(r.body.plan.priceMonthly, 35);
    assert.equal(r.body.plan.limits.maxMonitors, 7);
    assert.equal(r.body.plan.limits.maxTeamMembers, 4, "other limits untouched");

    const log = await models.AuditLog.findOne({ action: "plan.update", targetLabel: "Renamed" });
    assert.deepEqual(log.changes.name, { from: "Test ONE", to: "Renamed" });
    assert.deepEqual(log.changes.maxMonitors, { from: 3, to: 7 });
    assert.deepEqual(Object.keys(log.changes).sort(), ["maxMonitors", "name", "priceMonthly"]);
  });

  test("unknown plan -> 404, nothing to change or invalid values -> 400", async () => {
    assert.equal((await admin(manager.token, "PATCH", "/plans/NOPE", { name: "x" })).status, 404);
    assert.equal((await admin(manager.token, "PATCH", "/plans/ZTP_ONE", {})).status, 400);
    assert.equal((await admin(manager.token, "PATCH", "/plans/ZTP_ONE", { priceMonthly: -5 })).status, 400);
    assert.equal((await admin(manager.token, "PATCH", "/plans/ZTP_ONE", { limits: { retentionDays: 0 } })).status, 400);
    assert.equal((await models.Plan.findOne({ key: "ZTP_ONE" })).priceMonthly, 35);
  });

  test("a saved change with nothing different writes no audit entry", async () => {
    const before = await models.AuditLog.countDocuments({ action: "plan.update" });
    assert.equal((await admin(manager.token, "PATCH", "/plans/ZTP_ONE", { name: "Renamed" })).status, 200);
    assert.equal(await models.AuditLog.countDocuments({ action: "plan.update" }), before);
  });
});

describe("limits apply to customers on the plan straight away", () => {
  let C;

  test("a customer on a custom plan is held to its monitor limit, and a raised limit lets them add more", async () => {
    await admin(manager.token, "POST", "/plans", validPlan("LIM", { limits: { maxMonitors: 1, minIntervalSeconds: 60, maxTimeoutSeconds: 20, maxTeamMembers: 2, retentionDays: 30 } }));
    C = await createClient(api, TAG, "lim", { plan: "ZTP_LIM" });

    const post = (name) => call(api.url, "POST", "/api/client/monitors", { name, url: "https://example.org" }, C.token);
    assert.equal((await post("first")).status, 201);
    const refused = await post("second");
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "PLAN_LIMIT_REACHED");

    assert.equal((await admin(manager.token, "PATCH", "/plans/ZTP_LIM", { limits: { maxMonitors: 2 } })).status, 200);
    assert.equal((await post("second")).status, 201, "the new limit is used at once");
  });

  test("the billing page and the interval rule use the plan's current values", async () => {
    const page = (await billing(C.token)).body.billing;
    assert.equal(page.plan.key, "ZTP_LIM");
    assert.deepEqual(page.usage.monitors, { used: 2, max: 2 });

    const tooFast = await call(api.url, "POST", "/api/client/monitors", { name: "fast", url: "https://example.org", intervalSeconds: 30 }, C.token);
    assert.equal(tooFast.status, 400);
    assert.match(tooFast.body.message, /no more often than every 60 seconds/);

    await admin(manager.token, "PATCH", "/plans/ZTP_LIM", { limits: { maxMonitors: 5, minIntervalSeconds: 120 } });
    const refused = await call(api.url, "POST", "/api/client/monitors", { name: "fast", url: "https://example.org", intervalSeconds: 60 }, C.token);
    assert.equal(refused.status, 400);
    assert.match(refused.body.message, /no more often than every 120 seconds/);
  });

  test("after an edit staff are told how many customers are now over a limit; nothing is removed", async () => {
    const r = await admin(manager.token, "PATCH", "/plans/ZTP_LIM", { limits: { maxMonitors: 1, minIntervalSeconds: 600 } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.impact, { customers: 1, overMonitorLimit: 1, overSeatLimit: 0, tooFastMonitors: 2 });
    assert.equal(await models.Monitor.countDocuments({ clientId: C.client._id }), 2, "monitors keep existing");
    assert.equal(r.body.plan.customerCount, 1);
  });
});

describe("the default plan, archiving and what customers can pick", () => {
  test("making another plan the default unsets the old one; the default can't be archived or unset", async () => {
    assert.equal((await admin(manager.token, "PATCH", "/plans/ZTP_ONE", { isDefault: true })).status, 200);
    const plans = (await admin(manager.token, "GET", "/plans")).body.plans;
    assert.deepEqual(plans.filter((p) => p.isDefault).map((p) => p.key), ["ZTP_ONE"]);

    const archive = await admin(manager.token, "PATCH", "/plans/ZTP_ONE", { isActive: false });
    assert.equal(archive.status, 400);
    assert.match(archive.body.message, /default plan can't be archived/);
    const unset = await admin(manager.token, "PATCH", "/plans/ZTP_ONE", { isDefault: false });
    assert.equal(unset.status, 400);
    assert.match(unset.body.message, /another plan the default/);
  });

  test("new sign-ups start on the default plan", async () => {
    const email = testEmail(TAG, "signup");
    const r = await call(api.url, "POST", "/api/client/auth/register", { name: "Sign Up", email, companyName: "Signup Co" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.client.plan, "ZTP_ONE");
    await admin(manager.token, "PATCH", "/plans/FREE", { isDefault: true });
    assert.equal((await models.Plan.findOne({ key: "ZTP_ONE" })).isDefault, false);
  });

  test("an archived plan can't be requested or assigned, but customers already on it keep it", async () => {
    const A = await createClient(api, TAG, "arch", { plan: "FREE" });
    const onTwo = await createClient(api, TAG, "ontwo", { plan: "ZTP_TWO" });
    assert.equal((await admin(manager.token, "PATCH", "/plans/ZTP_TWO", { isActive: false })).status, 200);

    // the customer on it still sees and uses it
    const page = (await billing(onTwo.token)).body.billing;
    assert.equal(page.plan.key, "ZTP_TWO");
    assert.equal(page.plan.isActive, false);
    assert.equal((await call(api.url, "GET", "/api/client/monitors", undefined, onTwo.token)).status, 200);

    // nobody else can choose it
    const request = await billing(A.token, "POST", "/plan-requests", { plan: "ZTP_TWO" });
    assert.equal(request.status, 400);
    const assign = await admin(reader.token, "PATCH", `/clients/${A.client._id}`, { plan: "ZTP_TWO" });
    assert.equal(assign.status, 400);
    assert.equal((await models.Client.findById(A.client._id)).plan, "FREE");

    // an unchanged archived plan can still be saved on its own customer (e.g. only the company name changes)
    const rename = await admin(reader.token, "PATCH", `/clients/${onTwo.client._id}`, { plan: "ZTP_TWO", companyName: "Renamed Co" });
    assert.equal(rename.status, 200, JSON.stringify(rename.body));
  });

  test("a request for a plan that is archived before staff decide can't be approved, but can be rejected", async () => {
    await admin(manager.token, "PATCH", "/plans/ZTP_TWO", { isActive: true });
    const A = await createClient(api, TAG, "reqarch", { plan: "FREE" });
    const sent = await billing(A.token, "POST", "/plan-requests", { plan: "ZTP_TWO" });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const id = sent.body.request.id;
    assert.equal(sent.body.request.direction, "UPGRADE", "direction follows the plans' order");

    await admin(manager.token, "PATCH", "/plans/ZTP_TWO", { isActive: false });
    const approve = await admin(reader.token, "POST", `/plan-requests/${id}/approve`, {});
    assert.equal(approve.status, 400);
    assert.match(approve.body.message, /no longer available/);
    assert.equal((await models.Client.findById(A.client._id)).plan, "FREE");
    assert.equal((await admin(reader.token, "POST", `/plan-requests/${id}/reject`, {})).status, 200);
  });

  test("upgrade or downgrade follows the order staff set, not the names", async () => {
    await admin(manager.token, "PATCH", "/plans/ZTP_TWO", { isActive: true, sortOrder: -5 });
    const list = (await admin(manager.token, "GET", "/plans")).body.plans.map((p) => p.key);
    assert.equal(list[0], "ZTP_TWO", "lowest sort order comes first");

    const B = await createClient(api, TAG, "order", { plan: "FREE" });
    const sent = await billing(B.token, "POST", "/plan-requests", { plan: "ZTP_TWO" });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.request.direction, "DOWNGRADE", "ZTP_TWO now ranks below FREE");
    await billing(B.token, "DELETE", `/plan-requests/${sent.body.request.id}`);
  });

  test("only one plan is marked recommended at a time", async () => {
    await admin(manager.token, "PATCH", "/plans/ZTP_ONE", { isRecommended: true });
    await admin(manager.token, "PATCH", "/plans/ZTP_TWO", { isRecommended: true });
    const plans = (await admin(manager.token, "GET", "/plans")).body.plans;
    assert.deepEqual(plans.filter((p) => p.isRecommended).map((p) => p.key), ["ZTP_TWO"]);
  });
});

describe("how long history is kept", () => {
  test("results older than the plan's retention are deleted when it is shortened; other plans are untouched", async () => {
    await admin(manager.token, "POST", "/plans", validPlan("RET", { limits: { maxMonitors: 3, minIntervalSeconds: 60, maxTimeoutSeconds: 20, maxTeamMembers: 4, retentionDays: 30 } }));
    const A = await createClient(api, TAG, "ret", { plan: "ZTP_RET" });
    const other = await createClient(api, TAG, "retother", { plan: "FREE" });
    const monitorA = await addMonitor(A.client, "ret mon");
    const monitorB = await addMonitor(other.client, "other mon");

    const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
    const result = (client, monitor, days) => ({ monitorId: monitor._id, clientId: client._id, checkedAt: daysAgo(days), success: true, statusCode: 200, responseTimeMs: 100 });
    await models.CheckResult.insertMany([
      result(A.client, monitorA, 1), result(A.client, monitorA, 10), result(A.client, monitorA, 20),
      result(other.client, monitorB, 20),
    ]);

    assert.equal((await admin(manager.token, "PATCH", "/plans/ZTP_RET", { limits: { retentionDays: 5 } })).status, 200);

    // the clean-up runs in the background right after the edit
    for (let i = 0; i < 30 && (await models.CheckResult.countDocuments({ clientId: A.client._id })) > 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(await models.CheckResult.countDocuments({ clientId: A.client._id }), 1, "only the 1-day-old result is left");
    assert.equal(await models.CheckResult.countDocuments({ clientId: other.client._id }), 1, "a customer on another plan keeps theirs");
  });

  test("the old database-wide expiry is gone", async () => {
    const indexes = await models.CheckResult.collection.indexes();
    assert.ok(!indexes.some((i) => i.expireAfterSeconds !== undefined), "no TTL index on check results");
  });
});
