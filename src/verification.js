const crypto = require('crypto');
const dayjs = require('dayjs');

// ═══════════════════════════════════════════════════════════════════
// ROTATING PIN (changes every 5 minutes)
// ═══════════════════════════════════════════════════════════════════

const PIN_SECRET = process.env.PIN_SECRET || crypto.randomBytes(16).toString('hex');
const PIN_ROTATION_MIN = parseInt(process.env.PIN_ROTATION_MIN || '5', 10);

/**
 * Generate current PIN based on time slot.
 * Same PIN for all users within the same 5-min window.
 */
const getCurrentPin = () => {
  const slot = Math.floor(Date.now() / (PIN_ROTATION_MIN * 60 * 1000));
  const hash = crypto.createHmac('sha256', PIN_SECRET)
    .update(String(slot))
    .digest('hex');
  // Take first 4 numeric digits from hash
  const digits = hash.replace(/[^0-9]/g, '');
  return digits.slice(0, 4).padStart(4, '0');
};

/**
 * Verify PIN — accept current and previous slot (grace period)
 */
const verifyPin = (input) => {
  const current = getCurrentPin();
  // Also accept previous slot for grace period
  const prevSlot = Math.floor(Date.now() / (PIN_ROTATION_MIN * 60 * 1000)) - 1;
  const prevHash = crypto.createHmac('sha256', PIN_SECRET)
    .update(String(prevSlot))
    .digest('hex');
  const prevDigits = prevHash.replace(/[^0-9]/g, '');
  const prevPin = prevDigits.slice(0, 4).padStart(4, '0');

  return input === current || input === prevPin;
};

/**
 * Seconds until next PIN rotation
 */
const getSecondsUntilRotation = () => {
  const msPerSlot = PIN_ROTATION_MIN * 60 * 1000;
  const elapsed = Date.now() % msPerSlot;
  return Math.ceil((msPerSlot - elapsed) / 1000);
};

// ═══════════════════════════════════════════════════════════════════
// TEMPORARY TOKENS (one-time use, expire in 2 min)
// ═══════════════════════════════════════════════════════════════════

// Map<token, { slackId, createdAt, used }>
const tokenStore = new Map();
const TOKEN_TTL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Create a temporary token for a user
 */
const createToken = (slackId) => {
  // Clean expired tokens
  const now = Date.now();
  for (const [key, val] of tokenStore) {
    if (now - val.createdAt > TOKEN_TTL_MS) tokenStore.delete(key);
  }

  const token = crypto.randomBytes(24).toString('hex');
  tokenStore.set(token, { slackId, createdAt: now, used: false });
  return token;
};

/**
 * Validate and consume a token. Returns slackId or null.
 */
const consumeToken = (token) => {
  const entry = tokenStore.get(token);
  if (!entry) return null;
  if (entry.used) return null;
  if (Date.now() - entry.createdAt > TOKEN_TTL_MS) {
    tokenStore.delete(token);
    return null;
  }
  entry.used = true;
  return entry.slackId;
};

/**
 * Peek at a token without consuming it. Returns slackId or null.
 */
const peekToken = (token) => {
  const entry = tokenStore.get(token);
  if (!entry) return null;
  if (entry.used) return null;
  if (Date.now() - entry.createdAt > TOKEN_TTL_MS) return null;
  return entry.slackId;
};

// ═══════════════════════════════════════════════════════════════════
// USER-AGENT DETECTION
// ═══════════════════════════════════════════════════════════════════

const MOBILE_PATTERNS = [
  /Android/i,
  /iPhone/i,
  /iPad/i,
  /iPod/i,
  /webOS/i,
  /BlackBerry/i,
  /Windows Phone/i,
  /Opera Mini/i,
  /IEMobile/i,
  /Mobile Safari/i,
  /Silk/i,
];

/**
 * Returns true if User-Agent looks like a mobile device
 */
const isMobileUA = (userAgent) => {
  if (!userAgent) return true; // No UA = reject
  return MOBILE_PATTERNS.some(pattern => pattern.test(userAgent));
};

module.exports = {
  getCurrentPin,
  verifyPin,
  getSecondsUntilRotation,
  PIN_ROTATION_MIN,
  createToken,
  consumeToken,
  peekToken,
  isMobileUA,
};
