#!/usr/bin/env node
// Offline desktop regression. --seed creates a new disposable fixture; --fixture
// connects ONLY to an app started with that fixture's isolated Claude/user-data roots.
// No provider is launched. Git reads, branch tracking, and UI clicks remain real.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import WebSocket from 'ws';

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    // Do not inherit Git directory/config overrides from the caller's checkout.
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: '1',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const json = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
};

async function validateFixture(file) {
  const fixture = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(fixture.kind, 'issue509-disposable-desktop-v1');
  assert.equal(fixture.teamName, 'issue509-test-team');
  assert.equal(fixture.branch, 'feat/issue509-custom-member-branch');
  assert(path.isAbsolute(fixture.root), 'Fixture root must be absolute');
  const root = await realpath(fixture.root);
  assert.equal(
    path.dirname(root),
    await realpath(os.tmpdir()),
    'Fixture must be directly under the system temporary directory'
  );
  assert(
    /^issue509-desktop-e2e-[a-zA-Z0-9]+$/.test(path.basename(root)),
    'Unexpected disposable fixture prefix'
  );
  const inside = (candidate) => {
    const relative = path.relative(root, candidate);
    assert(
      relative &&
        !relative.startsWith(`..${path.sep}`) &&
        relative !== '..' &&
        !path.isAbsolute(relative),
      `Path escapes disposable fixture: ${candidate}`
    );
    return candidate;
  };
  const contained = async (candidate) => {
    assert(
      typeof candidate === 'string' && path.isAbsolute(candidate),
      'Fixture paths must be absolute'
    );
    inside(path.resolve(candidate));
    return inside(await realpath(candidate));
  };
  await contained(path.resolve(file));
  fixture.root = root;
  for (const key of ['claudeRoot', 'userDataRoot', 'projectPath', 'worktreePath', 'artifacts']) {
    fixture[key] = await contained(fixture[key]);
    assert((await lstat(fixture[key])).isDirectory(), `Expected fixture directory: ${key}`);
  }
  const teamDir = path.join(fixture.claudeRoot, 'teams', fixture.teamName);
  for (const name of ['config.json', 'members.meta.json', 'team.meta.json']) {
    const config = JSON.parse(await readFile(await contained(path.join(teamDir, name)), 'utf8'));
    for (const candidate of [
      config.cwd,
      config.projectPath,
      ...(config.projectPathHistory ?? []),
      ...(config.members ?? []).map((member) => member.cwd),
    ].filter((value) => value !== undefined))
      await contained(candidate);
  }
  await contained(path.join(fixture.claudeRoot, 'agent-teams-config.json'));
  for (const name of ['tracked.txt', 'untracked.txt'])
    await contained(path.join(fixture.worktreePath, name));
  // Existing output symlinks must not redirect screenshots or failure reports outside.
  for (const name of await readdir(fixture.artifacts))
    await contained(path.join(fixture.artifacts, name));
  const dotGit = path.join(fixture.projectPath, '.git');
  assert((await lstat(dotGit)).isDirectory(), 'Fixture project must own a real .git directory');
  const commonDir = await contained(dotGit);
  for (const cwd of [fixture.projectPath, fixture.worktreePath]) {
    assert.equal(
      await realpath(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')),
      commonDir,
      'Project and member worktree must share the sandbox project .git'
    );
    assert.equal(
      await realpath(git(cwd, 'rev-parse', '--show-toplevel')),
      cwd,
      'Git working tree escapes fixture directory'
    );
  }
  return fixture;
}

async function seed() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'issue509-desktop-e2e-')));
  const fixture = {
    kind: 'issue509-disposable-desktop-v1',
    root,
    claudeRoot: path.join(root, '.claude'),
    userDataRoot: path.join(root, 'user-data'),
    projectPath: path.join(root, 'project'),
    worktreePath: path.join(root, 'member-worktree'),
    teamName: 'issue509-test-team',
    branch: 'feat/issue509-custom-member-branch',
    artifacts: path.join(root, 'artifacts'),
  };
  const repoHash = createHash('sha256').update(fixture.projectPath).digest('hex').slice(0, 10);
  fixture.worktreePath = path.join(
    fixture.userDataRoot,
    'data',
    'team-worktrees',
    `project-${repoHash}`,
    fixture.teamName,
    'isolated'
  );
  await mkdir(fixture.projectPath);
  await mkdir(fixture.userDataRoot);
  await mkdir(fixture.artifacts);
  git(fixture.projectPath, 'init', '-b', 'main');
  git(fixture.projectPath, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
  await writeFile(path.join(fixture.projectPath, 'tracked.txt'), 'committed baseline\n');
  git(fixture.projectPath, 'add', 'tracked.txt');
  git(
    fixture.projectPath,
    '-c',
    'user.name=Desktop E2E',
    '-c',
    'user.email=e2e@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'test: disposable issue509 fixture'
  );
  git(fixture.projectPath, 'worktree', 'add', '-b', fixture.branch, fixture.worktreePath);
  await writeFile(
    path.join(fixture.worktreePath, 'tracked.txt'),
    'dirty member work must survive\n'
  );
  await writeFile(
    path.join(fixture.worktreePath, 'untracked.txt'),
    'untracked member work must survive\n'
  );
  const member = (name, cwd, options = {}) => ({
    name,
    agentId: `${name}@${fixture.teamName}`,
    agentType: name === 'team-lead' ? 'team-lead' : 'general-purpose',
    role: name === 'team-lead' ? 'Lead' : 'Developer',
    providerId: 'anthropic',
    model: 'sonnet',
    color: name === 'isolated' ? 'blue' : 'green',
    cwd,
    joinedAt: Date.now(),
    subscriptions: [],
    ...options,
  });
  const members = [
    member('team-lead', fixture.projectPath),
    member('isolated', fixture.worktreePath, { isolation: 'worktree' }),
    member('shared', fixture.projectPath),
  ];
  const teamDir = path.join(fixture.claudeRoot, 'teams', fixture.teamName);
  await json(path.join(fixture.claudeRoot, 'agent-teams-config.json'), {
    general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark', defaultTab: 'dashboard' },
  });
  await json(path.join(teamDir, 'config.json'), {
    name: fixture.teamName,
    description: 'Disposable offline issue509 desktop regression',
    createdAt: Date.now(),
    leadAgentId: `team-lead@${fixture.teamName}`,
    members,
    projectPath: fixture.projectPath,
    projectPathHistory: [fixture.projectPath],
    language: 'en',
  });
  await json(path.join(teamDir, 'members.meta.json'), { version: 1, members });
  await json(path.join(teamDir, 'team.meta.json'), {
    version: 1,
    cwd: fixture.projectPath,
    providerId: 'anthropic',
    model: 'sonnet',
    prompt: 'Offline fixture; never launch a real provider.',
    createdAt: Date.now(),
  });
  await mkdir(path.join(fixture.claudeRoot, 'tasks', fixture.teamName), { recursive: true });
  await mkdir(path.join(fixture.claudeRoot, 'projects'), { recursive: true });
  await json(path.join(root, 'fixture.json'), fixture);
  process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    socket.on('close', () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
    });
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description ?? 'Evaluation failed');
    return result.result.value;
  }
  async wait(expression, label, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.evaluate(`Boolean(${expression})`)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${label}`);
  }
  async click(expression) {
    await this.wait(expression, expression);
    await this.evaluate(
      `(${expression}).scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'})`
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const rect = await this.evaluate(`(() => {
      const element = (${expression});
      const r = element.getBoundingClientRect();
      return {x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height};
    })()`);
    assert(rect.width > 0 && rect.height > 0, `Invisible control: ${expression}`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', {
        type,
        x: rect.x,
        y: rect.y,
        button: 'left',
        clickCount: 1,
      });
    }
  }
  async escape() {
    for (const type of ['keyDown', 'keyUp'])
      await this.send('Input.dispatchKeyEvent', {
        type,
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });
  }
  async screenshot(file) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await writeFile(file, Buffer.from(result.data, 'base64'));
  }
}

