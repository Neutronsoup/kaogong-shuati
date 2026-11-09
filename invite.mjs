#!/usr/bin/env node
// invite.mjs —— 邀请码管理 CLI（一人一码、用一次失效）
// 用法（线上在容器内执行：docker exec kaogong node invite.mjs ...）：
//   node invite.mjs gen 10                     # 生成 10 个一次性邀请码
//   node invite.mjs gen 5 --note 内测A --days 7 # 带备注、7 天后过期
//   node invite.mjs list                       # 列出全部邀请码及状态
//   node invite.mjs revoke <code>              # 作废某未使用的码
//   node invite.mjs del <code>                 # 删除某条邀请码记录
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { ensureAuthSchema, createAuth } from './lib/auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, 'practice.db');

// 生成短码：去掉易混淆字符（0/O/1/I）
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  const bytes = randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

const args = process.argv.slice(2);
const cmd = args[0];
function flag(name, def = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const pdb = new DatabaseSync(DB_FILE, { timeout: 10000 });
ensureAuthSchema(pdb);
const auth = createAuth(pdb);

try {
  if (cmd === 'gen') {
    const n = Math.max(1, Math.min(500, Number(args[1]) || 1));
    const note = flag('note', '');
    const days = Number(flag('days', 0)) || 0;
    const expiresAt = days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null;
    const out = [];
    for (let i = 0; i < n; i++) {
      let code;
      do { code = genCode(); } while (auth.findInvite(code));
      auth.createInvite(code, note, expiresAt);
      out.push(code);
    }
    console.log(`✓ 已生成 ${n} 个一次性邀请码${note ? `（备注：${note}）` : ''}${expiresAt ? `，过期：${expiresAt}` : '，未使用前永久有效'}：`);
    for (const c of out) console.log('  ' + c);
  } else if (cmd === 'list') {
    const rows = auth.listInvites();
    if (!rows.length) { console.log('（暂无邀请码，用 `gen` 生成）'); }
    else {
      const st = { 0: '未使用', 1: '已使用', 2: '已作废' };
      console.log('邀请码'.padEnd(18) + '状态'.padEnd(8) + '备注'.padEnd(14) + '创建时间'.padEnd(20) + '使用信息');
      for (const r of rows) {
        console.log(
          String(r.code).padEnd(16) +
          String(st[r.status] || r.status).padEnd(6) +
          String(r.note || '').padEnd(12) +
          String(r.created_at || '').padEnd(20) +
          (r.status === 1 ? `user#${r.used_by} @ ${r.used_at}` : (r.expires_at ? `过期于 ${r.expires_at}` : ''))
        );
      }
    }
  } else if (cmd === 'revoke') {
    const code = args[1];
    if (!code) { console.error('用法: node invite.mjs revoke <code>'); process.exit(1); }
    console.log(auth.revokeInvite(code) ? `✓ 已作废 ${code}` : `✗ 未找到未使用的码：${code}`);
  } else if (cmd === 'del') {
    const code = args[1];
    if (!code) { console.error('用法: node invite.mjs del <code>'); process.exit(1); }
    const r = pdb.prepare('DELETE FROM invites WHERE code = ?').run(code);
    console.log(r.changes ? `✓ 已删除 ${code}` : `✗ 未找到：${code}`);
  } else {
    console.log(`用法:
  node invite.mjs gen <数量> [--note 备注] [--days 有效天数]
  node invite.mjs list
  node invite.mjs revoke <code>
  node invite.mjs del <code>`);
    process.exit(1);
  }
} finally {
  try { pdb.close(); } catch {}
}
