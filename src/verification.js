const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════════
// TOKEN + PIN STORE
// Each token gets a unique 4-digit PIN for that user
// ═══════════════════════════════════════════════════════════════════

// Map<token, { slackId, pin, createdAt, used }>
const tokenStore = new Map();
const TOKEN_TTL_MS = 2 * 60 * 1000; // 2 minutes

const generatePin = () => {
  return String(Math.floor(1000 + Math.random() * 9000)); // 4 digits, never starts with 0
};

const createToken = (slackId) => {
  // Clean expired
  const now = Date.now();
  for (const [key, val] of tokenStore) {
    if (now - val.createdAt > TOKEN_TTL_MS) tokenStore.delete(key);
  }

  const token = crypto.randomBytes(24).toString('hex');
  const pin = generatePin();
  tokenStore.set(token, { slackId, pin, createdAt: now, used: false });
  return { token, pin };
};

/** Peek without consuming. Returns { slackId, pin } or null */
const peekToken = (token) => {
  const entry = tokenStore.get(token);
  if (!entry || entry.used || Date.now() - entry.createdAt > TOKEN_TTL_MS) return null;
  return { slackId: entry.slackId, pin: entry.pin };
};

/** Consume token + verify PIN. Returns slackId or null */
const consumeToken = (token, inputPin) => {
  const entry = tokenStore.get(token);
  if (!entry) return null;
  if (entry.used) return null;
  if (Date.now() - entry.createdAt > TOKEN_TTL_MS) { tokenStore.delete(token); return null; }
  if (entry.pin !== inputPin) return null;

  entry.used = true;
  return entry.slackId;
};

// ═══════════════════════════════════════════════════════════════════
// USER-AGENT DETECTION
// ═══════════════════════════════════════════════════════════════════

const MOBILE_PATTERNS = [
  /Android/i, /iPhone/i, /iPad/i, /iPod/i, /webOS/i,
  /BlackBerry/i, /Windows Phone/i, /Opera Mini/i,
  /IEMobile/i, /Mobile Safari/i, /Silk/i,
];

const isMobileUA = (ua) => {
  if (!ua) return true;
  return MOBILE_PATTERNS.some(p => p.test(ua));
};

module.exports = { createToken, peekToken, consumeToken, isMobileUA };
