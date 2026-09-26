const AdminJSModule = require('adminjs');
const AdminJS = AdminJSModule.default || AdminJSModule.AdminJS;
const { BaseResource, BaseRecord, BaseProperty, ValidationError } = AdminJSModule;
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'bot.db');
const raw = new Database(DB_PATH);
raw.pragma('journal_mode = WAL');

function tableInfo(table) {
  return raw.prepare(`PRAGMA table_info(${table})`).all();
}

function getPK(table) {
  const pk = tableInfo(table).find(c => c.pk);
  return pk ? pk.name : 'rowid';
}

class SqliteResource extends BaseResource {
  constructor(table, options = {}) {
    super({ id: table, name: table });
    this.table = table;
    this._pk = getPK(table);
    this._options = options;
    // FIX crash "edit" : AdminJS colle un ResourceDecorator cyclique sur
    // `resource._decorated`, et flat.flatten() (storeParams au save/update)
    // boucle à l'infini dessus. On le stocke en NON-ÉNUMÉRABLE :
    // invisible pour flat/Object.keys, mais lisible via le getter (decorate(), handlers).
    let _dec = this._decorated;
    Object.defineProperty(this, '_decorated', {
      get: () => _dec,
      set: (v) => { _dec = v; },
      enumerable: false,
      configurable: true,
    });
    this._cols = null;
  }

  static isAdapterFor(rawResource) {
    return rawResource instanceof SqliteResource;
  }

  databaseName() { return 'SQLite'; }
  id() { return this.table; }
  name() { return this.table; }

  properties() {
    const cols = tableInfo(this.table);
    return cols.map(c => new BaseProperty({
      path: c.name,
      isVisible: {
        list: true,
        show: true,
        edit: c.name !== this._pk,
        filter: true,
      },
      isId: c.name === this._pk,
      type: /int|real|numeric/i.test(c.type) ? 'number' : 'string',
    }));
  }

  property(propName) {
    return this.properties().find(p => p.path === propName) || null;
  }

  // AdminJS envoie les filtres sous forme d'OBJET { chemin: filtre } (classe Filters),
  // pas d'un tableau. On normalise les deux formes + accès path redondant (méthode ou string).
  _filterList(filters) {
    if (!filters) return [];
    const raw = filters.filters !== undefined ? filters.filters : filters;
    const arr = Array.isArray(raw) ? raw : Object.values(raw || {});
    const out = [];
    for (const f of arr) {
      if (!f || typeof f !== 'object') continue;
      const p = f.property;
      const path = typeof p?.path === 'function' ? p.path() : (p?.path ?? (typeof p === 'string' ? p : null) ?? f.path);
      const value = f.value && typeof f.value === 'object' && 'value' in f.value ? f.value.value : f.value;
      if (path) out.push({ path, value });
    }
    return out;
  }

  _columns() {
    if (!this._cols) this._cols = tableInfo(this.table);
    return this._cols;
  }

  // Ne garde que les vraies colonnes, convertit les types, refuse les rôles invalides.
  // Évite les crashs/erreurs SQL depuis le formulaire (ex: champs vides, clés parasites).
  _cleanParams(params, isCreate = false) {
    const cols = this._columns();
    const byName = Object.fromEntries(cols.map(c => [c.name, c]));
    const out = {};
    for (const k of Object.keys(params || {})) {
      if (!(k in byName)) continue;              // clé parasite du formulaire
      if (k === this._pk && !isCreate) continue; // PK gérée par le WHERE
      let v = params[k];
      if (v === undefined) continue;
      const type = byName[k].type || '';
      if (v === '' && /int|real|numeric/i.test(type)) v = null;
      if (this.table === 'users' && k === 'role' && v !== 'admin' && v !== 'user') {
        throw new ValidationError({ role: { message: 'Rôle invalide (admin ou user).' } });
      }
      out[k] = v;
    }
    return out;
  }

