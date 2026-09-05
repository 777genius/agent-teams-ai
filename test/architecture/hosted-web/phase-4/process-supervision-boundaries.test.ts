import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  NodeAnchorSpawner,
  NodeAttestedOwningProcess,
} from '@features/team-runtime-control/main/infrastructure/process-supervision';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  AnchorSpawnPort,
  AttestedOwningProcessPort,
} from '@features/team-runtime-control/main/adapters/output/process-supervision';

const ROOT = resolve(import.meta.dirname, '../../../..');
const OWNED_PRODUCTION_FILES = [
  'src/features/team-runtime-control/main/infrastructure/process-supervision/index.ts',
  'src/features/team-runtime-control/main/infrastructure/process-supervision/NodeAnchorLaunchMaterializer.ts',
  'src/features/team-runtime-control/main/infrastructure/process-supervision/NodeAnchorSpawner.ts',
  'src/features/team-runtime-control/main/infrastructure/process-supervision/NodeAttestedOwningProcess.ts',
  'src/features/team-runtime-control/main/native/process-anchor/process_anchor_protocol.h',
  'src/features/team-runtime-control/main/native/process-anchor/process_anchor.c',
] as const;

function source(relativePath: (typeof OWNED_PRODUCTION_FILES)[number] | string): string {
  // Repository-owned fixed allowlist and fixed architecture paths.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

describe('Phase 4 process supervision architecture boundaries', () => {
  it('keeps concrete launch authority and native ownership main-only', () => {
    const browserSafe = [
      source('src/features/team-runtime-control/index.ts'),
      source('src/features/team-runtime-control/contracts/index.ts'),
    ].join('\n');
    const centralMain = source('src/main/index.ts');

    expect(browserSafe).not.toMatch(
      /NodeAnchor(?:LaunchMaterializer|Spawner|Status|Control)|NodeAttestedOwningProcess|process_anchor/
    );
    expect(centralMain).not.toMatch(/NodeAnchorSpawner|process_anchor/);
    expectTypeOf<NodeAnchorSpawner>().toExtend<AnchorSpawnPort>();
    expectTypeOf<NodeAttestedOwningProcess>().toExtend<AttestedOwningProcessPort>();
  });

  it('materializes opaque authorities without inheriting host environment or launch paths', () => {
    const materializer = source(
      'src/features/team-runtime-control/main/infrastructure/process-supervision/NodeAnchorLaunchMaterializer.ts'
    );
    const spawner = source(
      'src/features/team-runtime-control/main/infrastructure/process-supervision/NodeAnchorSpawner.ts'
    );

    expect(materializer).toMatch(/Main-process-only resolver from opaque launch authorities/);
    expect(materializer).toMatch(/computeCanonicalPolicyDigest/);
    expect(materializer).toMatch(/anchor-launch-executable-hash-mismatch/);
    expect(materializer).not.toMatch(/process\.env|window\.|@renderer|@preload/);
    expect(spawner).toMatch(
      /this\.spawnProcess\s*=\s*options\.spawnProcess \?\?\s*\(\(command, args, spawnOptions\) => spawn\(command, args, spawnOptions\)\)/
    );
    expect(spawner).toContain('child = this.spawnProcess(anchorExecutablePath, [], {');
    expect(spawner).toMatch(/cwd:\s*neutralWorkingDirectory/);
    expect(spawner).toMatch(/env:\s*\{\}/);
    expect(spawner).toMatch(/shell:\s*false/);
    expect(spawner).toMatch(/detached:\s*false/);
    expect(spawner).toMatch(
      /stdio:\s*\[\s*'pipe',\s*'pipe',\s*'ignore',\s*'pipe',\s*materialized\.executableDescriptor,\s*materialized\.workdirDescriptor,\s*\]/
    );
    expect(materializer).toContain('executableDescriptor: input.executableHandle.fd');
    expect(materializer).toContain('workdirDescriptor: input.workdirHandle.fd');
    expect(spawner).toContain('launch = child.stdio[3] as Writable | null;');
    expect(spawner).toMatch(/endWithBytes\(launchStream, launchBytes\)/);
  });

  it('passes one bounded protocol-v1 launch frame over a dedicated EOF-delimited pipe', () => {
    const protocol = source(
      'src/features/team-runtime-control/main/native/process-anchor/process_anchor_protocol.h'
    );
    const anchor = source(
      'src/features/team-runtime-control/main/native/process-anchor/process_anchor.c'
    );
    const spawner = source(
      'src/features/team-runtime-control/main/infrastructure/process-supervision/NodeAnchorSpawner.ts'
    );

    expect(protocol).toContain('#define PA_PROTOCOL_VERSION 1');
    expect(protocol).toContain('#define PA_MAX_LAUNCH_BYTES (512U * 1024U)');
    expect(protocol).toContain('#define PA_MAX_CONTROL_BYTES 4096U');
    expect(anchor).toMatch(/pa_read_frame\(PA_LAUNCH_FD,[\s\S]*1\)/);
    expect(protocol).toMatch(/seen != 0x7ffffU/);
    expect(protocol).toMatch(/seen != 0x7ffU/);
    expect(anchor).toContain('#define PA_LAUNCH_FD 3');
    expect(anchor).toContain('int main(void)');
    expect(spawner).toContain('NODE_ANCHOR_MAX_LAUNCH_FRAME_BYTES = 512 * 1_024');
    expect(spawner).toMatch(/JSON\.stringify\(frame\)/);
    expect(spawner).not.toMatch(/spawn\(anchorExecutablePath,\s*\[[^\]]+\]/);
  });

  it('isolates provider cwd, environment, stdio, and undeclared descriptors in native code', () => {
    const anchor = source(
      'src/features/team-runtime-control/main/native/process-anchor/process_anchor.c'
    );

    expect(anchor).toContain('#define PA_EXECUTABLE_FD 4');
    expect(anchor).toContain('#define PA_WORKDIR_FD 5');
    expect(anchor).toMatch(/fchdir\(PA_WORKDIR_FD\)/);
    expect(anchor).toMatch(/open\("\/dev\/null", O_RDWR \| O_CLOEXEC\)/);
    expect(anchor).toMatch(/dup2\(null_fd, STDIN_FILENO\)/);
    expect(anchor).toMatch(/dup2\(null_fd, STDOUT_FILENO\)/);
    expect(anchor).toMatch(/dup2\(null_fd, STDERR_FILENO\)/);
    expect(anchor).toMatch(/pa_close_provider_descriptors\(handoff_pipe\[1\]\)/);
    expect(anchor).toMatch(
      /SYS_execveat, PA_EXECUTABLE_FD, "", arguments, environment, AT_EMPTY_PATH/
    );
    expect(anchor).not.toMatch(/\bchdir\s*\(|\bexecve\s*\(/);
    expect(anchor).not.toMatch(/\bexec[lv]?p[e]?\s*\(|\benviron\b/);
  });

  it('uses pidfds and a subreaper without a numeric signal fallback', () => {
    const anchor = source(
      'src/features/team-runtime-control/main/native/process-anchor/process_anchor.c'
    );

    expect(anchor).toMatch(/SYS_pidfd_open/);
    expect(anchor).toMatch(/SYS_pidfd_send_signal/);
    expect(anchor).toMatch(/PR_SET_CHILD_SUBREAPER/);
    expect(anchor).toMatch(/before\.start_time != after\.start_time/);
    expect(anchor).toMatch(/after\.pgrp != owned_pgrp/);
    expect(anchor).not.toMatch(/\bkill\s*\(|\bkillpg\s*\(/);
  });

  it('binds boot-local EOF evidence to the exact ChildProcess handle and never signals identity refs', () => {
    const ownership = source(
      'src/features/team-runtime-control/main/infrastructure/process-supervision/NodeAttestedOwningProcess.ts'
    );
    const spawner = source(
      'src/features/team-runtime-control/main/infrastructure/process-supervision/NodeAnchorSpawner.ts'
    );

    expect(ownership).toContain("child.once('close'");
    expect(ownership).toMatch(/isExactProcessOwnerAttestation/);
    expect(ownership).not.toMatch(/\.pid\b|process\.kill|\.kill\s*\(/);
    expect(spawner).toContain('new NodeAttestedOwningProcess(child, ownerAttestation)');
    expect(spawner).toContain("if (!child.killed) child.kill('SIGKILL');");
    expect(spawner).not.toMatch(/\.pid\b|process\.kill/);
    expect(spawner.match(/[A-Za-z_$][\w$]*\.kill\s*\([^)]*\)/gu)).toEqual([
      "child.kill('SIGKILL')",
    ]);
  });

  it('emits only the current strict JSON status/control vocabulary', () => {
    const anchor = source(
      'src/features/team-runtime-control/main/native/process-anchor/process_anchor.c'
    );
    const protocol = source(
      'src/features/team-runtime-control/main/native/process-anchor/process_anchor_protocol.h'
    );
    const combined = OWNED_PRODUCTION_FILES.map((path) => source(path)).join('\n');

    for (const frameType of [
      'ready',
      'main_exit',
      'escalation',
      'drained',
      'unclassified_residual',
      'protocol_error',
    ]) {
      expect(anchor).toContain(`\\"type\\":\\"${frameType}\\"`);
    }
    expect(protocol).toMatch(/strcmp\(control->type, "stop"\)/);
    expect(combined).not.toMatch(/fastify|electron|@renderer|@preload|window\./i);
  });
});
