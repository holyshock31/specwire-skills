#!/usr/bin/env node
// specwire-merge-change（许可合并）：校验 MR 关联与状态 → glab mr merge → 清理评审 worktree → 输出归档前指引
// 用法：node <技能目录>/scripts/specwire-merge-change.mjs <change-id> --mr <编号> [--squash] [--force-cleanup] [--allow-non-main] [--dry-run] [--repo <group/project>]
// 边界：调用即 = 合并许可；不改 change 分支（change/feat-*）；不执行规格归档（仅输出指引）；源分支由 MR/GitLab 设置控制，本技能不删
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

function die(msg) { throw new Error(msg); }
process.on('uncaughtException', (e) => { console.error(`✗ ${e.message}`); process.exit(1); });

function usage() {
  console.log(`用法：
  node <技能目录>/scripts/specwire-merge-change.mjs <change-id> --mr <编号> [--squash] [--force-cleanup] [--allow-non-main] [--dry-run] [--repo <group/project>]
说明：调用即 = 合并许可；先校验 MR 关联与状态，再合并（不改 change 分支、不归档规格）
  --squash          压缩合并（默认常规 merge commit，保留实现提交与 trailer）
  --force-cleanup   强制删除有未提交修改的评审 worktree（需用户明确授权）
  --allow-non-main  允许目标分支不是 main（需用户明确确认）
  --dry-run         只预览将执行的命令与清理清单，不执行`);
}

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
let changeId = null;
let mr = null;
let repo = null;
let squash = false;
let forceCleanup = false;
let allowNonMain = false;
let dryRun = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--help' || a === '-h') { usage(); process.exit(0); }
  else if (a === '--mr') { mr = argv[++i]; if (!mr) die('--mr 需要编号'); }
  else if (a === '--repo') { repo = argv[++i]; if (!repo) die('--repo 需要 group/project'); }
  else if (a === '--squash') squash = true;
  else if (a === '--force-cleanup') forceCleanup = true;
  else if (a === '--allow-non-main') allowNonMain = true;
  else if (a === '--dry-run') dryRun = true;
  else if (a.startsWith('-')) die(`未知参数：${a}`);
  else if (changeId) die('只接受一个 change-id（放 --mr 前）');
  else changeId = a;
}
if (!changeId) { usage(); die('缺少 change-id'); }
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(changeId)) die('change-id 需为 kebab-case');
if (!mr) { usage(); die('缺少 --mr 编号'); }
if (!/^\d+$/.test(mr)) die('--mr 需要数字编号');

// ---------- 前置自检 ----------
for (const cmd of ['git', 'glab']) {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  if (r.status !== 0) die(`缺少 ${cmd}：请先安装`);
}

