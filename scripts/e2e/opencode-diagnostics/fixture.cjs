const fs = require('node:fs');
const path = require('node:path');
const root = path.dirname(__filename);
const [role, ...args] = process.argv.slice(2);
const scenario = fs.readFileSync(path.join(root, 'scenario'), 'utf8').trim();
fs.appendFileSync(path.join(root, 'calls.ndjson'), JSON.stringify({ binary: role, args }) + '\n');
const providerQuery = (verb) =>
  args[0] === verb &&
  args[1] === 'status' &&
  (args.length === 2 ||
    ((args.length === 5 || (verb === 'runtime' && args.length === 6 && args[5] === '--summary')) &&
      args[2] === '--json' &&
      args[3] === '--provider' &&
      ['anthropic', 'codex', 'gemini', 'opencode'].includes(args[4])));
const exact = (...expected) => JSON.stringify(args) === JSON.stringify(expected);
if (!['version-exit', 'version-timeout', 'ready'].includes(scenario)) process.exit(64);
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
else if (role === 'orchestrator' && providerQuery('runtime'))
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
else if (
  role === 'orchestrator' &&
  (exact('runtime', 'providers', 'view', '--runtime', 'opencode', '--json', '--compact') ||
    exact('runtime', 'providers', 'directory', '--runtime', 'opencode', '--json'))
)
  console.log(
    JSON.stringify({
      runtimeId: 'opencode',
      ok: false,
      error: {
        code: 'runtime-unhealthy',
        message: 'Sandbox provider settings unavailable',
        recoverable: true,
      },
    })
  );
else {
  process.stderr.write('Fixture refuses unsupported command\n');
  process.exitCode = 64;
}
