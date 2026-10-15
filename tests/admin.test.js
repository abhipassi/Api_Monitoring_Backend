import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { startApi, call, DEAD_REDIS } from "./helpers/app.js";
import { createSmtpSink } from "./helpers/smtpSink.js";
import { makeTestRedis, waitFor } from "./helpers/redis.js";
import {
  connectDb, disconnectDb, cleanup, models, testEmail, ObjectId,
  createClient, addClientUser, createEmployee, addMonitor,
} from "./helpers/db.js";

const TAG = "admin";
const sink = createSmtpSink();
const redis = makeTestRedis("admin");
let api, apiNoRedis;
let sa, reader, manager, plain, auditor;
let X, Y;

const admin = (token, method, route, body) => call(api.url, method, `/api/admin${route}`, body, token);

before(async () => {
  await connectDb();
  await cleanup(TAG);
  await sink.start();
  api = await startApi({ ...sink.env(), REDIS_URL: redis.url, QUEUE_PREFIX: redis.prefix });
  apiNoRedis = await startApi({ ...sink.env(), REDIS_URL: DEAD_REDIS });

  sa = await createEmployee(api, TAG, "sa", { role: "SUPER_ADMIN" });
  reader = await createEmployee(api, TAG, "reader", { permissions: ["clients.read"] });
  manager = await createEmployee(api, TAG, "manager", { permissions: ["clients.read", "clients.manage"] });
  plain = await createEmployee(api, TAG, "plain", { permissions: [] });
  auditor = await createEmployee(api, TAG, "auditor", { permissions: ["audit.read"] });

  // X: STARTER, 7 monitors (2 check faster than FREE allows, 1 paused), 3 active people
  X = await createClient(api, TAG, "x", { plan: "STARTER", ownerName: "Xena Owner" });
  await addClientUser(api, X.client, TAG, "xmember1");
  await addClientUser(api, X.client, TAG, "xmember2");
  await addClientUser(api, X.client, TAG, "xdisabled", { status: "DISABLED" });
  await addMonitor(X.client, "x1", { intervalSeconds: 60, "health.status": "DOWN" });
  await addMonitor(X.client, "x2", { intervalSeconds: 120, "health.status": "DOWN" });
  await addMonitor(X.client, "x3", { "health.status": "UP" });
  await addMonitor(X.client, "x4", { "health.status": "UP" });
  await addMonitor(X.client, "x5", { "health.status": "UP" });
  await addMonitor(X.client, "x6", { "health.status": "UNKNOWN" });
  await addMonitor(X.client, "x7", { status: "PAUSED" });
  await models.Incident.create({ clientId: X.client._id, monitorId: new ObjectId(), monitorName: "x1", monitorUrl: "https://example.org", startedAt: new Date(), failureCount: 3 });

  // Y: FREE, used to watch schedules change in Redis
  Y = await createClient(api, TAG, "y", { plan: "FREE", ownerName: "Yara Owner" });
});

after(async () => {
  await api?.stop();
  await apiNoRedis?.stop();
  await cleanup(TAG);
  await redis.close();
  await sink.stop();
  await disconnectDb();
});

describe("who may do what", () => {
  test("no token -> 401, customer token -> 403", async () => {
    assert.equal((await admin(undefined, "GET", "/stats")).status, 401);
    assert.equal((await admin("garbage", "GET", "/stats")).status, 401);
    assert.equal((await admin(X.token, "GET", "/stats")).status, 403);
    assert.equal((await admin(X.token, "GET", "/clients")).status, 403);
  });

  test("staff with no permissions can only read the config", async () => {
    assert.equal((await admin(plain.token, "GET", "/meta")).status, 200);
    for (const route of ["/stats", "/clients", `/clients/${X.client._id}`, "/plan-requests", "/audit-logs"]) {
      assert.equal((await admin(plain.token, "GET", route)).status, 403, route);
    }
  });

  test("clients.read can look but not change", async () => {
    assert.equal((await admin(reader.token, "GET", "/clients")).status, 200);
    assert.equal((await admin(reader.token, "GET", `/clients/${X.client._id}`)).status, 200);
    assert.equal((await admin(reader.token, "GET", "/stats")).status, 200);
    assert.equal((await admin(reader.token, "PATCH", `/clients/${X.client._id}`, { companyName: "Nope" })).status, 403);
    assert.equal((await admin(reader.token, "GET", "/plan-requests")).status, 403);
    assert.equal((await admin(reader.token, "GET", "/audit-logs")).status, 403);
  });

  test("employee management is for super admins only", async () => {
    assert.equal((await call(api.url, "GET", "/api/admin/employees", undefined, manager.token)).status, 403);
    assert.equal((await call(api.url, "PATCH", `/api/admin/employees/${plain.employee._id}`, { name: "x" }, manager.token)).status, 403);
    assert.equal((await call(api.url, "GET", "/api/admin/employees", undefined, sa.token)).status, 200);
  });
});

