import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CapturedProcess } from '../../packages/legacy-agent-host/dist/adapters/providers/CapturedProcess.js';
import { timeout } from './nativeGateContext';

const fileHash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const STDERR_LIMIT = 4096;
const observe = (value: Record<string, unknown>) => {
  try { writeSync(1, JSON.stringify({ nativeLauncherObservation: value }) + '\n'); }
  catch { /* Diagnostics never replace the original result or cleanup. */ }
};

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
          : `@echo off\r\n"${node}" "%~dp0TEST argv.mjs" ${mode === 'positional-bat' ? '"%~1" "%~2" "%~3"' : '%*'}\r\n`;
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
    observe({ mode, phase: 'start' });
    const custody = new CapturedProcess(profile);
    try {
      const child = custody.launch({ command: wrapper, cwd: root, args });
      const output: Buffer[] = [];
      const diagnostics: Buffer[] = [];
      let stderrBytes = 0, capturedBytes = 0;
      child.stderr.on('data', (chunk: Buffer) => {
        const remaining = Math.max(0, STDERR_LIMIT - capturedBytes);
        stderrBytes += chunk.byteLength;
        if (remaining) {
          const captured = Buffer.from(chunk.subarray(0, remaining));
          diagnostics.push(captured); capturedBytes += captured.byteLength;
        }
      });
      child.once('close', (exitCode: number | null) => {
        try {
          let stderr = Buffer.concat(diagnostics).toString('utf8');
          const privateValues: [string, string][] = [
            [wrapper, '<TEST_WRAPPER>'], [script, '<TEST_SCRIPT>'], [bun, '<TEST_BUN>'],
            [node, '<TEST_NODE>'], [broker, '<TEST_BROKER>'], [actor, '<TEST_ACTOR>'],
            [root, '<TEST_ROOT>'], [sandbox, '<TEST_SANDBOX>'],
            ...Object.values(profile.environment).map(value => [value, '<TEST_ENV>'] as [string, string]),
            ...args.filter(Boolean).map(value => [value, '<TEST_ARG>'] as [string, string]),
            [input.toString(), '<TEST_STDIN>'], ['TEST private binary\0input', '<TEST_STDIN>'],
          ];
          const replacements = privateValues.flatMap(([value, label]) =>
            [...new Set([value, value.replaceAll('\\', '/'), JSON.stringify(value).slice(1, -1)])]
              .map(original => ({ original, label }))).sort((a, b) => b.original.length - a.original.length);
          for (const { original, label } of replacements) stderr = stderr.replaceAll(original, label);
          const encoded = Buffer.from(stderr);
          observe({ mode, phase: 'close', exitCode, stderrBytes, capturedBytes,
            stderrTruncated: stderrBytes > capturedBytes || encoded.byteLength > STDERR_LIMIT,
            stderr: new TextDecoder().decode(encoded.subarray(0, STDERR_LIMIT), { stream: true }) });
        } catch { observe({ mode, phase: 'close', exitCode, diagnosticUnavailable: true }); }
      });
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
