import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** All files and Git projects are fresh TEST state; no runtime can be launched. */
export function prepareTaskTabsFixture(
  scratch: string,
  sourceCommit: string,
  runtimeVersion: string
) {
  assert(
    scratch.startsWith('/srv/workers/'),
    'Disposable fixture scratch must be under /srv/workers'
  );
  assert(/^[a-f0-9]{40}$/.test(sourceCommit), 'Exact integrated source SHA required');
  assert(/^[a-zA-Z0-9.+-]+$/.test(runtimeVersion));
  const operator = scratch;
  const node = process.execPath;
  const root = mkdtempSync(join(operator, 'task-tabs-TEST-'));
  chmodSync(root, 0o700);
  const claude = join(root, 'claude');
  const files: { path: string; bytes: number; sha256: string }[] = [];
  function write(file: string, contents: string, mode = 0o600): void {
    assert(resolve(file).startsWith(root + '/'));
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(file, contents, { flag: 'wx', mode });
    files.push({
      path: file,
      bytes: Buffer.byteLength(contents),
      sha256: createHash('sha256').update(contents).digest('hex'),
    });
  }
  function json(file: string, value: unknown): void {
    write(file, JSON.stringify(value, null, 2) + '\n');
  }
  const env: Record<string, string> = {
    HOME: join(root, 'home'),
    TMPDIR: mkdtempSync('/srv/workers/task-tabs-tmp-TEST-'),
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: claude,
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: join(root, 'user-data'),
    CLAUDE_CONFIG_DIR: join(root, 'claude-config'),
    CLAUDE_MULTIMODEL_DATA_HOME: join(root, 'multimodel-data'),
    CLAUDE_MULTIMODEL_CACHE_HOME: join(root, 'multimodel-cache'),
    CLAUDE_DEV_RUNTIME_CACHE_ROOT: join(root, 'runtime-cache'),
    COREPACK_HOME: join(root, 'corepack'),
    CLAUDE_DEV_RUNTIME_DISABLE_GH: '1',
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    pnpm_config_verify_deps_before_run: 'false',
    NODE_BINARY: node,
    SHELL: '/bin/sh',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TZ: 'UTC',
    TASK_TABS_TEST_RUNTIME_AUDIT: join(root, 'runtime-audit.ndjson'),
    TASK_TABS_TEST_RUNTIME_VERSION: runtimeVersion,
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: join(root, 'deny-runtime.mjs'),
    CLAUDE_TERMINAL_DAEMON_BINARY: join(root, 'deny-runtime.mjs'),
    CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
  };
  mkdirSync(join(claude, 'projects'), { recursive: true, mode: 0o700 });
  for (const key of ['CONFIG', 'DATA', 'CACHE', 'STATE', 'RUNTIME'])
    env[`XDG_${key}_${key === 'RUNTIME' ? 'DIR' : 'HOME'}`] = join(
      root,
      'xdg-' + key.toLowerCase()
    );
  for (const key of [
    'HOME',
    'TMPDIR',
    'AGENT_TEAMS_ELECTRON_CLAUDE_ROOT',
    'AGENT_TEAMS_ELECTRON_USER_DATA_DIR',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_MULTIMODEL_DATA_HOME',
    'CLAUDE_MULTIMODEL_CACHE_HOME',
    'CLAUDE_DEV_RUNTIME_CACHE_ROOT',
    'COREPACK_HOME',
    ...Object.keys(env).filter((k) => k.startsWith('XDG_')),
  ])
    mkdirSync(env[key], { recursive: true, mode: 0o700 });
  write(
    join(root, '.test-only'),
    'task-detail-tabs synthetic two-team fixture; never launch a team\n'
  );
  write(env.TASK_TABS_TEST_RUNTIME_AUDIT, '');
  write(
    env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH,
    `#!${node}\nimport {appendFileSync} from 'node:fs';\nconst args=process.argv.slice(2);\nif(!process.env.TASK_TABS_TEST_RUNTIME_AUDIT||!process.env.TASK_TABS_TEST_RUNTIME_VERSION)process.exit(78);\nappendFileSync(process.env.TASK_TABS_TEST_RUNTIME_AUDIT,JSON.stringify({at:new Date().toISOString(),args})+'\\n');\nif(args.length===1&&args[0]==='--version')console.log(process.env.TASK_TABS_TEST_RUNTIME_VERSION);else process.exitCode=77;\n`,
    0o700
  );
  json(join(claude, 'agent-teams-config.json'), {
    general: { appLocale: 'ru', agentLanguage: 'en', theme: 'dark', defaultTab: 'teams' },
  });
  const epoch = Date.now() - 86400000;
  const timestamp = new Date(epoch).toISOString();
  const taskId = '1';
  const teams = ['A', 'B'].map((side) => {
    const teamName = 'task-tabs-test-' + side.toLowerCase() + '-' + randomUUID();
    assert(/^[a-z0-9][a-z0-9-]{0,127}$/.test(teamName));
    const project = join(root, 'TEST-project-' + side);
    mkdirSync(project, { recursive: true, mode: 0o700 });
    write(join(project, 'README.md'), '# Disposable task tabs TEST ' + side + '\n');
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', project], { stdio: 'pipe' });
    const secondOwner = 'task-owner';
    const members = [
      {
        name: 'team-lead',
        agentId: 'team-lead@' + teamName,
        agentType: 'team-lead',
        cwd: project,
        joinedAt: epoch,
        color: side === 'A' ? 'blue' : 'green',
        subscriptions: [],
      },
      {
        name: secondOwner,
        agentId: secondOwner + '@' + teamName,
        agentType: 'general-purpose',
        cwd: project,
        joinedAt: epoch,
        color: side === 'A' ? 'cyan' : 'orange',
        subscriptions: [],
      },
    ];
    mkdirSync(join(claude, 'teams', teamName, 'inboxes'), { recursive: true, mode: 0o700 });
    json(join(claude, 'teams', teamName, 'config.json'), {
      name: teamName,
      description: 'Disposable TEST task tabs ' + side,
      createdAt: epoch,
      leadAgentId: members[0].agentId,
      members,
      projectPath: project,
      projectPathHistory: [project],
    });
    json(join(claude, 'teams', teamName, 'members.meta.json'), { version: 1, members });
    json(join(claude, 'teams', teamName, 'team.meta.json'), {
      version: 1,
      cwd: project,
      createdAt: epoch,
      prompt: 'Test only. Never launch.',
    });
    const groupChatId = randomUUID();
    const groupName = 'TEST group ' + side;
    json(join(claude, 'teams', teamName, 'group-chats.json'), {
      version: 1,
      groups: [
        {
          id: groupChatId,
          name: groupName,
          createdAt: timestamp,
          membership: { kind: 'fixed', memberNames: ['team-lead', secondOwner] },
          archivedAt: null,
        },
      ],
    });
    const taskFile = join(claude, 'tasks', teamName, taskId + '.json');
    const kanbanFile = join(claude, 'teams', teamName, 'kanban-state.json');
    json(kanbanFile, { teamName, reviewers: [], tasks: {} });
    const markers = {
      description: 'DESC_TAIL_' + side,
      prompt: 'PROMPT_TAIL_' + side,
      source: 'SOURCE_TAIL_' + side,
      comment: 'COMMENT_TAIL_' + side,
      history: 'HISTORY_TAIL_' + side,
    };
    json(taskFile, {
      id: taskId,
      displayId: taskId,
      subject: 'TEST ' + side + ' same ID task',
      status: side === 'A' ? 'in_progress' : 'pending',
      owner: 'team-lead',
      createdBy: 'user',
      createdAt: timestamp,
      projectPath: project,
      description:
        'description prefix '.repeat(160) + '\n\n[README](README.md)\n\n' + markers.description,
      prompt: 'prompt prefix '.repeat(80) + markers.prompt,
      sourceMessageId: 'test-source-' + side,
      sourceMessage: {
        from: 'user',
        timestamp,
        source: 'user_sent',
        text: 'source prefix '.repeat(100) + markers.source,
      },
      blocks: [],
      blockedBy: [],
      related: [],
      comments: Array.from({ length: 125 }, (_, i) => ({
        id: 'comment-shared-' + i,
        author: 'user',
        createdAt: new Date(epoch + i * 1000).toISOString(),
        type: 'regular',
        text:
          'comment ' + i + ' '.repeat(2) + 'comment body '.repeat(60) + markers.comment + '_' + i,
      })),
      historyEvents: Array.from({ length: 125 }, (_, i) => ({
        id: 'history-' + side + '-' + i,
        timestamp: new Date(epoch + i * 1000).toISOString(),
        actor: i === 124 ? markers.history : 'user',
        type: 'owner_changed',
        from: 'user',
        to: 'team-lead',
      })),
    });
    return {
      side,
      teamName,
      project,
      taskId,
      taskFile,
      kanbanFile,
      groupChatId,
      groupName,
      secondOwner,
      markers,
    };
  });
  for (const file of files)
    assert.equal(createHash('sha256').update(readFileSync(file.path)).digest('hex'), file.sha256);
  const manifest = {
    kind: 'task-tabs-TEST-fixture-v1',
    root,
    preparedAgainstSourceCommit: sourceCommit,
    testedSourceCommit: null,
    uiVerified: false,
    teamOrRuntimeLaunched: false,
    claude,
    env,
    teams,
    files,
  };
  json(join(root, 'fixture.json'), manifest);
  return manifest;
}
