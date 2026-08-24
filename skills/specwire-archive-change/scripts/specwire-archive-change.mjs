#!/usr/bin/env node
// specwire-archive-change（任务归档）：同步 main → openspec archive → archived trailer 推送 → 验证（GitLab Issue closed + Multica 卡提示）
// 用法：node <技能目录>/scripts/specwire-archive-change.mjs <change-id> [--stash] [--dry-run] [--repo <group/project>]
// 边界：不删 change 分支；不直接调用 Bridge API——事件驱动：archived trailer 推送触发 Bridge 自动关 Issue/置卡 done
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

function die(msg) { throw new Error(msg); }
process.on('uncaughtException', (e) => { console.error(`✗ ${e.message}`); process.exit(1); });

function usage() {
  console.log(`用法：
  node <技能目录>/scripts/specwire-archive-change.mjs <change-id> [--stash] [--dry-run] [--repo <group/project>]
说明：将已合并的 change 归档（同步 main → openspec archive → archived trailer 推送 → 验证闭环）
  --stash          自动暂存已跟踪修改并全程还原（同 specwire-initiate-change）
  --dry-run        预览将执行的命令，不执行`);
}

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
let changeId = null;
let repo = null;
let stashOpt = false;
let dryRun = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--help' || a === '-h') { usage(); process.exit(0); }
  else if (a === '--repo') { repo = argv[++i]; if (!repo) die('--repo 需要 group/project'); }
  else if (a === '--stash') stashOpt = true;
  else if (a === '--dry-run') dryRun = true;
  else if (a.startsWith('-')) die(`未知参数：${a}`);
  else if (changeId) die('只接受一个 change-id');
  else changeId = a;
}
if (!changeId) { usage(); die('缺少 change-id'); }
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(changeId)) die('change-id 需为 kebab-case');

// ---------- 前置自检 ----------
for (const cmd of ['git', 'glab', 'openspec']) {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  if (r.status !== 0) die(`缺少 ${cmd}：请先安装`);
}

