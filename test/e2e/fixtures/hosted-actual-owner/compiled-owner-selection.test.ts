import { chmod, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  descriptorMountId,
  type FileAnchor,
} from '../../../../scripts/e2e/hosted-actual-owner/anchors';
import {
  type FilePin,
  MAXIMUM_FINAL_RUNS,
  OPENCODE_IDENTITIES,
  P3B_SOURCE_COMMIT,
  P3C_LANE,
  PACKET_BASE_COMMIT,
  parseIntegrationDescriptor,
  PRODUCT_AUTHORITY_COMMIT,
  ROOT_NAMES,
  type RootName,
} from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import {
  OWNER_V2_ARGV,
  ownerChildPlanV2,
} from '../../../../scripts/e2e/hosted-actual-owner/owner-child-protocol';
import { selectOwnerPlan } from '../../../../scripts/e2e/hosted-actual-owner/owner-plan';
import {
  selectedOwnerImages,
  verifyP3B2Recipe,
} from '../../../../scripts/e2e/hosted-actual-owner/owner-recipe';
import {
  admitIntegration,
  type PreflightAdmission,
} from '../../../../scripts/e2e/hosted-actual-owner/preflight';
import * as secureFiles from '../../../../scripts/e2e/hosted-actual-owner/secure-files';
import {
  canonicalJson,
  sha256,
} from '../../../../scripts/e2e/hosted-actual-owner/supervisor/canonical';

// Pure contract vectors only: no signatures, mount admission or executing ELF proof.
function fixture(version: 2 | 3 | 4 = 4, composition = false) {
  const pin = (
    relativePath: string,
    n: number,
    mode: FilePin['mode'],
    root: FilePin['root'] = 'p3b2'
  ): FilePin => ({
    root,
    relativePath,
    sha256: sha256(relativePath),
    size: 128,
    mode,
    device: '1',
    inode: String(n),
    nlink: 1,
  });
  const entry = pin(
    version === 4 ? 'bin/hosted-owner' : 'owner.ts',
    1,
    version === 4 ? 0o500 : 0o555
  );
  const supervisor = pin('launcher', 2, 0o555),
    recipePin = pin('recipe.json', 3, 0o444);
  const node = pin('node', 4, 0o555, 'toolchain'),
    loader = pin('loader.mjs', 5, 0o444, 'toolchain');
  const module = pin('supervisor.cjs', 6, 0o400),
    helper = pin('helper', 7, 0o500);
  const executable = version === 4 ? entry : pin('bun', 8, 0o500);
  const recipe = {
    schemaVersion: version,
    purpose:
      version === 4
        ? 'agent-teams.p3b2.compiled-actual-owner-entry/v4'
        : version === 3
          ? 'agent-teams.p3b2.selected-native-supervisor/v3'
          : 'agent-teams.p3b2.source-actual-owner-entry/v2',
    sourceBaseCommit: P3B_SOURCE_COMMIT,
    resultCommit: 'b'.repeat(40),
    entry: { relativePath: entry.relativePath, sha256: entry.sha256 },
    supervisor: { relativePath: supervisor.relativePath, sha256: supervisor.sha256 },
    candidateOpenCodeSha256: OPENCODE_IDENTITIES.linuxX64BinarySha256,
    accepted: true,
    sourceTreeRequired: version !== 4,
    argv: version === 4 ? [...OWNER_V2_ARGV] : ['run', '/p3b2/owner.ts', ...OWNER_V2_ARGV],
    ...(version === 4
      ? {
          compiledInvocation: {
            format: 'agent-teams.hosted-owner-compiled-invocation/v1',
            executable,
            module: { path: '/p3b2/bin/hosted-owner', sha256: entry.sha256 },
          },
        }
      : {
          sourceInvocation: {
            format: 'agent-teams.hosted-owner-source-invocation/v1',
            executable,
            module: { path: '/p3b2/owner.ts', sha256: entry.sha256 },
          },
        }),
    launchHelper: helper,
    ...(version === 2
      ? {}
      : {
          supervisorInvocation: {
            format: 'agent-teams.hosted-selected-supervisor-invocation/v1',
            launcher: supervisor,
            executable: node,
            loader,
            module,
            argv: [
              '--selected-namespace-v1',
              loader.relativePath,
              node.relativePath,
              module.relativePath,
            ],
          },
        }),
    ...(composition
      ? {
          nativeComposition: {
            format: 'agent-teams.hosted-selected-native-composition/v1',
            serverAuthFormat: 'agent-teams.hosted-control.opencode-server-auth/v2',
            preparationModule: pin('preparation.cjs', 9, 0o400),
            kernelModule: pin('kernel.node', 10, 0o400),
          },
        }
      : {}),
  };
  const bind = (value: unknown = recipe, entryPin = entry) => {
    const bytes = Buffer.from(canonicalJson(value)),
      digest = sha256(bytes);
    const base = validDescriptor();
    const descriptorBytes = Buffer.from(
      canonicalJson({
        ...base,
        p3b2: {
          ...base.p3b2,
          entry: entryPin,
          supervisor,
          recipe: { ...recipePin, sha256: digest, size: bytes.length },
          recipeSha256: digest,
          sourceBaseCommit: recipe.sourceBaseCommit,
          resultCommit: recipe.resultCommit,
        },
        toolchain: { ...base.toolchain, node, loader },
      })
    );
    const descriptor = parseIntegrationDescriptor(descriptorBytes);
    return { bytes, descriptor, descriptorBytes };
  };
  return { recipe, bind, entry };
}

