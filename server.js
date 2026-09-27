const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const auth = require('./auth');

const app = express();
app.set('trust proxy', 1); // cookies sécurisés derrière le proxy HTTPS (Railway/Render)
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Healthcheck pour l'hébergeur (Railway/Render/Docker)
app.get('/api/health', (req, res) => {
  const n = [...waConnected.values()].filter(Boolean).length;
  res.json({ ok: true, whatsapp: `${n} compte(s) connecte(s)`, uptime: Math.round(process.uptime()) });
});

// ---------- CONFIG : SQLite d'abord, env ensuite, config.json (migration une fois) ----------
let CONFIG = {
  mistralModel: 'mistral-medium-latest',
  systemInstructions: 'Tu es un assistant virtuel utile, poli et court dans tes reponses sur WhatsApp.',
  useConversationsApi: true, // true = /v1/conversations avec suivi serveur + miroir SQLite ; false = /chat/completions avec historique SQLite
  historyLimit: 20,
  phoneNumber: '',
  minDelaySec: 4,
  maxDelaySec: 9,
  maxPerMinute: 8,
  cooldownPerUserSec: 10,
  ignoreGroups: true
};
function loadConfig() {
  for (const k of Object.keys(CONFIG)) {
    const v = db.getSetting('cfg_' + k, null);
    if (v !== null && v !== undefined && v !== '') {
      if (typeof CONFIG[k] === 'boolean') CONFIG[k] = v === 'true';
      else if (typeof CONFIG[k] === 'number') CONFIG[k] = Number(v);
      else CONFIG[k] = v;
    }
  }
  // Migration unique depuis l'ancien config.json (cle en clair -> SQLite, puis on efface la cle du json)
  try {
    if (fs.existsSync('./config.json')) {
      const old = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
      if (old.mistralApiKey && !db.getSetting('mistral_key', '')) {
        db.setSetting('mistral_key', old.mistralApiKey);
        console.log('🔐 Cle Mistral migree de config.json vers SQLite.');
      }
      for (const k of Object.keys(CONFIG)) {
        if (old[k] !== undefined && db.getSetting('cfg_' + k, null) === null) db.setSetting('cfg_' + k, old[k]);
      }
      delete old.mistralApiKey;
      fs.writeFileSync('./config.json', JSON.stringify(old, null, 2));
    }
  } catch {}
}
loadConfig();
function saveConfig() { for (const k of Object.keys(CONFIG)) db.setSetting('cfg_' + k, CONFIG[k]); }

