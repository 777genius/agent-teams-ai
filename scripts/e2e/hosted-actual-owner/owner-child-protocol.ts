export const OWNER_CHILD_FDS = Object.freeze({
  sealedLauncherLease: 3,
  bootstrap: 4,
  activationV2: 5,
} as const);
export const OWNER_WRAPPER_ARGUMENT = '--runtime-manifest' as const;
export const OWNER_SEALED_PROTOCOL_ARGUMENT = '--hosted-actual-owner-sealed-protocol=v1' as const;
export const OWNER_CHILD_PROTOCOL = Object.freeze({
  sealedLauncherLease: Object.freeze({
    fd: 3,
    kind: 'sealed-memfd',
    format: 'agent-teams.hosted-control.launcher-lease/v1',
    maximumBytes: 64 * 1024,
    requiredSeals: Object.freeze(['seal', 'shrink', 'grow', 'write'] as const),
    childOwnership: 'retained-until-owner-close',
  }),
  bootstrap: Object.freeze({
    fd: 4,
    kind: 'one-use-stream',
    format: 'agent-teams.hosted-control.bootstrap/v1',
    framing: 'u32be-header-length+canonical-json-header+32-byte-key+32-byte-hmac',
    maximumHeaderBytes: 64 * 1024,
    maximumFrameBytes: 4 + 64 * 1024 + 32 + 32,
    childOwnership: 'close-after-one-frame-eof',
  }),
  activationV2: Object.freeze({
    fd: 5,
    kind: 'connected-stream-socket',
    protocol: 'agent-teams.hosted-approval-activation-v2',
    alreadyAuthenticated: true,
    maximumPrepareBytes: 64 * 1024,
    maximumResponseBytes: 64 * 1024,
    maximumAdmissionBytes: 256 * 1024,
    childOwnership: 'retained-by-activation-lease',
  }),
  parentOwnership: Object.freeze({
    sourceDescriptors: 'arbitrary-distinct-owned',
    closeCopiesAfterSpawn: true,
  }),
} as const);

// The legacy constants above retain their original meaning. V2 never infers roles from a position.
export const OWNER_V2_ROLE_FDS = Object.freeze({
  'sealed-launcher-lease': 3, bootstrap: 4, 'activation-v2': 5, liveness: 6,
  'private-server-auth': 7, 'raw-opencode-retention': 8, 'owner-wal-native': 9,
  'executable-anchor': 11,
} as const);
export type OwnerV2Role = keyof typeof OWNER_V2_ROLE_FDS;
export const OWNER_V2_ARGUMENT = '--hosted-actual-owner-sealed-protocol=v2' as const;
export const OWNER_V2_ARGV = Object.freeze([
  OWNER_V2_ARGUMENT, OWNER_WRAPPER_ARGUMENT, '/sandbox/runtime-manifest.json',
] as const);
export const OWNER_CHILD_FDS_V2 = Object.freeze({
  sealedLauncherLease: 3, bootstrap: 4, activationV2: 5, liveness: 6,
  privateServerAuth: 7, rawOpenCodeRetention: 8, ownerWalNative: 9, executableAnchor: 11,
} as const);
export const OWNER_CHILD_PROTOCOL_V2 = Object.freeze({
  sealedLauncherLease: Object.freeze({ ...OWNER_CHILD_PROTOCOL.sealedLauncherLease,
    format: 'agent-teams.hosted-control.launcher-lease/v2' }),
  bootstrap: Object.freeze({ ...OWNER_CHILD_PROTOCOL.bootstrap,
    format: 'agent-teams.hosted-control.bootstrap/v2' }),
  activationV2: OWNER_CHILD_PROTOCOL.activationV2,
  liveness: Object.freeze({ fd: 6, kind: 'connected-stream-socket', childOwnership: 'retained-until-owner-close' }),
  privateServerAuth: Object.freeze({ fd: 7, kind: 'one-use-stream',
    format: 'agent-teams.hosted-control.opencode-server-auth/v1', maximumFrameBytes: 8196,
    childOwnership: 'close-after-one-frame-eof' }),
  rawOpenCodeRetention: Object.freeze({ fd: 8, kind: 'regular-file', accessMode: 'write-only', append: true }),
  ownerWalNative: Object.freeze({ fd: 9, kind: 'regular-file', accessMode: 'write-only', append: true }),
  reservedFd: 10,
  executableAnchor: Object.freeze({ fd: 11, kind: 'regular-file', accessMode: 'read-only',
    childOwnership: 'close-before-helper-spawn' }),
  descriptorMap: 'agent-teams.hosted-owner-child-fd-map/v2',
  parentCleanup: 'agent-teams.hosted-owner-child-parent-fd-cleanup/v3',
  parentOwnership: OWNER_CHILD_PROTOCOL.parentOwnership,
} as const);
export function legacyOwnerChildPlan() {
  return Object.freeze({
    wrapperArgv: Object.freeze([OWNER_WRAPPER_ARGUMENT, '/sandbox/runtime-manifest.json'] as const),
    sealedArgv: Object.freeze([OWNER_SEALED_PROTOCOL_ARGUMENT, OWNER_WRAPPER_ARGUMENT,
      '/sandbox/runtime-manifest.json'] as const),
    childLocalDescriptors: OWNER_CHILD_FDS, descriptorContract: OWNER_CHILD_PROTOCOL,
    parentSourceDescriptors: 'arbitrary-distinct-owned' as const, closeParentCopiesAfterSpawn: true as const,
    compatibilityProbing: false as const, socketPathReconnect: false as const,
  });
}
export function ownerChildPlanV2() {
  return Object.freeze({ ...legacyOwnerChildPlan(), protocolVersion: 2 as const,
    // Any wrapper caller must preserve the discriminator too. No legacy shell path is authorized.
    wrapperArgv: OWNER_V2_ARGV, sealedArgv: OWNER_V2_ARGV,
    childLocalDescriptors: OWNER_CHILD_FDS_V2, descriptorContract: OWNER_CHILD_PROTOCOL_V2 });
}
export type OwnerChildPlan = ReturnType<typeof legacyOwnerChildPlan> | ReturnType<typeof ownerChildPlanV2>;
export interface OwnerSourceInvocation {
  readonly format: 'agent-teams.hosted-owner-source-invocation/v1';
  readonly executable: { readonly device: string; readonly inode: string; readonly sha256: string };
  readonly module: { readonly path: string; readonly sha256: string };
}
