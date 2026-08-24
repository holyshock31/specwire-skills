#!/usr/bin/env node
// specwire-preflight：SpecWire 管线前置体检（零副作用：只探测 + 给修复建议，不修复）
// 用法：node <技能目录>/scripts/specwire-preflight.mjs [init|review|merge|archive|all] [--project <group/project>] [--bridge]
// 默认 all = 全链路；指定目标只查该环前置。退出码：0=无 ❌，1=存在 ❌
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

function die(msg) { throw new Error(msg); }
process.on('uncaughtException', (e) => { console.error(`✗ ${e.message}`); process.exit(1); });

function usage() {
  console.log(`用法：
  node <技能目录>/scripts/specwire-preflight.mjs [init|review|merge|archive|all] [--project <group/project>] [--bridge]
说明：零副作用体检工具链/认证/网络/SSH/仓库态/阶段前置，每项附修复建议
  默认：all（全链路）；--bridge 附加检查 Bridge 容器运行状态`);
}

// ---------- 参数 ----------
const argv = process.argv.slice(2);
let target = 'all';
let project = null;
let bridgeCheck = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--help' || a === '-h') { usage(); process.exit(0); }
  else if (a === '--bridge') bridgeCheck = true;
  else if (a === '--project') { project = argv[++i]; if (!project) die('--project 需要 group/project'); }
  else if (a.startsWith('-')) die(`未知参数：${a}`);
  else if (!['init', 'review', 'merge', 'archive', 'all'].includes(a)) die(`未知目标：${a}（init|review|merge|archive|all）`);
  else target = a;
}

let okCount = 0, warnCount = 0, failCount = 0;
let repoPath = null;
function ok(msg) { okCount++; console.log(`  ✅ ${msg}`); }
function warn(msg) { warnCount++; console.log(`  ⚠️  ${msg}`); }
function fail(msg) { failCount++; console.log(`  ❌ ${msg}`); }
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 25000, ...opts });
}

console.log(`# SpecWire 前置体检（目标: ${target}${bridgeCheck ? ' + bridge' : ''}）\n`);

// ---------- 1. 工具链 ----------
console.log('## 工具链');
for (const [cmd, hint] of [
  ['git', 'brew install git / https://git-scm.com'],
  ['glab', 'brew install glab（GitLab CLI）'],
  ['openspec', 'npm i -g @fission-ai/openspec'],
]) {
  if (cmd === 'node') continue;
  const r = run(cmd, ['--version']);
  r.status === 0 ? ok(`${cmd} ${r.stdout.trim().split('\n')[0] || ''}`) : fail(`${cmd} 未安装 — 修复：${hint}`);
}
ok(`node ${process.version}`);

// ---------- 2. 认证与网络 ----------
console.log('\n## 认证 & 网络');
const hasNetdns = /netdns=go/.test(process.env.GODEBUG || '');
if (!hasNetdns) warn('GODEBUG 未含 netdns=go（若存在 .local 域名解析超时：export GODEBUG=netdns=go）');
const u = run('glab', ['api', 'user']);
if (u.status === 0) {
  try { ok(`glab 认证有效：${JSON.parse(u.stdout).username || '用户'}`); } catch { ok('glab 认证有效（token 可访问 API）'); }
} else {
  const tail = `${u.stderr}${u.stdout}`.trim().slice(0, 120);
  fail(`glab 无法访问 API（${tail}）— 修复：① export GODEBUG=netdns=go ② glab auth login --hostname <实例> --token <PAT>`);
}