// ---------- Config PAR COMPTE : chaque compte a ses reglages (clé, modèle, prompt, délais...)
// Priorité : cfg_<uid>_<clé> > cfg_<clé> (global) > défaut. La config globale reste le défaut.
function userCfg(uid) {
  const out = {};
  for (const k of Object.keys(CONFIG)) {
    let v = uid ? db.getSetting(`cfg_${uid}_${k}`, null) : null;
    if (v === null || v === undefined || v === '') v = db.getSetting('cfg_' + k, null);
    if (v === null || v === undefined || v === '') v = CONFIG[k];
    if (typeof CONFIG[k] === 'boolean') out[k] = (v === true || v === 'true');
    else if (typeof CONFIG[k] === 'number') out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}
function saveUserConfig(uid, obj) {
  for (const k of Object.keys(obj)) {
    if (Object.prototype.hasOwnProperty.call(CONFIG, k)) db.setSetting(`cfg_${uid}_${k}`, obj[k]);
  }
}

// ---------- Cle API : env > compte > globale (SQLite). Jamais exposee en clair, jamais loggee ----------
function getApiKey(uid) {
  if (process.env.MISTRAL_API_KEY) return process.env.MISTRAL_API_KEY;
  if (uid) { const k = db.getSetting(`cfg_${uid}_mistral_key`, ''); if (k) return k; }
  return db.getSetting('mistral_key', '');
}
function maskKey(k) { return k ? '***' + k.slice(-4) : ''; }

// ---------- Multi-comptes : UN bot WhatsApp par user (chaque compte = son numero + son prompt) ----------
// socks : userId -> socket Baileys ; waConnected : userId -> bool
let socks = new Map();
let waConnected = new Map();
let messageQueue = []; // items { uid, from, text }
let processing = false;
let rlPerUser = new Map(); // uid -> { sent: [], lastReply: {} }
function rl(uid) {
  let r = rlPerUser.get(uid);
  if (!r) { r = { sent: [], lastReply: {} }; rlPerUser.set(uid, r); }
  return r;
}
function room(uid) { return 'user_' + uid; }
function userSock(uid) { const e = socks.get(uid); return e ? e.sock : null; }
function userConnected(uid) { return !!waConnected.get(uid); }
function firstSock() { for (const e of socks.values()) if (e.sock) return e.sock; return null; }
// Dossier session WhatsApp du compte (migration auto de l'ancien dossier unique vers user_1)
const AUTH_BASE = process.env.AUTH_DIR || 'auth_info';
function authDirFor(uid) { return path.join(AUTH_BASE, 'user_' + uid); }
function migrateLegacyAuth() {
  try {
    const legacyCreds = path.join(AUTH_BASE, 'creds.json');
    const u1dir = path.join(AUTH_BASE, 'user_1');
    if (fs.existsSync(legacyCreds) && !fs.existsSync(path.join(u1dir, 'creds.json'))) {
      fs.mkdirSync(u1dir, { recursive: true });
      for (const f of fs.readdirSync(AUTH_BASE)) {
        const src = path.join(AUTH_BASE, f);
        if (fs.statSync(src).isFile() && f.endsWith('.json')) fs.renameSync(src, path.join(u1dir, f));
      }
      log('📦 Session WhatsApp existante migrée vers le compte #1 (re-scan inutile).');
    }
  } catch (e) { log('⚠️ Migration auth_info : ' + e.message); }
}
let logs = [];
function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  logs.push(line); if (logs.length > 200) logs.shift();
  io.emit('log', line);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ---------- Format WhatsApp : l'IA parle Markdown (**gras**, ## titres, [liens](url), - listes)
// WhatsApp n'affiche que *gras*, _italique_, `code`, • listes => on convertit avant envoi ----------
const FORMAT_SUFFIX = "\n\n[Format obligatoire : texte compatible WhatsApp uniquement. Gras avec *texte* (UN seul asterisque de chaque cote). Italique avec _texte_. Listes avec • ou -. Titres en *Titre*. Emojis OK. Interdit : **doubles asterisques**, ## titres, [texte](lien) — ecris plutot 'texte : url'.]";
function toWhatsApp(text) {
  if (!text) return text;
  const blocks = [];
  text = text.replace(/```[\s\S]*?```/g, m => { blocks.push(m); return `\u0000${blocks.length - 1}\u0000`; });
  text = text.replace(/\[([^\]]+)\]\((https?[^)\s]+)\)/g, '$1 : $2'); // [texte](url) -> texte : url
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  text = text.replace(/^\s*#{1,6}\s+(.+?)\s*$/gm, '*$1*');            // ## Titre -> *Titre*
  text = text.replace(/\*\*([^*]+?)\*\*/g, '*$1*');                  // **gras** -> *gras*
  text = text.replace(/__([^_]+?)__/g, '*$1*');                      // __gras__ -> *gras*
  text = text.replace(/\*[ \t]+([^*\n]+?)[ \t]+\*/g, '*$1*');                // * texte * -> *texte* (meme ligne)
  text = text.replace(/\*\*/g, '*'); // ** restants -> *
  text = text.replace(/^(\s*)[-*]\s+/gm, '$1• ');                    // - item -> • item
  text = text.replace(/`([^`\n]+)`/g, '`$1`');
  text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

async function mistralFetch(url, body, key) {
  const k = key || getApiKey(); // clé de l'assistant, sinon clé globale (SQLite/ENV)
  if (!k) { log('⚠️ Cle Mistral manquante (ni assistant ni globale).'); return null; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + k },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, data };
  } catch (e) {
    clearTimeout(timer);
    log('❌ Erreur reseau Mistral : ' + e.message);
    return null;
  }
}

// Extrait le texte assistant d'une reponse Conversations API
function extractConvReply(data) {
  const outs = data.outputs || data.entries || [];
  for (let i = outs.length - 1; i >= 0; i--) {
    const o = outs[i];
    if ((o.type === 'message.output' || o.role === 'assistant') && o.content) {
      if (typeof o.content === 'string') return o.content;
      if (Array.isArray(o.content)) return o.content.map(c => c.text || c.content || '').join('');
    }
  }
  return null;
}

// Assistant qui repond : l'assistant actif DU COMPTE (chaque compte = son numero + son prompt)
// Clé : celle de l'assistant, sinon clé globale (SQLite/ENV)
function resolveAssistant(uid) {
  const gk = getApiKey(uid);
  const UC = uid ? userCfg(uid) : CONFIG;
  const a = uid ? db.getActiveAssistantForUser(uid) : db.getActiveAssistant();
  if (!a) return { id: 0, name: 'Global', model: UC.mistralModel, instructions: UC.systemInstructions, instructionsSource: 'global', paused: false, useConversations: UC.useConversationsApi, historyLimit: UC.historyLimit, key: gk, keySource: gk ? (process.env.MISTRAL_API_KEY ? 'env' : 'compte/globale') : 'aucune' };
  const k = a.api_key || gk;
  // Prompt vide sur l'assistant = on reprend le prompt DU COMPTE (jamais d'identité Mistral par défaut)
  const hasOwn = !!(a.instructions && a.instructions.trim());
  const UC2 = uid ? userCfg(uid) : CONFIG;
  const instructions = hasOwn ? a.instructions : UC2.systemInstructions;
  return { id: a.id, name: a.name, model: a.model, instructions, instructionsSource: hasOwn ? 'assistant' : 'global', paused: !!a.is_paused, useConversations: !!a.use_conversations, historyLimit: a.history_limit || 20, owner: a.owner_login, key: k, keySource: a.api_key ? 'assistant' : (gk ? 'globale' : 'aucune') };
}
// Version publique d'un assistant : JAMAIS la clé en clair
function publicAssistant(a) {
  if (!a) return null;
  const { api_key, ...rest } = a;
  return { ...rest, keyConfigured: !!api_key, keyMask: maskKey(api_key) };
}

// --- Conversations API : suivi serveur (conversation_id) + miroir SQLite local ---
async function askViaConversations(jid, userMessage, A) {
  const model = A.model;
  const instructions = (A.instructions || '') + FORMAT_SUFFIX;
  let conv = db.getConv(A.id, jid);

  // Nouveau modele OU nouveau prompt = nouvelle conversation
  // (un conversation_id Mistral garde le modele ET les instructions de sa creation)
  if (conv && (conv.model !== model || (conv.instructions || '') !== instructions)) {
    log(`🧹 [${A.name}] Prompt/modèle changé pour ${jid}, nouvelle conversation...`);
    db.resetConv(A.id, jid); conv = null;
  }

  // 1) Suite de conversation existante
  if (conv) {
    const r = await mistralFetch(`https://api.mistral.ai/v1/conversations/${conv.conversation_id}`, {
      inputs: [{ role: 'user', content: userMessage }]
    }, A.key);
    if (r && r.ok) {
      const reply = extractConvReply(r.data);
      const newId = r.data.conversation_id || conv.conversation_id;
      if (reply) {
        const clean = toWhatsApp(reply);
        db.setConv(A.id, jid, newId, model, instructions);
        db.addMsg(A.id, jid, 'user', userMessage);
        db.addMsg(A.id, jid, 'assistant', clean);
        return clean;
      }
      log('❌ Conversations (suite) reponse vide.');
    } else if (r && r.status === 404) {
      log('ℹ️ Conversation expiree cote Mistral, nouvelle conversation...');
      db.resetConv(A.id, jid);
    } else if (r) {
      log(`❌ Conversations (suite) HTTP ${r.status} : ${(r.data.message || JSON.stringify(r.data)).slice(0, 200)}`);
      if (r.status === 429 || r.status >= 500) return null; // laisser le fallback tenter chat/completions
    } else return null;
    conv = db.getConv(A.id, jid);
    if (conv && r && r.ok) return null;
  }

  // 2) Nouvelle conversation (exactement votre curl : model + inputs + tools + completion_args + instructions)
  const r = await mistralFetch('https://api.mistral.ai/v1/conversations', {
    model,
    inputs: [{ role: 'user', content: userMessage }],
    tools: [],
    completion_args: { temperature: 0.7, max_tokens: 2048, top_p: 1 },
    instructions: instructions || ''
  }, A.key);
  if (r && r.ok) {
    const reply = extractConvReply(r.data);
    if (reply && r.data.conversation_id) {
      const clean = toWhatsApp(reply);
      db.setConv(A.id, jid, r.data.conversation_id, model, instructions);
      db.addMsg(A.id, jid, 'user', userMessage);
      db.addMsg(A.id, jid, 'assistant', clean);
      log(`💬 [${A.name}] Nouvelle conversation ${r.data.conversation_id} (${model})`);
      return clean;
    }
    log('❌ Conversations (nouvelle) reponse vide.');
    return null;
  }
  if (r) log(`❌ Conversations HTTP ${r.status} (${model}) : ${(r.data.message || JSON.stringify(r.data)).slice(0, 200)}`);
  return null;
}

