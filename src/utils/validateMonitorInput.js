import { HTTP_METHODS } from "../Models/Monitor.js";
import { MAX_INTERVAL_SECONDS } from "../../config/plans.js";
import { validateMonitorUrl } from "./validateMonitorUrl.js";

export const MAX_HEADERS = 20;
export const MAX_NAME_LENGTH = 100;
export const MAX_BODY_LENGTH = 10000;
export const MAX_URL_LENGTH = 2048;
const HEADER_NAME_REGEX = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Set by the HTTP client itself; letting users override them breaks requests or enables smuggling
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
]);
const METHODS_WITH_BODY = ["POST", "PUT", "PATCH"];

export const DEFAULT_INTERVAL_SECONDS = 300;
export const DEFAULT_TIMEOUT_SECONDS = 10;

const has = (obj, key) => Object.hasOwn(obj, key);
const isInt = (v) => typeof v === "number" && Number.isInteger(v);

const validateHeaders = (headers, errors) => {
  if (!Array.isArray(headers)) {
    errors.push('Headers must be an array of { "name", "value" } objects');
    return null;
  }
  if (headers.length > MAX_HEADERS) {
    errors.push(`At most ${MAX_HEADERS} headers are allowed`);
    return null;
  }

  const seen = new Set();
  const clean = [];

  for (const h of headers) {
    const name = typeof h?.name === "string" ? h.name.trim() : "";
    const value = typeof h?.value === "string" ? h.value.trim() : "";

    if (!name || !HEADER_NAME_REGEX.test(name) || name.length > 100) {
      errors.push(`Invalid header name: "${String(h?.name ?? "").slice(0, 50)}"`);
      continue;
    }
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      errors.push(`The "${name}" header can't be set manually`);
      continue;
    }
    if (seen.has(name.toLowerCase())) {
      errors.push(`Header "${name}" is listed more than once`);
      continue;
    }
    if (!value || value.length > 1000 || /[\r\n\0]/.test(value)) {
      errors.push(`Header "${name}" needs a value of 1-1000 characters with no line breaks`);
      continue;
    }

    seen.add(name.toLowerCase());
    clean.push({ name, value });
  }

  return clean;
};

// Validates a create (existing = null) or partial update (existing = current monitor).
// Only fields that were sent are returned in `data`; plan limits are checked on those,
// while rules that span fields (body vs method, timeout vs interval) use the merged result.
// Returns { errors: string[] } or { data }.
export const validateMonitorInput = (input, { plan, existing = null }) => {
  const errors = [];
  const data = {};
  const isCreate = !existing;

  if (isCreate || has(input, "name")) {
    if (typeof input.name !== "string" || !input.name.trim()) {
      errors.push("Name is required");
    } else if (input.name.trim().length > 100) {
      errors.push("Name must be at most 100 characters");
    } else {
      data.name = input.name.trim();
    }
  }

  if (isCreate || has(input, "url")) {
    const result = validateMonitorUrl(input.url);
    if (result.error) errors.push(result.error);
    else data.url = result.url;
  }

  if (has(input, "method")) {
    const method = typeof input.method === "string" ? input.method.trim().toUpperCase() : "";
    if (!HTTP_METHODS.includes(method)) {
      errors.push(`Method must be one of ${HTTP_METHODS.join(", ")}`);
    } else {
      data.method = method;
    }
  }

  if (has(input, "headers")) {
    const headers = validateHeaders(input.headers, errors);
    if (headers) data.headers = headers;
  }

  if (has(input, "body")) {
    if (input.body === null || input.body === "") {
      data.body = null;
    } else if (typeof input.body !== "string") {
      errors.push("Body must be a string (send JSON as a string)");
    } else if (input.body.length > 10000) {
      errors.push("Body must be at most 10000 characters");
    } else {
      data.body = input.body;
    }
  }

  if (has(input, "expectedStatus")) {
    if (!isInt(input.expectedStatus) || input.expectedStatus < 100 || input.expectedStatus > 599) {
      errors.push("Expected status must be a whole number between 100 and 599");
    } else {
      data.expectedStatus = input.expectedStatus;
    }
  }

  if (has(input, "intervalSeconds")) {
    const v = input.intervalSeconds;
    if (!isInt(v) || v > MAX_INTERVAL_SECONDS) {
      errors.push(`Interval must be a whole number of seconds, at most ${MAX_INTERVAL_SECONDS}`);
    } else if (v < plan.minIntervalSeconds) {
      errors.push(`Your plan allows checks no more often than every ${plan.minIntervalSeconds} seconds`);
    } else {
      data.intervalSeconds = v;
    }
  }

  if (has(input, "timeoutSeconds")) {
    const v = input.timeoutSeconds;
    if (!isInt(v) || v < 1) {
      errors.push("Timeout must be a whole number of seconds, at least 1");
    } else if (v > plan.maxTimeoutSeconds) {
      errors.push(`Your plan allows a timeout of at most ${plan.maxTimeoutSeconds} seconds`);
    } else {
      data.timeoutSeconds = v;
    }
  }

  if (has(input, "status")) {
    if (!["ACTIVE", "PAUSED"].includes(input.status)) {
      errors.push("Status must be ACTIVE or PAUSED");
    } else {
      data.status = input.status;
    }
  }

  if (errors.length) return { errors };

  // Cross-field rules on the final state
  const merged = {
    method: "GET",
    body: null,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    ...(existing ? existing.toObject() : {}),
    ...data,
  };

  if (merged.body && !METHODS_WITH_BODY.includes(merged.method)) {
    errors.push(`A request body can't be sent with ${merged.method}. Remove the body or change the method`);
  }
  if (merged.timeoutSeconds >= merged.intervalSeconds) {
    errors.push("Timeout must be shorter than the check interval");
  }

  if (isCreate) {
    // Fill defaults here so they're checked against the plan like any other value
    data.method ??= merged.method;
    data.intervalSeconds ??= Math.max(DEFAULT_INTERVAL_SECONDS, plan.minIntervalSeconds);
    data.timeoutSeconds ??= Math.min(DEFAULT_TIMEOUT_SECONDS, plan.maxTimeoutSeconds);
  }

  return errors.length ? { errors } : { data };
};
