import { join } from 'node:path';

/** Inert selected profile shared by the Node and socket-free Vitest probe checks. */
export function opencodeV2ModelProbeProfile(root: string, model = 'TEST-model', timeoutMs = 30000) {
  return {
    provider: 'opencode', nativeGeneration: 'v2', protocolRevision: '2.1.4',
    teamId: 'TEST-team', memberId: 'TEST-member', principalId: 'TEST-principal',
    sessionId: 'TEST-session', generation: 1, configRevision: 'TEST-revision',
    cwd: root, accountBinding: 'TEST-account', model,
    executable: { path: join(root, 'TEST-bun'), sha256: 'a'.repeat(64) },
    endpoint: 'http://127.0.0.1:19332',
    environment: Object.fromEntries(
      ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'].map(key => [key, root])
    ),
    embedded: {
      version: '2.1.4', platform: process.platform, arch: process.arch,
      directory: join(root, 'engine'), manifestSha256: 'b'.repeat(64), externalDirectory: 'deny',
    },
    nativeOptions: { providerId: 'TEST-provider', agent: 'build', variant: 'high', toolApprovalMode: 'manual' },
    limits: { queuedInputs: 1, inputBytes: 4096, outputBytes: 8192, outputEvents: 128,
      pendingInteractions: 1, timeoutMs },
  } as const;
}
