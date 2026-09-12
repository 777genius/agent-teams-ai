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
    'startup-cleanup',
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
  } else {
    fs.appendFileSync(
      path.join(root, 'calls.ndjson'),
      JSON.stringify({ event: 'version-success', scenario, pid: process.pid, at: Date.now() }) +
        '\n'
    );
    console.log('1.16.0');
  }
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
} else if (
  scenario === 'startup-cleanup' &&
  role === 'orchestrator' &&
  args[0] === 'runtime' &&
  args[1] === 'opencode-command'
) {
  cleanupCommand();
} else {
  refuse();
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
    setTimeout(emit, 120000);
  } else emit();
}
function refuse() {
  fs.appendFileSync(
    path.join(root, 'calls.ndjson'),
    JSON.stringify({
      event: 'refused',
      scenario,
      pid: process.pid,
      at: Date.now(),
      binary: role,
      args,
    }) + '\n'
  );
  process.stderr.write('Fixture refuses unsupported command\n');
  process.exitCode = 64;
}

// The only synthetic mutating response: no host records, subprocesses or cwd execution.
function cleanupCommand() {
  const assert = require('node:assert/strict');
  const journal = (event, extra = {}) =>
    fs.appendFileSync(
      path.join(root, 'calls.ndjson'),
      JSON.stringify({ event, scenario, pid: process.pid, at: Date.now(), ...extra }) + '\n'
    );
  const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), expected.sort());
  let request;
  try {
    assert.equal(args.length, 7);
    assert.deepEqual(
      args.filter((_, i) => i !== 4 && i !== 6),
      ['runtime', 'opencode-command', '--json', '--input', '--output']
    );
    const [input, output] = [args[4], args[6]];
    const bridgeDir = path.join(root, 'tmp', 'claude-team-opencode-bridge');
    const safe = (file, exists) => {
      assert(path.isAbsolute(file));
      assert(!/^[\\/]{2}/.test(file), 'UNC/device path');
      assert(!file.slice(process.platform === 'win32' ? 2 : 0).includes(':'), 'ADS');
      assert(!file.split(/[\\/]/).some((p) => p === '..' || p === '.' || /[. ]$/.test(p)));
      assert.equal(path.dirname(file), bridgeDir);
      // Walk from the trusted fixture root: reject junctions, including ancestors.
      for (const part of ['tmp', 'tmp/claude-team-opencode-bridge']) {
        const dir = path.join(root, part);
        assert(!fs.lstatSync(dir).isSymbolicLink());
        assert.equal(fs.realpathSync(dir), path.join(fs.realpathSync(root), part));
      }
      let info;
      try {
        info = fs.lstatSync(file);
      } catch (error) {
        if (exists || error.code !== 'ENOENT') throw error;
      }
      if (info) {
        assert(info.isFile() && !info.isSymbolicLink());
        assert.equal(
          fs.realpathSync(file),
          path.join(fs.realpathSync(bridgeDir), path.basename(file))
        );
      }
    };
    safe(input, true);
    safe(output, false);
    assert.equal(output, input + '.output.json');
    assert(!fs.existsSync(output));
    assert(fs.statSync(input).size < 16384);
    request = JSON.parse(fs.readFileSync(input, 'utf8'));
    keys(request, [
      'schemaVersion',
      'requestId',
      'command',
      'cwd',
      'startedAt',
      'timeoutMs',
      'body',
    ]);
    assert.equal(request.schemaVersion, 1);
    assert.equal(request.command, 'opencode.cleanupStartupHosts');
    assert(
      /^opencode-startup-cleanup-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(
        request.requestId
      )
    );
    assert.equal(path.basename(input), `opencode-command-${request.requestId}.json`);
    assert(
      typeof request.cwd === 'string' && request.cwd.length > 0 && !request.cwd.includes('\0')
    );
    const started = Date.parse(request.startedAt);
    assert(Number.isFinite(started) && new Date(started).toISOString() === request.startedAt);
    assert(started <= Date.now() + 1000 && started >= Date.now() - 120000);
    assert(
      Number.isSafeInteger(request.timeoutMs) &&
        request.timeoutMs > 0 &&
        request.timeoutMs <= 120000
    );
    const b = request.body;
    keys(b, [
      'reason',
      'mode',
      'staleAgeMs',
      'leaseStaleAgeMs',
      'preflightLeaseStaleAgeMs',
      'deadlineUnixMs',
    ]);
    assert.equal(b.reason, 'startup');
    assert.equal(b.mode, 'stale');
    assert(Number.isSafeInteger(b.staleAgeMs) && b.staleAgeMs >= 300000);
    assert.equal(b.leaseStaleAgeMs, 86400000);
    assert.equal(b.preflightLeaseStaleAgeMs, 360000);
    assert(Number.isSafeInteger(b.deadlineUnixMs) && b.deadlineUnixMs > Date.now());
    assert(Math.abs(b.deadlineUnixMs - started - request.timeoutMs) <= 1000);
    const control = path.join(root, 'cleanup-control');
    assert(!fs.lstatSync(control).isSymbolicLink());
    assert.equal(fs.realpathSync(control), path.join(fs.realpathSync(root), 'cleanup-control'));
    const marker = path.join(control, request.requestId + '.accepted');
    fs.writeFileSync(marker, '', { flag: 'wx' });
    journal('accepted', { requestId: request.requestId, request });
    process.on('exit', (code) => journal('exit', { requestId: request.requestId, code }));
    const release = path.join(control, request.requestId + '.release.json');
    const timer = setInterval(() => {
      try {
        if (Date.now() >= b.deadlineUnixMs) throw new Error('Unreleased fixture deadline');
        assert(!fs.lstatSync(control).isSymbolicLink());
        assert.equal(fs.realpathSync(control), path.join(fs.realpathSync(root), 'cleanup-control'));
        if (!fs.existsSync(release)) return;
        assert(fs.lstatSync(release).isFile() && !fs.lstatSync(release).isSymbolicLink());
        assert(fs.statSync(release).size < 1024);
        const value = JSON.parse(fs.readFileSync(release, 'utf8'));
        keys(value, ['requestId', 'coverage']);
        assert.equal(value.requestId, request.requestId);
        assert(['partial', 'complete'].includes(value.coverage));
        safe(input, true);
        safe(output, false);
        assert(!fs.existsSync(output));
        const response = {
          ok: true,
          schemaVersion: 1,
          requestId: request.requestId,
          command: request.command,
          completedAt: new Date().toISOString(),
          durationMs: 1,
          runtime: {
            providerId: 'opencode',
            binaryPath: null,
            binaryFingerprint: null,
            version: null,
            capabilitySnapshotId: null,
          },
          diagnostics: [],
          data: {
            cleaned: 0,
            remaining: 0,
            hosts: [],
            diagnostics: value.coverage === 'partial' ? ['Fixture terminal partial coverage'] : [],
            startupCleanup: { completion: 'drained', coverage: value.coverage, survivingPids: [] },
          },
        };
        const staging = output + '.fixture-tmp';
        fs.writeFileSync(staging, JSON.stringify(response), { flag: 'wx' });
        fs.renameSync(staging, output);
        journal('response-written', { requestId: request.requestId, response });
        clearInterval(timer);
      } catch {
        clearInterval(timer);
        refuse();
      }
    }, 50);
  } catch {
    refuse();
  }
}
