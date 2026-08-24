#!/usr/bin/env node
// specwire-review-change（验证审核）：列出 MR → 评审（元数据校验 / 拉分支 / worktree / 测试）→ 报告 + 人工闸门
// 用法：
//   node <技能目录>/scripts/specwire-review-change.mjs                        # 列出打开中 MR（让人选）
//   node <技能目录>/scripts/specwire-review-change.mjs --mr <编号>            # 评审该 MR（change_id 自动从 MR 描述提取）
//   node <技能目录>/scripts/specwire-review-change.mjs <change-id> --mr <编号> # 严格校验（MR 必须关联该 change-id）
//   --repo <group/project>               # 覆盖 remote 推断
// 依赖：git、glab（凭据由 glab 管理）；不自动合并、不清理 worktree（人工闸门）
// 已知问题：本机 glab 解析 .local 域名需 GODEBUG=netdns=go

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';

function die(msg) { throw new Error(msg); }
process.on('uncaughtException', (e) => { console.error(`✗ ${e.message}`); process.exit(1); });

function usage() {
  console.log(`用法：
  node <技能目录>/scripts/specwire-review-change.mjs                         # 列出打开中 MR，选定后带 --mr 再跑
  node <技能目录>/scripts/specwire-review-change.mjs --mr <编号>             # 评审该 MR（change_id 从 MR 描述自动提取）
  node <技能目录>/scripts/specwire-review-change.mjs <change-id> --mr <编号> # 严格校验（MR 必须关联该 change-id）
  --repo <group/project>                # 覆盖 remote 推断
  --diff                                # 控制台输出完整 diff（按需，默认只给入口）
  --diff-file <path>                    # 只输出某文件的 diff（--diff 的单文件版）`);
}

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
let changeId = null;
let mr = null;
let repo = null;
let diffOpt = false;
let diffFile = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--help' || a === '-h') { usage(); process.exit(0); }
  else if (a === '--mr') { mr = argv[++i]; if (!mr) die('--mr 需要编号'); }
  else if (a === '--repo') { repo = argv[++i]; if (!repo) die('--repo 需要 group/project'); }
  else if (a === '--diff') diffOpt = true;
  else if (a === '--diff-file') { diffFile = argv[++i]; if (!diffFile) die('--diff-file 需要文件路径'); }
  else if (a.startsWith('-')) die(`未知参数：${a}`);
  else if (changeId) die('只接受一个 change-id（放 --mr 前）');
  else { changeId = a; }
}
if (changeId && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(changeId)) die('change-id 需为 kebab-case');

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

// ---------- 模式一：无 --mr → 列出打开中 MR ----------
if (!mr) {
  const r = spawnSync('glab', ['mr', 'list', '--repo', repo], { encoding: 'utf8' });
  if (r.status !== 0) die(`glab mr list 失败：${(r.stderr || '').trim().slice(0, 200)}`);
  console.log((r.stdout || '').trim() || '（没有打开中的 MR，或该仓库无 MR）');
  console.log(`\n选定后运行：node <技能目录>/scripts/specwire-review-change.mjs --mr <编号> --repo ${repo}`);
  process.exit(0);
}
if (!/^\d+$/.test(mr)) die('--mr 需要数字编号');

// ---------- 模式二：评审指定 MR ----------
const view = spawnSync('glab', ['mr', 'view', mr, '--repo', repo, '--output', 'json'], { encoding: 'utf8' });
if (view.status !== 0) die(`glab mr view ${mr} 失败：${(view.stderr || view.stdout || '').trim().slice(0, 200)}`);
let mrd;
try { mrd = JSON.parse(view.stdout); } catch { die(`glab mr view 输出解析失败：${view.stdout.slice(0, 200)}`); }
const source = mrd.source_branch;
const target = mrd.target_branch || 'main';
if (!source) die(`MR #${mr} 缺少 source_branch`);
if (target !== 'main') console.log(`⚠ 目标分支非 main：${target}`);
const desc = `${mrd.description || ''}\n${mrd.title || ''}`;
if (changeId) {
  if (!desc.includes(changeId)) die(`MR #${mr} 未关联 change-id「${changeId}」（严格校验失败，防审错 MR）`);
  console.log(`→ 严格校验通过：MR 关联 ${changeId}`);
} else {
  const m = desc.match(/(?:SpecWire-Change|change_id)[:：]\s*([a-zA-Z0-9-]+)/);
  if (m) { changeId = m[1]; console.log(`→ 从 MR 描述提取 change_id：${changeId}`); }
  else console.log('⚠ MR 未声明关联变更（描述缺 SpecWire-Change / change_id）');
}