// --- Fallback : chat/completions avec historique SQLite (toujours le suivi local) ---
async function askViaChat(jid, userMessage, A) {
  const model = A.model;
  const system = (A.instructions || '') + FORMAT_SUFFIX;
  const hist = db.getHistory(A.id, jid, A.historyLimit).map(m => ({ role: m.role, content: m.content }));
  const r = await mistralFetch('https://api.mistral.ai/v1/chat/completions', {
    model,
    messages: [{ role: 'system', content: system }, ...hist, { role: 'user', content: userMessage }],
    temperature: 0.7, max_tokens: 500
  }, A.key);
  if (r && r.ok && r.data.choices?.[0]?.message?.content) {
    const clean = toWhatsApp(r.data.choices[0].message.content);
    db.addMsg(A.id, jid, 'user', userMessage);
    db.addMsg(A.id, jid, 'assistant', clean);
    return clean;
  }
  if (r) {
    log(`❌ Chat HTTP ${r.status} (${model}) : ${(r.data.message || JSON.stringify(r.data)).slice(0, 200)}`);
    // Dernier recours si le modele choisi est rate-limite : mistral-tiny (verifie OK le 26/09)
    if (r.status === 429 && model !== 'mistral-tiny') {
      log('🔄 Retry avec mistral-tiny (quota OK)...');
      const r2 = await mistralFetch('https://api.mistral.ai/v1/chat/completions', {
        model: 'mistral-tiny',
        messages: [{ role: 'system', content: system }, ...hist, { role: 'user', content: userMessage }],
        temperature: 0.7, max_tokens: 500
      }, A.key);
      if (r2 && r2.ok && r2.data.choices?.[0]?.message?.content) {
        const clean = toWhatsApp(r2.data.choices[0].message.content);
        db.addMsg(A.id, jid, 'user', userMessage);
        db.addMsg(A.id, jid, 'assistant', clean);
        return clean;
      }
    }
  }
  return null;
}

async function askMistral(uid, jid, userMessage) {
  const A = resolveAssistant(uid);
  if (A.id !== 0 && A.paused) { log(`⏸️ [${A.name}] en pause : message de ${jid} ignoré (reprenez-le pour répondre).`); return null; }
  log(`🧠 [${A.name}] prompt "${A.instructionsSource}" (${(A.instructions || '').length} car.) + modèle ${A.model}`);
  if (A.useConversations) {
    const reply = await askViaConversations(jid, userMessage, A);
    if (reply) return reply;
    log('🔄 Fallback vers chat/completions + historique SQLite...');
    return askViaChat(jid, userMessage, A);
  }
  return askViaChat(jid, userMessage, A);
}