describe("customers", () => {
  test("list: search, filters, counts, paging", async () => {
    const all = await admin(sa.token, "GET", `/clients?search=zz-${TAG}-&limit=100`);
    assert.equal(all.status, 200);
    assert.equal(all.body.clients.length, 2);

    const x = all.body.clients.find((c) => c.id === String(X.client._id));
    assert.equal(x.plan, "STARTER");
    assert.equal(x.monitorCount, 7);
    assert.equal(x.activeUserCount, 3, "owner + 2 members; the disabled one is not counted");
    assert.equal(x.hasPendingPlanRequest, false);

    const starter = await admin(sa.token, "GET", `/clients?search=zz-${TAG}-&plan=STARTER`);
    assert.deepEqual(starter.body.clients.map((c) => c.id), [String(X.client._id)]);
    const paged = await admin(sa.token, "GET", `/clients?search=zz-${TAG}-&limit=1&page=2`);
    assert.equal(paged.body.clients.length, 1);
    assert.equal(paged.body.pagination.pages, 2);
    const none = await admin(sa.token, "GET", `/clients?search=zz-${TAG}-&status=SUSPENDED`);
    assert.equal(none.body.clients.length, 0);

    assert.equal((await admin(sa.token, "GET", "/clients?plan=GOLD")).status, 400);
    assert.equal((await admin(sa.token, "GET", "/clients?status=GONE")).status, 400);
  });

  test("search treats special characters literally", async () => {
    const r = await admin(sa.token, "GET", `/clients?search=${encodeURIComponent(".*")}`);
    assert.equal(r.body.clients.length, 0);
  });

  test("detail: usage against the plan, monitor health, people, incidents", async () => {
    const r = await admin(reader.token, "GET", `/clients/${X.client._id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.client.companyName, "x Co");
    assert.deepEqual(r.body.usage, { monitors: { used: 7, max: 50 }, teamMembers: { used: 3, max: 10 } });
    assert.deepEqual(r.body.monitors, { total: 7, paused: 1, up: 3, down: 2, unknown: 1 });
    assert.equal(r.body.openIncidents, 1);
    assert.equal(r.body.users.length, 4);
    assert.ok(r.body.users.some((u) => u.status === "DISABLED"));
    assert.equal(r.body.pendingPlanRequest, null);
    assert.equal(JSON.stringify(r.body).includes("passwordHash"), false);
  });

  test("unknown or malformed id -> 404", async () => {
    assert.equal((await admin(sa.token, "GET", `/clients/${new ObjectId()}`)).status, 404);
    assert.equal((await admin(sa.token, "GET", "/clients/nope")).status, 404);
    assert.equal((await admin(sa.token, "PATCH", "/clients/nope", { plan: "FREE" })).status, 404);
  });
});

describe("changing a customer", () => {
  test("validation", async () => {
    const id = X.client._id;
    for (const body of [{ plan: "GOLD" }, { status: "GONE" }, { companyName: "  " }, { companyName: "x".repeat(101) }, {}, { plan: "STARTER" }, { email: "new@example.com" }]) {
      const r = await admin(manager.token, "PATCH", `/clients/${id}`, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status}`);
    }
  });

  test("downgrade explains what won't fit, and removes nothing", async () => {
    const r = await admin(manager.token, "PATCH", `/clients/${X.client._id}`, { plan: "FREE" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.client.plan, "FREE");
    assert.equal(r.body.warnings.length, 3, JSON.stringify(r.body.warnings));
    assert.match(r.body.warnings[0], /7 monitors exist but the Free plan allows 5/);
    assert.match(r.body.warnings[1], /3 team members are active but the Free plan allows 2/);
    assert.match(r.body.warnings[2], /2 monitors check more often than the Free plan allows.*every 300 seconds/);
    assert.equal(await models.Monitor.countDocuments({ clientId: X.client._id }), 7);
    assert.equal(await models.ClientUser.countDocuments({ clientId: X.client._id, status: "ACTIVE" }), 3);

    const back = await admin(manager.token, "PATCH", `/clients/${X.client._id}`, { plan: "STARTER" });
    assert.deepEqual(back.body.warnings, []);
  });

  test("every change is recorded with who did it and the before/after", async () => {
    const logs = await models.AuditLog.find({ targetId: X.client._id, action: "client.update" }).sort({ createdAt: 1 });
    assert.equal(logs.length, 2);
    assert.equal(logs[0].actorEmail, manager.email);
    assert.deepEqual(logs[0].changes.plan, { from: "STARTER", to: "FREE" });
    assert.deepEqual(logs[1].changes.plan, { from: "FREE", to: "STARTER" });
    assert.equal(logs[0].targetLabel, "x Co");
  });

  test("the owner is emailed when the plan changes", async () => {
    const mails = sink.to(X.email).filter((m) => /plan was changed/.test(sink.subject(m)));
    assert.equal(mails.length, 2);
    assert.equal(sink.subject(mails[0]), "Your plan was changed to Free");
    assert.match(mails[0].raw, /changed from Starter to Free/);
  });

  test("rename a company", async () => {
    const r = await admin(manager.token, "PATCH", `/clients/${X.client._id}`, { companyName: "  Xena Industries " });
    assert.equal(r.body.client.companyName, "Xena Industries");
    await admin(manager.token, "PATCH", `/clients/${X.client._id}`, { companyName: "x Co" });
  });

  test("suspending locks the customer out; restoring lets them back in", async () => {
    assert.equal((await call(api.url, "GET", "/api/client/monitors", undefined, X.token)).status, 200);
    assert.equal((await admin(manager.token, "PATCH", `/clients/${X.client._id}`, { status: "SUSPENDED" })).status, 200);

    const blocked = await call(api.url, "GET", "/api/client/monitors", undefined, X.token);
    assert.equal(blocked.status, 403, "existing session is blocked at once");
    const login = await call(api.url, "POST", "/api/client/auth/login", { email: X.email, password: "testpass123" });
    assert.equal(login.status, 403);

    assert.equal((await admin(manager.token, "PATCH", `/clients/${X.client._id}`, { status: "ACTIVE" })).status, 200);
    assert.equal((await call(api.url, "GET", "/api/client/monitors", undefined, X.token)).status, 200);
  });
});

