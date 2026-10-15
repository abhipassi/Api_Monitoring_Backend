import path from "path";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env"), quiet: true });

// Every test run gets a private key prefix, so it never reads or deletes anyone else's Redis data
export const makeTestRedis = (label) => {
  const prefix = `apimon-test-${label}-${Math.random().toString(36).slice(2, 8)}`;
  const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue("monitor-checks", { connection, prefix });

  return {
    prefix,
    url: process.env.REDIS_URL,
    // monitor id -> repeat interval in ms
    schedulers: async () => new Map((await queue.getJobSchedulers(0, -1)).map((s) => [s.key, s.every])),
    close: async () => {
      let cursor = "0";
      do {
        const [next, keys] = await connection.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 500);
        cursor = next;
        if (keys.length) await connection.del(...keys);
      } while (cursor !== "0");
      await queue.close();
      await connection.quit();
    },
  };
};

export const waitFor = async (fn, ms = 8000, step = 100) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
};
