#!/usr/bin/env node
// specwire-initiate-change（发起变更）：拉取分支 → propose → 提交推送 → 发起 GitLab Issue
// 用法：node <技能目录>/scripts/specwire-initiate-change.mjs <change-id> --type feat|fix [--todo] [--assignee <name>] [--stash] [--dry-run]
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
  console.log(`用法：node <技能目录>/scripts/specwire-initiate-change.mjs <change-id> --type feat|fix [--todo] [--assignee <name>] [--stash] [--dry-run]
流程：拉取分支(change/<type>-<change-id>) → openspec new change(propose) → commit/push → glab issue create
凭据：由 glab 管理（先执行 glab auth status 确认已登录）
--stash：开始时自动暂存已跟踪修改，结束时切回原分支并精确还原（不触碰未跟踪内容）
--dry-run：只输出执行计划，不执行 stash、fetch、checkout、生成、提交、推送或创建 Issue`);
}

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
let changeId = null;
let type = null;
let todo = false;
let assignee = null;
let stashOpt = false;
let dryRun = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--help' || a === '-h') { usage(); process.exit(0); }
  else if (a === '--todo') todo = true;
  else if (a === '--stash') stashOpt = true;
  else if (a === '--dry-run') dryRun = true;
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
const oldRef = oldBranch === 'HEAD' ? git(['rev-parse', 'HEAD']) : oldBranch;
const changeDir = `openspec/changes/${changeId}`;
const remoteUrl = git(['remote', 'get-url', remote]);
const projectMatch = remoteUrl.match(new RegExp('[:/]([^/:]+/[^/:]+?)(?:\\.git)?/?$'));
if (!projectMatch) die(`无法从 remote URL 推断 GitLab 项目路径：${remoteUrl}`);
const project = projectMatch[1];
const trackedDirty = Boolean(gitOut(['status', '--porcelain', '--untracked-files=no']));
const localBranchExists = gitOut(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) !== null;

// ---------- dry-run：严格零写入，必须早于 stash / fetch / checkout ----------
if (dryRun) {
  console.log('\n[dry-run] 将执行：');
  if (trackedDirty && !stashOpt) console.log('  阻塞条件：工作区有已跟踪修改；实际执行前需选择 --stash 或自行清理');
  if (localBranchExists) console.log(`  阻塞条件：本地分支 ${branch} 已存在；需先确认如何处理重复发起`);
  if (stashOpt) console.log('  git stash push（仅在存在已跟踪修改时创建独立 stash）');
  console.log(`  git fetch ${remote} ${defBranch}`);
  console.log(`  git checkout -b ${branch} ${remote}/${defBranch}`);
  if (existsSync(changeDir)) console.log(`  使用现有 ${changeDir}`);
  else {
    const onOldBranch = spawnSync('git', ['cat-file', '-e', `${oldRef}:${changeDir}`], { encoding: 'utf8' }).status === 0;
    console.log(onOldBranch ? `  从 ${oldBranch} 带入 ${changeDir}` : `  openspec new change ${changeId}`);
  }
  console.log(`  git add/commit ${changeDir}`);
  console.log(`  git push -u ${remote} ${branch}`);
  console.log(`  glab issue create --repo ${project} --title "[change] ${changeId}"${todo ? '（描述含 SpecWire-Status: todo）' : ''}${assignee ? `（描述含 SpecWire-Assignee: ${assignee}）` : ''}`);
  if (stashOpt) console.log(`  切回 ${oldBranch}，并仅还原本次创建的 stash`);
  console.log('\n[dry-run] 未执行任何写操作或远端变更。');
  process.exit(0);
}

if (trackedDirty && !stashOpt) die('工作区有已跟踪修改；请先处理，或在用户确认后加 --stash 自动暂存并还原');
if (localBranchExists) die(`分支 ${branch} 已存在（可能重复发起；请先确认继续使用、改名或删除）`);

let stashCommit = null;
let switchedBranch = false;

function stashTrackedChanges() {
  const before = gitOut(['rev-parse', '--verify', 'refs/stash']);
  const r = spawnSync('git', ['stash', 'push', '-m', `specwire-initiate-change: ${changeId}`], { encoding: 'utf8' });
  if (r.status !== 0) die(`git stash push 失败：${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
  const after = gitOut(['rev-parse', '--verify', 'refs/stash']);
  if (after && after !== before) {
    console.log('→ --stash：已暂存工作区已跟踪修改（结束精确还原）');
    return after;
  }
  console.log('→ --stash：没有需要暂存的已跟踪修改');
  return null;
}

try {
  // ---------- 0. --stash：暂存已跟踪修改（不触碰未跟踪内容） ----------
  if (stashOpt) stashCommit = stashTrackedChanges();

  // ---------- 1. 拉取分支 ----------
  git(['fetch', remote, defBranch]);
  git(['checkout', '-b', branch, `${remote}/${defBranch}`]);
  switchedBranch = true;
  console.log(`→ 分支 ${branch}（基于 ${remote}/${defBranch}）`);

  // ---------- 2. opsx:propose ----------
  if (!existsSync(changeDir)) {
    // 原分支已撰写但未推送的内容自动带入，否则生成骨架
    const r = spawnSync('git', ['cat-file', '-e', `${oldRef}:${changeDir}`], { encoding: 'utf8' });
    if (r.status === 0) {
      git(['checkout', oldRef, '--', changeDir]);
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
  let branchReady = true;
  if (stashOpt && switchedBranch) {
    const r = spawnSync('git', ['checkout', oldRef], { encoding: 'utf8' });
    branchReady = r.status === 0;
    if (!branchReady) console.error(`⚠ 无法切回原分支 ${oldBranch}：${(r.stderr || r.stdout || '').trim().slice(0, 180)}`);
    else if (!stashCommit) console.log(`→ --stash：已切回原分支 ${oldBranch}（本次未创建 stash）`);
  }
  if (stashCommit && branchReady) {
    const top = gitOut(['rev-parse', '--verify', 'refs/stash']);
    const args = top === stashCommit ? ['stash', 'pop', '--index', 'stash@{0}'] : ['stash', 'apply', '--index', stashCommit];
    const r = spawnSync('git', args, { encoding: 'utf8' });
    if (r.status === 0 && top === stashCommit) console.log('→ --stash：已还原本次暂存的工作区修改');
    else if (r.status === 0) console.log(`⚠ 已还原本次工作区修改，但 stash 栈已变化；为安全起见保留记录 ${stashCommit.slice(0, 12)}`);
    else console.error(`⚠ --stash 还原失败；本次 stash ${stashCommit.slice(0, 12)} 仍保留：${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
  }
}