function decode(f: ReturnType<typeof fixture>, value: unknown = f.recipe, entry = f.entry) {
  const { bytes, descriptor } = f.bind(value, entry);
  return verifyP3B2Recipe(bytes, descriptor)!;
}

describe('frozen R1467 compiled recipe paired Product selection', () => {
  it.each([false, true])(
    'selects direct v2 argv, one private image and retained composition=%s',
    (composition) => {
      const f = fixture(4, composition),
        selection = decode(f),
        { descriptor } = f.bind();
      expect(selection.source).toBeUndefined();
      expect(selection.compiled?.module).toEqual({
        path: '/p3b2/bin/hosted-owner',
        sha256: f.entry.sha256,
      });
      expect(
        selectedOwnerImages(selection).filter((p) => p.relativePath === f.entry.relativePath)
      ).toHaveLength(1);
      expect(selectedOwnerImages(selection)).toHaveLength(composition ? 5 : 3);
      const admission: PreflightAdmission = {
        descriptor,
        ownerLaunch: {
          selection,
          executable: planAnchor(selection.executable),
          helper: planAnchor(selection.helper),
        },
        execution: {
          ownerEntry: planAnchor(descriptor.p3b2.entry),
          get supervisor(): never {
            throw new Error('unused supervisor anchor');
          },
          get openCode(): never {
            throw new Error('unused OpenCode anchor');
          },
          get browserDescriptor(): never {
            throw new Error('unused browser anchor');
          },
          get productCompositionDescriptor(): never {
            throw new Error('unused composition anchor');
          },
        },
        closures: {
          harness: {
            manifestSha256: sha256('manifest'),
            merkleRoot: sha256('closure'),
            fileCount: 1,
            totalBytes: 1,
            entries: [
              {
                path: 'scripts/e2e/hosted-actual-owner/actual-owner-contract.v2.json',
                sha256: sha256('contract'),
                size: 1,
                mode: 0o444,
              },
            ],
          },
          get toolchain(): never {
            throw new Error('unused toolchain closure');
          },
          get productRuntime(): never {
            throw new Error('unused runtime closure');
          },
          get browserBundle(): never {
            throw new Error('unused browser closure');
          },
          get p3b2(): never {
            throw new Error('unused Owner closure');
          },
        },
        get roots(): never {
          throw new Error('plan must not access filesystem roots');
        },
        control: descriptor.control,
      };
      const plan = selectOwnerPlan(admission);
      expect(plan.argv).toEqual(OWNER_V2_ARGV);
      expect(plan.protocol).toEqual(ownerChildPlanV2(composition));
      expect(Object.hasOwn(plan.selection, 'ownerSourceInvocation')).toBe(false);
      expect(plan.image).toEqual(f.entry);
      if (!('ownerLaunchHelper' in plan.selection)) throw new Error('expected v2 plan selection');
      expect(plan.selection.ownerPreparationModule).toEqual(selection.preparationModule);
      expect(plan.selection.selectedKernelModule).toEqual(selection.kernelModule);
    }
  );

  it.each([2, 3] as const)('retains source v%s and its distinct image', (version) => {
    const f = fixture(version),
      s = decode(f);
    expect(s.compiled).toBeUndefined();
    expect(s.source?.module.path).toBe('/p3b2/owner.ts');
    expect(s.executable.sha256).not.toBe(f.entry.sha256);
    expect(() => decode(f, { ...f.recipe, argv: [...OWNER_V2_ARGV] })).toThrow();
  });
  it('retains the v3 optional native composition and rejects it on v2', () => {
    expect(decode(fixture(3, true)).kernelModule).toBeDefined();
    expect(() => decode(fixture(2, true))).toThrow();
  });

  it('rejects hybrid, noncanonical, unbound and extended records', () => {
    const f = fixture(),
      r = f.recipe;
    if (!('compiledInvocation' in r)) throw new Error('expected compiled recipe fixture');
    for (const value of [
      { ...r, sourceInvocation: r.compiledInvocation },
      { ...r, closureMerkleRoot: sha256('closure') },
      { ...r, sourceTreeRequired: true },
      { ...r, schemaVersion: 5 },
      { ...r, argv: ['run', '/p3b2/bin/hosted-owner', ...OWNER_V2_ARGV] },
      { ...r, compiledInvocation: { ...r.compiledInvocation, extra: true } },
      {
        ...r,
        compiledInvocation: {
          ...r.compiledInvocation,
          module: { ...r.compiledInvocation!.module, extra: true },
        },
      },
    ])
      expect(() => decode(f, value)).toThrow();
    const { supervisorInvocation: _supervisor, ...missingSupervisor } = r;
    expect(() => decode(f, missingSupervisor)).toThrow();
    const { bytes, descriptor } = f.bind();
    expect(() => verifyP3B2Recipe(Buffer.concat([bytes, Buffer.from('\n')]), descriptor)).toThrow();
    expect(() =>
      verifyP3B2Recipe(Buffer.from(canonicalJson({ ...r, accepted: false })), descriptor)
    ).toThrow();
  });

  it('requires every entry pin field equal before deduplicating', () => {
    const f = fixture();
    if (!('compiledInvocation' in f.recipe)) throw new Error('expected compiled recipe fixture');
    const compiledInvocation = f.recipe.compiledInvocation;
    for (const change of [
      { size: 129 },
      { mode: 0o555 },
      { device: '2' },
      { inode: '99' },
      { nlink: 2 },
      { sha256: sha256('container') },
      { relativePath: 'bin/other' },
    ] as Partial<FilePin>[]) {
      expect(() => decode(f, f.recipe, { ...f.entry, ...change })).toThrow();
    }
    for (const change of [
      { size: 0 },
      { size: 1024 ** 3 + 1 },
      { mode: 0o555 },
      { inode: '0' },
      { device: '01' },
      { inode: '18446744073709551616' },
    ] as Partial<FilePin>[]) {
      const executable = { ...f.entry, ...change };
      expect(() =>
        decode(
          f,
          {
            ...f.recipe,
            compiledInvocation: {
              ...compiledInvocation,
              executable,
            },
          },
          executable
        )
      ).toThrow();
    }
  });

  it('rejects every other payload physical alias, including separately pinned composition', () => {
    const f = fixture(4, true),
      r = f.recipe;
    const pins = [
      f.entry,
      r.launchHelper,
      r.supervisorInvocation!.launcher,
      r.supervisorInvocation!.module,
      r.nativeComposition!.preparationModule,
      r.nativeComposition!.kernelModule,
    ];
    for (const pin of pins.filter((p) => p !== r.launchHelper)) {
      expect(() =>
        decode(f, {
          ...r,
          launchHelper: { ...r.launchHelper, device: pin.device, inode: pin.inode },
        })
      ).toThrow();
      expect(() =>
        decode(f, { ...r, launchHelper: { ...r.launchHelper, relativePath: pin.relativePath } })
      ).toThrow();
    }
    expect(() =>
      decode(f, {
        ...r,
        nativeComposition: {
          ...r.nativeComposition,
          kernelModule: {
            ...r.nativeComposition!.kernelModule,
            inode: r.nativeComposition!.preparationModule.inode,
          },
        },
      })
    ).toThrow();
    const { kernelModule: _kernel, ...missingKernel } = r.nativeComposition!;
    expect(() => decode(f, { ...r, nativeComposition: missingKernel })).toThrow();
  });
});

