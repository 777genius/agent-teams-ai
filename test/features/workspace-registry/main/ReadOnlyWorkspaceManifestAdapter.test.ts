import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  MAX_WORKSPACE_ALLOWED_OPERATIONS,
  MAX_WORKSPACE_REGISTRATIONS,
  WORKSPACE_OPERATIONS,
} from '@features/workspace-registry/contracts/workspace-registration';
import {
  AdmittedWorkspaceManifestSource,
  ReadOnlyWorkspaceManifestAdapter,
  type WorkspaceManifestSourceAdmission,
  type WorkspaceStartupManifestSource,
} from '@features/workspace-registry/main/infrastructure/ReadOnlyWorkspaceManifestAdapter';
import { parseWorkspaceId } from '@shared/contracts/hosted';
import { afterEach, describe, expect, it } from 'vitest';

import { checkFeatureDependencies } from '../../../../scripts/hosted-web/phase-1/check-feature-dependencies';

const MARKER_FILE = '.agent-teams-p2-c-test-root';
const ROOT_HASH = '1'.repeat(64);
const OTHER_ROOT_HASH = '2'.repeat(64);
const WORKSPACE_ID = 'workspace_00000000000000000000000000000001';
const OTHER_WORKSPACE_ID = 'workspace_00000000000000000000000000000002';
const EMPTY_DEPLOYMENT = { kind: 'empty-deployment' } as const;

interface OwnedRoot {
  readonly path: string;
  readonly nonce: string;
}

const cleanupRoots: OwnedRoot[] = [];

async function createOwnedRoot(label: string): Promise<OwnedRoot> {
  const path = await mkdtemp(join(tmpdir(), `agent-teams-p2-c-${label}-`));
  const nonce = `${label}-${process.pid}-${cleanupRoots.length}`;
  await writeFile(join(path, MARKER_FILE), nonce, { flag: 'wx', mode: 0o600 });
  const root = { path, nonce };
  cleanupRoots.push(root);
  return root;
}

async function markerCheckedCleanup(root: OwnedRoot): Promise<void> {
  const stat = await lstat(root.path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('test-root-cleanup-refused');
  }
  if ((await readFile(join(root.path, MARKER_FILE), 'utf8')) !== root.nonce) {
    throw new Error('test-root-marker-mismatch');
  }

  const canonicalRoot = await realpath(root.path);
  const canonicalTemporaryDirectory = await realpath(tmpdir());
  if (
    !isWithin(canonicalRoot, canonicalTemporaryDirectory) ||
    canonicalRoot === canonicalTemporaryDirectory
  ) {
    throw new Error('test-root-cleanup-outside-temporary-directory');
  }
  await rm(root.path, { recursive: true, force: false });
}

afterEach(async () => {
  for (const root of cleanupRoots.splice(0).reverse()) {
    await markerCheckedCleanup(root);
  }
});

class MarkerOwnedRootAdmission implements WorkspaceManifestSourceAdmission {
  constructor(
    private readonly root: string,
    private readonly ownedRoots: ReadonlyMap<string, string>
  ) {}

  async assertAdmittedSource(sourceLocation: string): Promise<void> {
    if (!isAbsolute(sourceLocation)) {
      throw new Error('test-root-source-not-absolute');
    }

    const normalizedRoot = resolve(this.root);
    const normalizedSource = resolve(sourceLocation);
    const expectedNonce = this.ownedRoots.get(normalizedRoot);
    if (!expectedNonce) {
      throw new Error('test-root-pre-existing-or-unowned');
    }
    if (!isWithin(normalizedSource, normalizedRoot)) {
      throw new Error('test-root-source-escaped');
    }
    if (
      (await readFile(join(normalizedRoot, MARKER_FILE), 'utf8').catch(() => null)) !==
      expectedNonce
    ) {
      throw new Error('test-root-marker-missing');
    }

    await assertNoSymlinkSegments(normalizedRoot, normalizedSource);
    const canonicalRoot = await realpath(normalizedRoot);
    const canonicalSource = await realpath(normalizedSource);
    if (!isWithin(canonicalSource, canonicalRoot)) {
      throw new Error('test-root-realpath-escaped');
    }
  }
}