// ---------- 拉取 + 改动范围 ----------
git(['fetch', '-q', remoteName, source, target]);
const diffStat = spawnSync('git', ['diff', '--stat', `${remoteName}/${target}...FETCH_HEAD`], { encoding: 'utf8' });
console.log(`→ 改动范围（vs ${remoteName}/${target}）：\n${(diffStat.stdout || '').trim() || '（无差异？请确认分支）'}`);
if (diffOpt) {
  console.log(`→ 完整 diff（vs ${remoteName}/${target}）：`);
  console.log(spawnSync('git', ['diff', `${remoteName}/${target}...FETCH_HEAD`], { encoding: 'utf8' }).stdout);
} else if (diffFile) {
  const d = spawnSync('git', ['diff', `${remoteName}/${target}...FETCH_HEAD`, '--', diffFile], { encoding: 'utf8' });
  console.log(`→ ${diffFile} 的 diff：\n${d.stdout || '（无该文件差异）'}`);
}

// ---------- worktree 拉取（项目内 .worktrees/，独立目录，供测试与视觉实测） ----------
const wt = path.join(repoRoot, '.worktrees', `review-${mr}`);
if (existsSync(wt)) die(`worktree 目录已存在：${wt}（先 git worktree remove 再跑）`);
// 确保 .worktrees/ 被本地排除（git status 不污染；幂等）
const excludeFile = path.join(repoRoot, '.git', 'info', 'exclude');
try {
  const cur = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
  if (!cur.split('\n').some((l) => l.trim() === '.worktrees/')) {
    appendFileSync(excludeFile, '\n.worktrees/\n');
    console.log('→ 已将 .worktrees/ 追加到 .git/info/exclude（本地生效，git status 不污染）');
  }
} catch { /* 追加失败不阻断 */ }
git(['worktree', 'add', '-q', '--detach', wt, 'FETCH_HEAD']);
console.log(`→ 代码已 checkout（${source} @ FETCH_HEAD）：${wt}`);
const nm = path.join(repoRoot, 'node_modules');
if (existsSync(nm) && !existsSync(path.join(wt, 'node_modules'))) {
  try { symlinkSync(nm, path.join(wt, 'node_modules'), 'dir'); console.log('→ 软链 node_modules（复用主 checkout 依赖）'); }
  catch { console.log('⚠ 软链 node_modules 失败（Windows 无权限等）：请先在 worktree 内安装依赖（如 npm install）'); }
}

