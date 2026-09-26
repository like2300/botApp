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
let waConnected = false;
app.get('/api/health', (req, res) => res.json({ ok: true, whatsapp: waConnected ? 'connecte' : 'deconnecte', uptime: Math.round(process.uptime()) }));

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

// ---------- Cle API : env > SQLite. Jamais exposee en clair, jamais loggee ----------
function getApiKey() {
  return process.env.MISTRAL_API_KEY || db.getSetting('mistral_key', '');
}
function maskKey(k) { return k ? '***' + k.slice(-4) : ''; }

let sock = null;
let messageQueue = [];
let processing = false;
let sentTimestamps = [];
let lastReplyPerUser = {};
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

// Assistant qui repond : l'assistant actif (lie a son user), sinon config globale (avant inscription)
// Clé : celle de l'assistant, sinon clé globale (SQLite/ENV)
function resolveAssistant() {
  const gk = getApiKey();
  const a = db.getActiveAssistant();
  if (!a) return { id: 0, name: 'Global', model: CONFIG.mistralModel, instructions: CONFIG.systemInstructions, useConversations: CONFIG.useConversationsApi, historyLimit: CONFIG.historyLimit, key: gk, keySource: gk ? 'globale' : 'aucune' };
  const k = a.api_key || gk;
  // Prompt vide sur l'assistant = on reprend le prompt global (jamais d'identité Mistral par défaut)
  const hasOwn = !!(a.instructions && a.instructions.trim());
  const instructions = hasOwn ? a.instructions : CONFIG.systemInstructions;
  return { id: a.id, name: a.name, model: a.model, instructions, instructionsSource: hasOwn ? 'assistant' : 'global', useConversations: !!a.use_conversations, historyLimit: a.history_limit || 20, owner: a.owner_login, key: k, keySource: a.api_key ? 'assistant' : (gk ? 'globale' : 'aucune') };
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

async function askMistral(jid, userMessage) {
  const A = resolveAssistant();
  log(`🧠 [${A.name}] prompt "${A.instructionsSource}" (${(A.instructions || '').length} car.) + modèle ${A.model}`);
  if (A.useConversations) {
    const reply = await askViaConversations(jid, userMessage, A);
    if (reply) return reply;
    log('🔄 Fallback vers chat/completions + historique SQLite...');
    return askViaChat(jid, userMessage, A);
  }
  return askViaChat(jid, userMessage, A);
}

// --- File d'attente anti-blocage ---
async function processQueue() {
  if (processing || !sock) return;
  processing = true;
  while (messageQueue.length > 0) {
    const now = Date.now();
    sentTimestamps = sentTimestamps.filter(t => now - t < 60000);
    if (sentTimestamps.length >= CONFIG.maxPerMinute) {
      log(`⏳ Limite ${CONFIG.maxPerMinute}/min atteinte, pause 60s...`);
      await sleep(60000); continue;
    }
    const { from, text } = messageQueue.shift();
    const last = lastReplyPerUser[from] || 0;
    const waitUser = CONFIG.cooldownPerUserSec * 1000 - (Date.now() - last);
    if (waitUser > 0) await sleep(waitUser);

    const delay = rand(CONFIG.minDelaySec, CONFIG.maxDelaySec) * 1000;
    try { await sock.sendPresenceUpdate('composing', from); } catch {}
    await sleep(Math.min(delay, 8000));
    try { await sock.sendPresenceUpdate('paused', from); } catch {}

    const reply = await askMistral(from, text);
    if (reply) {
      try {
        await sock.sendMessage(from, { text: reply });
        sentTimestamps.push(Date.now());
        lastReplyPerUser[from] = Date.now();
        log(`🤖 Reponse envoyee a ${from} (apres ${Math.round(delay / 1000)}s)`);
        io.emit('stats', { queue: messageQueue.length, sent: sentTimestamps.length });
        io.emit('history-update', { jid: from });
      } catch (e) { log(`❌ Echec envoi a ${from} : ${e.message}`); }
    } else {
      log(`⚠️ Pas de reponse IA pour ${from}. Verifiez la cle / le quota (bouton Tester).`);
    }
    await sleep(1500);
  }
  processing = false;
}

async function startBot() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(process.env.AUTH_DIR || 'auth_info');
    let version;
    try { version = (await fetchLatestBaileysVersion()).version; } catch { version = [2, 3000, 1043857760]; }
const pino = require('pino');
    sock = makeWASocket({ auth: state, version, printQRInTerminal: false, syncFullHistory: false, connectTimeoutMs: 60000,
      logger: pino({ level: 'silent' }),
      browser: ['BotApp', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      fireInitQueries: false,
      shouldSyncHistoryMessage: () => false,
      getMessage: async () => undefined });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        try { const qrImg = await QRCode.toDataURL(qr); io.emit('qr', qrImg); log('📲 Nouveau QR genere, scannez-le sur la page web.'); } catch {}
      }
      if (connection === 'open') { waConnected = true; io.emit('status', 'connecte'); io.emit('qr', null); log('✅ WhatsApp connecte !'); }
      if (connection === 'close') {
        waConnected = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        log(`🔌 Deconnecte (code ${code}). Reconnexion...`);
        if (code !== DisconnectReason.loggedOut) setTimeout(() => startBot(), 3000);
        else { log('❌ Session deconnectee. Supprimez auth_info et rescanez.'); io.emit('status', 'deconnecte-logout'); }
      }
      if (connection === 'connecting') { waConnected = false; io.emit('status', 'connexion...'); }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (msg.key.fromMe || !msg.message) continue;
        if (msg.message.protocolMessage || msg.message.senderKeyDistributionMessage) continue;
        const from = msg.key.remoteJid;
        if (!from || from === 'status@broadcast') continue;
        if (CONFIG.ignoreGroups && (from.endsWith('@g.us') || from.endsWith('@broadcast'))) continue;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) continue;
        log(`📩 ${from} : ${text}`);
        io.emit('message', { from, text });
        messageQueue.push({ from, text });
        io.emit('stats', { queue: messageQueue.length, sent: sentTimestamps.length });
        processQueue();
      }
    });
  } catch (e) {
    log('❌ Erreur startBot : ' + e.message + ', reconnexion dans 5s...');
    setTimeout(() => startBot(), 5000);
  }
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
  // 1er assistant de l'utilisateur, reprend la config globale actuelle
  const asst = db.createAssistant({ user_id: Number(r.lastInsertRowid), name: 'Principal', model: CONFIG.mistralModel, instructions: CONFIG.systemInstructions, use_conversations: CONFIG.useConversationsApi, history_limit: CONFIG.historyLimit, is_active: !db.getActiveAssistant() });
  const token = auth.newToken();
  db.createSession(token, Number(r.lastInsertRowid), Date.now() + auth.SESSION_DAYS * 864e5);
  log(`👤 Inscription : ${login} (${role}, assistant #${asst.lastInsertRowid} créé).`);
  res.json({ ok: true, token, user: auth.publicUser(db.getUserById(Number(r.lastInsertRowid))) });
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
  res.json({ ok: true, user: auth.publicUser(db.getUserById(req.user.id)), assistants: db.countAssistants(req.user.id), active: publicAssistant(db.getActiveAssistant()) });
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
    if (sock) {
      try {
        await sock.sendMessage(target, { text: `🔐 Votre code de réinitialisation : *${code}*\nValable 15 minutes. Si ce n'est pas vous, ignorez ce message.` });
        log(`📲 Code reset envoyé à ${target} pour ${login}.`);
      } catch (e) { log(`❌ Echec envoi code reset à ${target} : ${e.message}`); }
    } else log('⚠️ Reset demandé mais WhatsApp non connecté, code non envoyé.');
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