// Complete wire fixture mirrors the existing descriptor harness. Pins here are synthetic;
// decoding them is structural evidence, never filesystem or signed admission evidence.
function digest(label: string): string {
  return sha256(`p3c-deterministic-fixture:${label}`);
}

function filePin(
  root: RootName,
  label: string,
  sha = digest(label),
  mode: 256 | 292 | 365 = 0o400
): FilePin {
  return {
    root,
    relativePath: `${label}.bin`,
    sha256: sha,
    size: 1,
    mode,
    device: '1',
    inode: String(100 + label.length),
    nlink: 1,
  };
}

function closure(root: RootName, label: string) {
  const manifest = filePin(root, `${label}-manifest`);
  return {
    manifest,
    manifestSha256: manifest.sha256,
    merkleRoot: digest(`${label}:merkle`),
    fileCount: 1,
    totalBytes: 1,
  };
}

function validDescriptor() {
  const rootNames = [
    'harness',
    'toolchain',
    'productRuntime',
    'browserBundle',
    'p3b2',
    'openCode',
    'controllerAuthority',
    'sandboxParent',
    'evidenceRoot',
  ] as const;
  return {
    schemaVersion: 2,
    purpose: 'agent-teams.p3c.integration-descriptor/v2',
    integrationReady: true,
    executionAuthorized: true,
    controllerNonce: digest('controller-nonce'),
    authority: {
      productAuthorityCommit: PRODUCT_AUTHORITY_COMMIT,
      packetBaseCommit: PACKET_BASE_COMMIT,
      auditedProductCommit: 'd71671599c062244767494d392575cfacba5e1ff',
      auditedProductTree: 'af7fa38ec50893550ce14026c39b428f8dbfd1f2',
    },
    control: {
      lane: P3C_LANE,
      maximumFinalRuns: MAXIMUM_FINAL_RUNS,
      freezeId: digest('freeze-id'),
      reviewId: digest('review-id'),
      authorizationId: digest('authorization-id'),
      freeze: filePin('controllerAuthority', 'p3c1-freeze'),
      harnessReview: filePin('controllerAuthority', 'harness-review'),
      oneRunAuthorization: filePin('controllerAuthority', 'one-run-authorization'),
      harnessReviewerPublicKey: filePin('controllerAuthority', 'harness-reviewer-public-key'),
      runAuthorizationPublicKey: filePin('controllerAuthority', 'run-authorization-public-key'),
    },
    roots: Object.fromEntries(
      rootNames.map((name, index) => [
        name,
        {
          path: `/controller-private/${name}`,
          device: String(index + 1),
          inode: String(index + 11),
          mountId: String(index + 21),
          mode: 0o700,
        },
      ])
    ),
    product: {
      finalHarnessCommit: '1111111111111111111111111111111111111111',
      harnessClosure: closure('harness', 'harness'),
      runEntry: filePin('harness', 'run-entry'),
      runtimeClosure: closure('productRuntime', 'product'),
      compositionEntry: filePin(
        'productRuntime',
        'product-composition-entry',
        digest('product-composition-entry'),
        0o555
      ),
      compositionDescriptor: filePin('productRuntime', 'product-composition-descriptor'),
      browserBundle: closure('browserBundle', 'browser'),
      playwrightEntry: filePin(
        'browserBundle',
        'playwright-entry',
        digest('playwright-entry'),
        0o555
      ),
      playwrightConfig: filePin(
        'browserBundle',
        'playwright-config',
        digest('playwright-config'),
        0o444
      ),
      playwrightSpec: filePin('browserBundle', 'playwright-spec', digest('playwright-spec'), 0o444),
      chromiumExecutable: filePin('browserBundle', 'chromium', digest('chromium'), 0o555),
    },
    toolchain: {
      node: filePin('toolchain', 'node', digest('node'), 0o555),
      loader: filePin('toolchain', 'loader', digest('loader'), 0o444),
      closure: closure('toolchain', 'toolchain'),
      nodeVersion: 'v24.16.0',
    },
    p3b2: {
      sourceBaseCommit: P3B_SOURCE_COMMIT,
      resultCommit: '2222222222222222222222222222222222222222',
      entry: filePin('p3b2', 'owner-entry', digest('owner-entry'), 0o555),
      supervisor: filePin('p3b2', 'supervisor', digest('supervisor'), 0o555),
      recipe: filePin('p3b2', 'recipe'),
      closure: closure('p3b2', 'p3b2'),
      recipeSha256: digest('recipe'),
      independentlyAccepted: true,
    },
    openCode: {
      identities: OPENCODE_IDENTITIES,
      acquisitionReceipt: filePin('openCode', 'receipt'),
      buildProvenanceBundle: filePin(
        'openCode',
        'build-provenance-bundle',
        OPENCODE_IDENTITIES.buildProvenanceBundleSha256
      ),
      releaseManifest: filePin(
        'openCode',
        'release-manifest',
        OPENCODE_IDENTITIES.releaseManifestSha256
      ),
      actionsArtifactZip: filePin(
        'openCode',
        'actions-envelope',
        OPENCODE_IDENTITIES.actionsArtifactZipSha256
      ),
      linuxX64Archive: filePin(
        'openCode',
        'linux-archive',
        OPENCODE_IDENTITIES.linuxX64ArchiveSha256
      ),
      linuxX64Binary: filePin(
        'openCode',
        'opencode',
        OPENCODE_IDENTITIES.linuxX64BinarySha256,
        0o555
      ),
      signedBuildProvenance: true,
      productionEligible: false,
      releaseEligible: false,
    },
    browser: {
      origin: 'http://127.0.0.1:45131',
      descriptor: filePin('browserBundle', 'browser-descriptor'),
      workers: 1,
      retries: 0,
    },
    productionGates: {
      productActivation: false,
      orchestratorActivation: false,
      openCodeActivation: false,
      coordinatedActivation: false,
    },
  };
}