async function assertNoSymlinkSegments(root: string, candidate: string): Promise<void> {
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('test-root-symlink-rejected');
  }

  const relativePath = relative(root, candidate);
  let current = root;
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      throw new Error('test-root-symlink-rejected');
    }
  }
}

function isWithin(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    registrations: [registration()],
    ...overrides,
  };
}

function registration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    registrationKey: 'operator.workspace.one',
    workspaceId: WORKSPACE_ID,
    displayName: 'Workspace One',
    registrationRevision: 1,
    declaredRootHash: ROOT_HASH,
    enabled: true,
    mountBinding: {
      bootId: 'boot_workspace_registry_current',
      mountGeneration: 1,
      observedAt: 100,
      health: 'healthy',
      allowedOperations: [WORKSPACE_OPERATIONS[0]],
    },
    ...overrides,
  };
}

function sourceAt(
  sourceLocation: string,
  value: unknown,
  cloneOnRead = true
): {
  readonly source: WorkspaceStartupManifestSource;
  readonly readCount: () => number;
} {
  let calls = 0;
  return {
    source: {
      sourceLocation,
      readStartupManifest: () => {
        calls += 1;
        return cloneOnRead ? structuredClone(value) : value;
      },
    },
    readCount: () => calls,
  };
}

async function admittedAdapter(
  sourceLocation: string,
  value: unknown,
  root: OwnedRoot,
  cloneOnRead = true
): Promise<{ adapter: ReadOnlyWorkspaceManifestAdapter; readCount: () => number }> {
  const candidate = sourceAt(sourceLocation, value, cloneOnRead);
  const admission = new MarkerOwnedRootAdmission(root.path, new Map([[root.path, root.nonce]]));
  const source = await AdmittedWorkspaceManifestSource.admit(candidate.source, admission);
  return { adapter: new ReadOnlyWorkspaceManifestAdapter(source), readCount: candidate.readCount };
}

