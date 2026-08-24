#!/usr/bin/env node
// specwire-initiate-change（发起变更）：拉取分支 → propose → 提交推送 → 发起 GitLab Issue
// 用法：node <技能目录>/scripts/specwire-initiate-change.mjs <change-id> --type feat|fix [--todo] [--assignee <name>] [--stash]
// 依赖：Node.js、git、openspec CLI、glab（GitLab CLI；凭据由 glab 管理，先 glab auth status 确认已登录）
// 已知问题：本机 glab 解析 .local 域名需 GODEBUG=netdns=go（见 SKILL.md 前置检查）

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function die(msg) {
  throw new Error(msg);
}

process.on('uncaughtException', (e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});

function usage() {
  console.log(`用法：node <技能目录>/scripts/specwire-initiate-change.mjs <change-id> --type feat|fix [--todo] [--assignee <name>] [--stash]
流程：拉取分支(change/<type>-<change-id>) → openspec new change(propose) → commit/push → glab issue create
凭据：由 glab 管理（先执行 glab auth status 确认已登录）
--stash：开始时自动暂存已跟踪修改，结束时切回原分支并还原（不触碰未跟踪内容）`);
}

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
let changeId = null;
let type = null;
let todo = false;
let assignee = null;
let stashOpt = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--help' || a === '-h') { usage(); process.exit(0); }
  else if (a === '--todo') todo = true;
  else if (a === '--stash') stashOpt = true;
  else if (a === '--assignee') { assignee = argv[++i]; if (!assignee) die('--assignee 需要参数'); }
  else if (a === '--type') { type = argv[++i]; }
  else if (a.startsWith('-')) die(`未知参数：${a}`);
  else if (changeId) die('只接受一个 change-id');
  else changeId = a;
}
if (!changeId || !type) { usage(); die('缺少必填参数：<change-id> 与 --type feat|fix'); }
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(changeId)) {
  die('参数必须是 kebab-case 的 change-id，不接受变更描述；描述性需求请走 /openspec-propose（可先 /openspec-explore）');
}
if (!['feat', 'fix'].includes(type)) die('--type 只能是 feat（功能）或 fix（修复）');

// ---------- 前置自检 ----------
for (const [cmd, hint] of [['git', 'https://git-scm.com/'], ['openspec', 'npm i -g @fission-ai/openspec'], ['glab', 'brew install glab 或 https://gitlab.com/gitlab-org/cli']]) {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  if (r.status !== 0) die(`缺少 ${cmd}：请先安装（${hint}）`);
}

