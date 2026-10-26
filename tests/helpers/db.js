import path from "path";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";

import "./testEnv.js";
import { call } from "./app.js";

const src = (file) => import(path.resolve(import.meta.dirname, "../../src/Models", file));

export const models = {};

export const connectDb = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  models.Client = (await src("clients.js")).default;
  models.ClientUser = (await src("ClientUser.js")).default;
  models.Employees = (await src("employees.js")).default;
  models.Monitor = (await src("Monitor.js")).default;
  models.CheckResult = (await src("CheckResult.js")).default;
  models.Incident = (await src("Incident.js")).default;
  models.PlanRequest = (await src("PlanRequest.js")).default;
  models.AuditLog = (await src("AuditLog.js")).default;
  models.Plan = (await src("Plan.js")).default;
  return models;
};

export const disconnectDb = () => mongoose.disconnect();

export const ObjectId = mongoose.Types.ObjectId;

// Test data always lives under zz-<tag>-...@example.com, and only that is ever deleted.
export const testEmail = (tag, name) => `zz-${tag}-${name}@example.com`;
const testPattern = (tag) => new RegExp(`^zz-${tag}-.*@example\\.com$`);

export const cleanup = async (tag) => {
  const { Client, ClientUser, Employees, Monitor, CheckResult, Incident, PlanRequest, AuditLog } = models;
  const clients = await Client.find({ email: testPattern(tag) }).select("_id");
  const clientIds = clients.map((c) => c._id);
  const employees = await Employees.find({ email: testPattern(tag) }).select("_id");
  const employeeIds = employees.map((e) => e._id);

  await Promise.all([
    CheckResult.deleteMany({ clientId: { $in: clientIds } }),
    Incident.deleteMany({ clientId: { $in: clientIds } }),
    Monitor.deleteMany({ clientId: { $in: clientIds } }),
    PlanRequest.deleteMany({ clientId: { $in: clientIds } }),
    AuditLog.deleteMany({ $or: [{ actorId: { $in: employeeIds } }, { targetId: { $in: [...clientIds, ...employeeIds] } }] }),
  ]);
  // A user whose email matches, even if the client was created by an API call
  await ClientUser.deleteMany({ $or: [{ clientId: { $in: clientIds } }, { email: testPattern(tag) }] });
  await Client.deleteMany({ _id: { $in: clientIds } });
  await Employees.deleteMany({ _id: { $in: employeeIds } });
};

const PASSWORD = "testpass123";
export const TEST_PASSWORD = PASSWORD;

// A customer with an owner who can already log in (no forced password change)
export const createClient = async (api, tag, name, { plan = "FREE", status = "ACTIVE", ownerName = "Owner" } = {}) => {
  const email = testEmail(tag, name);
  const client = await models.Client.create({ name: ownerName, email, companyName: `${name} Co`, plan, status });
  const owner = await models.ClientUser.create({
    clientId: client._id, name: ownerName, email, role: "OWNER",
    passwordHash: await bcrypt.hash(PASSWORD, 12), mustChangePassword: false,
  });
  const login = await call(api.url, "POST", "/api/client/auth/login", { email, password: PASSWORD });
  return { client, owner, email, token: login.body.token };
};

export const addClientUser = async (api, client, tag, name, { role = "MEMBER", status = "ACTIVE" } = {}) => {
  const email = testEmail(tag, name);
  const user = await models.ClientUser.create({
    clientId: client._id, name, email, role, status,
    passwordHash: await bcrypt.hash(PASSWORD, 12), mustChangePassword: false,
  });
  const login = await call(api.url, "POST", "/api/client/auth/login", { email, password: PASSWORD });
  return { user, email, token: login.body.token };
};

export const createEmployee = async (api, tag, name, { role = "STAFF", permissions = [], phone } = {}) => {
  const email = testEmail(tag, name);
  const employee = await models.Employees.create({
    name, email, role, permissions,
    phone: phone ?? Number(`99${String(Date.now()).slice(-7)}${Math.floor(Math.random() * 90 + 10)}`),
    password: await bcrypt.hash(PASSWORD, 12), mustChangePassword: false,
  });
  const login = await call(api.url, "POST", "/api/admin/auth/login", { email, password: PASSWORD });
  return { employee, email, token: login.body.token };
};

export const addMonitor = (client, name, extra = {}) =>
  models.Monitor.create({
    clientId: client._id, createdBy: new ObjectId(), name,
    url: "https://example.org", intervalSeconds: 300, timeoutSeconds: 10, ...extra,
  });
