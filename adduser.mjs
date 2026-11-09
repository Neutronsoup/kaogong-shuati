#!/usr/bin/env node
// adduser.mjs —— 管理员账号维护 CLI（零依赖）
// 用法：
//   node adduser.mjs add 小明 123456            # 建普通账号
//   node adduser.mjs add owner 密码 --admin     # 建管理员(可管理 AI 配置)
//   node adduser.mjs list                       # 列出所有账号（含状态/最后登录）
//   node adduser.mjs passwd 小明 newpass123     # 重置密码
//   node adduser.mjs ban 小明                   # 禁用（并踢下线）
//   node adduser.mjs unban 小明                 # 解禁
//   node adduser.mjs del 小明                   # 删除账号（连同其会话）
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ensureAuthSchema, createAuth } from './lib/auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, 'practice.db');

const [cmd, a1, a2, a3] = process.argv.slice(2);

function open() {
  const pdb = new DatabaseSync(DB_FILE, { timeout: 10000 });
  ensureAuthSchema(pdb);
  return { pdb, auth: createAuth(pdb) };
}

function usage() {
  console.log(`用法:
  node adduser.mjs add <昵称> <密码> [--admin]
  node adduser.mjs list
  node adduser.mjs passwd <昵称> <新密码>
  node adduser.mjs ban <昵称>
  node adduser.mjs unban <昵称>
  node adduser.mjs del <昵称>`);
}

const { pdb, auth } = open();
try {
  if (cmd === 'add') {
    if (!a1 || !a2) { usage(); process.exit(1); }
    const role = process.argv.includes('--admin') ? 'admin' : 'user';
    const id = auth.createUser(a1, a2, role);
    console.log(`✓ 已创建${role === 'admin' ? '管理员' : '用户'} #${id}：${a1}`);
  } else if (cmd === 'list') {
    const rows = auth.listUsers();
    if (!rows.length) { console.log('（暂无账号）'); }
    else {
      console.log('ID  昵称'.padEnd(20) + '状态   最后登录');
      for (const u of rows) {
        console.log(
          String(u.id).padEnd(4) +
          String(u.username).padEnd(16) +
          (u.status === 1 ? '正常  ' : '禁用  ') +
          (u.last_login_at || '-')
        );
      }
    }
  } else if (cmd === 'passwd') {
    if (!a1 || !a2) { usage(); process.exit(1); }
    const u = auth.findUserByName(a1);
    if (!u) { console.error(`✗ 用户不存在：${a1}`); process.exit(1); }
    auth.setPassword(u.id, a2);
    console.log(`✓ 已重置 ${a1} 的密码`);
  } else if (cmd === 'ban' || cmd === 'unban') {
    if (!a1) { usage(); process.exit(1); }
    const u = auth.findUserByName(a1);
    if (!u) { console.error(`✗ 用户不存在：${a1}`); process.exit(1); }
    auth.setStatus(u.id, cmd === 'unban');
    console.log(`✓ 已${cmd === 'ban' ? '禁用' : '解禁'} ${a1}`);
  } else if (cmd === 'del') {
    if (!a1) { usage(); process.exit(1); }
    const u = auth.findUserByName(a1);
    if (!u) { console.error(`✗ 用户不存在：${a1}`); process.exit(1); }
    pdb.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    pdb.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    console.log(`✓ 已删除 ${a1}（其做题记录/收藏/笔记作为普通数据保留，user_id 悬挂；如需彻底清理请手动处理）`);
  } else {
    usage();
    process.exit(1);
  }
} catch (e) {
  console.error(`✗ ${e.code ? '[' + e.code + '] ' : ''}${e.message}`);
  process.exit(1);
} finally {
  try { pdb.close(); } catch {}
}