// The pure plan seam reads pins only. Explicit throwing accessors prohibit accidental
// filesystem use without fabricating FileHandles or casting a partial admission.
function planAnchor(pin: FilePin): FileAnchor {
  return {
    pin,
    get root(): never {
      throw new Error('plan must not access anchor root');
    },
    get handle(): never {
      throw new Error('plan must not access anchor handle');
    },
    get identity(): never {
      throw new Error('plan must not access anchor identity');
    },
  };
}

describe('R1484-1 real integration descriptor boundary', () => {
  it('rejects noncanonical descriptor bytes before recipe selection', () => {
    const { descriptorBytes } = fixture().bind();
    expect(() =>
      parseIntegrationDescriptor(Buffer.concat([descriptorBytes, Buffer.from('\n')]))
    ).toThrow('p3c_descriptor_noncanonical');
  });

  it('decodes 0555 entry metadata but rejects it as a v4 executable', () => {
    const f = fixture();
    if (!('compiledInvocation' in f.recipe)) throw new Error('expected compiled recipe fixture');
    const entry = { ...f.entry, mode: 0o555 } satisfies FilePin;
    const value = {
      ...f.recipe,
      compiledInvocation: { ...f.recipe.compiledInvocation, executable: entry },
    };
    const { bytes, descriptor } = f.bind(value, entry);
    expect(descriptor.p3b2.entry.mode).toBe(0o555);
    expect(() => verifyP3B2Recipe(bytes, descriptor)).toThrow('p3c_owner_recipe_v2_image_metadata');
  });

  it.each(['device', 'inode'] as const)(
    'rejects unequal physical %s after real descriptor decoding',
    (field) => {
      const f = fixture(),
        { bytes, descriptor } = f.bind(f.recipe, { ...f.entry, [field]: '99' });
      expect(descriptor.p3b2.entry[field]).toBe('99');
      expect(() => verifyP3B2Recipe(bytes, descriptor)).toThrow(
        'p3c_owner_recipe_v2_compiled_module'
      );
    }
  );

  it('does not allow private mode on unrelated descriptor pins', () => {
    const { descriptor } = fixture().bind();
    const pins = [
      descriptor.p3b2.supervisor,
      descriptor.p3b2.recipe,
      descriptor.p3b2.closure.manifest,
      descriptor.toolchain.node,
      descriptor.toolchain.loader,
      descriptor.product.runEntry,
      descriptor.product.compositionEntry,
      descriptor.openCode.linuxX64Binary,
      descriptor.control.freeze,
      descriptor.browser.descriptor,
    ];
    for (const pin of pins) {
      // Replace only the selected complete pin, preserving all redundant digest bindings.
      const bytes = Buffer.from(
        canonicalJson(descriptor).replace(
          canonicalJson(pin),
          canonicalJson({ ...pin, mode: 0o500 })
        )
      );
      expect(() => parseIntegrationDescriptor(bytes)).toThrow(/p3c_.*_metadata/u);
    }
  });

  it.each([0o600, 0o4500, 0o2500])('still rejects unrelated entry mode %i', (mode) => {
    const { descriptor } = fixture().bind();
    expect(() =>
      parseIntegrationDescriptor(
        Buffer.from(
          canonicalJson({
            ...descriptor,
            p3b2: { ...descriptor.p3b2, entry: { ...descriptor.p3b2.entry, mode } },
          })
        )
      )
    ).toThrow('p3c_p3b2_entry_metadata');
  });

  // Real preflight up to its recipe-dependent mode gate; stop at the next closure
  // boundary. No signatures, launch, authorization consumption or runtime is involved.
  it.skipIf(process.platform !== 'linux').each([1, 2, 3, 4] as const)(
    'retains the later recipe-dependent entry mode for v%s',
    async (version) => {
      const f = fixture(version === 1 ? 2 : version);
      const value =
        version === 1
          ? {
              schemaVersion: 1,
              purpose: 'agent-teams.p3b2.built-actual-owner-entry/v1',
              sourceBaseCommit: f.recipe.sourceBaseCommit,
              resultCommit: f.recipe.resultCommit,
              entry: f.recipe.entry,
              supervisor: f.recipe.supervisor,
              closureMerkleRoot: validDescriptor().p3b2.closure.merkleRoot,
              candidateOpenCodeSha256: OPENCODE_IDENTITIES.linuxX64BinarySha256,
              argv: ['--runtime-manifest', '/sandbox/runtime-manifest.json'],
              sourceTreeRequired: false,
              accepted: true,
            }
          : f.recipe;
      for (const mode of [0o500, 0o555] as const) {
        const bound = f.bind(value, { ...f.entry, mode });
        const path = await mkdtemp(join(tmpdir(), 'r1494-descriptor-mode-'));
        const closure = vi
          .spyOn(secureFiles, 'verifyClosure')
          .mockRejectedValue(new Error('r1494_stop_at_closure'));
        try {
          const roots = { ...bound.descriptor.roots };
          for (const name of ROOT_NAMES) {
            const rootPath = join(path, name);
            await mkdir(rootPath, { mode: 0o700 });
            const handle = await open(rootPath, 'r');
            try {
              const stat = await handle.stat({ bigint: true });
              roots[name] = {
                path: rootPath,
                mode: 0o700,
                device: String(stat.dev),
                inode: String(stat.ino),
                mountId: await descriptorMountId(handle),
              };
            } finally {
              await handle.close();
            }
          }
          const recipePath = join(roots.p3b2.path, bound.descriptor.p3b2.recipe.relativePath);
          await writeFile(recipePath, bound.bytes, { mode: 0o444, flag: 'wx' });
          await chmod(recipePath, 0o444);
          const handle = await open(recipePath, 'r');
          let recipe: FilePin;
          try {
            const stat = await handle.stat({ bigint: true });
            recipe = {
              ...bound.descriptor.p3b2.recipe,
              device: String(stat.dev),
              inode: String(stat.ino),
            };
          } finally {
            await handle.close();
          }
          const descriptor = parseIntegrationDescriptor(
            Buffer.from(
              canonicalJson({
                ...bound.descriptor,
                roots,
                p3b2: { ...bound.descriptor.p3b2, recipe },
              })
            )
          );
          const acceptedMode = mode === (version === 4 ? 0o500 : 0o555);
          await expect(admitIntegration(descriptor, '/unused-by-mode-gate')).rejects.toThrow(
            acceptedMode
              ? 'r1494_stop_at_closure'
              : version === 4
                ? 'p3c_owner_recipe_v2_compiled_module'
                : 'p3c_descriptor_owner_entry_mode'
          );
          expect(closure).toHaveBeenCalledTimes(acceptedMode ? 5 : 0);
        } finally {
          closure.mockRestore();
          await rm(path, { recursive: true, force: true });
        }
      }
    }
  );
});