  _buildWhere(filters) {
    const params = [];
    let sql = '';
    for (const f of this._filterList(filters)) {
      if (f.value === undefined || f.value === null || f.value === '') continue;
      const col = String(f.path).replace(/"/g, '');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) continue; // whitelist anti-injection
      sql += (sql ? ' AND ' : ' WHERE ') + `"${col}" LIKE ?`;
      params.push(`%${f.value}%`);
    }
    return { sql, params };
  }

  async count(filters) {
    const { sql, params } = this._buildWhere(filters);
    const row = raw.prepare(`SELECT COUNT(*) AS n FROM "${this.table}"${sql}`).get(...params);
    return Number(row?.n || 0);
  }

  async find(filters, query = {}) {
    const { sql, params } = this._buildWhere(filters);
    const limit = Math.min(Number(query.limit) || 50, 200);
    const offset = Number(query.offset) || 0;
    const sortBy = query.sortBy || query.sort?.sortBy;
    const direction = String(query.direction || query.sort?.direction || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const cols = new Set(tableInfo(this.table).map(c => c.name));
    const order = sortBy && cols.has(sortBy) ? `"${sortBy}" ${direction}` : `"${this._pk}" DESC`;
    const rows = raw.prepare(`SELECT * FROM "${this.table}"${sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return rows.map(r => new BaseRecord(r, this));
  }

  async findOne(id) {
    const r = raw.prepare(`SELECT * FROM "${this.table}" WHERE "${this._pk}" = ?`).get(id);
    return r ? new BaseRecord(r, this) : null;
  }

  async create(params) {
    const p = this._cleanParams(params, true);
    delete p[this._pk];
    if (this.table === 'users' && p.password_hash && !p.password_hash.startsWith('scrypt:')) {
      p.password_hash = hashPassword(p.password_hash);
    }
    const keys = Object.keys(p);
    if (!keys.length) {
      throw new ValidationError({ _: { message: 'Aucune donnée à créer.' } });
    }
    const cols = keys.map(k => `"${k}"`).join(',');
    const vals = keys.map(() => '?');
    try {
      const r = raw.prepare(`INSERT INTO "${this.table}"(${cols}) VALUES(${vals})`).run(...keys.map(k => p[k]));
      return this.findOne(r.lastInsertRowid);
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      throw new ValidationError({ _: { message: 'Échec création : ' + e.message } });
    }
  }

  async update(pk, params) {
    const p = this._cleanParams(params, false);
    if (this.table === 'users' && p.password_hash && !p.password_hash.startsWith('scrypt:')) {
      p.password_hash = hashPassword(p.password_hash);
    }
    const keys = Object.keys(p);
    if (!keys.length) return this.findOne(pk);
    const set = keys.map(k => `"${k}" = ?`).join(', ');
    try {
      raw.prepare(`UPDATE "${this.table}" SET ${set} WHERE "${this._pk}" = ?`).run(...keys.map(k => p[k]), pk);
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      throw new ValidationError({ _: { message: 'Échec modification : ' + e.message } });
    }
    return this.findOne(pk);
  }

  async delete(pk) {
    raw.prepare(`DELETE FROM "${this.table}" WHERE "${this._pk}" = ?`).run(pk);
  }
}

function buildAdmin() {
  const db = require('./db');
  const auth = require('./auth');

  const admin = new AdminJS({
    rootPath: '/admin',
    branding: { companyName: 'WhatsApp Bot — Admin', withMadeWithLove: false },
    resources: [
      {
        resource: new SqliteResource('users'),
        options: {
          properties: {
            password_hash: { isVisible: { list: false, show: false, edit: false, filter: false } },
            id: { isVisible: { list: true, show: true } },
            role: {
              availableValues: [
                { value: 'admin', label: 'Administrateur' },
                { value: 'user', label: 'Utilisateur' },
              ],
            },
          },
          actions: {
            new: { isVisible: true },
            edit: { isVisible: true },
          },
        },
      },
      {
        resource: new SqliteResource('assistants'),
        options: {
          properties: {
            api_key: { isVisible: { list: false, show: false, edit: true, filter: false }, type: 'password' },
          },
        },
      },
      {
        resource: new SqliteResource('messages'),
        options: {
          actions: { new: { isVisible: false }, edit: { isVisible: false }, delete: { isVisible: false } },
        },
      },
      {
        resource: new SqliteResource('conversations'),
        options: {
          actions: { new: { isVisible: false }, edit: { isVisible: false }, delete: { isVisible: false } },
        },
      },
      { resource: new SqliteResource('settings'), options: {} },
    ],
  });

  return {
    admin,
    authenticate: async (email, password) => {
      const u = db.getUserByLogin(auth.normalizeLogin(email || ''));
      if (u && u.role === 'admin' && auth.verifyPassword(password || '', u.password_hash)) {
        return { email: u.login, title: u.login };
      }
      return null;
    },
  };
}

module.exports = { buildAdmin };
