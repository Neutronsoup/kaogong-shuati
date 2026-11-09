// lib/auth.mjs —— 零依赖认证（node:crypto 自带 scrypt，无第三方库）
//   - 密码哈希：scrypt$<saltHex>$<hashHex>（每条随机盐；恒定时间比较）
//   - 会话：有状态 token 存 sessions 表（可主动踢人、可统计在线），30 天有效
//   - 表结构：ensureAuthSchema(pdb) 幂等建表/补列；favorites/notes 的唯一约束重建在 server.mjs 迁移里做
//   - 所有函数通过 createAuth(pdb) 绑定到同一个 practice.db 连接，避免多连接写锁
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天

// ---------- 密码哈希 ----------
export function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(pw), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(pw, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const [, salt, hash] = parts;
    const calc = scryptSync(String(pw), salt, 64);
    const expect = Buffer.from(hash, 'hex');
    return calc.length === expect.length && timingSafeEqual(calc, expect);
  } catch {
    return false;
  }
}

// ---------- 表结构（幂等） ----------
//   users / sessions；practice_records、notes 补 user_id 列（favorites 由 server.mjs 重建，见迁移）
export function ensureAuthSchema(pdb) {
  pdb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user',
      status        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      expires_at TEXT NOT NULL,
      user_agent TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS invites (
      code       TEXT PRIMARY KEY,
      note       TEXT DEFAULT '',
      status     INTEGER NOT NULL DEFAULT 0,   -- 0 未用 / 1 已用 / 2 作废
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      expires_at TEXT,
      used_at    TEXT,
      used_by    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_invites_status ON invites(status);
  `);
  // 现有表补 user_id（已存在则 ALTER 抛错忽略，复用 server.mjs 里同款 try/catch 迁移手法）
  for (const t of ['practice_records', 'notes']) {
    try { pdb.exec(`ALTER TABLE ${t} ADD COLUMN user_id INTEGER DEFAULT NULL`); } catch { /* 已存在 */ }
  }
  try { pdb.exec('CREATE INDEX IF NOT EXISTS idx_records_user ON practice_records(user_id, created_at)'); } catch { /* ignore */ }
  try { pdb.exec('CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id)'); } catch { /* ignore */ }
}

// ---------- 工厂：把认证能力绑定到一个 db 连接 ----------
export function createAuth(pdb) {
  const userByName = (username) =>
    pdb.prepare('SELECT * FROM users WHERE username = ?').get(String(username));

  return {
    hashPassword,
    verifyPassword,

    findUserByName: userByName,

    createUser(username, password, role = 'user') {
      const name = String(username).trim();
      if (!/^[\u4e00-\u9fa5A-Za-z0-9_\-.]{2,20}$/.test(name)) {
        const e = new Error('昵称需为 2-20 位中文/字母/数字/下划线');
        e.code = 'BAD_USERNAME';
        throw e;
      }
      if (String(password).length < 6) {
        const e = new Error('密码至少 6 位');
        e.code = 'BAD_PASSWORD';
        throw e;
      }
      if (userByName(name)) {
        const e = new Error('该昵称已被注册');
        e.code = 'USER_EXISTS';
        throw e;
      }
      const r = pdb.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
        .run(name, hashPassword(password), role === 'admin' ? 'admin' : 'user');
      return Number(r.lastInsertRowid);
    },

    setPassword(userId, password) {
      if (String(password).length < 6) {
        const e = new Error('密码至少 6 位');
        e.code = 'BAD_PASSWORD';
        throw e;
      }
      pdb.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .run(hashPassword(password), Number(userId));
    },

    setStatus(userId, status) {
      pdb.prepare('UPDATE users SET status = ? WHERE id = ?').run(status ? 1 : 0, Number(userId));
      if (!status) pdb.prepare('DELETE FROM sessions WHERE user_id = ?').run(Number(userId)); // 禁用即踢下线
    },

    listUsers() {
      return pdb.prepare(
        'SELECT id, username, role, status, created_at, last_login_at FROM users ORDER BY id'
      ).all();
    },

    // ---------- 邀请码（一人一码、用一次失效）----------
    createInvite(code, note = '', expiresAt = null) {
      pdb.prepare('INSERT INTO invites (code, note, expires_at) VALUES (?, ?, ?)')
        .run(String(code), String(note || ''), expiresAt || null);
      return String(code);
    },
    findInvite(code) {
      return pdb.prepare('SELECT * FROM invites WHERE code = ?').get(String(code || ''));
    },
    listInvites() {
      return pdb.prepare(
        'SELECT code, note, status, created_at, expires_at, used_at, used_by FROM invites ORDER BY created_at DESC, code'
      ).all();
    },
    // 原子消费：仅当未用且未过期才置为已用；返回是否成功
    consumeInvite(code, userId) {
      const r = pdb.prepare(
        "UPDATE invites SET status = 1, used_at = datetime('now','localtime'), used_by = ? WHERE code = ? AND status = 0"
      ).run(Number(userId), String(code));
      return r.changes === 1;
    },
    revokeInvite(code) {
      const r = pdb.prepare('UPDATE invites SET status = 2 WHERE code = ? AND status = 0').run(String(code));
      return r.changes === 1;
    },

    createSession(userId, userAgent = '') {
      const token = randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
      pdb.prepare('INSERT INTO sessions (token, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)')
        .run(token, Number(userId), expires, String(userAgent || '').slice(0, 200));
      return token;
    },

    getUserByToken(token) {
      const t = String(token || '').trim();
      if (!t) return null;
      const s = pdb.prepare(`
        SELECT s.user_id, s.expires_at, u.username, u.role, u.status
        FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ?
      `).get(t);
      if (!s) return null;
      if (new Date(s.expires_at).getTime() < Date.now()) {
        pdb.prepare('DELETE FROM sessions WHERE token = ?').run(t);
        return null;
      }
      if (s.status !== 1) return null; // 被禁用
      return { id: s.user_id, username: s.username, role: s.role };
    },

    deleteSession(token) {
      pdb.prepare('DELETE FROM sessions WHERE token = ?').run(String(token || ''));
    },
  };
}
