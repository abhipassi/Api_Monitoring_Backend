import { rateLimit, ipKeyGenerator } from "express-rate-limit";

const MINUTE = 60 * 1000;

const tooManyRequests = (message) => (req, res) =>
  res.status(429).json({ success: false, message });

const baseOptions = {
  standardHeaders: "draft-7", // RateLimit-* headers, plus Retry-After when blocked
  legacyHeaders: false,
  // Automated tests make far more requests than a person would. Never set NODE_ENV=test in production.
  skip: () => process.env.NODE_ENV === "test",
};

// Client IP plus the email being targeted, so one attacker can't hammer a single
// account from many addresses, and one shared office IP isn't locked out by a typo.
const ipAndEmailKey = (req) => {
  const email =
    typeof req.body?.email === "string"
      ? req.body.email.trim().toLowerCase()
      : "";
  return `${ipKeyGenerator(req.ip)}|${email}`;
};

// Password guessing against one account. Successful logins don't count.
export const loginAccountLimiter = rateLimit({
  ...baseOptions,
  windowMs: 15 * MINUTE,
  limit: 5,
  skipSuccessfulRequests: true,
  keyGenerator: ipAndEmailKey,
  handler: tooManyRequests(
    "Too many failed login attempts. Please try again in 15 minutes."
  ),
});

// Password spraying: one IP trying many different accounts
export const loginIpLimiter = rateLimit({
  ...baseOptions,
  windowMs: 15 * MINUTE,
  limit: 30,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: tooManyRequests(
    "Too many failed login attempts. Please try again later."
  ),
});

// Each request can send an email, so keep this tight
export const forgotPasswordLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * MINUTE,
  limit: 5,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: tooManyRequests(
    "Too many password reset requests. Please try again in an hour."
  ),
});

// The same email can't be targeted over and over from rotating IPs
export const forgotPasswordEmailLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * MINUTE,
  limit: 3,
  keyGenerator: ipAndEmailKey,
  handler: tooManyRequests(
    "Too many password reset requests. Please try again in an hour."
  ),
});

// Guessing reset tokens (they are 256-bit, so this is mostly defence in depth)
export const resetPasswordLimiter = rateLimit({
  ...baseOptions,
  windowMs: 15 * MINUTE,
  limit: 10,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: tooManyRequests(
    "Too many attempts. Please try again in 15 minutes."
  ),
});

// Registration sends an email and creates records
export const registerLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * MINUTE,
  limit: 5,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: tooManyRequests(
    "Too many sign-up attempts. Please try again in an hour."
  ),
});

// Failed current-password checks on an authenticated session
export const changePasswordLimiter = rateLimit({
  ...baseOptions,
  windowMs: 15 * MINUTE,
  limit: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: tooManyRequests(
    "Too many attempts. Please try again in 15 minutes."
  ),
});

// For routes behind login: counted per signed-in user instead of per IP
const userKey = (req) => String(req.user?.id ?? ipKeyGenerator(req.ip));

// Each call sends an email
export const teamEmailLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * MINUTE,
  limit: 20,
  keyGenerator: userKey,
  handler: tooManyRequests("Too many team invitations. Please try again later."),
});

export const planRequestLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * MINUTE,
  limit: 5,
  keyGenerator: userKey,
  handler: tooManyRequests("Too many plan requests. Please try again later."),
});
