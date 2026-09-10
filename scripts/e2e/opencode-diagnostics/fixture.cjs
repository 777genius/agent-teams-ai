const fs = require('node:fs');
const path = require('node:path');
const root = path.dirname(__filename);
const [role, ...args] = process.argv.slice(2);
const scenario = fs.readFileSync(path.join(root, 'scenario'), 'utf8').trim();
fs.appendFileSync(
  path.join(root, 'calls.ndjson'),
  JSON.stringify({
    event: 'start',
    scenario,
    pid: process.pid,
    parent: process.ppid,
    at: Date.now(),
    binary: role,
    args,
  }) + '\n'
);
const providerQuery = (verb) => {
  if (args[0] !== verb || args[1] !== 'status') return false;
  if (args.length === 2) return true;
  const flags = args.slice(2);
  if (verb === 'runtime' && flags.includes('--summary')) {
    flags.splice(flags.indexOf('--summary'), 1);
  }
  return (
    flags.length === 3 &&
    flags[0] === '--json' &&
    flags[1] === '--provider' &&
    ['anthropic', 'codex', 'gemini', 'opencode'].includes(flags[2])
  );
};
const exact = (...expected) => JSON.stringify(args) === JSON.stringify(expected);
if (
  ![
    'version-exit',
    'version-timeout',
    'ready',
    'delayed8s',
    'directory-error',
    'models-four-errors',
    'partial-success',
    'catalog-retry',
    'catalog-timeout',
  ].includes(scenario)
)
  process.exit(64);
if (role === 'opencode' && exact('--version')) {
  if (scenario === 'version-timeout') {
    process.stderr.write('waiting for fixture\n');
    setTimeout(() => {}, 60000);
  } else if (scenario === 'version-exit') {
    process.stderr.write('fixture failed api_key=DO_NOT_COPY_THIS_SECRET\n');
    process.exitCode = 9;
  } else console.log('1.14.24');
} else if (role === 'orchestrator' && exact('--version')) console.log('2.1.114 (Claude Code)');
else if (role === 'orchestrator' && providerQuery('auth'))
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'oauth' }));
else if (role === 'orchestrator' && providerQuery('runtime')) {
  const emitStatus = () => {
    fs.appendFileSync(
      path.join(root, 'calls.ndjson'),
      JSON.stringify({
        event: 'response',
        operation: 'status',
        scenario,
        pid: process.pid,
        at: Date.now(),
      }) + '\n'
    );
    console.log(
      JSON.stringify({
        providers: Object.fromEntries(
          ['anthropic', 'codex', 'gemini', 'opencode'].map((providerId) => [
            providerId,
            {
              providerId,
              supported: true,
              authenticated: true,
              verificationState: 'verified',
              statusCheckOutcome: 'authoritative',
              statusMessage: 'Sandbox fixture',
              models: [],
              capabilities: { teamLaunch: false, oneShot: false },
            },
          ])
        ),
      })
    );
  };
  if (scenario === 'delayed8s' && args.includes('--summary')) setTimeout(emitStatus, 8000);
  else emitStatus();
} else if (
  role === 'orchestrator' &&
  exact('runtime', 'providers', 'view', '--runtime', 'opencode', '--json', '--compact')
) {
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      runtimeId: 'opencode',
      error: {
        code: 'runtime-unhealthy',
        message: 'Sandbox provider settings unavailable',
        recoverable: true,
      },
    })
  );
} else if (
  role === 'orchestrator' &&
  args.slice(0, 3).join(' ') === 'runtime providers directory'
) {
  catalogCommand('directory');
} else if (role === 'orchestrator' && args.slice(0, 3).join(' ') === 'runtime providers models') {
  catalogCommand('models');
} else {
  process.stderr.write('Fixture refuses unsupported command\n');
  process.exitCode = 64;
}

function catalogCommand(operation) {
  // Strict read-only grammar; never accept launch, auth mutations or runtime actions.
  const flags = new Map();
  for (let i = 3; i < args.length; i++) {
    const flag = args[i];
    if (flags.has(flag)) return refuse();
    if (['--json', '--summary', '--refresh'].includes(flag)) flags.set(flag, true);
    else if (['--runtime', '--provider', '--filter', '--limit'].includes(flag) && args[i + 1])
      flags.set(flag, args[++i]);
    else return refuse();
  }
  if (flags.get('--runtime') !== 'opencode' || flags.get('--json') !== true) return refuse();
  const sources = ['opencode', 'anthropic', 'google', 'openrouter'];
  const source = flags.get('--provider');
  if (operation === 'models' && !sources.includes(source)) return refuse();
  if (operation === 'directory' && source) return refuse();
  const emit = () => {
    const failed =
      (operation === 'directory' && scenario === 'directory-error') ||
      (operation === 'models' &&
        (scenario === 'models-four-errors' ||
          (scenario === 'partial-success' && source !== 'opencode')));
    const response = { schemaVersion: 1, runtimeId: 'opencode' };
    if (failed)
      response.error = {
        code: 'runtime-unhealthy',
        recoverable: true,
        message: `Fixture ${operation} ${source || 'directory'} failed api_key=DO_NOT_COPY_THIS_SECRET`,
      };
    else if (operation === 'directory')
      response.directory = {
        runtimeId: 'opencode',
        totalCount: 4,
        returnedCount: 4,
        query: null,
        filter: 'all',
        limit: 100,
        cursor: null,
        nextCursor: null,
        fetchedAt: new Date().toISOString(),
        diagnostics: [],
        entries: sources.map((providerId) => ({
          providerId,
          displayName: providerId,
          state: 'connected',
          setupKind: 'connect-api-key',
          ownership: [],
          recommended: false,
          modelCount: 1,
          authMethods: [],
          defaultModelId: null,
          sources: ['opencode-provider'],
          sourceLabel: null,
          providerSource: null,
          detail: null,
          actions: [],
          metadata: {
            hasKnownModels: true,
            requiresManualConfig: false,
            supportedInlineAuth: true,
            configuredAuthless: false,
          },
        })),
      };
    else
      response.models = {
        runtimeId: 'opencode',
        providerId: source,
        defaultModelId: null,
        diagnostics: [],
        catalogState: 'fresh',
        totalCount: 1,
        returnedCount: 1,
        cursor: null,
        nextCursor: null,
        models: [
          {
            modelId: 'fixture-model',
            providerId: source,
            displayName: `Fixture ${source} model`,
            sourceLabel: source,
            free: true,
            default: false,
            availability: 'available',
          },
        ],
      };
    fs.appendFileSync(
      path.join(root, 'calls.ndjson'),
      JSON.stringify({
        event: 'response',
        scenario,
        pid: process.pid,
        at: Date.now(),
        operation,
        source,
        failed,
        response,
      }) + '\n'
    );
    console.log(JSON.stringify(response));
  };
  if (operation === 'directory' && scenario === 'catalog-timeout') {
    process.stderr.write('fixture catalog waiting api_key=DO_NOT_COPY_THIS_SECRET\n');
    setTimeout(emit, 60000);
  } else emit();
}
function refuse() {
  process.stderr.write('Fixture refuses unsupported catalog command\n');
  process.exitCode = 64;
}