describe("a plan or status change updates check schedules right away (real Redis)", () => {
  let y1, y2, y3;
  before(async () => {
    y1 = await addMonitor(Y.client, "y1", { intervalSeconds: 60 });
    y2 = await addMonitor(Y.client, "y2", { intervalSeconds: 300 });
    y3 = await addMonitor(Y.client, "y3", { status: "PAUSED" });
  });

  const expectSchedule = async (expected) => {
    const ok = await waitFor(async () => {
      const s = await redis.schedulers();
      return [y1, y2, y3].every((m) => s.get(String(m._id)) === expected[m.name]);
    });
    const s = await redis.schedulers();
    assert.ok(ok, `expected ${JSON.stringify(expected)}, got ${JSON.stringify([...s])}`);
  };

  test("upgrade to STARTER: the 60s monitor now runs every 60s; paused is not scheduled", async () => {
    const initial = await redis.schedulers();
    assert.ok([y1, y2, y3].every((m) => !initial.has(String(m._id))), "nothing scheduled for Y yet");
    assert.equal((await admin(manager.token, "PATCH", `/clients/${Y.client._id}`, { plan: "STARTER" })).status, 200);
    await expectSchedule({ y1: 60000, y2: 300000, y3: undefined });
  });

  test("downgrade to FREE: the 60s monitor is slowed to FREE's 300s minimum", async () => {
    await admin(manager.token, "PATCH", `/clients/${Y.client._id}`, { plan: "FREE" });
    await expectSchedule({ y1: 300000, y2: 300000, y3: undefined });
  });

  test("suspend: every schedule is removed; restore: they come back", async () => {
    await admin(manager.token, "PATCH", `/clients/${Y.client._id}`, { status: "SUSPENDED" });
    await expectSchedule({ y1: undefined, y2: undefined, y3: undefined });
    await admin(manager.token, "PATCH", `/clients/${Y.client._id}`, { status: "ACTIVE" });
    await expectSchedule({ y1: 300000, y2: 300000, y3: undefined });
  });

  test("with Redis down the change still succeeds", async () => {
    const adminToken = (await call(apiNoRedis.url, "POST", "/api/admin/auth/login", { email: manager.email, password: "testpass123" })).body.token;
    const r = await call(apiNoRedis.url, "PATCH", `/api/admin/clients/${Y.client._id}`, { plan: "STARTER" }, adminToken);
    assert.equal(r.status, 200);
    assert.equal((await models.Client.findById(Y.client._id)).plan, "STARTER");
    assert.match(apiNoRedis.logs.text, /Could not resync schedules/);
  });
});