// ---------- 自动测试（多栈探测：npm / pytest / cargo / go / make；按确定性分级：强门 / 弱门） ----------
const WEAK_SCRIPTS = new Set(['smoke']); // 弱门：读真实环境态，失败需对照判定
const results = [];
function detectTests(cwd) {
  const t = [];
  const has = (f) => existsSync(path.join(cwd, f));
  try {
    if (has('package.json')) {
      const scripts = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')).scripts || {};
      for (const s of ['lint', 'typecheck', 'test', 'e2e', 'smoke']) if (scripts[s]) t.push({ name: s, cmd: ['npm', 'run', s], weak: WEAK_SCRIPTS.has(s) });
    }
  } catch { console.log('⚠ package.json 解析失败，跳过 npm 脚本'); }
  if (has('pyproject.toml') || has('pytest.ini') || has('tox.ini') || has('setup.py')) t.push({ name: 'pytest', cmd: ['python', '-m', 'pytest'], weak: false });
  if (has('Cargo.toml')) t.push({ name: 'cargo test', cmd: ['cargo', 'test'], weak: false });
  if (has('go.mod')) t.push({ name: 'go test', cmd: ['go', 'test', './...'], weak: false });
  if (has('Makefile')) t.push({ name: 'make test', cmd: ['make', 'test'], weak: false });
  return t;
}
function runScript(entry, cwd, display = entry.name) {
  console.log(`→ ${display}（${entry.weak ? '弱门·环境态' : '强门·确定性'}）...`);
  const t = spawnSync(entry.cmd[0], entry.cmd.slice(1), { cwd, encoding: 'utf8', timeout: 300000 });
  const tail = `${t.stdout || ''} ${t.stderr || ''}`.trim().slice(-400);
  return { name: entry.name, ok: t.status === 0, tail, weak: entry.weak, verdict: null, entry };
}
const avail = detectTests(wt);
console.log(avail.length ? `→ 探测到质量门：${avail.map((e) => e.name).join(', ')}` : '⚠ 未探测到已知质量门（npm / pytest / cargo / go / make），跳过自动测试');
for (const e of avail) results.push(runScript(e, wt));
// 弱门失败 → 自动 base 对照（通用判定：base 同败=环境态，base 通过=真回归）
const weakFails = results.filter((r) => !r.ok && r.weak);
if (weakFails.length) {
  const baseWt = path.join(repoRoot, '.worktrees', `base-${mr}`);
  if (existsSync(baseWt)) die(`base worktree 已存在：${baseWt}（先 git worktree remove 再跑）`);
  console.log(`→ 弱门失败，自动 base 对照（检出 ${remoteName}/${target} → ${baseWt}，同测试重跑）...`);
  git(['worktree', 'add', '-q', '--detach', baseWt, `${remoteName}/${target}`]);
  const nm2 = path.join(repoRoot, 'node_modules');
  if (existsSync(nm2) && !existsSync(path.join(baseWt, 'node_modules'))) {
    try { symlinkSync(nm2, path.join(baseWt, 'node_modules'), 'dir'); }
    catch { console.log('⚠ 软链 node_modules 失败（Windows 无权限等）：请先在 base worktree 内安装依赖'); }
  }
  for (const r of weakFails) {
    const b = runScript(r.entry, baseWt, `${r.name} [base]`);
    r.verdict = b.ok ? 'base 通过 → 真回归（建议打回）' : `base 同败 → 环境态（与 MR 无关）`;
    r.tail = `${r.tail}｜base: ${b.tail}`;
  }
}

// ---------- 报告 ----------
console.log('\n============== 验证报告 ==============');
console.log(`MR      : #${mr} ${mrd.title || ''}`);
console.log(`分支    : ${source} → ${target}`);
console.log(`change  : ${changeId || '未关联'}`);
console.log(`测试    : ${results.length ? results.map((r) => `${r.name}=${r.ok ? 'PASS' : 'FAIL'}(${r.weak ? '弱' : '强'})`).join(' ') : '无可用脚本'}`);
const strongFails = results.filter((r) => !r.ok && !r.weak);
if (strongFails.length) {
  console.log(`处置    : 强门失败（${strongFails.map((r) => r.name).join(', ')}）→ 大概率真回归，建议打回（评论说明问题）`);
} else if (weakFails.some((r) => r.verdict?.startsWith('base 通过'))) {
  console.log('处置    : 弱门失败且 base 通过 → 真回归，建议打回');
} else if (weakFails.length) {
  console.log(`处置    : 弱门失败且 base 同败 → 环境态，与 MR 无关（${weakFails.map((r) => r.verdict).join('; ')}）`);
} else {
  console.log('处置    : 全部质量门通过 → 可进入人工闸门（视觉实测）');
}
for (const r of results) if (!r.ok && r.verdict) console.log(`  └ ${r.name} 对照：${r.verdict}`);
for (const r of results) if (!r.ok) console.log(`  └ ${r.name} 摘要：${r.tail}`);
console.log('\n查看改动 diff：');
console.log(`  · 网页：glab mr view ${mr} --repo ${repo}`);
console.log(`  · 终端：git diff ${remoteName}/${target}...${remoteName}/${source}`);
console.log(`  · 代码：${wt}`);
let runHint = `cd ${wt} && 按项目惯例启动（如 npm start / python manage.py runserver / cargo run / make run）`;
try {
  const pk = existsSync(path.join(wt, 'package.json')) ? JSON.parse(readFileSync(path.join(wt, 'package.json'), 'utf8')) : null;
  if (pk?.scripts?.start) runHint = `cd ${wt} && npm start`;
} catch { /* 保持通用提示 */ }
console.log('\n【人工闸门 · 技能不代做】');
console.log(`1. 视觉实测：${runHint}`);
console.log('   检查点（按变更意图验证关键行为；主题/交互等顺带快速过）');
console.log(`2. 合并许可：glab mr merge ${mr} --repo ${repo}（仅你执行或显式授权）`);
console.log(`3. 审后清理：git worktree remove ${wt}${weakFails.length ? ` && git worktree remove .worktrees/base-${mr}` : ''}`);