// ---------- 仓库上下文 & 项目推断 ----------
function gitOut(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
const repoRoot = gitOut(['rev-parse', '--show-toplevel']);
if (!repoRoot) die('不在 git 仓库内（需在目标仓库运行）');
process.chdir(repoRoot);
// R-3：remote 名自适应（origin 优先，否则找含 gitlab 的 remote，再退首个）
const remotes = (gitOut(['remote']) || '').split('\n').filter(Boolean);
const remoteName = remotes.includes('origin')
  ? 'origin'
  : remotes.find((r) => (gitOut(['remote', 'get-url', r]) || '').includes('gitlab')) || remotes[0];
if (!remoteName) die('仓库无 remote，无法推断项目（可 --repo 指定）');
if (!repo) {
  const remoteUrl = gitOut(['remote', 'get-url', remoteName]);
  if (!remoteUrl) die(`无法读取 remote ${remoteName} 的 URL`);
  const m = remoteUrl.match(new RegExp('[:/]([^/:]+/[^/:]+?)(?:\\.git)?/?$'));
  if (!m) die(`无法从 remote URL 推断 GitLab 项目：${remoteUrl}`);
  repo = m[1];
  if (remoteName !== 'origin') console.log(`→ 项目推断自 remote「${remoteName}」`);
}

// ---------- 校验 MR：状态与关联 ----------
const view = spawnSync('glab', ['mr', 'view', mr, '--repo', repo, '--output', 'json'], { encoding: 'utf8' });
if (view.status !== 0) die(`glab mr view ${mr} 失败：${(view.stderr || view.stdout || '').trim().slice(0, 200)}`);
let mrd;
try { mrd = JSON.parse(view.stdout); } catch { die(`glab mr view 输出解析失败：${view.stdout.slice(0, 200)}`); }
const source = mrd.source_branch;
const target = mrd.target_branch || 'main';
if (!source) die(`MR #${mr} 缺少 source_branch`);
if (mrd.state !== 'opened') die(`MR #${mr} 状态为 ${mrd.state}（只能合并 opened 的 MR）`);
if (target !== 'main' && !allowNonMain) die(`MR #${mr} 的目标分支是 ${target}，不是 main；确认无误后显式加 --allow-non-main`);
if (target !== 'main') console.log(`⚠ 已显式允许合并到非 main 目标分支：${target}`);
const desc = `${mrd.description || ''}\n${mrd.title || ''}`;
if (!desc.includes(changeId)) die(`MR #${mr} 未关联 change-id「${changeId}」（防合并错 MR）`);
console.log(`→ 校验通过：MR #${mr}（${source} → ${target}）关联 ${changeId}`);

// ---------- 预览（--dry-run 不执行） ----------
const mergeCmd = `glab mr merge ${mr} --repo ${repo}${squash ? ' --squash' : ''} --yes`;
const reviewWt = path.join(repoRoot, '.worktrees', `review-${mr}`);
const baseWt = path.join(repoRoot, '.worktrees', `base-${mr}`);

function worktreeState(wt) {
  if (!existsSync(wt)) return { exists: false, dirty: false, error: null };
  const r = spawnSync('git', ['-C', wt, 'status', '--porcelain'], { encoding: 'utf8' });
  if (r.status !== 0) return { exists: true, dirty: true, error: (r.stderr || r.stdout || '').trim().slice(0, 160) };
  return { exists: true, dirty: Boolean(r.stdout.trim()), error: null };
}

if (dryRun) {
  console.log('\n[dry-run] 将执行：');
  console.log(`  ${mergeCmd}`);
  console.log('  清理：');
  let found = false;
  for (const wt of [reviewWt, baseWt]) {
    const state = worktreeState(wt);
    if (!state.exists) continue;
    found = true;
    if (state.dirty && !forceCleanup) console.log(`  保留 ${wt}（有未提交修改${state.error ? `；状态检查异常：${state.error}` : ''}）`);
    else console.log(`  git worktree remove${state.dirty ? ' --force' : ''} ${wt}`);
  }
  if (!found) console.log('  （无 review/base worktree 需清理）');
  console.log('\n[dry-run] 未执行任何操作。');
  process.exit(0);
}

// ---------- 合并 ----------
console.log(`→ 执行合并：${mergeCmd}`);
const g = spawnSync('glab', ['mr', 'merge', mr, '--repo', repo, '--yes', ...(squash ? ['--squash'] : [])], { encoding: 'utf8' });
if (g.status !== 0) die(`合并失败：${(g.stderr || g.stdout || '').trim().slice(0, 300)}`);
console.log(`✓ MR #${mr} 已合并（${(g.stdout || '').trim().split('\n')[0] || ''}）`);

// ---------- 清理评审 worktree（幂等，失败不阻断） ----------
for (const wt of [reviewWt, baseWt]) {
  const state = worktreeState(wt);
  if (!state.exists) continue;
  if (state.dirty && !forceCleanup) {
    console.log(`⚠ 已保留有未提交修改的 worktree：${wt}${state.error ? `（状态检查异常：${state.error}）` : ''}；确认可丢弃后再用 --force-cleanup`);
    continue;
  }
  const r = spawnSync('git', ['worktree', 'remove', ...(state.dirty ? ['--force'] : []), wt], { encoding: 'utf8' });
  console.log(r.status === 0 ? `→ 已清理：${wt}` : `⚠ 清理失败（可稍后手动）：${wt} —— ${(r.stderr || '').trim().slice(0, 120)}`);
}

// ---------- 归档前指引 ----------
console.log('\n【归档前指引 · 合并已完成】');
console.log(`1. 同步 main：git stash → git checkout main && git pull`);
console.log(`2. 归档规格：openspec archive ${changeId}`);
console.log(`3. 推送触发 Bridge：git add -A && git commit -m "spec: archive ${changeId}" \\`);
console.log(`     -m "SpecWire-Event: archived" -m "SpecWire-Change: ${changeId}" && git push origin main`);
console.log('   （Bridge 收到 archived 提交 → 自动关闭 Issue + 卡置 done；本地 change 分支可后续自行处理）');