describe('ReadOnlyWorkspaceManifestAdapter', () => {
  it('keeps contracts and core free of forbidden runtime dependencies', async () => {
    const productionPaths = [
      'src/features/workspace-registry/contracts/workspace-registration.ts',
      'src/features/workspace-registry/core/domain/WorkspaceRegistration.ts',
      'src/features/workspace-registry/core/application/AuthorizeWorkspaceOperation.ts',
      'src/features/workspace-registry/main/infrastructure/ReadOnlyWorkspaceManifestAdapter.ts',
    ];
    const diagnostics = checkFeatureDependencies(
      await Promise.all(
        productionPaths.map(async (path) => ({ path, source: await readFile(path, 'utf8') }))
      )
    );

    expect(diagnostics).toEqual([]);
  });

  it('rejects a structurally forged admitted source wrapper', () => {
    const forged = Object.create(AdmittedWorkspaceManifestSource.prototype);

    expect(() => new ReadOnlyWorkspaceManifestAdapter(forged)).toThrow(
      'workspace-manifest-source-not-admitted'
    );
  });

  it('reads an injected admitted source once and exposes stable registrations plus current bindings', async () => {
    const projectRoot = await createOwnedRoot('project');
    const runtimeRoot = join(projectRoot.path, 'runtime');
    await mkdir(runtimeRoot);
    await writeFile(join(runtimeRoot, MARKER_FILE), projectRoot.nonce, { flag: 'wx' });
    const runtime = { path: runtimeRoot, nonce: projectRoot.nonce };
    const { adapter, readCount } = await admittedAdapter(runtimeRoot, manifest(), runtime);

    const snapshot = await adapter.load(EMPTY_DEPLOYMENT);

    expect(readCount()).toBe(1);
    expect(snapshot.registry.requireEnabled(parseWorkspaceId(WORKSPACE_ID)).registrationKey).toBe(
      'operator.workspace.one'
    );
    expect(snapshot.bindings[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      bootId: 'boot_workspace_registry_current',
      mountGeneration: 1,
    });
    await expect(adapter.load(EMPTY_DEPLOYMENT)).rejects.toThrow(
      'workspace-manifest-startup-source-already-read'
    );
    expect(readCount()).toBe(1);
    expect('write' in adapter).toBe(false);
    expect('register' in adapter).toBe(false);
    expect('scan' in adapter).toBe(false);
  });

  it('fails closed on unknown versions, duplicate, disabled, unbound, or ambiguous registrations', async () => {
    const root = await createOwnedRoot('invalid-manifests');
    const cases: readonly [string, unknown, string][] = [
      [
        'unknown manifest version',
        manifest({ version: 2 }),
        'workspace-manifest-version-unsupported',
      ],
      [
        'unknown registration version',
        manifest({ registrations: [registration({ schemaVersion: 2 })] }),
        'workspace-registration-schema-version-unsupported',
      ],
      [
        'duplicate registration key',
        manifest({
          registrations: [
            registration(),
            registration({ workspaceId: OTHER_WORKSPACE_ID, declaredRootHash: OTHER_ROOT_HASH }),
          ],
        }),
        'workspace-registration-key-duplicate',
      ],
      [
        'ambiguous identity',
        manifest({
          registrations: [
            registration(),
            registration({
              registrationKey: 'operator.workspace.two',
              declaredRootHash: OTHER_ROOT_HASH,
            }),
          ],
        }),
        'workspace-registration-identity-ambiguous',
      ],
      [
        'enabled registration without binding',
        manifest({ registrations: [registration({ mountBinding: undefined })] }),
        'workspace-manifest-enabled-registration-unbound',
      ],
    ];

    for (const [name, value, error] of cases) {
      const { adapter } = await admittedAdapter(root.path, value, root);
      await expect(adapter.load(EMPTY_DEPLOYMENT), name).rejects.toThrow(error);
    }

    const { adapter } = await admittedAdapter(
      root.path,
      manifest({ registrations: [registration({ enabled: false, mountBinding: undefined })] }),
      root
    );
    const disabled = await adapter.load(EMPTY_DEPLOYMENT);
    expect(disabled.bindings).toEqual([]);
    expect(() => disabled.registry.requireEnabled(parseWorkspaceId(WORKSPACE_ID))).toThrow(
      'workspace-registration-disabled'
    );
  });

  it('bounds and density-checks manifest registrations before iterating attacker entries', async () => {
    const root = await createOwnedRoot('bounded-registrations');
    const oversized = new Array(MAX_WORKSPACE_REGISTRATIONS + 1);
    Object.defineProperty(oversized, 0, {
      get: () => {
        throw new Error('oversized-manifest-registration-iterated');
      },
    });
    const sparse = new Array(2);
    sparse[0] = registration();

    const cases: readonly [string, unknown, string, boolean?][] = [
      [
        'oversized',
        manifest({ registrations: oversized }),
        'workspace-manifest-registrations-limit-exceeded',
        false,
      ],
      ['sparse', manifest({ registrations: sparse }), 'workspace-manifest-registrations-sparse'],
      [
        'malformed collection',
        manifest({ registrations: { 0: registration(), length: 1 } }),
        'workspace-manifest-registrations-invalid',
      ],
      [
        'malformed entry',
        manifest({ registrations: [null] }),
        'workspace-manifest-registration-invalid',
      ],
    ];

    for (const [name, value, error, cloneOnRead = true] of cases) {
      const { adapter } = await admittedAdapter(root.path, value, root, cloneOnRead);
      await expect(adapter.load(EMPTY_DEPLOYMENT), name).rejects.toThrow(error);
    }
  });

  it('bounds and density-checks allowed operations before iterating attacker entries', async () => {
    const root = await createOwnedRoot('bounded-operations');
    const oversized = new Array(MAX_WORKSPACE_ALLOWED_OPERATIONS + 1);
    Object.defineProperty(oversized, 0, {
      get: () => {
        throw new Error('oversized-manifest-operation-iterated');
      },
    });
    const sparse = new Array(2);
    sparse[0] = WORKSPACE_OPERATIONS[0];

    const manifestWithOperations = (allowedOperations: unknown) =>
      manifest({
        registrations: [
          registration({
            mountBinding: {
              bootId: 'boot_workspace_registry_current',
              mountGeneration: 1,
              observedAt: 100,
              health: 'healthy',
              allowedOperations,
            },
          }),
        ],
      });
    const cases: readonly [string, unknown, string, boolean?][] = [
      [
        'oversized',
        manifestWithOperations(oversized),
        'workspace-allowed-operations-limit-exceeded',
        false,
      ],
      ['sparse', manifestWithOperations(sparse), 'workspace-allowed-operations-sparse'],
      [
        'duplicate',
        manifestWithOperations([WORKSPACE_OPERATIONS[0], WORKSPACE_OPERATIONS[0]]),
        'workspace-allowed-operation-duplicate',
      ],
      [
        'malformed collection',
        manifestWithOperations({ 0: WORKSPACE_OPERATIONS[0], length: 1 }),
        'workspace-allowed-operations-invalid',
      ],
      [
        'malformed operation',
        manifestWithOperations(['workspace.registry.forged']),
        'workspace-operation-unsupported',
      ],
    ];

    for (const [name, value, error, cloneOnRead = true] of cases) {
      const { adapter } = await admittedAdapter(root.path, value, root, cloneOnRead);
      await expect(adapter.load(EMPTY_DEPLOYMENT), name).rejects.toThrow(error);
    }
  });

  it('rejects manifest-supplied predecessors for an empty deployment and a newly registered workspace', async () => {
    const root = await createOwnedRoot('forged-predecessor');
    const forgedEmpty = await admittedAdapter(
      root.path,
      manifest({
        registrations: [
          registration({
            mountBinding: {
              bootId: 'boot_workspace_registry_current',
              previousMountGeneration: 7,
              mountGeneration: 8,
              observedAt: 100,
              health: 'healthy',
              allowedOperations: [WORKSPACE_OPERATIONS[0]],
            },
          }),
        ],
      }),
      root
    );
    await expect(forgedEmpty.adapter.load(EMPTY_DEPLOYMENT)).rejects.toThrow(
      'workspace-manifest-mount-binding-predecessor-forbidden'
    );

    const initial = await admittedAdapter(root.path, manifest(), root);
    const previousSnapshot = await initial.adapter.load(EMPTY_DEPLOYMENT);
    const forgedNewRegistration = await admittedAdapter(
      root.path,
      manifest({
        registrations: [
          registration({
            registrationRevision: 2,
            mountBinding: {
              bootId: 'boot_workspace_registry_restarted',
              mountGeneration: 2,
              observedAt: 200,
              health: 'healthy',
              allowedOperations: [WORKSPACE_OPERATIONS[0]],
            },
          }),
          registration({
            registrationKey: 'operator.workspace.two',
            workspaceId: OTHER_WORKSPACE_ID,
            declaredRootHash: OTHER_ROOT_HASH,
            mountBinding: {
              bootId: 'boot_workspace_registry_restarted',
              previousMountGeneration: 1,
              mountGeneration: 2,
              observedAt: 200,
              health: 'healthy',
              allowedOperations: [WORKSPACE_OPERATIONS[0]],
            },
          }),
        ],
      }),
      root
    );
    await expect(
      forgedNewRegistration.adapter.load({ kind: 'previous-snapshot', snapshot: previousSnapshot })
    ).rejects.toThrow('workspace-manifest-mount-binding-predecessor-forbidden');
  });

  it('derives the predecessor from the previous snapshot, advances the mount, and rejects root drift', async () => {
    const root = await createOwnedRoot('restart');
    const first = await admittedAdapter(root.path, manifest(), root);
    const firstSnapshot = await first.adapter.load(EMPTY_DEPLOYMENT);
    const mismatchedGeneration = await admittedAdapter(
      root.path,
      manifest({
        registrations: [
          registration({
            registrationRevision: 2,
            mountBinding: {
              bootId: 'boot_workspace_registry_restarted',
              mountGeneration: 10,
              observedAt: 150,
              health: 'healthy',
              allowedOperations: [WORKSPACE_OPERATIONS[0]],
            },
          }),
        ],
      }),
      root
    );
    await expect(
      mismatchedGeneration.adapter.load({ kind: 'previous-snapshot', snapshot: firstSnapshot })
    ).rejects.toThrow('workspace-mount-generation-not-advanced');

    const restarted = await admittedAdapter(
      root.path,
      manifest({
        registrations: [
          registration({
            displayName: 'Renamed Workspace',
            registrationRevision: 2,
            mountBinding: {
              bootId: 'boot_workspace_registry_restarted',
              mountGeneration: 2,
              observedAt: 200,
              health: 'healthy',
              allowedOperations: [WORKSPACE_OPERATIONS[0]],
            },
          }),
        ],
      }),
      root
    );
    const restartedSnapshot = await restarted.adapter.load({
      kind: 'previous-snapshot',
      snapshot: firstSnapshot,
    });

    expect(restartedSnapshot.registry.requireEnabled(parseWorkspaceId(WORKSPACE_ID))).toMatchObject(
      {
        workspaceId: WORKSPACE_ID,
        displayName: 'Renamed Workspace',
      }
    );
    expect(restartedSnapshot.bindings[0]).toMatchObject({
      bootId: 'boot_workspace_registry_restarted',
      mountGeneration: 2,
    });

    const drifted = await admittedAdapter(
      root.path,
      manifest({
        registrations: [
          registration({ registrationRevision: 3, declaredRootHash: OTHER_ROOT_HASH }),
        ],
      }),
      root
    );
    await expect(
      drifted.adapter.load({ kind: 'previous-snapshot', snapshot: restartedSnapshot })
    ).rejects.toThrow('workspace-registration-root-changed');
  });
});

