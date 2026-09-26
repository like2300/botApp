// Cree ou promeut un utilisateur ADMIN (idempotent).
// Usage :
//   node create-admin.js <email> <password> [nom] [telephone]
//   node create-admin.js <email> <password> --set-password   (reinitialise aussi le mot de passe d'un compte existant)
// Sans --set-password, le mot de passe d'un compte existant n'est JAMAIS touche.
const db = require('./db');
const auth = require('./auth');

function usage() {
  console.log('Usage: node create-admin.js <email> <password> [nom] [telephone] [--set-password]');
  process.exit(1);
}

const args = process.argv.slice(2).filter(a => a !== '--set-password');
const setPassword = process.argv.includes('--set-password');
const [email, password, name, phone] = args;
if (!email || !password) usage();

const login = auth.normalizeLogin(email);
if (login.length < 3) { console.log('Email/identifiant trop court.'); process.exit(1); }
if (password.length < 6) { console.log('Mot de passe trop court (6 min).'); process.exit(1); }
if (phone && auth.normalizePhone(phone).length < 9) { console.log('Numero WhatsApp invalide.'); process.exit(1); }

let u = db.getUserByLogin(login);
if (u) {
  if (setPassword) {
    db.setUserPassword(u.id, auth.hashPassword(password));
    console.log(`OK: mot de passe reinitialise pour ${login}.`);
  } else {
    console.log(`Note: compte existant, mot de passe inchange (ajoutez --set-password pour le changer).`);
  }
  if (u.role !== 'admin') {
    require('better-sqlite3')(require('path').join(__dirname, 'bot.db'))
      .prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(u.id);
    console.log(`OK: ${login} promu admin.`);
  } else {
    console.log(`OK: ${login} est deja admin.`);
  }
} else {
  const r = db.createUser(login, (name || login).slice(0, 60), phone ? auth.normalizePhone(phone) : '', auth.hashPassword(password), 'admin');
  const id = Number(r.lastInsertRowid);
  db.createAssistant({
    user_id: id, name: 'Principal', model: 'mistral-medium-latest',
    instructions: '', // vide = suit les "Instructions IA" du compte
    use_conversations: true, history_limit: 20, api_key: '',
    is_active: !db.getActiveAssistantForUser(id),
  });
  console.log(`OK: admin ${login} cree (id=${id}) + assistant Principal.`);
}
const check = db.getUserByLogin(login);
console.log(`Verif: login=${check.login} role=${check.role} (mot de passe non affiche)`);
