/** No Electron package, auth, model calls or tasks: exact desktop TEST setup -> SDK discovery. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
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
const moduleUrl = pathToFileURL(
  path.join(sdk, 'src/services/opencode/bridge/OpenCodeV2RunControl.ts')
).href;
const profileModuleUrl = pathToFileURL(
  path.join(sdk, 'src/services/opencode/OpenCodeProfileManager.ts')
).href;
const script = `
try {
 const { OpenCodeProfileManager } = await import(${JSON.stringify(profileModuleUrl)});
 await new OpenCodeProfileManager().prepareProfile(${JSON.stringify(desktop.projectPath)},
   {includeManagedSubscriptionPlugins:false});
 const { discoverOpenCodeV2Run } = await import(${JSON.stringify(moduleUrl)});
 const owner = await discoverOpenCodeV2Run(process.env.CLAUDE_MULTIMODEL_DATA_HOME,
   ${JSON.stringify(desktop.teamName)}, 'TEST-source-preflight');
 console.log('TEST_SOURCE_GATE=' + JSON.stringify({ok: owner === null}));
 process.exit(owner === null ? 0 : 1);
} catch (error) {
 const match = /^execution_owner_not_private:(private_acl_owner(?:_run_(?:data_root|opencode|v2|runs|leaf))?):[0-9]{1,10}$/.exec(error?.message ?? '');
 console.log('TEST_SOURCE_GATE=' + JSON.stringify({ok:false,
   code:match?'execution_owner_not_private':'source_gate_unknown',role:match?.[1]??'unknown'}));
 process.exit(1);
}`;
let output = '';
let code = 0;
try {
  ({ stdout: output } = await promisify(execFile)(process.execPath, ['-e', script], {
    cwd: sdk,
    env: desktop.env,
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
