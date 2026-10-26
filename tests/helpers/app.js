import net from "net";
import path from "path";
import { spawn } from "child_process";

import "./testEnv.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Starts the real API (server.js) as its own process on a free port. `env` overrides the .env
// values, so each test file picks its own SMTP sink, Redis and settings.
export const startApi = async (env = {}) => {
  const port = await freePort();
  const child = spawn("node", ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "test", PORT: String(port), ...env },
  });

  const logs = { text: "" };
  child.stdout.on("data", (d) => (logs.text += d));
  child.stderr.on("data", (d) => (logs.text += d));

  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    if ((await fetch(`${url}/health-check`).catch(() => null))?.ok) break;
    if (child.exitCode !== null) throw new Error(`API exited early:\n${logs.text}`);
    await sleep(250);
  }

  return {
    url,
    logs,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      child.kill("SIGKILL");
    }),
  };
};

// Redis that is guaranteed unreachable: the API must still work, it just can't schedule checks
export const DEAD_REDIS = "redis://127.0.0.1:6390";

export const call = async (base, method, route, body, token) => {
  const response = await fetch(base + route, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};
