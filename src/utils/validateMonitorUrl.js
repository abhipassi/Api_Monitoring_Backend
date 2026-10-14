import net from "net";

// Monitors make the server call user-supplied URLs, so addresses that point back
// into our own network (localhost, private ranges, cloud metadata) are refused.
// Set ALLOW_PRIVATE_MONITOR_URLS=true to allow them, e.g. when testing locally.
//
// This only inspects the URL as typed. A public hostname can still resolve to a
// private address (DNS rebinding), so monitorCheckService also verifies the IP it
// actually connects to (createGuardedLookup).

const isPrivateIPv4 = (ip) => {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // IETF protocol assignments / TEST-NET
    a >= 224 // multicast, reserved, broadcast
  );
};

const expandIPv6 = (ip) => {
  const [head, tail] = ip.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  return [...headGroups, ...Array(ip.includes("::") ? missing : 0).fill("0"), ...tailGroups].map(
    (g) => parseInt(g || "0", 16)
  );
};

const groupsToIPv4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

const isPrivateIPv6 = (ip) => {
  const g = expandIPv6(ip);
  if (g.length !== 8 || g.some(Number.isNaN)) return true; // unparsable: refuse

  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::/96)
  const embedded = groupsToIPv4(g[6], g[7]);
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return isPrivateIPv4(embedded);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isPrivateIPv4(embedded);
  }

  return false;
};

export const privateUrlsAllowed = () => process.env.ALLOW_PRIVATE_MONITOR_URLS === "true";

// True for any IP that points into a private/internal network. Anything that isn't a
// valid IP counts as private, so a malformed value can never slip through.
export const isPrivateAddress = (ip) => {
  const bare = String(ip).split("%")[0]; // drop an IPv6 zone id such as fe80::1%en0
  const version = net.isIP(bare);
  if (version === 4) return isPrivateIPv4(bare);
  if (version === 6) return isPrivateIPv6(bare);
  return true;
};

const BLOCKED_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain"];

const isPrivateHost = (hostname) => {
  const host = hostname.toLowerCase().replace(/\.$/, "");

  if (host === "localhost" || BLOCKED_HOSTNAME_SUFFIXES.some((s) => host.endsWith(s))) {
    return true;
  }

  const bare = host.replace(/^\[|\]$/g, "");
  const version = net.isIP(bare);
  if (version === 4) return isPrivateIPv4(bare);
  if (version === 6) return isPrivateIPv6(bare);

  return false;
};

// Returns { url } with the normalised URL, or { error } with a message for the user
export const validateMonitorUrl = (raw) => {
  if (typeof raw !== "string" || !raw.trim()) {
    return { error: "URL is required" };
  }

  const trimmed = raw.trim();

  if (trimmed.length > 2048) {
    return { error: "URL must be at most 2048 characters" };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: "URL is not valid. Include http:// or https://" };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { error: "URL must start with http:// or https://" };
  }

  if (parsed.username || parsed.password) {
    return {
      error: "URL must not contain a username or password. Use the headers field for credentials",
    };
  }

  if (!privateUrlsAllowed() && isPrivateHost(parsed.hostname)) {
    return { error: "URL must point to a public host (localhost and private network addresses are not allowed)" };
  }

  return { url: parsed.toString() };
};
