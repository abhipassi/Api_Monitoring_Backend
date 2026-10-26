import path from "path";
import dotenv from "dotenv";

// Tests never touch the real database. They run on a copy named "<database>_test", where the
// API creates its own starting plans, so edits to plans in the real database can't break a test
// (and a test can't change real plans). Import this before anything reads MONGODB_URI.
dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env"), quiet: true });

const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/apimon";
const [base, query = ""] = uri.split("?");
const withDatabase = /^mongodb(\+srv)?:\/\/[^/]+\/[^/]+$/.test(base) ? `${base}_test` : `${base.replace(/\/$/, "")}/apimon_test`;

process.env.MONGODB_URI = query ? `${withDatabase}?${query}` : withDatabase;
