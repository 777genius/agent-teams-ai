/* Installed-app smoke: no system Git, network, real project or agent credentials. */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function check(bundle, platform, arch) {
  const resources = platform === 'darwin'
    ? path.join(bundle, 'Contents', 'Resources')
    : path.join(bundle, 'resources');
  const root = path.join(resources, 'git');
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'MANAGED_GIT.json'), 'utf8'));
  assert.equal(marker.platform, `${platform}-${arch}`);
  assert.match(marker.sha256, /^[a-f0-9]{64}$/);

  const win = platform === 'win32';
  const flavor = win ? (arch === 'arm64' ? 'clangarm64' : 'ucrt64') : null;
  const git = path.join(root, win ? 'cmd/git.exe' : 'bin/git');
  const dirs = win
    ? [path.join(root, 'cmd'), path.join(root, flavor, 'bin'), path.join(root, flavor, 'usr', 'bin')]
    : [path.join(root, 'bin')];
  const env = {
    ...process.env,
    PATH: [...dirs, ...(process.env.PATH || '').split(path.delimiter)].join(path.delimiter),
    GIT_EXEC_PATH: win
      ? path.join(root, flavor, 'libexec', 'git-core')
      : path.join(root, 'libexec', 'git-core'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'agent-teams-ignored-global-gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    ...(platform === 'linux' ? { PREFIX: root, GIT_SSL_CAINFO: path.join(root, 'ssl/cacert.pem') } : {}),
  };
  // Make the test's Git invocation independent of system Git; no PATH="git" lookup for entrypoint.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-packaged-git-'));
  const run = (...args) =>
    execFileSync(git, args, { cwd, env, encoding: 'utf8', timeout: 15000 }).trim();

  try {
    assert.match(run('--version'), /git version 2\.56\.0/);
    assert.match(run('lfs', 'version'), /git-lfs\/3\.8\./i);
    run('init', '--initial-branch=main');
    fs.writeFileSync(path.join(cwd, 'README.md'), 'original\n');
    run('add', 'README.md');
    run('-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-m', 'initial');
    assert.equal(run('branch', '--show-current'), 'main');
    fs.writeFileSync(path.join(cwd, 'README.md'), 'changed\n');
    assert.match(run('status', '--porcelain'), /README\.md/);
    assert.match(run('diff', '--', 'README.md'), /changed/);
    run('checkout', '--', 'README.md');
    const worktree = path.join(cwd, 'smoke-worktree');
    run('worktree', 'add', '-b', 'smoke-worktree', worktree, 'HEAD');
    assert(fs.existsSync(path.join(worktree, 'README.md')));
    assert.match(run('-C', worktree, 'branch', '--show-current'), /smoke-worktree/);
    run('worktree', 'remove', '--force', worktree);
    const clone = path.join(cwd, 'clone');
    run('clone', '--no-hardlinks', cwd, clone);
    assert(fs.existsSync(path.join(clone, 'README.md')));
    // Verify an agent-like shell command resolves the portable Git, not /usr/bin/git.
    const fromPath = execFileSync(
      win ? 'cmd.exe' : '/bin/sh',
      win ? ['/d', '/s', '/c', 'git --version'] : ['-c', 'git --version'],
      { cwd, env, encoding: 'utf8', timeout: 15000 }
    );
    assert.match(fromPath, /git version 2\.56\.0/);
    console.log(`[smokeManagedGit] PASS ${marker.platform}: git, lfs, status, diff, worktree, clone, PATH`);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const [bundle, platform, arch] = process.argv.slice(2);
  if (!bundle || !platform || !arch) throw new Error('Usage: smokeManagedGit.cjs <bundle> <os> <arch>');
  check(path.resolve(bundle), platform, arch);
}

module.exports = { check };