// --- File d'attente anti-blocage (limites PAR COMPTE : chaque numero a son quota) ---
async function processQueue() {
  if (processing) return;
  processing = true;
  while (messageQueue.length > 0) {
    const { uid, from, text } = messageQueue.shift();
    const C = userCfg(uid); // réglages DU COMPTE (délais, quotas...)
    const sock = userSock(uid);
    if (!sock) { log(`⚠️ Compte #${uid} : WhatsApp non connecté, message de ${from} ignoré (scannez le QR).`); continue; }
    const r = rl(uid);
    const now = Date.now();
    r.sent = r.sent.filter(t => now - t < 60000);
    if (r.sent.length >= C.maxPerMinute) {
      log(`⏳ Compte #${uid} : limite ${C.maxPerMinute}/min atteinte, pause 60s...`);
      await sleep(60000); continue;
    }
    const last = r.lastReply[from] || 0;
    const waitUser = C.cooldownPerUserSec * 1000 - (Date.now() - last);
    if (waitUser > 0) await sleep(waitUser);

    const delay = rand(C.minDelaySec, C.maxDelaySec) * 1000;
    try { await sock.sendPresenceUpdate('composing', from); } catch {}
    await sleep(Math.min(delay, 8000));
    try { await sock.sendPresenceUpdate('paused', from); } catch {}

    const reply = await askMistral(uid, from, text);
    if (reply) {
      try {
        await sock.sendMessage(from, { text: reply });
        r.sent.push(Date.now());
        r.lastReply[from] = Date.now();
        log(`🤖 [compte #${uid}] Reponse envoyee a ${from} (apres ${Math.round(delay / 1000)}s)`);
        io.to(room(uid)).emit('stats', { queue: messageQueue.filter(m => m.uid === uid).length, sent: r.sent.length });
        io.to(room(uid)).emit('history-update', { jid: from });
      } catch (e) { log(`❌ Echec envoi a ${from} : ${e.message}`); }
    } else {
      log(`⚠️ Pas de reponse IA pour ${from}. Verifiez la cle / le quota (bouton Tester).`);
    }
    await sleep(1500);
  }
  processing = false;
}

async function startBot(uid) {
  if (!uid) return;
  if (socks.has(uid)) return; // deja demarre
  socks.set(uid, { sock: null }); // marque le demarrage (evite les doublons)
  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDirFor(uid));
    let version;
    try { version = (await fetchLatestBaileysVersion()).version; } catch { version = [2, 3000, 1043857760]; }
const pino = require('pino');
    const sock = makeWASocket({ auth: state, version, printQRInTerminal: false, syncFullHistory: false, connectTimeoutMs: 60000,
      logger: pino({ level: 'silent' }),
      browser: ['BotApp', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      fireInitQueries: false,
      shouldSyncHistoryMessage: () => false,
      getMessage: async () => undefined });
    socks.set(uid, { sock });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        try { const qrImg = await QRCode.toDataURL(qr); io.to(room(uid)).emit('qr', qrImg); log(`📲 [compte #${uid}] Nouveau QR genere, scannez-le sur la page web.`); } catch {}
      }
      if (connection === 'open') { waConnected.set(uid, true); io.to(room(uid)).emit('status', 'connecte'); io.to(room(uid)).emit('qr', null); log(`✅ [compte #${uid}] WhatsApp connecte !`); }
      if (connection === 'close') {
        waConnected.set(uid, false);
        const code = lastDisconnect?.error?.output?.statusCode;
        log(`🔌 [compte #${uid}] Deconnecte (code ${code}). Reconnexion...`);
        socks.delete(uid);
        if (code !== DisconnectReason.loggedOut) setTimeout(() => startBot(uid), 3000);
        else { log(`❌ [compte #${uid}] Session deconnectee. Supprimez ${authDirFor(uid)} et rescanez.`); io.to(room(uid)).emit('status', 'deconnecte-logout'); }
      }
      if (connection === 'connecting') { waConnected.set(uid, false); io.to(room(uid)).emit('status', 'connexion...'); }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      const C = userCfg(uid);
      for (const msg of messages) {
        if (msg.key.fromMe || !msg.message) continue;
        if (msg.message.protocolMessage || msg.message.senderKeyDistributionMessage) continue;
        const from = msg.key.remoteJid;
        if (!from || from === 'status@broadcast') continue;
        if (C.ignoreGroups && (from.endsWith('@g.us') || from.endsWith('@broadcast'))) continue;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) continue;
        log(`📩 [compte #${uid}] ${from} : ${text}`);
        io.to(room(uid)).emit('message', { from, text });
        messageQueue.push({ uid, from, text });
        io.to(room(uid)).emit('stats', { queue: messageQueue.filter(m => m.uid === uid).length, sent: rl(uid).sent.length });
        processQueue();
      }
    });
  } catch (e) {
    socks.delete(uid);
    log(`❌ Erreur startBot [compte #${uid}] : ` + e.message + ', reconnexion dans 5s...');
    setTimeout(() => startBot(uid), 5000);
  }
}

// Demarre UN bot par compte inscrit (chacun son numero WhatsApp + son prompt)
function startAllBots() {
  migrateLegacyAuth();
  try {
    for (const u of db.listUsers()) startBot(u.id);
  } catch (e) { log('❌ startAllBots : ' + e.message); }
}

