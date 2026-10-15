import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { startApi, call, DEAD_REDIS } from "./helpers/app.js";
import { createSmtpSink } from "./helpers/smtpSink.js";
import { connectDb, disconnectDb, cleanup, testEmail, createClient } from "./helpers/db.js";

const TAG = "limits";
const sink = createSmtpSink();
let api;

// The only suite that runs with rate limiting ON (everywhere else NODE_ENV=test switches it off)
before(async () => {
  await connectDb();
  await cleanup(TAG);
  await sink.start();
  api = await startApi({ ...sink.env(), REDIS_URL: DEAD_REDIS, NODE_ENV: "development" });
});

after(async () => {
  await api?.stop();
  await cleanup(TAG);
  await sink.stop();
  await disconnectDb();
});

test("repeated wrong passwords for one account are blocked, other accounts are not", async () => {
  const body = { email: testEmail(TAG, "nobody"), password: "wrong" };
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await call(api.url, "POST", "/api/client/auth/login", body)).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
  const r = await call(api.url, "POST", "/api/client/auth/login", { ...body, email: testEmail(TAG, "someone-else") });
  assert.equal(r.status, 401);
});

test("sign-ups are limited to 5 an hour per address", async () => {
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await call(api.url, "POST", "/api/client/auth/register", {})).status);
  assert.deepEqual(statuses, [400, 400, 400, 400, 400, 429]);
});

test("plan requests are limited per signed-in owner", async () => {
  const A = await createClient(api, TAG, "a");
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await call(api.url, "POST", "/api/client/billing/plan-requests", { plan: "STARTER" }, A.token);
    statuses.push(r.status);
    if (r.status === 201) await call(api.url, "DELETE", `/api/client/billing/plan-requests/${r.body.request.id}`, undefined, A.token);
  }
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429]);
});

test("team invitations are limited per signed-in owner", async () => {
  const B = await createClient(api, TAG, "b", { plan: "ENTERPRISE" });
  const statuses = [];
  for (let i = 0; i < 21; i++) {
    statuses.push((await call(api.url, "POST", "/api/client/team", { name: "N", email: testEmail(TAG, `n${i}`) }, B.token)).status);
  }
  assert.equal(statuses.filter((s) => s === 201).length, 20);
  assert.equal(statuses[20], 429);
});