describe('P1.NEG.TEST_ROOT_ESCAPE marker-owned root admission', () => {
  it('rejects unsafe roots before any manifest adapter access', async () => {
    const outer = await createOwnedRoot('root-admission');
    const projectRoot = join(outer.path, 'project');
    const runtimeRoot = join(outer.path, 'runtime');
    const unmarkedRoot = join(outer.path, 'unmarked');
    const preExistingRoot = join(outer.path, 'pre-existing');
    const symlinkTarget = join(outer.path, 'symlink-target');
    await Promise.all(
      [projectRoot, runtimeRoot, unmarkedRoot, preExistingRoot, symlinkTarget].map((path) =>
        mkdir(path)
      )
    );

    const projectNonce = `${outer.nonce}-project`;
    const runtimeNonce = `${outer.nonce}-runtime`;
    await writeFile(join(projectRoot, MARKER_FILE), projectNonce, { flag: 'wx' });
    await writeFile(join(runtimeRoot, MARKER_FILE), runtimeNonce, { flag: 'wx' });
    await writeFile(join(preExistingRoot, MARKER_FILE), `${outer.nonce}-old`, { flag: 'wx' });
    const ownedRoots = new Map([
      [projectRoot, projectNonce],
      [runtimeRoot, runtimeNonce],
      [unmarkedRoot, `${outer.nonce}-unmarked`],
    ]);

    const parentSymlink = join(runtimeRoot, 'parent-link');
    const finalTarget = join(runtimeRoot, 'final-target');
    const finalSymlink = join(runtimeRoot, 'final-link');
    await symlink(symlinkTarget, parentSymlink, 'dir');
    await mkdir(finalTarget);
    await symlink(finalTarget, finalSymlink, 'dir');

    const negativeMatrix: readonly [string, string, string][] = [
      ['unmarked', unmarkedRoot, unmarkedRoot],
      ['pre-existing', preExistingRoot, preExistingRoot],
      ['ambient temporary directory', tmpdir(), tmpdir()],
      ['home', homedir(), homedir()],
      ['real-project/ambient workspace', process.cwd(), process.cwd()],
      ['parent symlink', runtimeRoot, join(parentSymlink, 'nested')],
      ['final symlink', runtimeRoot, finalSymlink],
      ['escaped', runtimeRoot, resolve(runtimeRoot, '..', 'escape')],
    ];

    for (const [name, admittedRoot, sourceLocation] of negativeMatrix) {
      const candidate = sourceAt(sourceLocation, manifest());
      const admission = new MarkerOwnedRootAdmission(admittedRoot, ownedRoots);

      await expect(
        AdmittedWorkspaceManifestSource.admit(candidate.source, admission),
        name
      ).rejects.toThrow();
      expect(candidate.readCount(), name).toBe(0);
    }

    const admitted = sourceAt(runtimeRoot, manifest());
    const source = await AdmittedWorkspaceManifestSource.admit(
      admitted.source,
      new MarkerOwnedRootAdmission(runtimeRoot, ownedRoots)
    );
    const adapter = new ReadOnlyWorkspaceManifestAdapter(source);
    await adapter.load(EMPTY_DEPLOYMENT);
    expect(admitted.readCount()).toBe(1);
    expect(dirname(join(runtimeRoot, 'manifest.json'))).toBe(runtimeRoot);
  });
});
