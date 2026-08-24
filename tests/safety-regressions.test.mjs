import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = {
  archive: path.join(root, 'skills/specwire-archive-change/scripts/specwire-archive-change.mjs'),
  initiate: path.join(root, 'skills/specwire-initiate-change/scripts/specwire-initiate-change.mjs'),
  merge: path.join(root, 'skills/specwire-merge-change/scripts/specwire-merge-change.mjs'),
  review: path.join(root, 'skills/specwire-review-change/scripts/specwire-review-change.mjs'),
};

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

function must(command, args, options = {}) {
  const result = run(command, args, options);
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function git(repo, args) {
  return must('git', args, { cwd: repo });
}

function createRepo({ bareRemote = false } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'specwire-skills-test-'));
  const repo = path.join(base, 'work');
  mkdirSync(repo);
  must('git', ['init', '--initial-branch=main'], { cwd: repo });
  git(repo, ['config', 'user.name', 'SpecWire Tests']);
  git(repo, ['config', 'user.email', 'specwire-tests@example.com']);
  mkdirSync(path.join(repo, 'openspec', 'changes', 'demo-change'), { recursive: true });
  writeFileSync(path.join(repo, 'README.md'), 'initial\n');
  writeFileSync(path.join(repo, 'openspec', 'changes', 'demo-change', 'implementation.md'), 'implemented\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial']);

  let remote = null;
  if (bareRemote) {
    remote = path.join(base, 'remote.git');
    mkdirSync(remote);
    must('git', ['init', '--bare', '--initial-branch=main'], { cwd: remote });
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', '-u', 'origin', 'main']);
  } else {
    git(repo, ['remote', 'add', 'origin', 'https://gitlab.example/group/project.git']);
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    git(repo, ['branch', '--set-upstream-to=origin/main', 'main']);
  }
  return { base, repo, remote };
}

function createFakeTools(base) {
  const bin = path.join(base, 'fake-bin');
  mkdirSync(bin);

  const glab = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('glab test'); process.exit(0); }
if (args[0] === 'issue' && args[1] === 'list') process.exit(0);
if (args[0] === 'mr' && args[1] === 'view') {
  console.log(JSON.stringify({
    source_branch: 'change/feat-demo-change',
    target_branch: process.env.GLAB_TARGET || 'main',
    state: 'opened',
    title: process.env.GLAB_UNLINKED ? 'ordinary MR' : 'demo-change',
    description: process.env.GLAB_UNLINKED ? '' : 'change_id: demo-change',
  }));
  process.exit(0);
}
if (args[0] === 'mr' && args[1] === 'merge') {
  if (process.env.GLAB_LOG) appendFileSync(process.env.GLAB_LOG, args.join(' ') + '\\n');
  console.log('merged');
  process.exit(0);
}
console.error('unexpected glab call: ' + args.join(' '));
process.exit(91);
`;
  const openspec = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('openspec test'); process.exit(0); }
if (args[0] === 'archive') {
  if (process.env.OPENSPEC_LOG) appendFileSync(process.env.OPENSPEC_LOG, args.join(' ') + '\\n');
  const changeId = args[1];
  const archive = path.join(process.cwd(), 'openspec', 'changes', 'archive');
  mkdirSync(archive, { recursive: true });
  renameSync(path.join(process.cwd(), 'openspec', 'changes', changeId), path.join(archive, changeId));
  console.log('{}');
  process.exit(0);
}
console.error('unexpected openspec call: ' + args.join(' '));
process.exit(92);
`;
  writeFileSync(path.join(bin, 'glab'), glab);
  writeFileSync(path.join(bin, 'openspec'), openspec);
  chmodSync(path.join(bin, 'glab'), 0o755);
  chmodSync(path.join(bin, 'openspec'), 0o755);
  return bin;
}

function childEnv(bin, extra = {}) {
  return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...extra };
}

function snapshot(repo) {
  return {
    branch: git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']),
    head: git(repo, ['rev-parse', 'HEAD']),
    refs: git(repo, ['show-ref']),
    stash: run('git', ['rev-parse', '--verify', 'refs/stash'], { cwd: repo }).stdout.trim(),
    status: git(repo, ['status', '--porcelain']),
  };
}