describe("staff management", () => {
  test("list with filters", async () => {
    const r = await call(api.url, "GET", `/api/admin/employees?search=zz-${TAG}-&limit=100`, undefined, sa.token);
    assert.equal(r.status, 200);
    assert.equal(r.body.employees.length, 5);
    assert.ok(r.body.employees.every((e) => e.pendingFirstLogin === false));
    assert.equal(JSON.stringify(r.body).includes("$2"), false, "no password hashes");

    const staff = await call(api.url, "GET", `/api/admin/employees?search=zz-${TAG}-&role=STAFF`, undefined, sa.token);
    assert.equal(staff.body.employees.length, 4);
    for (const q of ["role=GOD", "status=GONE"]) {
      assert.equal((await call(api.url, "GET", `/api/admin/employees?${q}`, undefined, sa.token)).status, 400);
    }
  });

  test("creating an employee rejects unknown permissions and is audited", async () => {
    const bad = await call(api.url, "POST", "/api/admin/employees", { name: "New Hire", email: testEmail(TAG, "hire"), phone: "9990001234", permissions: ["can.fly"] }, sa.token);
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /clients\.read/);

    const ok = await call(api.url, "POST", "/api/admin/employees", { name: "New Hire", email: testEmail(TAG, "hire"), phone: "9990001234", permissions: ["clients.read"] }, sa.token);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.ok(sink.passwordIn(sink.to(testEmail(TAG, "hire"))[0]));
    const log = await models.AuditLog.findOne({ action: "employee.create", targetId: ok.body.employee.id });
    assert.equal(log.actorEmail, sa.email);
  });

  test("changing permissions takes effect on the very next request", async () => {
    assert.equal((await admin(plain.token, "GET", "/clients")).status, 403);
    const r = await call(api.url, "PATCH", `/api/admin/employees/${plain.employee._id}`, { permissions: ["clients.read", "clients.read"] }, sa.token);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.employee.permissions, ["clients.read"], "duplicates removed");
    assert.equal((await admin(plain.token, "GET", "/clients")).status, 200);
  });

  test("deactivating locks the person out at once", async () => {
    const r = await call(api.url, "PATCH", `/api/admin/employees/${plain.employee._id}`, { status: "INACTIVE" }, sa.token);
    assert.equal(r.status, 200);
    assert.equal((await admin(plain.token, "GET", "/clients")).status, 401);
    await call(api.url, "PATCH", `/api/admin/employees/${plain.employee._id}`, { status: "ACTIVE" }, sa.token);
    assert.equal((await admin(plain.token, "GET", "/clients")).status, 200);
  });

  test("validation and self-protection", async () => {
    const patch = (id, body) => call(api.url, "PATCH", `/api/admin/employees/${id}`, body, sa.token);
    for (const body of [{ role: "GOD" }, { status: "GONE" }, { name: " " }, { permissions: ["can.fly"] }, { permissions: "clients.read" }, {}]) {
      assert.equal((await patch(reader.employee._id, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await patch(sa.employee._id, { role: "STAFF" })).status, 400, "can't demote yourself");
    assert.equal((await patch(sa.employee._id, { status: "INACTIVE" })).status, 400, "can't deactivate yourself");
    assert.equal((await patch(new ObjectId(), { name: "x" })).status, 404);
    assert.equal((await patch("nope", { name: "x" })).status, 404);
  });
});

