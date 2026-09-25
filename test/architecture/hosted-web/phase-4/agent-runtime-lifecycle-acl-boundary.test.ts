import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AGENT_RUNTIME_LIFECYCLE_EFFECTS } from '@features/team-runtime-control/contracts/agent-runtime-lifecycle-acl';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const PRODUCTION_PATHS = [
  'src/features/team-runtime-control/contracts/agent-runtime-lifecycle-acl.ts',
  [
    'src/features/team-runtime-control/core/application/agent-runtime-lifecycle',
    'DispatchAgentRuntimeLifecycleEffect.ts',
  ].join('/'),
  'src/features/team-runtime-control/core/application/agent-runtime-lifecycle/ports.ts',
  'src/features/team-runtime-control/core/application/agent-runtime-lifecycle/index.ts',
  [
    'src/features/team-runtime-control/main/adapters/input/agent-runtime-lifecycle',
    'AgentRuntimeLifecycleWireCodec.ts',
  ].join('/'),
  [
    'src/features/team-runtime-control/main/adapters/input/agent-runtime-lifecycle',
    'AgentRuntimeLifecycleSocketServer.ts',
  ].join('/'),
  'src/features/team-runtime-control/main/adapters/input/agent-runtime-lifecycle/index.ts',
  'src/features/team-runtime-control/main/composition/createAgentRuntimeLifecycleAcl.ts',
  'src/features/team-runtime-control/main/agent-runtime.ts',
] as const;

describe('agent runtime lifecycle effect ACL boundary', () => {
  it('exposes only the five machine-side effects', () => {
    expect(AGENT_RUNTIME_LIFECYCLE_EFFECTS).toEqual([
      'preflight',
      'launch',
      'observe',
      'stop',
      'recover',
    ]);
    const forbiddenCommands =
      /\b(?:createTeam|createRun|chooseProvider|selectProvider|authorizeTeam|schedule|fanOut|retry|mountRoute|registerRoute)\b/;
    for (const path of PRODUCTION_PATHS) {
      expect(source(path), path).not.toMatch(forbiddenCommands);
    }
  });

  it('does not import command owners, browser/server transports, or legacy provisioning', () => {
    const forbidden = [
      '@features/team-lifecycle',
      'TeamProvisioningService',
      '@renderer/',
      'electron',
      'fastify',
      'standalone',
      'node:child_process',
    ];
    for (const path of PRODUCTION_PATHS) {
      const contents = source(path);
      for (const value of forbidden) expect(contents, `${path}: ${value}`).not.toContain(value);
      expect(contents, path).not.toMatch(/\b(?:process\.kill|killProcessByPid|rawPid)\b/);
    }
  });

  it('keeps core runtime-free and leaves existing root feature exports untouched', () => {
    for (const path of PRODUCTION_PATHS.filter((candidate) => candidate.includes('/core/'))) {
      expect(source(path), path).not.toMatch(/from ['"](?:node:|@main|@renderer|@preload)/);
    }
    expect(source('src/features/team-runtime-control/index.ts')).not.toContain(
      'agent-runtime-lifecycle'
    );
    expect(source('src/features/team-runtime-control/contracts/index.ts')).not.toContain(
      'agent-runtime-lifecycle'
    );
  });

  it('is not mounted by any pre-existing production composition', () => {
    const dedicatedEntry = 'src/features/team-runtime-control/main/agent-runtime.ts';
    for (const path of ['src/features/team-runtime-control/index.ts', 'src/main/standalone.ts']) {
      expect(source(path), path).not.toContain(dedicatedEntry);
      expect(source(path), path).not.toContain('createAgentRuntimeLifecycleAcl');
    }
  });

  it('exposes a feature-owned lifecycle facade without raw dispatch or adapters', () => {
    const entrypoint = source('src/features/team-runtime-control/main/agent-runtime.ts');
    expect(entrypoint).toContain('createAgentRuntimeLifecycleAcl');
    expect(entrypoint).toContain('AgentRuntimeLifecycleAcl');
    expect(entrypoint).not.toMatch(/DispatchAgentRuntimeLifecycleEffect|SocketServer|WireCodec/);
    expect(entrypoint).not.toContain('/adapters/');

    const composition = source(
      'src/features/team-runtime-control/main/composition/createAgentRuntimeLifecycleAcl.ts'
    );
    expect(composition).toContain('start: () => server.start()');
    expect(composition).toContain('stop: () => server.stop()');
    expect(composition).not.toMatch(/return Object\.freeze\(\{\s*dispatch|\{ dispatch, server \}/);
  });
});

function source(path: string): string {
  // Repository-owned fixed allowlist.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(resolve(ROOT, path), 'utf8');
}