// ---------- ASSISTANTS : liés au user connecté, un user = plusieurs assistants ----------
app.get('/api/assistants', auth.requireAuth, (req, res) => {
  res.json({ ok: true, assistants: db.listAssistants(req.user.id).map(publicAssistant), active: publicAssistant(db.getActiveAssistant()) });
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
    is_active: !db.getActiveAssistant()
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
  const wasActive = !!db.getActiveAssistant() && db.getActiveAssistant().id === a.id;
  db.deleteAssistant(a.id);
  log(`🗑️ Assistant "${a.name}" supprimé${wasActive ? ' (était actif, retour config globale)' : ''}.`);
  res.json({ ok: true });
});
app.post('/api/assistants/:id/activate', auth.requireAuth, (req, res) => {
  const a = ownAssistant(req, res); if (!a) return;
  db.setActiveAssistant(a.id);
  io.emit('assistant', { id: a.id, name: a.name });
  log(`▶️ Assistant actif : "${a.name}" (${a.model}) de ${req.user.login}.`);
  res.json({ ok: true });
});
app.get('/api/assistant/active', (req, res) => res.json({ ok: true, active: publicAssistant(db.getActiveAssistant()) }));

// ---------- API ----------
// Config SANS la cle en clair (securite : l'interface ne voit que "configuree oui/non + ***4 derniers")
app.get('/api/config', (req, res) => {
  const k = getApiKey();
  res.json({ ...CONFIG, keyConfigured: !!k, mistralApiKey: maskKey(k), envKey: !!process.env.MISTRAL_API_KEY });
});
app.post('/api/config', (req, res) => {
  const { mistralApiKey, mistralModel, systemInstructions, useConversationsApi, historyLimit, phoneNumber, minDelaySec, maxDelaySec, maxPerMinute, cooldownPerUserSec, ignoreGroups } = req.body;
  if (mistralApiKey && !mistralApiKey.startsWith('***')) {
    db.setSetting('mistral_key', mistralApiKey); // stockee cote serveur uniquement (SQLite)
    log('🔐 Cle API mise a jour (stockee en SQLite, jamais exposee).');
  }
  if (mistralModel) CONFIG.mistralModel = mistralModel;
  if (systemInstructions !== undefined && systemInstructions !== CONFIG.systemInstructions) {
    CONFIG.systemInstructions = systemInstructions;
    // Les conversation_id Mistral gardent les instructions de leur creation :
    // nouveau prompt => on invalide toutes les conversations pour que chacun reparte avec le nouveau prompt
    const n = db.resetAllConvs();
    log(`🧹 Nouveau system prompt : ${n} conversation(s) Mistral reinitialisee(s), le nouveau prompt s'appliquera au prochain message.`);
  }
  if (useConversationsApi !== undefined && !!useConversationsApi !== CONFIG.useConversationsApi) {
    // Bascule Conversations ON/OFF = admin uniquement (les autres la voient même pas dans l'UI)
    const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const s = tok && db.getSession(tok);
    const u = s && s.expires_at > Date.now() ? db.getUserById(s.user_id) : null;
    if (!u || u.role !== 'admin') return res.status(403).json({ error: 'Réservé à l administrateur.' });
    CONFIG.useConversationsApi = !!useConversationsApi;
  }
  if (historyLimit) CONFIG.historyLimit = Math.min(100, Math.max(2, Number(historyLimit)));
  if (phoneNumber !== undefined) CONFIG.phoneNumber = phoneNumber;
  if (minDelaySec) CONFIG.minDelaySec = Number(minDelaySec);
  if (maxDelaySec) CONFIG.maxDelaySec = Number(maxDelaySec);
  if (maxPerMinute) CONFIG.maxPerMinute = Number(maxPerMinute);
  if (cooldownPerUserSec) CONFIG.cooldownPerUserSec = Number(cooldownPerUserSec);
  if (ignoreGroups !== undefined) CONFIG.ignoreGroups = !!ignoreGroups;
  saveConfig();
  log('⚙️ Configuration mise a jour.');
  res.json({ ok: true, keyConfigured: !!getApiKey() });
});
app.delete('/api/key', (req, res) => {
  db.delSetting('mistral_key');
  log('🗑️ Cle API supprimee de SQLite.');
  res.json({ ok: true });
});
app.post('/api/logout', async (req, res) => {
  try { await sock?.logout(); } catch {}
  try { fs.rmSync('./auth_info', { recursive: true, force: true }); } catch {}
  io.emit('status', 'deconnecte-logout');
  log('🚪 Session supprimee. Redemarrage...');
  startBot();
  res.json({ ok: true });
});
app.get('/api/logs', (req, res) => res.json(logs));
// Test reel : demarre une mini-conversation puis la supprime (ne pollue pas l'historique)
app.get('/api/test-mistral', async (req, res) => {
  const A = resolveAssistant();
  if (!A.key) return res.json({ ok: false, error: 'Cle manquante (ni assistant ni globale)' });
  if (A.useConversations) {
    const r = await mistralFetch('https://api.mistral.ai/v1/conversations', {
      model: A.model,
      inputs: [{ role: 'user', content: 'Dis bonjour en 5 mots' }],
      tools: [],
      completion_args: { temperature: 0.7, max_tokens: 50, top_p: 1 },
      instructions: ''
    }, A.key);
    const reply = r && r.ok ? toWhatsApp(extractConvReply(r.data)) : null;
    if (r && !r.ok) log(`❌ Test HTTP ${r.status} : ${(r.data.message || '').slice(0, 200)}`);
    return res.json({ ok: !!reply, mode: 'conversations', model: A.model, keySource: A.keySource, assistant: A.name, reply });
  }
  const reply = await askViaChat('__test__', 'Dis bonjour en 5 mots', { ...A, id: -1 });
  db.clearHistory(-1, '__test__');
  res.json({ ok: !!reply, mode: 'chat', model: A.model, keySource: A.keySource, assistant: A.name, reply });
});
// Historique SQLite par contact, scope par assistant actif (suivi local, meme si Mistral cloud est vide)
function reqAid(req) {
  const q = Number(req.query.assistant ?? req.body?.assistant);
  if (q) return q;
  return resolveAssistant().id;
}
app.get('/api/history', (req, res) => {
  const jid = req.query.jid;
  if (!jid) return res.status(400).json({ error: 'jid requis' });
  const aid = reqAid(req);
  const conv = db.getConv(aid, jid);
  res.json({ jid, assistant_id: aid, conversation_id: conv?.conversation_id || null, model: conv?.model || null, messages: db.getHistory(aid, jid, 100) });
});
app.get('/api/contacts', (req, res) => res.json(db.contacts(reqAid(req), 30)));
app.post('/api/conversation/reset', (req, res) => {
  const { jid, clearMessages } = req.body;
  if (!jid) return res.status(400).json({ error: 'jid requis' });
  const aid = reqAid(req);
  if (clearMessages) db.clearHistory(aid, jid); else db.resetConv(aid, jid);
  log(`🧹 Conversation ${clearMessages ? 'et historique' : ''} reinitialisee pour ${jid}.`);
  res.json({ ok: true });
});

io.on('connection', (s) => { s.emit('log-history', logs); });

app.get('/api/status', (req, res) => {
  const connected = sock && sock.ws && sock.ws.readyState === 1;
  res.json({ ok: true, connected });
});

const PORT = process.env.PORT || 3000;
// Sur Vercel (serverless) : pas de listen(), pas de bot WhatsApp persistant — on exporte app.
if (!process.env.VERCEL) {
  server.listen(PORT, () => { console.log(`🌐 Interface : http://localhost:${PORT}`); if (!process.env.SKIP_BOT) startBot(); });
} else {
  console.log('ℹ️ Mode Vercel : API seule (bot WhatsApp désactivé, utilisez Railway/Render pour le bot).');
}
module.exports = app;