// ---------- 仓库上下文 & 项目推断 ----------
function gitOut(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) die(`git ${args.join(' ')} 失败：${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}
const repoRoot = git(['rev-parse', '--show-toplevel']);
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
let defBranch = null;
const headRef = gitOut(['symbolic-ref', '--short', `refs/remotes/origin/HEAD`]);
if (headRef) defBranch = headRef.split('/').pop();
if (!defBranch) { defBranch = 'main'; console.log('→ 无法解析远端默认分支，fallback main'); }

// ---------- 材料性校验：change 状态 + 实施痕迹提示 ----------
const activeDir = path.join('openspec', 'changes', changeId);
let archived = false;
try {
  const inArchive = (readdirSync(path.join('openspec', 'changes', 'archive')) || [])
    .some((d) => d === changeId || d.endsWith(`-${changeId}`));
  archived = inArchive;
} catch { archived = false; }
if (!existsSync(activeDir) && !archived) die(`未找到 change：${changeId}（openspec/changes/ 与 archive/ 均无——未合并归档在前？先 specwire-merge-change）`);
const state = archived ? 'archived' : 'active';
if (state === 'archived') console.log('→ change 已在 archive/（幂等：直接进入验证环节）');
if (state === 'active') {
  console.log(existsSync(path.join(activeDir, 'implementation.md'))
    ? '→ 实施痕迹 ✓（change 已在 main 上，含 implementation.md）'
    : '⚠ 未发现 implementation.md（确定已实现？确认后继续）');
}

// ---------- 同步 main（仅 active 需要；--stash 全程还原） ----------
let stashed = false;
let origBranch = null;
try {
  if (state === 'active') {
    origBranch = gitOut(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'HEAD';
    const cur = origBranch;
    if (cur !== defBranch) {
      if (!stashOpt) die(`需在 ${defBranch} 分支归档（当前 ${cur}）；或加 --stash 自动处理`);
      spawnSync('git', ['stash', 'push', '-m', `specwire-archive-change: ${changeId}`], { encoding: 'utf8' });
      stashed = true;
      console.log('→ --stash：已暂存已跟踪修改');
      git(['checkout', defBranch]);
    }
    if (stashOpt && !stashed) {
      const r = spawnSync('git', ['stash', 'push', '-m', `specwire-archive-change: ${changeId}`], { encoding: 'utf8' });
      if (r.status === 0 && !/No local changes/.test(`${r.stdout} ${r.stderr}`)) {
        stashed = true;
        console.log('→ --stash：已暂存已跟踪修改');
      }
    }
    git(['fetch', '-q', remoteName, defBranch]);
    const m = spawnSync('git', ['merge', '--ff-only', `${remoteName}/${defBranch}`], { encoding: 'utf8' });
    if (m.status !== 0) die(`main 无法快进（分叉？）：${(m.stderr || m.stdout || '').trim().slice(0, 200)} —— 先处理分叉（git merge ${remoteName}/${defBranch} 或 push）再归档`);
    console.log(`→ main 已同步（含 MR 合并结果）`);
  }

  // ---------- dry-run 预览 ----------
  if (dryRun) {
    console.log('\n[dry-run] 将执行：');
    if (state === 'active') {
      console.log(`  openspec archive ${changeId} -y --json`);
      console.log('  精确暂存：git add <归档前后快照差分路径>（仅归档改动，不含工作区其他内容）');
      console.log(`  git commit -m "spec: archive ${changeId}" -m "SpecWire-Event: archived" -m "SpecWire-Change: ${changeId}"`);
      console.log(`  git push origin ${defBranch}`);
    }
    console.log('  验证：glab issue list 找 [change] <id> → 轮询 closed；multica issue list 核对卡状态');
    console.log('\n[dry-run] 未执行任何操作。');
    process.exit(0);
  }

  // ---------- 归档（仅 active；非交互；commit 仅含归档改动本身） ----------
  if (state === 'active') {
    console.log(`→ openspec archive ${changeId} ...`);
    const before = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout;
    const ar = spawnSync('openspec', ['archive', changeId, '-y', '--json'], { encoding: 'utf8', timeout: 120000 });
    if (ar.status !== 0) die(`openspec archive 失败：${(ar.stderr || ar.stdout || '').trim().slice(0, 300)}（tasks 未勾完或工件不一致？先补全再试，或经确认 --no-validate）`);
    console.log('→ 归档完成（规格已并入 + change 移入 archive/）');
    // 精确暂存：仅归档产生的前后快照差分（不裹挟工作区其他改动）
    const after = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout;
    const delta = after.split('\n').filter((l) => l.trim() && !before.includes(l));
    const deltaPaths = delta.map((l) => l.slice(3));
    if (!deltaPaths.length) {
      console.log('→ 归档无本地改动（已归档过），跳过提交');
    } else {
      console.log(`→ 暂存范围（仅归档改动）：\n${deltaPaths.map((p) => `    ${p}`).join('\n')}`);
      git(['add', '--', ...deltaPaths]);
      git(['commit', '-q', '-m', `spec: archive ${changeId}`, '-m', 'SpecWire-Event: archived', '-m', `SpecWire-Change: ${changeId}`]);
      console.log('→ 已提交（archived trailer，仅含归档改动）');
    }
    try {
      git(['push', '-q', remoteName, defBranch]);
      console.log(`→ 已推送 ${remoteName}/${defBranch}（Bridge 收到 archived trailer → 自动关 Issue + 置卡 done）`);
    } catch (e) {
      die(`推送失败：${String(e.message).slice(0, 200)}（本地已归档未推送：修复后 git push ${remoteName} ${defBranch}）`);
    }
  }

  // ---------- 验证 ----------
  const iss = spawnSync('glab', ['issue', 'list', '--repo', repo, '--per-page', '50'], { encoding: 'utf8' });
  const row = iss.status === 0 ? iss.stdout.split('\n').find((l) => l.includes(`[change] ${changeId}`)) : undefined;
  const iid = row?.match(/#(\d+)/)?.[1];
  if (iid) {
    console.log(`→ 验证 GitLab Issue #${iid}（等待 Bridge 关闭，轮询 ≤50s）...`);
    let closed = false;
    for (let i = 0; i < 10; i++) {
      const v = spawnSync('glab', ['issue', 'view', iid, '--repo', repo, '--output', 'json'], { encoding: 'utf8' });
      try { if (JSON.parse(v.stdout).state === 'closed') { closed = true; break; } } catch { /* keep polling */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
    }
    console.log(closed ? `✓ Issue #${iid} 已 closed` : '⚠ Issue 尚未 closed（Bridge 可能未触发：检查归档推送 / Bridge 日志；稍后重跑本技能即幂等验证）');
  } else {
    console.log(`⚠ 未找到 [change] ${changeId} 的 Issue（跳过 Issue 验证）`);
  }
  try {
    const ml = spawnSync('multica', ['issue', 'list'], { encoding: 'utf8' });
    const mrow = ml.status === 0 ? ml.stdout.split('\n').find((l) => l.includes(changeId)) : undefined;
    if (mrow) console.log(`→ Multica：${mrow.trim().slice(0, 140)}`);
    else console.log('→ Multica 卡：未在 issue list 中匹配（可用 multica issue list 核对；Bridge 应已置 done）');
  } catch { /* multica 不可用则不阻断 */ }
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
} finally {
  if (stashed) {
    let r = spawnSync('git', ['checkout', origBranch], { encoding: 'utf8' });
    if (r.status === 0) r = spawnSync('git', ['stash', 'pop'], { encoding: 'utf8' });
    console.log(r.status === 0 ? '→ --stash：已切回原分支并还原工作区' : `⚠ --stash 还原失败：${(r.stderr || '').trim().slice(0, 150)}`);
  }
}
