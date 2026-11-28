import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  linkSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readConfiguredMcpServers,
  selectMcpCatalog,
} from '../dist/mcp-catalog/catalog.js';
import {
  captureClaudeMcpCatalog,
  McpCatalogUnavailable,
} from '../dist/mcp-catalog/captureClaudeCatalog.js';
import {
  normalizeTeamMemberMcpPolicy,
  buildTeamMemberMcpSettingSources,
} from '../dist/mcp-catalog/memberPolicy.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'TEST-mcp-catalog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const user = join(root, 'captured-user.json');
  const config = {
    sentinelCredential: 'TEST-private-unrelated',
    mcpServers: {
      shared: { command: 'user' },
      userOnly: { url: 'https://example.invalid/user' },
    },
    projects: {
      [project]: {
        mcpServers: {
          shared: { command: 'local' },
          localOnly: { command: 'local-only' },
        },
      },
    },
  };
  writeFileSync(user, JSON.stringify(config));
  writeFileSync(
    join(project, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        shared: { command: 'project' },
        projectOnly: { command: 'project-only' },
        team: { command: 'TEST-must-not-override' },
      },
    })
  );
  return { root, project, user, config };
}

test('Desktop primitive keeps parser behavior and shallow copied config', () => {
  const input = {
    valid: { command: 'npx', args: ['-y', 'TEST'] },
    bad: null,
    badArray: [],
    badPrimitive: 3,
  };
  const rows = readConfiguredMcpServers(input, 'user');
  assert.deepEqual(rows, [{ name: 'valid', scope: 'user', config: input.valid }]);
  assert.notEqual(rows[0]!.config, input.valid);
  assert.deepEqual(readConfiguredMcpServers(null, 'local'), []);
});

test('actual scoped files apply old user/project/local precedence without leaking unrelated config', (t) => {
  const f = fixture(t),
    before = readFileSync(f.user);
  const rows = captureClaudeMcpCatalog({
    userConfigPath: f.user,
    projectPath: f.project,
  });
  const selected = selectMcpCatalog(rows, undefined, ['team', 'agent-teams']);
  assert.equal(selected.shared!.command, 'local');
  assert.deepEqual(Object.keys(selected).sort(), [
    'localOnly',
    'projectOnly',
    'shared',
    'userOnly',
  ]);
  assert.equal(JSON.stringify(rows).includes('TEST-private-unrelated'), false);
  assert.deepEqual(readFileSync(f.user), before);
});

test('strict allowlist is case insensitive and preserves exact original keys', () => {
  const rows = [
    ...readConfiguredMcpServers(
      { Docs: { command: 'user' }, docs: { command: 'second' }, other: {} },
      'user'
    ),
    ...readConfiguredMcpServers({ Docs: { command: 'project' } }, 'project'),
  ];
  const selected = selectMcpCatalog(rows, {
    mode: 'strictAllowlist',
    serverNames: [' DOCS ', 'agent-teams'],
  });
  assert.deepEqual(Object.keys(selected), ['Docs', 'docs']);
  assert.equal(selected.Docs!.command, 'project');
  assert.equal(selected.docs!.command, 'second');
});

test('inheritScopes selects exact scopes; appOnly returns no external servers', () => {
  const rows = (['user', 'project', 'local'] as const).flatMap((scope) =>
    readConfiguredMcpServers({ [scope]: { command: scope } }, scope)
  );
  assert.deepEqual(
    Object.keys(
      selectMcpCatalog(rows, {
        mode: 'inheritScopes',
        scopes: { user: false, local: false },
      })
    ),
    ['project']
  );
  assert.deepEqual(Object.keys(selectMcpCatalog(rows, { mode: 'appOnly' })), []);
  assert.deepEqual(
    Object.keys(selectMcpCatalog(rows, { mode: 'strictAllowlist', serverNames: [] })),
    []
  );
});

test('policy extraction preserves normalizer and independent non-MCP setting sources', () => {
  assert.equal(normalizeTeamMemberMcpPolicy({ mode: 'inheritLead' }), undefined);
  assert.deepEqual(
    normalizeTeamMemberMcpPolicy({
      mode: 'inheritScopes',
      scopes: { user: false, project: false, local: false },
    }),
    { mode: 'appOnly' }
  );
  assert.deepEqual(
    normalizeTeamMemberMcpPolicy({
      mode: 'strictAllowlist',
      serverNames: [' Docs ', 'docs', 'Other'],
    }),
    { mode: 'strictAllowlist', serverNames: ['Docs', 'Other'] }
  );
  assert.equal(buildTeamMemberMcpSettingSources({ mode: 'appOnly' }), 'user,project,local');
});

for (const fault of ['malformed', 'symlink', 'hardlink', 'oversize', 'invalid-server'])
  test(`captured IO refuses ${fault} without altering source`, (t) => {
    const f = fixture(t);
    if (fault === 'malformed') writeFileSync(f.user, '{TEST');
    if (fault === 'symlink') {
      rmSync(f.user);
      symlinkSync(join(f.project, '.mcp.json'), f.user);
    }
    if (fault === 'hardlink') linkSync(f.user, join(f.root, 'second-link'));
    if (fault === 'oversize') writeFileSync(f.user, Buffer.alloc(2 * 1024 * 1024 + 1, 32));
    if (fault === 'invalid-server')
      writeFileSync(f.user, JSON.stringify({ mcpServers: { bad: [] } }));
    const before = readFileSync(f.user);
    assert.throws(
      () =>
        captureClaudeMcpCatalog({
          userConfigPath: f.user,
          projectPath: f.project,
        }),
      McpCatalogUnavailable
    );
    assert.deepEqual(readFileSync(f.user), before);
  });

test('missing optional source is empty; malformed existing source never becomes empty success', (t) => {
  const f = fixture(t);
  rmSync(f.user);
  rmSync(join(f.project, '.mcp.json'));
  assert.deepEqual(captureClaudeMcpCatalog({ userConfigPath: f.user, projectPath: f.project }), []);
  writeFileSync(f.user, '[]');
  assert.throws(
    () =>
      captureClaudeMcpCatalog({
        userConfigPath: f.user,
        projectPath: f.project,
      }),
    McpCatalogUnavailable
  );
});