// ---------- AUTH : chaque user a son compte (mot de passe hashé scrypt), plusieurs assistants par user ----------
app.post('/api/auth/register', (req, res) => {
  const login = auth.normalizeLogin(req.body.login);
  const name = String(req.body.name || '').trim().slice(0, 60);
  const phone = auth.normalizePhone(req.body.phone);
  const password = String(req.body.password || '');
  if (login.length < 3) return res.status(400).json({ error: 'Identifiant trop court (3 min).' });
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 min).' });
  if (phone.length < 9) return res.status(400).json({ error: 'Numero WhatsApp invalide.' });
  if (db.getUserByLogin(login)) return res.status(409).json({ error: 'Identifiant deja pris.' });
  const role = db.hasAdmin() ? 'user' : 'admin'; // premier compte = admin
  const r = db.createUser(login, name || login, phone, auth.hashPassword(password), role);
  const newUid = Number(r.lastInsertRowid);
  const NUC = userCfg(newUid); // reprend les défauts (globaux) pour son 1er assistant
  // 1er assistant de l'utilisateur, instructions VIDES : il suit toujours
  // les "Instructions IA" du compte (pas de copie figée qui diverge)
  const asst = db.createAssistant({ user_id: newUid, name: 'Principal', model: NUC.mistralModel, instructions: '', use_conversations: NUC.useConversationsApi, history_limit: NUC.historyLimit, is_active: !db.getActiveAssistantForUser(newUid) });
  const token = auth.newToken();
  db.createSession(token, newUid, Date.now() + auth.SESSION_DAYS * 864e5);
  log(`👤 Inscription : ${login} (${role}, assistant #${asst.lastInsertRowid} créé).`);
  if (!process.env.VERCEL && !process.env.SKIP_BOT) startBot(newUid); // son propre bot WhatsApp
  res.json({ ok: true, token, user: auth.publicUser(db.getUserById(newUid)) });
});
app.post('/api/auth/login', (req, res) => {
  const login = auth.normalizeLogin(req.body.identifier || req.body.login);
  const password = String(req.body.password || '');
  const u = db.getUserByLogin(login);
  if (!u || !auth.verifyPassword(password, u.password_hash)) return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
  const days = req.body.remember ? 30 : auth.SESSION_DAYS;
  const token = auth.newToken();
  db.createSession(token, u.id, Date.now() + days * 864e5);
  log(`🔓 Connexion : ${login}.`);
  res.json({ ok: true, token, user: auth.publicUser(u) });
});
app.post('/api/auth/logout', auth.requireAuth, (req, res) => {
  db.deleteSession(req.token);
  res.json({ ok: true });
});
app.get('/api/auth/me', auth.requireAuth, (req, res) => {
  res.json({ ok: true, user: auth.publicUser(db.getUserById(req.user.id)), assistants: db.countAssistants(req.user.id), active: publicAssistant(db.getActiveAssistantForUser(req.user.id)), whatsapp: userConnected(req.user.id) ? 'connecte' : 'deconnecte' });
});
// Mot de passe oublié : code à 6 chiffres envoyé sur le numéro WhatsApp enregistré
app.post('/api/auth/forgot', async (req, res) => {
  const login = auth.normalizeLogin(req.body.identifier || req.body.login);
  const u = db.getUserByLogin(login);
  // Réponse générique (ne révèle pas si le compte existe), envoi seulement si user + numéro
  if (u && u.phone) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    db.createResetCode(u.id, code, Date.now() + 15 * 60e3);
    const target = `${auth.normalizePhone(u.phone)}@s.whatsapp.net`;
    const fromSock = userSock(u.id) || firstSock(); // son bot de préférence, sinon un bot connecté
    if (fromSock) {
      try {
        await fromSock.sendMessage(target, { text: `🔐 Votre code de réinitialisation : *${code}*\nValable 15 minutes. Si ce n'est pas vous, ignorez ce message.` });
        log(`📲 Code reset envoyé à ${target} pour ${login}.`);
      } catch (e) { log(`❌ Echec envoi code reset à ${target} : ${e.message}`); }
    } else log('⚠️ Reset demandé mais aucun WhatsApp connecté, code non envoyé.');
    return res.json({ ok: true, hint: '****' + String(u.phone).slice(-2) });
  }
  res.json({ ok: true, hint: '' });
});
app.post('/api/auth/reset', (req, res) => {
  const login = auth.normalizeLogin(req.body.identifier || req.body.login);
  const code = String(req.body.code || '').trim();
  const password = String(req.body.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 min).' });
  const u = db.getUserByLogin(login);
  const rc = u && db.getValidReset(u.id, code);
  if (!rc || rc.expires_at < Date.now()) return res.status(400).json({ error: 'Code invalide ou expiré.' });
  db.markResetUsed(rc.id);
  db.setUserPassword(u.id, auth.hashPassword(password));
  res.json({ ok: true });
});

