/** TEST-only shell syntax proof, runnable with Node type stripping before dependencies. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { windowsVerificationCommand } from './opencode-native-real-task-prompts.ts';

const execute = promisify(execFile);
export type WindowsCommandSyntaxFact = {
  shell: 'powershell' | 'cmd'; markerMatches: boolean; exitCode: number | null;
  nativeCode: string | null; signal: 'SIGTERM' | 'SIGKILL' | null;
};

export async function verifyWindowsCommandSyntax(
  executable: string,
  project: string,
  env: NodeJS.ProcessEnv,
  observe: (fact: WindowsCommandSyntaxFact) => Promise<void>
) {
  assert.equal(process.platform, 'win32');
  const marker = `HOST_COMMAND_SYNTAX:${randomUUID()}`;
  const program = path.join(project, 'host-command-syntax.cjs');
  await writeFile(program, `console.log(${JSON.stringify(marker)});`, { flag: 'wx' });
  const command = windowsVerificationCommand(executable, program);
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  assert(systemRoot && path.isAbsolute(systemRoot), 'Windows system shell root required');
  for (const [shellClass, shell, args] of [
    ['powershell', path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]],
    ['cmd', path.join(systemRoot, 'System32/cmd.exe'), ['/d', '/s', '/c', command]],
  ] as const) {
    let markerMatches: boolean;
    try {
      const result = await execute(shell, [...args], {
        cwd: project, env, timeout: 20_000, maxBuffer: 16_384,
      });
      markerMatches = result.stdout.trim() === marker;
    } catch (error: unknown) {
      const failure = error && typeof error === 'object' ? error as { code?: unknown; signal?: unknown } : {};
      await observe({ shell: shellClass, markerMatches: false,
        exitCode: typeof failure.code === 'number' && Number.isInteger(failure.code) ? failure.code : null,
        nativeCode: typeof failure.code === 'string' && /^(?:ENOENT|EACCES|EPERM|ETIMEDOUT)$/.test(failure.code) ? failure.code : null,
        signal: failure.signal === 'SIGTERM' || failure.signal === 'SIGKILL' ? failure.signal : null });
      throw new Error(`TEST ${shellClass} verifier syntax failed`);
    }
    await observe({ shell: shellClass, markerMatches, exitCode: 0, nativeCode: null, signal: null });
    assert(markerMatches, `TEST ${shellClass} literal command marker missing`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const main = async () => {
    const executable = process.env.OPENCODE_NATIVE_TEST_NODE_PATH;
    assert(executable && path.basename(executable) === 'node.exe' && executable.includes('TEST-'),
      'Explicit staged TEST Node required');
    const project = await mkdtemp(path.join(os.tmpdir(), 'TEST-command-syntax-'));
    try {
      await verifyWindowsCommandSyntax(executable, project, process.env, async fact => {
        console.log(JSON.stringify({ phase: 'command_syntax', ...fact }));
      });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  };
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    const guard = message.startsWith('Cross-shell TEST') || message === 'Canonical TEST command paths required'
      ? 'unsafe_test_path'
      : message === 'Explicit staged TEST Node required' ? 'test_node_required'
        : message === 'Windows system shell root required' ? 'system_shell_root_required'
          : message.startsWith('TEST powershell') ? 'powershell_failure'
            : message.startsWith('TEST cmd') ? 'cmd_failure' : 'host_setup_failure';
    console.log(JSON.stringify({ phase: 'command_syntax', status: 'failed', guard }));
    process.exitCode = 1;
  });
}
