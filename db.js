// Persistances SQLite : reglages, users/assistants/sessions/reset, conversations Mistral, historique.
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || (process.env.VERCEL ? '/tmp/bot.db' : path.join(__dirname, 'bot.db'));
try { require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch {}
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS conversations (
  jid TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  model TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_jid ON messages(jid, id);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS assistants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Principal',
  model TEXT NOT NULL DEFAULT 'mistral-medium-latest',
  instructions TEXT NOT NULL DEFAULT '',
  use_conversations INTEGER NOT NULL DEFAULT 1,
  history_limit INTEGER NOT NULL DEFAULT 20,
  api_key TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reset_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

// --- Migration v2 : conversations/messages scopes par assistant ---
function hasCol(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}
if (!db.prepare("SELECT value FROM settings WHERE key='schema_v2'").get()) {
  const tx = db.transaction(() => {
    if (!hasCol('conversations', 'assistant_id')) {
      db.exec(`
        CREATE TABLE conversations_new(
          assistant_id INTEGER NOT NULL DEFAULT 0,
          jid TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          model TEXT NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY(assistant_id, jid)
        );
        INSERT OR IGNORE INTO conversations_new(assistant_id, jid, conversation_id, model, updated_at)
          SELECT 0, jid, conversation_id, model, updated_at FROM conversations;
        DROP TABLE conversations;
        ALTER TABLE conversations_new RENAME TO conversations;
      `);
    }
    if (!hasCol('messages', 'assistant_id')) {
      db.exec(`
        ALTER TABLE messages ADD COLUMN assistant_id INTEGER NOT NULL DEFAULT 0;
        DROP INDEX IF EXISTS idx_messages_jid;
        CREATE INDEX IF NOT EXISTS idx_messages_aid_jid ON messages(assistant_id, jid, id);
      `);
    }
    db.prepare("INSERT INTO settings(key,value) VALUES('schema_v2','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  });
  tx();
}
// --- Migration v3 : clé API propre à chaque assistant (toujours hors garde v2) ---
if (!hasCol('assistants', 'api_key')) {
  db.exec(`ALTER TABLE assistants ADD COLUMN api_key TEXT NOT NULL DEFAULT ''`);
}
// --- Migration v4 : rôle admin/user. Premier compte = admin ---
if (!hasCol('users', 'role')) {
  db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`);
}
if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get()) {
  db.exec(`UPDATE users SET role = 'admin' WHERE id = (SELECT MIN(id) FROM users)`);
}

const stmts = {
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare(`INSERT INTO settings(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`),
  delSetting: db.prepare('DELETE FROM settings WHERE key = ?'),
  getConv: db.prepare('SELECT conversation_id, model FROM conversations WHERE assistant_id = ? AND jid = ?'),
  setConv: db.prepare(`INSERT INTO conversations(assistant_id, jid, conversation_id, model) VALUES(?, ?, ?, ?)
    ON CONFLICT(assistant_id, jid) DO UPDATE SET conversation_id = excluded.conversation_id, model = excluded.model, updated_at = CURRENT_TIMESTAMP`),
  delConv: db.prepare('DELETE FROM conversations WHERE assistant_id = ? AND jid = ?'),
  delConvsAid: db.prepare('DELETE FROM conversations WHERE assistant_id = ?'),
  addMsg: db.prepare('INSERT INTO messages(assistant_id, jid, role, content) VALUES(?, ?, ?, ?)'),
  history: db.prepare('SELECT role, content, created_at FROM messages WHERE assistant_id = ? AND jid = ? ORDER BY id DESC LIMIT ?'),
  contacts: db.prepare(`SELECT jid, MAX(id) AS last_id FROM messages WHERE assistant_id = ? GROUP BY jid ORDER BY last_id DESC LIMIT ?`),
  lastMsg: db.prepare('SELECT role, content, created_at FROM messages WHERE assistant_id = ? AND jid = ? ORDER BY id DESC LIMIT 1'),
  clearMsgs: db.prepare('DELETE FROM messages WHERE assistant_id = ? AND jid = ?'),
  resetAllConvs: db.prepare('DELETE FROM conversations'),
  // users
  createUser: db.prepare('INSERT INTO users(login, name, phone, password_hash, role) VALUES(?, ?, ?, ?, ?)'),
  userByLogin: db.prepare('SELECT * FROM users WHERE login = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  setUserPass: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  // assistants
  createAsst: db.prepare('INSERT INTO assistants(user_id, name, model, instructions, use_conversations, history_limit, api_key, is_active) VALUES(?, ?, ?, ?, ?, ?, ?, ?)'),
  listAsst: db.prepare('SELECT * FROM assistants WHERE user_id = ? ORDER BY id'),
  getAsst: db.prepare('SELECT * FROM assistants WHERE id = ?'),
  updateAsst: db.prepare('UPDATE assistants SET name = ?, model = ?, instructions = ?, use_conversations = ?, history_limit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'),
  setAsstKey: db.prepare('UPDATE assistants SET api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'),
  deleteAsst: db.prepare('DELETE FROM assistants WHERE id = ?'),
  clearActive: db.prepare('UPDATE assistants SET is_active = 0'),
  setActive: db.prepare('UPDATE assistants SET is_active = 1 WHERE id = ?'),
  getActive: db.prepare(`SELECT a.*, u.login AS owner_login, u.name AS owner_name FROM assistants a JOIN users u ON u.id = a.user_id WHERE a.is_active = 1 LIMIT 1`),
  countAsst: db.prepare('SELECT COUNT(*) AS n FROM assistants WHERE user_id = ?'),
  // sessions
  createSess: db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES(?, ?, ?)'),
  hasAdmin: db.prepare("SELECT 1 AS ok FROM users WHERE role = 'admin' LIMIT 1"),
  getSess: db.prepare('SELECT s.*, u.login, u.name AS user_name, u.role AS user_role FROM sessions s JOIN users u ON u.id = s.user_id WHERE token = ?'),
  delSess: db.prepare('DELETE FROM sessions WHERE token = ?'),
  delUserSess: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  // reset codes
  createReset: db.prepare('INSERT INTO reset_codes(user_id, code, expires_at) VALUES(?, ?, ?)'),
  getReset: db.prepare('SELECT * FROM reset_codes WHERE user_id = ? AND code = ? AND used = 0 ORDER BY id DESC LIMIT 1'),
  markReset: db.prepare('UPDATE reset_codes SET used = 1 WHERE id = ?'),
  invalidateResets: db.prepare('UPDATE reset_codes SET used = 1 WHERE user_id = ? AND used = 0'),
};

module.exports = {
  getSetting: (k, fallback = '') => stmts.getSetting.get(k)?.value ?? fallback,
  setSetting: (k, v) => stmts.setSetting.run(k, String(v)),
  delSetting: (k) => stmts.delSetting.run(k),
  getConv: (aid, jid) => stmts.getConv.get(aid, jid) || null,
  setConv: (aid, jid, convId, model) => stmts.setConv.run(aid, jid, convId, model),
  resetConv: (aid, jid) => { stmts.delConv.run(aid, jid); },
  resetAssistantConvs: (aid) => stmts.delConvsAid.run(aid).changes,
  resetAllConvs: () => stmts.resetAllConvs.run().changes,
  clearHistory: (aid, jid) => { stmts.clearMsgs.run(aid, jid); stmts.delConv.run(aid, jid); },
  addMsg: (aid, jid, role, content) => stmts.addMsg.run(aid, jid, role, content),
  getHistory: (aid, jid, limit = 20) => stmts.history.all(aid, jid, limit).reverse(),
  contacts: (aid, limit = 30) => stmts.contacts.all(aid, limit).map(c => ({ jid: c.jid, ...(stmts.lastMsg.get(aid, c.jid) || {}) })),
  // users / assistants / sessions / reset
  createUser: (login, name, phone, hash, role = 'user') => stmts.createUser.run(login, name, phone, hash, role),
  hasAdmin: () => !!stmts.hasAdmin.get(),
  getUserByLogin: (login) => stmts.userByLogin.get(login) || null,
  getUserById: (id) => stmts.userById.get(id) || null,
  setUserPassword: (id, hash) => stmts.setUserPass.run(id, hash),
  createAssistant: (u) => stmts.createAsst.run(u.user_id, u.name, u.model, u.instructions, u.use_conversations ? 1 : 0, u.history_limit, u.api_key || '', u.is_active ? 1 : 0),
  listAssistants: (uid) => stmts.listAsst.all(uid),
  getAssistant: (id) => stmts.getAsst.get(id) || null,
  updateAssistant: (id, f) => stmts.updateAsst.run(f.name, f.model, f.instructions, f.use_conversations ? 1 : 0, f.history_limit, id),
  setAssistantKey: (id, key) => stmts.setAsstKey.run(key, id),
  deleteAssistant: (id) => stmts.deleteAsst.run(id),
  setActiveAssistant: (id) => { stmts.clearActive.run(); stmts.setActive.run(id); },
  getActiveAssistant: () => stmts.getActive.get() || null,
  countAssistants: (uid) => stmts.countAsst.get(uid).n,
  createSession: (token, uid, exp) => stmts.createSess.run(token, uid, exp),
  getSession: (token) => stmts.getSess.get(token) || null,
  deleteSession: (token) => stmts.delSess.run(token),
  createResetCode: (uid, code, exp) => { stmts.invalidateResets.run(uid); return stmts.createReset.run(uid, code, exp); },
  getValidReset: (uid, code) => stmts.getReset.get(uid, code) || null,
  markResetUsed: (id) => stmts.markReset.run(id),
};