// ---------- git 助手 ----------
function gitOut(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) die(`git ${args.join(' ')} 失败：${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

// ---------- 仓库上下文 ----------
const repoRoot = git(['rev-parse', '--show-toplevel']);
process.chdir(repoRoot);
const upstream = gitOut(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
if (!upstream || !upstream.includes('/')) die('当前分支没有 upstream 跟踪分支');
const remote = upstream.split('/')[0];

// 默认分支自适应（origin/HEAD 探测，fallback main）
let defBranch = null;
const headRef = gitOut(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]);
if (headRef) defBranch = headRef.split('/').pop();
if (!defBranch) { defBranch = 'main'; console.log('→ 无法解析远端默认分支，fallback main'); }

const branch = `change/${type}-${changeId}`;
const oldBranch = gitOut(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'HEAD';

let stashed = false;
try {
  // ---------- 0. --stash：暂存已跟踪修改（不触碰未跟踪内容） ----------
  if (stashOpt) {
    const r = spawnSync('git', ['stash', 'push', '-m', `specwire-initiate-change: ${changeId}`], { encoding: 'utf8' });
    if (r.status === 0 && !/No local changes/.test(`${r.stdout} ${r.stderr}`)) {
      stashed = true;
      console.log('→ --stash：已暂存工作区已跟踪修改（结束自动还原）');
    }
  }

  // ---------- 1. 拉取分支 ----------
  git(['fetch', remote, defBranch]);
  if (gitOut(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) !== null) {
    die(`分支 ${branch} 已存在（可能重复发起；确认后删除再跑）`);
  }
  git(['checkout', '-b', branch, `${remote}/${defBranch}`]);
  console.log(`→ 分支 ${branch}（基于 ${remote}/${defBranch}）`);

  // ---------- 2. opsx:propose ----------
  const changeDir = `openspec/changes/${changeId}`;
  if (!existsSync(changeDir)) {
    // 原分支已撰写但未推送的内容自动带入，否则生成骨架
    const r = spawnSync('git', ['cat-file', '-e', `${oldBranch}:${changeDir}`], { encoding: 'utf8' });
    if (r.status === 0) {
      git(['checkout', oldBranch, '--', changeDir]);
      console.log(`→ 从 ${oldBranch} 带入已撰写的 ${changeDir}`);
    } else {
      const p = spawnSync('openspec', ['new', 'change', changeId], { encoding: 'utf8' });
      if (p.status !== 0) die(`openspec new change 失败：${(p.stderr || p.stdout).trim()}`);
      console.log(`→ 骨架已生成：${changeDir}`);
    }
  } else {
    console.log(`→ 已存在 ${changeDir}，跳过 propose`);
  }
  git(['add', '-A', '--', changeDir]);
  if (gitOut(['diff', '--cached', '--quiet']) === null) {
    // 有暂存改动：提交（git diff --cached 非 0 即有差异）
    git(['commit', '-q', '-m', `spec(${changeId}): initiate change`]);
  } else {
    console.log('→ 无改动（变更已包含在分支基线），跳过提交');
  }
  const headSha = git(['rev-parse', 'HEAD']);

  // ---------- 3. 推送分支 ----------
  git(['push', '-q', '-u', remote, branch]);
  console.log(`→ 分支 ${branch} 已推送（${headSha}）`);

  // ---------- 4. 发起 GitLab Issue（经 glab，凭据由 glab 管理） ----------
  const remoteUrl = git(['remote', 'get-url', remote]);
  const m = remoteUrl.match(new RegExp('[:/]([^/:]+/[^/:]+?)(?:\\.git)?/?$'));
  if (!m) die(`无法从 remote URL 推断 GitLab 项目路径：${remoteUrl}`);
  const project = m[1];
  let desc = `change_id: ${changeId}\nbranch: ${branch}\nbranch_head_sha: ${headSha}`;
  if (todo) desc += `\nSpecWire-Status: todo`;
  if (assignee) desc += `\nSpecWire-Assignee: ${assignee}`;

  const g = spawnSync('glab', [
    'issue', 'create', '--repo', project,
    '--title', `[change] ${changeId}`,
    '--label', 'change',
    '--description', desc,
    '--yes',
  ], { encoding: 'utf8' });
  if (g.status !== 0) die(`glab issue create 失败：${(g.stderr || g.stdout || '').trim().slice(0, 300)}`);
  // glab 非交互下 create 通常不输出编号：从 issue list 按标题反查（最新在前）
  let iid = '?';
  const out = `${g.stdout} ${g.stderr}`;
  const iidMatch = out.match(/issues\/(\d+)/) ?? out.match(/#(\d+)/);
  if (iidMatch) {
    iid = iidMatch[1];
  } else {
    const list = spawnSync('glab', ['issue', 'list', '--repo', project, '--per-page', '10'], { encoding: 'utf8' });
    const row = list.status === 0 ? list.stdout.split('\n').find((l) => l.includes(`[change] ${changeId}`)) : undefined;
    const m = row?.match(/#(\d+)/);
    if (m) iid = m[1];
  }
  console.log(`✓ 已发起 ${changeId}：分支 ${branch}（${headSha}）→ Issue #${iid}（tag: change）`);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
} finally {
  if (stashed) {
    let r = spawnSync('git', ['checkout', oldBranch], { encoding: 'utf8' });
    if (r.status === 0) r = spawnSync('git', ['stash', 'pop'], { encoding: 'utf8' });
    if (r.status === 0) console.log('→ --stash：已切回原分支并还原工作区');
    else console.error(`⚠ --stash 还原失败：${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
  }
}