// ---------- API OTP : vos apps externes envoient un code via le WhatsApp DU COMPTE ----------
// Chaque compte a SA propre URL d'envoi (clé API visible sur le dashboard) :
//   GET /api/otp/send?token=CLE&to=243...&code=482913[&message=...]
// ou POST /api/send-otp (Bearer session) { to, code, message? }
async function sendOtp(uid, to, code, message) {
  code = String(code || '').trim();
  if (!/^[0-9A-Za-z-]{4,12}$/.test(code)) return { status: 422, body: { ok: false, error: 'Code invalide (4 a 12 caracteres).' } };
  return sendWhatsApp(uid, to, String(message || `🔐 Votre code de vérification : *${code}*`));
}
// Message simple (sans code) : POST /api/send { to, message } ou GET /api/send?token=CLE&to=..&message=..
async function sendWhatsApp(uid, to, text) {
  to = auth.normalizePhone(to || '');
  text = String(text || '').trim().slice(0, 2000);
  if (to.length < 9) return { status: 422, body: { ok: false, error: 'Numero destinataire invalide (9 chiffres min, ex. 243...).' } };
  if (!text) return { status: 422, body: { ok: false, error: 'Message vide.' } };
  const sock = userSock(uid);
  if (!sock || !userConnected(uid)) return { status: 409, body: { ok: false, error: 'WhatsApp non connecte pour ce compte (scannez le QR).' } };
  const C = userCfg(uid);
  const r = rl(uid);
  r.sent = r.sent.filter(t => Date.now() - t < 60000);
  if (r.sent.length >= C.maxPerMinute) return { status: 429, body: { ok: false, error: `Quota ${C.maxPerMinute}/min atteint, reessayez dans une minute.` } };
  try {
    const sent = await sock.sendMessage(to + '@s.whatsapp.net', { text });
    r.sent.push(Date.now());
    log(`📲 [compte #${uid}] Message envoye au ${to}.`);
    return { status: 200, body: { ok: true, to, id: sent?.key?.id || null } };
  } catch (e) {
    log(`❌ [compte #${uid}] Echec envoi vers ${to} : ${e.message}`);
    return { status: 502, body: { ok: false, error: 'Echec envoi WhatsApp : ' + e.message } };
  }
}
app.post('/api/send-otp', auth.requireAuth, async (req, res) => {
  const r = await sendOtp(req.user.id, req.body.to || req.body.phone, req.body.code, req.body.message);
  res.status(r.status).json(r.body);
});
app.post('/api/send', auth.requireAuth, async (req, res) => {
  const r = await sendWhatsApp(req.user.id, req.body.to || req.body.phone, req.body.message);
  res.status(r.status).json(r.body);
});
// URL par compte : cle API (dashboard) en parametre — pour vos apps externes (GET simple)
//   OTP :     GET /api/otp/send?token=CLE&to=243...&code=482913[&message=...]
//   Message : GET /api/send?token=CLE&to=243...&message=Bonjour
function apiTokenAuth(req) {
  const key = req.query.token || req.query.key || req.headers['x-api-token'];
  const t = key && db.getApiToken(String(key));
  if (!t) return null;
  db.touchApiToken(t.id);
  return t;
}
app.get('/api/otp/send', async (req, res) => {
  const t = apiTokenAuth(req);
  if (!t) return res.status(401).json({ ok: false, error: 'Cle API invalide (voir dashboard > API OTP).' });
  const r = await sendOtp(t.user_id, req.query.to || req.query.phone, req.query.code, req.query.message);
  res.status(r.status).json(r.body);
});
app.get('/api/send', async (req, res) => {
  const t = apiTokenAuth(req);
  if (!t) return res.status(401).json({ ok: false, error: 'Cle API invalide (voir dashboard > API OTP).' });
  const r = await sendWhatsApp(t.user_id, req.query.to || req.query.phone, req.query.message);
  res.status(r.status).json(r.body);
});
// Gestion des cles API du compte (session requise) — le token complet n'est rendu qu'a la creation
app.get('/api/api-tokens', auth.requireAuth, (req, res) => {
  res.json({ ok: true, tokens: db.listApiTokens(req.user.id) });
});
app.post('/api/api-tokens', auth.requireAuth, (req, res) => {
  if (db.listApiTokens(req.user.id).length >= 10) return res.status(400).json({ ok: false, error: 'Maximum 10 cles API.' });
  const name = String(req.body.name || 'app').trim().slice(0, 40) || 'app';
  const token = 'otp_' + auth.newToken();
  const r = db.createApiToken(req.user.id, name, token);
  log(`🔑 [compte #${req.user.id}] Cle API "${name}" creee.`);
  res.json({ ok: true, token: { id: Number(r.lastInsertRowid), name, token } });
});
app.delete('/api/api-tokens/:id', auth.requireAuth, (req, res) => {
  const n = db.deleteApiToken(req.user.id, Number(req.params.id));
  if (!n) return res.status(404).json({ ok: false, error: 'Cle introuvable.' });
  log(`🗑️ [compte #${req.user.id}] Cle API #${req.params.id} supprimee.`);
  res.json({ ok: true });
});

