import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CapturedProcess } from '../../packages/legacy-agent-host/dist/adapters/providers/CapturedProcess.js';
import { timeout } from './nativeGateContext';

const fileHash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Genuine Windows argv/stdin round trips through repository-only executable/script fixtures. */
export async function nativeLauncherScenarios(sandbox: string, broker: string, actor: string): Promise<string[]> {
  assert.ok(process.arch === 'x64' || process.arch === 'arm64');
  const root = join(sandbox, 'TEST launchers Я'); mkdirSync(root);
  const node = realpathSync(process.execPath), script = join(root, 'TEST argv.mjs');
  writeFileSync(script, "const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);" +
    "process.stdout.write(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),value:process.env.TEST_VALUE,input:Buffer.concat(chunks).toString('base64')}));\n", { flag: 'wx' });
  const bun = join(root, 'bun.exe'); copyFileSync(node, bun);
  const input = Buffer.from('TEST binary\0stdin');
  const adversarial = ['TOKEN={"k":"x&echo INJECTED|rem ","pct":"%PATH%","bang":"!PATH!"}', '', 'C:\\temp\\'];
  const results: string[] = [];
  for (const mode of ['npm-node', 'generated-bun', 'opaque-cmd', 'positional-bat', 'npm-native'] as const) {
    const wrapper = join(root, `TEST ${mode}.${mode === 'positional-bat' ? 'bat' : 'cmd'}`);
    const content = mode === 'npm-node' ? `@echo off\r\nset "_prog=node"\r\n"%_prog%" "${script}" %*\r\n`
      : mode === 'generated-bun' ? `@echo off\r\nset "TARGET=${script}"\r\nbun "%TARGET%" %*\r\n`
        : mode === 'npm-native' ? `@echo off\r\n"${actor}" %*\r\n`
          : `@echo off\r\n"${node}" "${script}" ${mode === 'positional-bat' ? '"%~1" "%~2" "%~3"' : '%*'}\r\n`;
    writeFileSync(wrapper, content, { flag: 'wx' });
    const profile = { provider: 'codex' as const, cwd: root,
      executable: { path: realpathSync(wrapper), sha256: fileHash(wrapper) },
      environment: { HOME: root, CODEX_HOME: root, SystemRoot: process.env.SystemRoot!,
        PATH: [root, dirname(node)].join(';'), TEST_VALUE: 'TEST captured',
        TEST_CAPTURED_CWD: root, TEST_CAPTURED_VALUE: 'space quote " slash\\ end\\ Я日' },
      windowsBroker: { path: broker, sha256: fileHash(broker), arch: process.arch, protocol: 1 as const } };
    const args = mode === 'positional-bat' ? ['safe value', '', 'C:\\temp\\']
      : mode === 'npm-native' ? ['selection', join(root, 'native-start'), randomUUID(), '', 'space quote " slash\\ end\\', 'Я日']
        : adversarial;
    const custody = new CapturedProcess(profile);
    try {
      const child = custody.launch({ command: wrapper, cwd: root, args });
      const output: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
      const closed = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
      child.stdin.end(mode === 'npm-native' ? 'TEST private binary\0input' : input);
      assert.equal(await timeout(closed), mode === 'npm-native' ? 7 : 0);
      const bytes = Buffer.concat(output).toString();
      if (mode === 'npm-native') assert.equal(bytes, 'TEST private binary\0inputTEST native stdout tail\n');
      else assert.deepEqual(JSON.parse(bytes), { argv: args, cwd: root, value: 'TEST captured', input: input.toString('base64') });
      assert.equal(await custody.confirmStopped(), true);
      results.push(mode);
    } finally { assert.equal(await custody.confirmStopped(), true); }
  }
  return results;
}
