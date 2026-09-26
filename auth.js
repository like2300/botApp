// Auth : hash scrypt + tokens de session + middleware Express.
const crypto = require('crypto');
const db = require('./db');

const SESSION_DAYS = 7;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  try {
    const [algo, salt, hash] = String(stored).split(':');
    if (algo !== 'scrypt' || !salt || !hash) return false;
    const h = crypto.scryptSync(password, salt, 64).toString('hex');
    const a = Buffer.from(h, 'hex'), b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
function newToken() { return crypto.randomBytes(32).toString('hex'); }

function normalizePhone(phone) {
  return String(phone || '').replace(/[^0-9]/g, '').replace(/^0+/, '');
}
function normalizeLogin(login) { return String(login || '').trim().toLowerCase(); }

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, login: u.login, name: u.name, phone: u.phone, role: u.role || 'user', created_at: u.created_at };
}

// Middleware : Authorization: Bearer <token>
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'Non connecte' });
  const s = db.getSession(token);
  if (!s || s.expires_at < Date.now()) {
    if (s) db.deleteSession(token);
    return res.status(401).json({ error: 'Session expiree' });
  }
  req.user = { id: s.user_id, login: s.login, name: s.user_name, role: s.user_role || 'user' };
  req.token = token;
  next();
}

// Réservé à l'admin (à chaîner après requireAuth)
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  return res.status(403).json({ error: 'Réservé à l administrateur.' });
}

module.exports = { hashPassword, verifyPassword, newToken, normalizePhone, normalizeLogin, publicUser, requireAuth, requireAdmin, SESSION_DAYS };