// ---------- ASSISTANTS : liés au user connecté, un user = plusieurs assistants ----------
app.get('/api/assistants', auth.requireAuth, (req, res) => {
  res.json({ ok: true, assistants: db.listAssistants(req.user.id).map(publicAssistant), active: publicAssistant(db.getActiveAssistantForUser(req.user.id)) });
});
app.post('/api/assistants', auth.requireAuth, (req, res) => {
  if (db.countAssistants(req.user.id) >= 10) return res.status(400).json({ error: 'Maximum 10 assistants.' });
  const name = String(req.body.name || 'Assistant').trim().slice(0, 60) || 'Assistant';
  const apiKey = String(req.body.api_key || req.body.mistralApiKey || '');
  if (apiKey && apiKey.startsWith('***')) return res.status(400).json({ error: 'Cle masquee, retapez-la en clair.' });
  const r = db.createAssistant({
    user_id: req.user.id, name,
    model: req.body.model || 'mistral-medium-latest',
    instructions: String(req.body.instructions || ''),
    use_conversations: req.body.use_conversations !== false,
    history_limit: Math.min(100, Math.max(2, Number(req.body.history_limit) || 20)),
    api_key: apiKey,
    is_active: !db.getActiveAssistantForUser(req.user.id)
  });
  log(`🤖 Assistant "${name}" créé pour ${req.user.login} (#${r.lastInsertRowid})${apiKey ? ' avec sa propre clé.' : '.'}`);
  res.json({ ok: true, assistant: publicAssistant(db.getAssistant(Number(r.lastInsertRowid))) });
});
function ownAssistant(req, res) {
  const a = db.getAssistant(Number(req.params.id));
  if (!a) { res.status(404).json({ error: 'Assistant introuvable.' }); return null; }
  if (a.user_id !== req.user.id) { res.status(403).json({ error: 'Pas votre assistant.' }); return null; }
  return a;
}
app.put('/api/assistants/:id', auth.requireAuth, (req, res) => {
  const a = ownAssistant(req, res); if (!a) return;
  const f = {
    name: String(req.body.name || a.name).slice(0, 60),
    model: req.body.model || a.model,
    instructions: req.body.instructions ?? a.instructions,
    use_conversations: req.body.use_conversations !== undefined ? !!req.body.use_conversations : !!a.use_conversations,
    history_limit: Math.min(100, Math.max(2, Number(req.body.history_limit) || a.history_limit))
  };
  db.updateAssistant(a.id, f);
  if (req.body.api_key !== undefined || req.body.mistralApiKey !== undefined) {
    const newKey = String(req.body.api_key ?? req.body.mistralApiKey ?? '');
    if (newKey && newKey.startsWith('***')) return res.status(400).json({ error: 'Cle masquee, retapez-la en clair.' });
    db.setAssistantKey(a.id, newKey);
    db.resetAssistantConvs(a.id); // nouvelle clé = nouveau crédit/quota => repartir propre
    log(`🔐 Clé de l'assistant "${f.name}" ${newKey ? 'mise à jour' : 'supprimée (retour clé globale)'}.`);
  }
  if (f.model !== a.model || f.instructions !== a.instructions) {
    const n = db.resetAssistantConvs(a.id); // nouveau prompt/modele => conversations périmées
    log(`🧹 Assistant "${f.name}" modifié : ${n} conversation(s) réinitialisée(s).`);
  }
  res.json({ ok: true, assistant: publicAssistant(db.getAssistant(a.id)) });
});
app.delete('/api/assistants/:id', auth.requireAuth, (req, res) => {
  const a = ownAssistant(req, res); if (!a) return;
  const cur = db.getActiveAssistantForUser(req.user.id);
  const wasActive = !!cur && cur.id === a.id;
  db.deleteAssistant(a.id);
  log(`🗑️ Assistant "${a.name}" supprimé${wasActive ? ' (était actif)' : ''}.`);
  res.json({ ok: true });
});
app.post('/api/assistants/:id/activate', auth.requireAuth, (req, res) => {
  const a = ownAssistant(req, res); if (!a) return;
  db.setActiveAssistant(req.user.id, a.id);
  io.to(room(req.user.id)).emit('assistant', { id: a.id, name: a.name });
  log(`▶️ Assistant actif : "${a.name}" (${a.model}) de ${req.user.login}.`);
  res.json({ ok: true });
});
// Pause / reprise : en pause, le bot ne répond plus (messages ignorés, sans erreur)
app.post('/api/assistants/:id/pause', auth.requireAuth, (req, res) => {
  const a = ownAssistant(req, res); if (!a) return;
  const paused = req.body.paused !== false;
  db.setPaused(a.id, paused);
  log(`${paused ? '⏸️' : '▶️'} Assistant "${a.name}" ${paused ? 'mis en pause (bot silencieux)' : 'repris'} par ${req.user.login}.`);
  res.json({ ok: true, paused });
});
app.get('/api/assistant/active', auth.requireAuth, (req, res) => res.json({ ok: true, active: publicAssistant(db.getActiveAssistantForUser(req.user.id)), whatsapp: userConnected(req.user.id) ? 'connecte' : 'deconnecte' }));

