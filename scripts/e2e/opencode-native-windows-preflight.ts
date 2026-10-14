/** No Electron package, real credentials, model calls or tasks: exact desktop TEST setup -> SDK discovery. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { realpath, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { prepareNativeDesktopEnvironment } from './opencode-native-desktop-environment';
import { protectWindowsTestDirectory } from './opencode-native-test-auth';

assert.equal(process.platform, 'win32');
assert.equal(process.versions.bun, '1.3.11');
assert.equal(process.argv.length, 3);
const sdk = await realpath(path.resolve(process.argv[2]!));
const desktop = await prepareNativeDesktopEnvironment();
// Match the packaged Windows scenario exactly: root protection follows child creation.
await protectWindowsTestDirectory(desktop.root);
const mcpEntry = path.join(desktop.root, 'TEST-never-launch-mcp.mjs');
await writeFile(mcpEntry, "throw new Error('Source gate must not launch MCP');\n", {
  flag: 'wx', mode: 0o600,
});
const moduleUrl = pathToFileURL(
  path.join(sdk, 'src/services/opencode/bridge/OpenCodeV2RunControl.ts')
).href;
const profileModuleUrl = pathToFileURL(
  path.join(sdk, 'src/services/opencode/OpenCodeProfileManager.ts')
).href;
const authModuleUrl = pathToFileURL(
  path.join(sdk, 'src/services/opencode/OpenCodeAuthStore.ts')
).href;
const script = `
let stage='seed-sdk-auth';
try {
 const { OpenCodeProfileManager, resolveOpenCodeProfileScope } = await import(${JSON.stringify(profileModuleUrl)});
 const manager = new OpenCodeProfileManager();
 const { upsertOpenCodeApiAuthCredential } = await import(${JSON.stringify(authModuleUrl)});
 await upsertOpenCodeApiAuthCredential({authPath:manager.getGlobalAuthPath(),
   providerId:'openrouter',apiKey:'TEST-noncredential'});
 stage='resolve-scope';
 const profileScope = await resolveOpenCodeProfileScope({
   projectPath:${JSON.stringify(desktop.projectPath)}, purpose:'launch_runtime',
   selectedModel:'openrouter/TEST-model', env:process.env});
 stage='prepare-profile';
 await manager.prepareProfile(${JSON.stringify(desktop.projectPath)},
   {profileScope,includeAppMcp:false,includeManagedSubscriptionPlugins:false});
 stage='discover';
 const { discoverOpenCodeV2Run } = await import(${JSON.stringify(moduleUrl)});
 const owner = await discoverOpenCodeV2Run(process.env.CLAUDE_MULTIMODEL_DATA_HOME,
   ${JSON.stringify(desktop.teamName)}, 'TEST-source-preflight');
 console.log('TEST_SOURCE_GATE=' + JSON.stringify({ok: owner === null,stage}));
 process.exit(owner === null ? 0 : 1);
} catch (error) {
 const match = /^execution_owner_not_private:(private_acl_owner(?:_run_(?:data_root|opencode|v2|runs|leaf))?):[0-9]{1,10}(?::private_dir_([0-9]{1,2}))?$/.exec(error?.message ?? '');
 console.log('TEST_SOURCE_GATE=' + JSON.stringify({ok:false,stage,
   code:match?'execution_owner_not_private':'source_gate_unknown',role:match?.[1]??'unknown',privateDirectoryIndex:match?.[2]??null}));
 process.exit(1);
}`;
let output = '';
let code = 0;
try {
  ({ stdout: output } = await promisify(execFile)(process.execPath, ['-e', script], {
    cwd: sdk,
    env: { ...desktop.env, OPENROUTER_API_KEY: 'TEST-noncredential',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: mcpEntry },
    timeout: 45_000,
    maxBuffer: 65_536,
  }));
} catch (error: unknown) {
  code = 1;
  if (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string')
    output = error.stdout;
}
const receipts = output.split(/\r?\n/).filter((line) => line.startsWith('TEST_SOURCE_GATE='));
assert.equal(receipts.length, 1, 'Source preflight receipt unavailable');
const receipt: unknown = JSON.parse(receipts[0]!.slice('TEST_SOURCE_GATE='.length));
assert(receipt && typeof receipt === 'object' && 'ok' in receipt);
console.log(
  JSON.stringify({ scope: 'desktop TEST setup -> real SDK native discovery', ...receipt })
);
assert.equal(code, 0, 'Source discovery gate failed; do not package or submit model tasks');