// ---------- 3. 仓库上下文（git 仓库内才做） ----------
console.log('\n## 仓库');
const top = run('git', ['rev-parse', '--show-toplevel']);
if (top.status !== 0) {
  warn('不在 git 仓库内（后续仓库检查跳过）');
} else {
  process.chdir(top.stdout.trim());
  const remotes = (run('git', ['remote']).stdout || '').trim().split('\n').filter(Boolean);
  const remoteName = remotes.includes('origin')
    ? 'origin'
    : remotes.find((r) => (run('git', ['remote', 'get-url', r]).stdout || '').includes('gitlab')) || remotes[0];
  const remote = run('git', ['remote', 'get-url', remoteName]);
  if (remote.status !== 0) {
    fail('无可用 remote — 修复：git remote add origin <url>');
  } else {
    const m = remote.stdout.trim().match(new RegExp('[:/]([^/:]+/[^/:]+?)(?:\\.git)?/?$'));
    repoPath = project || (m ? m[1] : null);
    if (repoPath) ok(`origin → ${repoPath}`); else warn('无法从 origin 推断项目（后续阶段检查将受限 — 可 --project 指定）');
    const ls = run('git', ['ls-remote', remoteName, 'HEAD'], { timeout: 20000 });
    ls.status === 0 ? ok('SSH 免密可访问远端（ls-remote ok）') : fail(`SSH 推送不通（${`${ls.stderr}${ls.stdout}`.trim().slice(0, 100)}）— 修复：配置 SSH key 或 GIT_SSH_COMMAND='ssh -i <key> -o IdentitiesOnly=yes'`);
    let defBranch = 'main';
    const headRef = run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (headRef.status === 0) defBranch = headRef.stdout.trim().split('/').pop();
    ok(`默认分支：${defBranch}`);
    const up = run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    up.status === 0 ? ok(`upstream：${up.stdout.trim()}`) : fail('当前分支无 upstream 跟踪 — 修复：git push -u origin <branch>');
    // 远端领先/本地领先/分叉
    const f = run('git', ['fetch', '-q', remoteName, defBranch]);
    if (f.status === 0) {
      const behind = parseInt(run('git', ['rev-list', '--count', `${defBranch}..${remoteName}/${defBranch}`]).stdout.trim() || '0', 10);
      const ahead = parseInt(run('git', ['rev-list', '--count', `${remoteName}/${defBranch}..${defBranch}`]).stdout.trim() || '0', 10);
      if (ahead > 0 && behind > 0) fail(`main 与远端分叉（ahead ${ahead} / behind ${behind}）— 修复：git merge ${remoteName}/${defBranch} 或 git rebase ${remoteName}/${defBranch}`)
      else if (behind > 0) warn(`本地落后远端 ${behind} 提交 — 修复：git pull --ff-only`);
      else if (ahead > 0) warn(`本地领先远端 ${ahead} 提交（未推送 — 注意归档前先处理）`);
      else ok('本地与远端同步');
    } else {
      warn(`无法 fetch（${`${f.stderr}${f.stdout}`.trim().slice(0, 100)}）— 远端不可达`);
    }
    const dirty = run('git', ['status', '--porcelain']);
    const dirtyLines = dirty.stdout.trim().split('\n').filter(Boolean);
    if (dirtyLines.some((l) => /^[ MARCUD?]{2} [^?]/.test(l) && !l.startsWith('??'))) {
      warn(`工作区有已跟踪修改（${dirtyLines.length} 行）— 修复：git stash 或使用 --stash 参数`);
    } else if (dirtyLines.length) {
      warn(`工作区有未跟踪内容（${dirtyLines.length} 项）— 一般不影响管线`);
    } else {
      ok('工作区干净');
    }
    if (!existsSync('openspec')) warn('非 OpenSpec 仓库（openspec/ 不存在）— 管线需 openspec 根目录');
  }
}

// ---------- 4. 阶段专属（只读探测） ----------
if (target === 'review' || target === 'merge' || target === 'all') {
  console.log('\n## MR 可读性');
  if (!repoPath) { warn('未推断项目，跳过 MR 检查（可用 --project 指定）'); }
  else {
    const mr = run('glab', ['mr', 'list', '--repo', repoPath, '--per-page', '5']);
    mr.status === 0 ? ok('MR 列表可读') : warn('MR 列表不可读（合并/评审前确认 glab 登录与仓库权限）');
  }
}
if (target === 'archive' || target === 'all') {
  console.log('\n## Issue 可读性（归档关联验证用）');
  if (!repoPath) { warn('未推断项目，跳过 Issue 检查（可用 --project 指定）'); }
  else {
    const iss = run('glab', ['issue', 'list', '--repo', repoPath, '--per-page', '5']);
    iss.status === 0 ? ok('Issue 列表可读') : warn('Issue 列表不可读（归档验证前确认 glab 登录与仓库权限）');
  }
}

// ---------- 5. --bridge ----------
if (bridgeCheck) {
  console.log('\n## Bridge');
  const dps = run('docker', ['ps', '--filter', 'name=specwire-bridge', '--format', '{{.Names}} {{.Status}}']);
  if (dps.status === 0 && /specwire-bridge/.test(dps.stdout)) {
    ok(`Bridge 容器运行中：${dps.stdout.trim()}`);
    warn('注意：容器内 GitLab token 与 glab 独立——归档关 Issue 失败时查 bridge/.env 与 docker logs specwire-bridge');
  } else {
    fail('Bridge 容器未运行/不可见（非 Bridge 宿主机器可忽略；本机修复：cd <bridge 目录> && docker compose up -d）');
  }
}

// ---------- 汇总 ----------
console.log(`\n# 汇总：✅ ${okCount} · ⚠️ ${warnCount} · ❌ ${failCount}`);
if (failCount > 0) {
  console.log('存在 ❌：按上方修复建议处理后重跑；管线各环节仍以实际结果为准（本体检不替代环节内校验）');
  process.exit(1);
}