// ---------- API ----------
// Config SANS la cle en clair : chaque compte voit/modifie SA config (jamais exposee)
// (l'interface ne voit que "configuree oui/non + ***4 derniers")
app.get('/api/config', auth.requireAuth, (req, res) => {
  const k = getApiKey(req.user.id);
  res.json({ ...userCfg(req.user.id), keyConfigured: !!k, mistralApiKey: maskKey(k), envKey: !!process.env.MISTRAL_API_KEY });
});
app.post('/api/config', auth.requireAuth, (req, res) => {
  const uid = req.user.id;
  const { mistralApiKey, mistralModel, systemInstructions, useConversationsApi, historyLimit, phoneNumber, minDelaySec, maxDelaySec, maxPerMinute, cooldownPerUserSec, ignoreGroups } = req.body;
  if (mistralApiKey && !mistralApiKey.startsWith('***')) {
    db.setSetting(`cfg_${uid}_mistral_key`, mistralApiKey); // clé DU COMPTE, côté serveur uniquement (SQLite)
    log(`🔐 [compte #${uid}] Cle API mise a jour (stockee en SQLite, jamais exposee).`);
  }
  const perUser = {};
  if (mistralModel) perUser.mistralModel = mistralModel;
  if (systemInstructions !== undefined && systemInstructions !== userCfg(uid).systemInstructions) {
    perUser.systemInstructions = systemInstructions;
    // Les conversation_id Mistral gardent les instructions de leur creation :
    // nouveau prompt => on invalide les conversations DU COMPTE pour repartir avec le nouveau prompt
    let n = 0;
    for (const a of db.listAssistants(uid)) n += db.resetAssistantConvs(a.id);
    log(`🧹 [compte #${uid}] Nouveau prompt : ${n} conversation(s) Mistral reinitialisee(s), le nouveau prompt s'appliquera au prochain message.`);
  }
  if (useConversationsApi !== undefined && !!useConversationsApi !== userCfg(uid).useConversationsApi) {
    // Bascule Conversations ON/OFF = admin uniquement (les autres la voient même pas dans l'UI)
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Réservé à l administrateur.' });
    perUser.useConversationsApi = !!useConversationsApi;
  }
  if (historyLimit) perUser.historyLimit = Math.min(100, Math.max(2, Number(historyLimit)));
  if (phoneNumber !== undefined) perUser.phoneNumber = phoneNumber;
  if (minDelaySec) perUser.minDelaySec = Number(minDelaySec);
  if (maxDelaySec) perUser.maxDelaySec = Number(maxDelaySec);
  if (maxPerMinute) perUser.maxPerMinute = Number(maxPerMinute);
  if (cooldownPerUserSec) perUser.cooldownPerUserSec = Number(cooldownPerUserSec);
  if (ignoreGroups !== undefined) perUser.ignoreGroups = !!ignoreGroups;
  saveUserConfig(uid, perUser);
  log(`⚙️ [compte #${uid}] Configuration mise a jour.`);
  res.json({ ok: true, keyConfigured: !!getApiKey(uid) });
});
app.delete('/api/key', auth.requireAuth, (req, res) => {
  db.delSetting(`cfg_${req.user.id}_mistral_key`);
  log(`🗑️ [compte #${req.user.id}] Cle API supprimee.`);
  res.json({ ok: true });
});
app.post('/api/logout', auth.requireAuth, async (req, res) => {
  const uid = req.user.id;
  try { await userSock(uid)?.logout(); } catch {}
  socks.delete(uid); waConnected.delete(uid);
  try { fs.rmSync(authDirFor(uid), { recursive: true, force: true }); } catch {}
  io.to(room(uid)).emit('status', 'deconnecte-logout');
  log(`🚪 [compte #${uid}] Session WhatsApp supprimee. Redemarrage...`);
  if (!process.env.VERCEL && !process.env.SKIP_BOT) startBot(uid);
  res.json({ ok: true });
});
app.get('/api/logs', (req, res) => res.json(logs));
// Test reel : mini-conversation avec le VRAI prompt systeme (ne pollue pas l'historique)
app.get('/api/test-mistral', auth.requireAuth, async (req, res) => {
  const A = resolveAssistant(req.user.id);
  if (!A.key) return res.json({ ok: false, error: 'Cle manquante (ni assistant ni globale)' });
  const probe = 'Qui es-tu ? Presente-toi en une phrase courte en respectant tes instructions.';
  if (A.useConversations) {
    const r = await mistralFetch('https://api.mistral.ai/v1/conversations', {
      model: A.model,
      inputs: [{ role: 'user', content: probe }],
      tools: [],
      completion_args: { temperature: 0.7, max_tokens: 150, top_p: 1 },
      instructions: (A.instructions || '') + FORMAT_SUFFIX
    }, A.key);
    const reply = r && r.ok ? toWhatsApp(extractConvReply(r.data)) : null;
    if (r && !r.ok) log(`❌ Test HTTP ${r.status} : ${(r.data.message || '').slice(0, 200)}`);
    return res.json({ ok: !!reply, mode: 'conversations', model: A.model, keySource: A.keySource, instructionsSource: A.instructionsSource, assistant: A.name, reply });
  }
  const reply = await askViaChat('__test__', probe, { ...A, id: -1 });
  db.clearHistory(-1, '__test__');
  res.json({ ok: !!reply, mode: 'chat', model: A.model, keySource: A.keySource, instructionsSource: A.instructionsSource, assistant: A.name, reply });
});
// Historique SQLite par contact, scope par assistant actif DU COMPTE (suivi local, meme si Mistral cloud est vide)
function reqAid(req) {
  const q = Number(req.query.assistant ?? req.body?.assistant);
  if (q && req.user) {
    const a = db.getAssistant(q);
    if (a && a.user_id === req.user.id) return q; // assistant explicite, vérifié
  }
  return req.user ? resolveAssistant(req.user.id).id : resolveAssistant().id;
}
app.get('/api/history', auth.requireAuth, (req, res) => {
  const jid = req.query.jid;
  if (!jid) return res.status(400).json({ error: 'jid requis' });
  const aid = reqAid(req);
  const conv = db.getConv(aid, jid);
  res.json({ jid, assistant_id: aid, conversation_id: conv?.conversation_id || null, model: conv?.model || null, messages: db.getHistory(aid, jid, 100) });
});
app.get('/api/contacts', auth.requireAuth, (req, res) => res.json(db.contacts(reqAid(req), 30)));
app.post('/api/conversation/reset', auth.requireAuth, (req, res) => {
  const { jid, clearMessages } = req.body;
  if (!jid) return res.status(400).json({ error: 'jid requis' });
  const aid = reqAid(req);
  if (clearMessages) db.clearHistory(aid, jid); else db.resetConv(aid, jid);
  log(`🧹 Conversation ${clearMessages ? 'et historique' : ''} reinitialisee pour ${jid}.`);
  res.json({ ok: true });
});

// Socket.io : chaque page rejoint la room de SON compte (QR / statut / messages ciblés)
io.on('connection', (s) => {
  s.emit('log-history', logs);
  s.on('register', (token) => {
    try {
      const sess = token && db.getSession(String(token));
      if (sess && sess.expires_at > Date.now()) {
        s.join(room(sess.user_id));
        // Renvoie l'état actuel du compte dès l'inscription
        s.emit('status', userConnected(sess.user_id) ? 'connecte' : 'connexion...');
      }
    } catch {}
  });
});

app.get('/api/status', auth.requireAuth, (req, res) => {
  const s = userSock(req.user.id);
  const connected = !!(s && s.ws && s.ws.readyState === 1);
  res.json({ ok: true, connected });
});

const PORT = process.env.PORT || 3000;
// Sur Vercel (serverless) : pas de listen(), pas de bot WhatsApp persistant — on exporte app.
if (!process.env.VERCEL) {
  server.listen(PORT, () => { console.log(`🌐 Interface : http://localhost:${PORT}`); if (!process.env.SKIP_BOT) startAllBots(); });
} else {
  console.log('ℹ️ Mode Vercel : API seule (bot WhatsApp désactivé, utilisez Railway/Render pour le bot).');
}
module.exports = app;
