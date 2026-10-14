import crypto from "crypto";

const LOWER = "abcdefghijkmnpqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%&*?";
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

const pick = (chars) => chars[crypto.randomInt(chars.length)];

// Cryptographically random password with at least one of each character class.
// Look-alike characters (0/O, 1/l/I) are left out so it's easy to type from an email.
const generatePassword = (length = 12) => {
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];

  while (chars.length < length) {
    chars.push(pick(ALL));
  }

  // Fisher–Yates shuffle so the guaranteed characters aren't always first
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join("");
};

export default generatePassword;
