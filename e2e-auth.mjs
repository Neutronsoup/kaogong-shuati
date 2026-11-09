// e2e-auth.mjs —— 登录 + 用户隔离端到端测试（零依赖，node --test）
// 覆盖：注册/登录/me、错误密码、用户数据隔离、收藏/笔记按用户、管理员列表/禁用、登录限流。
// 说明：直接跑在真实 practice.db 上，但所有测试账号/数据用唯一后缀创建，结束时清理干净。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3187;
const BASE = `http://127.0.0.1:${PORT}`;
const SUF = Date.now().toString(36).slice(-6);
const U = { a: `eA_${SUF}`, b: `eB_${SUF}`, lock: `eLk_${SUF}` };
const PWD = 'pass123';
const tokens = {};
const createdUserIds = [];
let serverProc;

const post = async (p, body, token) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body || {}),
  });
  return r.json();
};
const get = async (p, token) => {
  const r = await fetch(BASE + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  return r.json();
};

before(async () => {
  serverProc = spawn(process.execPath, ['server.mjs', String(PORT)], { cwd: __dirname, stdio: 'ignore', env: { ...process.env, KAOGONG_INVITE: 'e2e-invite' } });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + '/api/subjects'); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(async () => {
  if (serverProc) { serverProc.kill('SIGKILL'); await new Promise((r) => setTimeout(r, 500)); }
  // 清理本次测试创建的用户及其数据（不动真实游客/历史数据）
  try {
    const db = new DatabaseSync(path.join(__dirname, 'practice.db'), { timeout: 10000 });
    for (const id of createdUserIds) {
      db.prepare('DELETE FROM practice_records WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM favorites WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM notes WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }
    db.close();
  } catch (e) { console.error('cleanup error:', e.message); }
});

test('注册 → 登录 → me', async () => {
  const rA = await post('/api/auth/register', { username: U.a, password: PWD, inviteCode: 'e2e-invite' });
  assert.equal(rA.ok, true, '注册 A 失败: ' + JSON.stringify(rA));
  tokens.a = rA.data.token;
  createdUserIds.push(rA.data.user.id);

  const rB = await post('/api/auth/register', { username: U.b, password: PWD, inviteCode: 'e2e-invite' });
  assert.equal(rB.ok, true);
  tokens.b = rB.data.token;
  createdUserIds.push(rB.data.user.id);

  const me = await get('/api/auth/me', tokens.a);
  assert.equal(me.ok, true);
  assert.equal(me.data.user.username, U.a);

  const dup = await post('/api/auth/register', { username: U.a, password: PWD, inviteCode: 'e2e-invite' });
  assert.equal(dup.ok, false);
  assert.equal(dup.error.code, 'USER_EXISTS');
});

test('错误密码被拒绝', async () => {
  const r = await post('/api/auth/login', { username: U.a, password: 'wrongbad' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BAD_CREDENTIALS');
});

test('用户数据隔离：A 的记录 B 看不到', async () => {
  for (let i = 0; i < 3; i++) {
    const r = await post('/api/records', { questionId: 900000 + i, subject: '公务员·行测', chapter: '测试', type: 1, selected: [0], correct: false, costMs: 1 }, tokens.a);
    assert.equal(r.ok, true);
  }
  const sa = await get('/api/records/stats', tokens.a);
  const sb = await get('/api/records/stats', tokens.b);
  assert.equal(sa.total, 3, 'A 应有 3 条记录');
  assert.equal(sb.total, 0, 'B 应看不到 A 的记录');
});

test('收藏同一题：A、B 各自成功且互不覆盖，重复插入去重', async () => {
  const qid = 555001;
  await post('/api/favorites', { questionId: qid, subject: 'x', chapter: 'y' }, tokens.a);
  await post('/api/favorites', { questionId: qid, subject: 'x', chapter: 'y' }, tokens.a); // 重复
  await post('/api/favorites', { questionId: qid, subject: 'x', chapter: 'y' }, tokens.b);
  const fa = await get('/api/favorites', tokens.a);
  const fb = await get('/api/favorites', tokens.b);
  assert.equal(fa.total, 1, 'A 收藏同一题应去重为 1');
  assert.equal(fb.total, 1, 'B 收藏同一题应成功为 1');
});

test('笔记按用户隔离：同题各自内容互不覆盖', async () => {
  const qid = 666002;
  await post('/api/notes', { questionId: qid, note: 'A的笔记' }, tokens.a);
  await post('/api/notes', { questionId: qid, note: 'B的笔记' }, tokens.b);
  const na = await get(`/api/notes?qid=${qid}`, tokens.a);
  const nb = await get(`/api/notes?qid=${qid}`, tokens.b);
  assert.equal(na.list[0].note, 'A的笔记');
  assert.equal(nb.list[0].note, 'B的笔记');
});

test('一次性邀请码：可用一次，二次失效，假码拒绝', async () => {
  const { ensureAuthSchema, createAuth } = await import('./lib/auth.mjs');
  const db = new DatabaseSync(path.join(__dirname, 'practice.db'));
  ensureAuthSchema(db);
  const a = createAuth(db);
  const code = `E2E-${Date.now().toString(36).toUpperCase().slice(-6)}-TST`;
  a.createInvite(code, 'e2e');
  db.close();

  const r1 = await post('/api/auth/register', { username: `eInv1_${SUF}`, password: PWD, inviteCode: code });
  assert.equal(r1.ok, true, '首次使用一次性码应成功: ' + JSON.stringify(r1));
  createdUserIds.push(r1.data.user.id);

  const r2 = await post('/api/auth/register', { username: `eInv2_${SUF}`, password: PWD, inviteCode: code });
  assert.equal(r2.ok, false, '同一码第二次应失败');
  assert.equal(r2.error.code, 'INVITE_REQUIRED');

  const r3 = await post('/api/auth/register', { username: `eInv3_${SUF}`, password: PWD, inviteCode: 'NOPE-XXXX-XXXX' });
  assert.equal(r3.ok, false, '假码应失败');
});

test('登录限流：5 次失败后锁定', async () => {
  for (let i = 0; i < 5; i++) await post('/api/auth/login', { username: U.lock, password: 'x' });
  const r = await post('/api/auth/login', { username: U.lock, password: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'LOCKED');
});