test('archive --dry-run does not stash, switch, fetch, merge, or modify files', (t) => {
  const { base, repo } = createRepo();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bin = createFakeTools(base);
  git(repo, ['checkout', '-b', 'feature']);
  writeFileSync(path.join(repo, 'README.md'), 'old stash\n');
  git(repo, ['stash', 'push', '-m', 'pre-existing']);
  writeFileSync(path.join(repo, 'README.md'), 'pending work\n');
  const before = snapshot(repo);

  const result = run(process.execPath, [scripts.archive, 'demo-change', '--stash', '--dry-run', '--repo', 'group/project'], {
    cwd: repo,
    env: childEnv(bin),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /未执行 stash、checkout、fetch、merge/);
  assert.deepEqual(snapshot(repo), before);
  assert.equal(readFileSync(path.join(repo, 'README.md'), 'utf8'), 'pending work\n');
});

test('initiate --dry-run leaves dirty worktree, refs, and stash untouched', (t) => {
  const { base, repo } = createRepo();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bin = createFakeTools(base);
  writeFileSync(path.join(repo, 'README.md'), 'old stash\n');
  git(repo, ['stash', 'push', '-m', 'pre-existing']);
  writeFileSync(path.join(repo, 'README.md'), 'pending work\n');
  const before = snapshot(repo);

  const result = run(process.execPath, [scripts.initiate, 'new-change', '--type', 'feat', '--stash', '--dry-run'], {
    cwd: repo,
    env: childEnv(bin),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /未执行任何写操作或远端变更/);
  assert.deepEqual(snapshot(repo), before);
  assert.notEqual(run('git', ['show-ref', '--verify', 'refs/heads/change/feat-new-change'], { cwd: repo }).status, 0);
});

test('archive with a clean worktree returns to the original branch without popping an older stash', (t) => {
  const { base, repo, remote } = createRepo({ bareRemote: true });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bin = createFakeTools(base);
  const openspecLog = path.join(base, 'openspec.log');
  writeFileSync(path.join(repo, 'README.md'), 'old stash\n');
  git(repo, ['stash', 'push', '-m', 'pre-existing']);
  const oldStash = git(repo, ['rev-parse', 'refs/stash']);
  git(repo, ['checkout', '-b', 'feature']);

  const result = run(process.execPath, [scripts.archive, 'demo-change', '--stash', '--no-validate', '--repo', 'group/project'], {
    cwd: repo,
    env: childEnv(bin, { OPENSPEC_LOG: openspecLog }),
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature');
  assert.equal(git(repo, ['rev-parse', 'refs/stash']), oldStash);
  assert.equal(readFileSync(path.join(repo, 'README.md'), 'utf8'), 'initial\n');
  assert.match(readFileSync(openspecLog, 'utf8'), /archive demo-change -y --json --no-validate/);
  assert.equal(must('git', [`--git-dir=${remote}`, 'show', 'main:openspec/changes/archive/demo-change/implementation.md']), 'implemented');
});

test('merge preserves a dirty review worktree unless force cleanup was explicitly requested', (t) => {
  const { base, repo } = createRepo();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bin = createFakeTools(base);
  const glabLog = path.join(base, 'glab.log');
  const worktree = path.join(repo, '.worktrees', 'review-7');
  mkdirSync(path.dirname(worktree), { recursive: true });
  git(repo, ['worktree', 'add', '--detach', worktree, 'HEAD']);
  writeFileSync(path.join(worktree, 'README.md'), 'review notes\n');

  const result = run(process.execPath, [scripts.merge, 'demo-change', '--mr', '7', '--repo', 'group/project'], {
    cwd: repo,
    env: childEnv(bin, { GLAB_LOG: glabLog }),
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /已保留有未提交修改的 worktree/);
  assert.equal(existsSync(worktree), true);
  assert.equal(readFileSync(path.join(worktree, 'README.md'), 'utf8'), 'review notes\n');
  assert.match(readFileSync(glabLog, 'utf8'), /mr merge 7/);
});

test('review requires explicit overrides for non-main and unlinked MRs before fetch/worktree creation', (t) => {
  const { base, repo } = createRepo();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bin = createFakeTools(base);
  const env = childEnv(bin, { GLAB_TARGET: 'release', GLAB_UNLINKED: '1' });

  const nonMain = run(process.execPath, [scripts.review, '--mr', '9', '--repo', 'group/project'], { cwd: repo, env });
  assert.equal(nonMain.status, 1);
  assert.match(`${nonMain.stdout}${nonMain.stderr}`, /--allow-non-main/);

  const unlinked = run(process.execPath, [scripts.review, '--mr', '9', '--repo', 'group/project', '--allow-non-main'], { cwd: repo, env });
  assert.equal(unlinked.status, 1);
  assert.match(`${unlinked.stdout}${unlinked.stderr}`, /--allow-unlinked/);
  assert.equal(existsSync(path.join(repo, '.worktrees', 'review-9')), false);
});