describe("audit log", () => {
  test("entries show who, what and before/after", async () => {
    const r = await admin(auditor.token, "GET", `/audit-logs?targetType=CLIENT&targetId=${X.client._id}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.logs.length >= 4);
    const planChange = r.body.logs.find((l) => l.changes.plan?.to === "FREE");
    assert.equal(planChange.actor.email, manager.email);
    assert.equal(planChange.action, "client.update");
    assert.equal(planChange.targetLabel, "x Co");
    assert.ok(r.body.logs.every((l, i, a) => i === 0 || new Date(a[i - 1].createdAt) >= new Date(l.createdAt)), "newest first");
  });

  test("filter by person, paging, and only with audit.read", async () => {
    const byActor = await admin(sa.token, "GET", `/audit-logs?actorId=${manager.employee._id}&limit=1&page=2`);
    assert.equal(byActor.status, 200);
    assert.equal(byActor.body.logs.length, 1);
    assert.ok(byActor.body.pagination.total >= 2);
    assert.equal((await admin(manager.token, "GET", "/audit-logs")).status, 403);
    assert.equal((await admin(sa.token, "GET", "/audit-logs?targetType=NOPE")).status, 400);
    assert.equal((await admin(sa.token, "GET", "/audit-logs?targetId=nope")).status, 400);
  });
});

describe("platform stats", () => {
  test("add up, including estimated revenue from the plan prices", async () => {
    const read = async () => (await admin(reader.token, "GET", "/stats")).body.stats;
    const before = await read();

    const Z = await createClient(api, TAG, "z", { plan: "ENTERPRISE" });
    await addMonitor(Z.client, "z1", { "health.status": "UP" });
    await addMonitor(Z.client, "z2", { status: "PAUSED" });
    const after = await read();

    assert.equal(after.clients.total - before.clients.total, 1);
    assert.equal(after.clients.byPlan.ENTERPRISE - before.clients.byPlan.ENTERPRISE, 1);
    assert.equal(after.clients.newLast30Days - before.clients.newLast30Days, 1);
    assert.equal(after.monitors.total - before.monitors.total, 2);
    assert.equal(after.monitors.up - before.monitors.up, 1);
    assert.equal(after.monitors.paused - before.monitors.paused, 1);
    assert.equal(after.activeUsers - before.activeUsers, 1);

    const meta = (await call(api.url, "GET", "/api/meta")).body.meta;
    const price = meta.plans.find((p) => p.key === "ENTERPRISE").priceMonthly;
    assert.equal(after.estimatedMonthlyRevenue.amount - before.estimatedMonthlyRevenue.amount, price);
    assert.equal(after.estimatedMonthlyRevenue.isSample, true);
    assert.equal(after.estimatedMonthlyRevenue.currency, meta.currency);

    await models.Client.updateOne({ _id: Z.client._id }, { status: "SUSPENDED" });
    const suspended = await read();
    assert.equal(suspended.estimatedMonthlyRevenue.amount, before.estimatedMonthlyRevenue.amount, "suspended customers add no revenue");
    assert.equal(suspended.clients.byStatus.SUSPENDED - before.clients.byStatus.SUSPENDED, 1);
  });
});
