import dns from "dns";
import http from "http";
import https from "https";

import {
  isPrivateAddress,
  privateUrlsAllowed,
  validateMonitorUrl,
} from "../utils/validateMonitorUrl.js";

// Response bodies are only read to time the request; stop after this many bytes
const MAX_BODY_BYTES = 1024 * 1024;

const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
  "EPROTO",
]);

const classifyError = (error) => {
  const code = error?.code || "";

  if (code === "EBLOCKEDADDRESS") return "BLOCKED_ADDRESS";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NODATA") return "DNS_ERROR";
  if (code === "ECONNREFUSED") return "CONNECTION_REFUSED";
  if (code === "ECONNRESET" || code === "EPIPE") return "CONNECTION_RESET";
  if (code === "ETIMEDOUT") return "TIMEOUT";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "UNREACHABLE";
  if (TLS_ERROR_CODES.has(code) || code.startsWith("ERR_SSL") || code.startsWith("ERR_TLS")) {
    return "TLS_ERROR";
  }
  return "NETWORK_ERROR";
};

// Wraps the DNS lookup used for the connection so the address that is really dialled
// is checked, not just the hostname as typed. This is what stops a public name that
// resolves (or is later re-pointed) to 127.0.0.1 / 10.x / 169.254.169.254.
// `resolve` is injectable for tests.
export const createGuardedLookup = (resolve = dns.lookup) => (hostname, options, callback) => {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }

  resolve(hostname, options, (error, address, family) => {
    if (error) return callback(error);

    const addresses = Array.isArray(address) ? address : [{ address, family }];

    if (!privateUrlsAllowed() && addresses.some((a) => isPrivateAddress(a.address))) {
      const blocked = new Error("Host resolves to a private or internal address");
      blocked.code = "EBLOCKEDADDRESS";
      return callback(blocked);
    }

    return callback(null, address, family);
  });
};

const buildHeaders = (monitor) => {
  const headers = {};
  for (const { name, value } of monitor.headers || []) headers[name] = value;

  const has = (name) => Object.keys(headers).some((k) => k.toLowerCase() === name);
  if (!has("user-agent")) {
    headers["User-Agent"] = `${process.env.APP_NAME || "API Monitoring"}-Monitor/1.0`;
  }
  if (!has("accept")) headers.Accept = "*/*";

  if (monitor.body) headers["Content-Length"] = Buffer.byteLength(monitor.body);

  return headers;
};

// Performs one check and always resolves (never rejects) with:
//   { success, statusCode, responseTimeMs, checkedAt, error: { type, message } | null }
// Redirects are not followed: a 3xx is reported as the status the server returned.
// Certificate errors count as failures.
export const runCheck = (monitor, { lookup = createGuardedLookup() } = {}) =>
  new Promise((resolve) => {
    const checkedAt = new Date();
    const started = performance.now();
    let settled = false;
    let timer;
    let request;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        success: false,
        statusCode: null,
        error: null,
        ...result,
        responseTimeMs: Math.round(performance.now() - started),
        checkedAt,
      });
    };

    const fail = (type, message, statusCode = null) =>
      finish({ success: false, statusCode, error: { type, message: String(message).slice(0, 300) } });

    // Re-validate every time: stored data may predate a rule, or settings may have changed
    const validated = validateMonitorUrl(monitor.url);
    if (validated.error) return fail("INVALID_URL", validated.error);

    const url = new URL(validated.url);
    const transport = url.protocol === "https:" ? https : http;

    timer = setTimeout(() => {
      request?.destroy();
      fail("TIMEOUT", `No response within ${monitor.timeoutSeconds} seconds`);
    }, monitor.timeoutSeconds * 1000);

    const complete = (statusCode) => {
      if (statusCode === monitor.expectedStatus) {
        finish({ success: true, statusCode });
      } else {
        fail("UNEXPECTED_STATUS", `Expected ${monitor.expectedStatus} but got ${statusCode}`, statusCode);
      }
    };

    try {
      request = transport.request(
        url,
        {
          method: monitor.method,
          headers: buildHeaders(monitor),
          lookup,
          agent: false, // fresh connection per check, so each one measures a real connect
        },
        (response) => {
          const statusCode = response.statusCode;
          let received = 0;

          response.on("data", (chunk) => {
            received += chunk.length;
            if (received > MAX_BODY_BYTES) {
              response.destroy();
              complete(statusCode);
            }
          });
          response.on("end", () => complete(statusCode));
          response.on("error", (error) => fail(classifyError(error), error.message, statusCode));
          response.on("close", () => {
            if (!response.complete) fail("CONNECTION_RESET", "Connection closed before the response finished", statusCode);
          });
        }
      );

      request.on("error", (error) => fail(classifyError(error), error.message));

      if (monitor.body) request.write(monitor.body);
      request.end();
    } catch (error) {
      fail("NETWORK_ERROR", error.message);
    }
  });