const button = (text) => `Array.from(document.querySelectorAll('button')).find(e =>
  e.textContent.trim() === ${JSON.stringify(text)} && e.getBoundingClientRect().width > 0)`;
const row = (name) => `Array.from(document.querySelectorAll('[data-role="member-row"]')).find(e =>
  Array.from(e.querySelectorAll('input')).some(input => input.value === ${JSON.stringify(name)}))`;
const checkbox = (name) => `(${row(name)})?.querySelector('[id$="-worktree-isolation"]')`;
const rowText = (name) => `(${row(name)})?.innerText`;

async function run() {
  const file = argument('--fixture');
  assert(file, 'Use --seed, then --fixture /absolute/disposable/root/fixture.json');
  const fixture = await validateFixture(file);
  if (process.argv.includes('--validate-fixture')) {
    process.stdout.write(`PASS disposable fixture validated: ${fixture.root}\n`);
    return;
  }
  const mutateGit = async (cwd, ...args) => {
    await validateFixture(file);
    return git(cwd, '-c', `core.hooksPath=${os.devNull}`, ...args);
  };
  const before = {
    branch: git(fixture.worktreePath, 'branch', '--show-current'),
    head: git(fixture.worktreePath, 'rev-parse', 'HEAD'),
    status: git(fixture.worktreePath, 'status', '--porcelain'),
    tracked: await readFile(path.join(fixture.worktreePath, 'tracked.txt'), 'utf8'),
    untracked: await readFile(path.join(fixture.worktreePath, 'untracked.txt'), 'utf8'),
  };
  const endpoint = new URL(argument('--cdp', 'http://127.0.0.1:9222'));
  assert(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Only local dev:mcp is supported');
  let targets;
  const readyDeadline = Date.now() + 60_000;
  while (!targets) {
    try {
      targets = await (
        await fetch(new URL('/json/list', endpoint), {
          signal: AbortSignal.timeout(2_000),
        })
      ).json();
    } catch (error) {
      if (Date.now() >= readyDeadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const page = targets.find(
    (target) => target.type === 'page' && target.url.startsWith('http://localhost:')
  );
  assert(page, 'Expected Electron dev:mcp renderer');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const cdp = new Cdp(socket);
  const evidence = { fixture: file, providerLaunched: false, assertions: [], screenshots: [] };
  const record = (label) => {
    evidence.assertions.push(label);
    process.stdout.write(`PASS ${label}\n`);
  };
  const artifactFile = async (name) => {
    await validateFixture(file);
    return path.join(fixture.artifacts, name);
  };
  const screenshot = async (name) => {
    const output = await artifactFile(`${name}.png`);
    await cdp.screenshot(output);
    evidence.screenshots.push(output);
  };
  let runError = null;
  let cleanupError = null;
  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.wait(
      'window.__agentTeamsDevStore && window.electronAPI?.teams',
      'dev store and Electron API'
    );
    // Verify isolation before navigating or touching any app state.
    const teams = await cdp.evaluate('window.electronAPI.teams.list()');
    assert(
      teams.every((team) => team.teamName === fixture.teamName),
      'App is not isolated to the disposable team'
    );
    assert(
      teams.some((team) => team.teamName === fixture.teamName),
      'Disposable team not found'
    );
    const initialData = await cdp.evaluate(
      `window.electronAPI.teams.getData(${JSON.stringify(fixture.teamName)})`
    );
    assert.equal(
      initialData.config.projectPath,
      fixture.projectPath,
      'App fixture project does not match'
    );
    await cdp.escape();
    await cdp.escape();
    await cdp.evaluate(
      `window.__agentTeamsDevStore.getState().openTeamTab(${JSON.stringify(fixture.teamName)})`
    );
    await cdp.wait(
      `document.querySelector('[data-member-branch="${fixture.branch}"]')`,
      'real custom branch on stopped member'
    );
    assert.equal(
      await cdp.evaluate(`document.querySelectorAll('[data-member-branch="main"]').length`),
      0,
      'Common project branch must be hidden from member cards'
    );
    const branchBadge = `document.querySelector('[data-member-branch="${fixture.branch}"]')`;
    assert(
      await cdp.evaluate(
        `(${branchBadge}).querySelector('span').getBoundingClientRect().width >= 30`
      ),
      'Branch text must have visible width, not only a Git icon in the DOM'
    );
    record('Stopped cards hide the common branch and show the isolated alternate branch');
    await screenshot('01-stopped-custom-branch');
    const badgeRect =
      await cdp.evaluate(`(() => {const r = (${branchBadge}).getBoundingClientRect();
      return {x: r.x + r.width / 2, y: r.y + r.height / 2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...badgeRect });
    await cdp.wait(
      `Array.from(document.querySelectorAll('[role="tooltip"]')).some(e =>
      e.innerText.includes(${JSON.stringify(fixture.branch)}))`,
      'full custom branch in themed tooltip'
    );
    await screenshot('01b-full-branch-tooltip');
    await cdp.click(button('Launch'));
    await cdp.click(`Array.from(document.querySelectorAll('button')).find(e =>
      e.textContent.trim().startsWith('Optional launch settings'))`);
    await cdp.wait(
      `${rowText('isolated')}?.includes('Worktree branch: ${fixture.branch}')`,
      'launch dialog isolated worktree branch'
    );
    assert.equal(
      await cdp.evaluate(`(${checkbox('isolated')})?.getAttribute('data-state')`),
      'checked'
    );
    assert.equal(
      await cdp.evaluate(`(${checkbox('shared')})?.getAttribute('data-state')`),
      'unchecked'
    );
    assert.equal(
      await cdp.evaluate(`${rowText('shared')}?.includes('Worktree branch:') ?? false`),
      false,
      'Shared launch row must hide the common project branch'
    );
    assert.equal(
      await cdp.evaluate(`${rowText('shared')}?.includes('Shared project workspace:') ?? false`),
      false,
      'Shared launch row must not show a workspace information block'
    );
    record('Mixed launch roster shows only the isolated worktree branch deviation');
    await screenshot('02-launch-mixed');
    const alternateBranch = `${fixture.branch}-live`;
    await mutateGit(fixture.projectPath, 'branch', '-f', alternateBranch, before.head);
    await mutateGit(fixture.worktreePath, 'switch', alternateBranch);
    await cdp.wait(
      `${rowText('isolated')}?.includes('Worktree branch: ${alternateBranch}') &&
      document.querySelector('[data-member-branch="${alternateBranch}"]')`,
      'live main-process branch update in dialog and card'
    );
    record('Real Git switch updates the mounted member card and launch row without reload');
    await mutateGit(fixture.worktreePath, 'switch', before.branch);
    await cdp.wait(
      `${rowText('isolated')}?.includes('Worktree branch: ${before.branch}') &&
      !${rowText('isolated')}?.includes(${JSON.stringify(alternateBranch)}) &&
      document.querySelector('[data-member-branch="${before.branch}"]')`,
      'original branch restored in card and dialog'
    );
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 850,
      height: 760,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await screenshot('02b-launch-narrow');
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await cdp.click(checkbox('isolated'));
    await cdp.wait(
      `(${checkbox('isolated')})?.getAttribute('data-state') === 'unchecked' &&
      !${rowText('isolated')}?.includes('Worktree branch:') &&
      !${rowText('isolated')}?.includes('Shared project workspace:') &&
      !${rowText('isolated')}?.includes(${JSON.stringify(fixture.branch)})`,
      'toggled-off shared member has no workspace information block'
    );
    record('Toggling Worktree off removes the member workspace information block');
    await screenshot('03-worktree-off');
    await cdp.click(checkbox('isolated'));
    await cdp.wait(
      `${rowText('isolated')}?.includes('Last workspace:') &&
      ${rowText('isolated')}?.includes('Worktree branch: ${fixture.branch}')`,
      'restored existing worktree destination'
    );
    await cdp.click(checkbox('shared'));
    await cdp.wait(
      `(${checkbox('shared')})?.getAttribute('data-state') === 'checked'`,
      'shared member Worktree checkbox changed'
    );
    await cdp.wait(
      `${rowText('shared')}?.includes('Worktree: reused if available, otherwise created on launch.') &&
      !${rowText('shared')}?.includes('Worktree branch:')`,
      'new member worktree has no fabricated current branch'
    );
    record('Toggling on restores existing custom branch; new worktree is marked as planned');
    await screenshot('04-worktree-new');
    await cdp.click(checkbox('shared'));
    await cdp.click(button('Advanced'));
    const leadWorktreeCheckbox = `document.querySelector('[id="worktree-${fixture.teamName}"]')`;
    await cdp.click(leadWorktreeCheckbox);
    await cdp.click('document.querySelector(\'input[placeholder="worktree-name"]\')');
    await cdp.send('Input.insertText', { text: 'issue509-lead-worktree' });
    await cdp.wait(
      `${rowText('shared')}?.includes('Shared workspace: resolved on launch with the lead worktree.') &&
      !${rowText('shared')}?.includes('Worktree branch:')`,
      'lead worktree shared destination is not fabricated'
    );
    await screenshot('04b-lead-worktree-pending');
    record('Lead worktree with a name suppresses the root branch forecast for shared teammates');
    await cdp.click(leadWorktreeCheckbox);
    await cdp.escape();
    await cdp.wait('!document.querySelector("[role=dialog]")', 'launch dialog closed');
    // UI-only running snapshot: exercise relaunch presentation without a live runtime.
    await cdp.evaluate(`(() => {
      const store = window.__agentTeamsDevStore;
      const state = store.getState();
      const data = {...state.selectedTeamData, isAlive: true};
      window.__issue509StoppedData = state.selectedTeamData;
      store.setState({selectedTeamData: data,
        teamDataCacheByName: {...state.teamDataCacheByName, [data.teamName]: data}});
    })()`);
    await cdp.click('document.querySelector(\'button[aria-label="Edit team"]\')');
    await cdp.click(
      `document.querySelector('[role="dialog"] [data-role="member-row"] button[aria-label*="provider,"]')`
    );
    await cdp.click(button('Change lead runtime'));
    await cdp.wait("document.body.innerText.includes('Relaunch settings')", 'relaunch settings');
    await cdp.click(`Array.from(document.querySelectorAll('button')).find(e =>
      e.textContent.trim().startsWith('Relaunch settings'))`);
    await cdp.wait(
      `${rowText('isolated')}?.includes('Worktree branch: ${fixture.branch}')`,
      'relaunch keeps custom branch'
    );
    assert.equal(
      await cdp.evaluate(`(${checkbox('isolated')})?.getAttribute('data-state')`),
      'checked'
    );
    assert.equal(
      await cdp.evaluate(`${rowText('shared')}?.includes('Worktree branch:') ?? false`),
      false,
      'Relaunch shared row must hide the common project branch'
    );
    record(
      'UI-only running fixture: relaunch dialog shows persisted mixed worktree states and branches'
    );
    await screenshot('05-relaunch-mixed-ui-fixture');
    await cdp.escape();
    await cdp.escape();
    await cdp.evaluate(`(() => {
      const store = window.__agentTeamsDevStore;
      const data = window.__issue509StoppedData;
      store.setState({selectedTeamData: data,
        teamDataCacheByName: {...store.getState().teamDataCacheByName, [data.teamName]: data}});
      delete window.__issue509StoppedData;
      const project = {id: 'issue509-fixture-project', name: 'Issue509 sandbox',
        path: ${JSON.stringify(fixture.projectPath)}, sessions: [], createdAt: Date.now()};
      store.setState({projects: [project], selectedProjectId: project.id});
      store.getState().openTeamsTab(project.path);
    })()`);
    await cdp.click(button('Create Team'));
    const bulkCheckbox = 'document.querySelector(\'[id="teammate-worktree-default-createTeam"]\')';
    await cdp.wait(bulkCheckbox, 'create roster Worktree checkbox');
    assert(
      await cdp.evaluate(
        "document.querySelector('[role=dialog]').innerText.includes('Worktree for all teammates')"
      )
    );
    await cdp.wait(
      `!(${bulkCheckbox}).disabled`,
      'create Worktree checkbox enabled for real fixture Git repo'
    );
    await cdp.click(button('Add member'));
    await cdp.click(bulkCheckbox);
    const createCheckboxes = `Array.from(document.querySelectorAll('[data-role="member-row"] [id$="-worktree-isolation"]'))`;
    await cdp.wait(
      `${createCheckboxes}.length > 0 && ${createCheckboxes}.every(e =>
      e.getAttribute('data-state') === (${bulkCheckbox}).getAttribute('data-state'))`,
      'create bulk Worktree applies to all rows'
    );
    await cdp.click(bulkCheckbox);
    await cdp.wait(
      `${createCheckboxes}.every(e =>
      e.getAttribute('data-state') === (${bulkCheckbox}).getAttribute('data-state'))`,
      'create Worktree bulk toggle reverses'
    );
    await cdp.wait(
      `${createCheckboxes}.every(e => {
        const text = e.closest('[data-role="member-row"]').innerText;
        return e.getAttribute('data-state') === 'checked'
          ? text.includes('Worktree: reused if available') && !text.includes('Worktree branch:')
          : !text.includes('Worktree branch:') && !text.includes('Shared project workspace:');
      })`,
      'create rows describe only planned worktrees and hide common/shared workspace information'
    );
    record(
      'Create dialog exposes explicit Worktree label; bulk checkbox toggles every teammate both ways'
    );
    await screenshot('06-create-worktree-label');
    await cdp.escape();
    assert.equal(git(fixture.worktreePath, 'branch', '--show-current'), before.branch);
    assert.equal(git(fixture.worktreePath, 'rev-parse', 'HEAD'), before.head);
    assert.equal(git(fixture.worktreePath, 'status', '--porcelain'), before.status);
    assert.equal(
      await readFile(path.join(fixture.worktreePath, 'tracked.txt'), 'utf8'),
      before.tracked
    );
    assert.equal(
      await readFile(path.join(fixture.worktreePath, 'untracked.txt'), 'utf8'),
      before.untracked
    );
    record('All UI interactions preserve Git branch, HEAD, dirty files, and untracked files');
    await json(await artifactFile('evidence.json'), evidence);
  } catch (error) {
    runError = error;
    await screenshot('failure').catch(() => undefined);
    const body = await cdp.evaluate('document.body.innerText').catch(() => 'CDP unavailable');
    try {
      await json(await artifactFile('failure.json'), {
        error: String(error),
        body,
        evidence,
      });
    } catch (reportingError) {
      process.stderr.write(`Failed to write failure diagnostics: ${reportingError}\n`);
    }
  } finally {
    try {
      if (git(fixture.worktreePath, 'branch', '--show-current') !== before.branch)
        await mutateGit(fixture.worktreePath, 'switch', before.branch);
    } catch (error) {
      cleanupError = error;
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
    await cdp
      .evaluate(
        `(() => {
      if (!window.__issue509StoppedData) return;
      const store = window.__agentTeamsDevStore, data = window.__issue509StoppedData;
      store.setState({selectedTeamData: data,
        teamDataCacheByName: {...store.getState().teamDataCacheByName, [data.teamName]: data}});
      delete window.__issue509StoppedData;
    })()`
      )
      .catch(() => undefined);
    try {
      socket.close();
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (runError) {
    if (cleanupError) process.stderr.write(`Fixture cleanup failed: ${cleanupError}\n`);
    throw runError;
  }
  if (cleanupError) throw cleanupError;
  process.stdout.write(`Evidence: ${path.join(fixture.artifacts, 'evidence.json')}\n`);
}

try {
  if (process.argv.includes('--seed')) await seed();
  else await run();
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
}
