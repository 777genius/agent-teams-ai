import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const OWNED_PRODUCTION_FILES = [
  'src/features/team-runtime-control/contracts/runtime-ingress-http.ts',
  'src/features/team-runtime-control/core/application/runtime-ingress/ports.ts',
  'src/features/team-runtime-control/main/adapters/input/runtime-ingress/RuntimeIngressHttpInputAdapter.ts',
  'src/features/team-runtime-control/main/adapters/input/runtime-ingress/RuntimeIngressRateLimiter.ts',
  'src/features/team-runtime-control/main/adapters/output/runtime-ingress/FileRuntimeIngressDurableStore.ts',
  'src/features/team-runtime-control/main/adapters/output/runtime-ingress/FixedScopeRuntimeIngressRelay.ts',
  'src/features/team-runtime-control/main/adapters/output/runtime-ingress/InheritedFdRuntimeIngressSecretSource.ts',
  'src/features/team-runtime-control/main/adapters/output/runtime-ingress/runtimeIngressDurableState.ts',
  'src/features/team-runtime-control/main/adapters/output/runtime-ingress/runtimeIngressFileStoreIo.ts',
  'src/features/team-runtime-control/main/composition/createRuntimeIngressFeature.ts',
] as const;

async function source(path: string): Promise<string> {
  return readFile(resolve(ROOT, path), 'utf8');
}

describe('Phase 4 runtime ingress architecture boundaries', () => {
  it('keeps the private contract absent from browser-safe and feature public barrels', async () => {
    const [contractsBarrel, featureBarrel] = await Promise.all([
      source('src/features/team-runtime-control/contracts/index.ts'),
      source('src/features/team-runtime-control/index.ts'),
    ]);
    expect(contractsBarrel).not.toContain('runtime-ingress-http');
    expect(featureBarrel).not.toContain('createRuntimeIngressFeature');
    expect(featureBarrel).not.toContain('RuntimeIngressHttp');
  });

  it('does not register the runtime route or depend on a public HTTP framework', async () => {
    const composition = await source(
      'src/features/team-runtime-control/main/composition/createRuntimeIngressFeature.ts'
    );
    expect(composition).not.toMatch(/fastify|registerRoute|routeCatalog|listen\s*\(/i);
    expect(composition).not.toContain('/api/runtime/v1');

    const mainSource = await sourceTree('src/main');
    expect(mainSource).not.toContain('createRuntimeIngressFeature');
    expect(mainSource).not.toContain('/api/runtime/v1');
  });

  it('keeps bearer material out of environment, argv, files, and diagnostics code paths', async () => {
    const combined = (await Promise.all(OWNED_PRODUCTION_FILES.map((path) => source(path)))).join(
      '\n'
    );
    const withoutNonSecretSystemRoot = combined.replaceAll('process.env.SystemRoot', '');
    expect(withoutNonSecretSystemRoot).not.toMatch(/process\.env|console\.|logger\.|argv/i);
    expect(combined).not.toMatch(/writeFile\s*\([^)]*(secret|bearer|authorization)/i);
    expect(combined).not.toMatch(/appendFile|createWriteStream/i);
    expect(combined).not.toMatch(/secretDigest\s*:\s*request\.presentedSecret/);
  });

  it('keeps body authority fields out of the narrow HTTP command contract', async () => {
    const contract = await source(
      'src/features/team-runtime-control/contracts/runtime-ingress-http.ts'
    );
    const body = contract.slice(
      contract.indexOf('export interface RuntimeIngressHttpCommandBody'),
      contract.indexOf('export interface RuntimeIngressHttpRequest')
    );
    expect(body).not.toMatch(
      /\b(teamId|runId|laneId|providerId|deploymentId|credentialId|sessionId|deliveryOwnerId|cwd|teamName|topology)\b/
    );
  });

  it('keeps ingress adapters behind owned ports and OS-enforced resource boundaries', async () => {
    const [relay, ports, store, fileIo, secretSource, contract] = await Promise.all([
      source(
        'src/features/team-runtime-control/main/adapters/output/runtime-ingress/FixedScopeRuntimeIngressRelay.ts'
      ),
      source('src/features/team-runtime-control/core/application/runtime-ingress/ports.ts'),
      source(
        'src/features/team-runtime-control/main/adapters/output/runtime-ingress/FileRuntimeIngressDurableStore.ts'
      ),
      source(
        'src/features/team-runtime-control/main/adapters/output/runtime-ingress/runtimeIngressFileStoreIo.ts'
      ),
      source(
        'src/features/team-runtime-control/main/adapters/output/runtime-ingress/InheritedFdRuntimeIngressSecretSource.ts'
      ),
      source('src/features/team-runtime-control/contracts/runtime-ingress-http.ts'),
    ]);
    expect(ports).toContain('RuntimeIngressCommandOrchestrationPort');
    expect(ports).not.toMatch(/RuntimeIngressHttp(Request|Response)/);
    expect(relay).not.toMatch(/runtime-ingress-http|RuntimeIngressHttp/);
    expect(fileIo).toMatch(/O_NOFOLLOW/);
    expect(fileIo).toMatch(/lockAcquireTimeoutMs/);
    expect(fileIo).toMatch(/ownerPid/);
    expect(fileIo).not.toMatch(/\bmkdir\(paths\.lock/);
    expect(fileIo).toMatch(/TEMP: helperTempPath,\s*TMP: helperTempPath,\s*USERPROFILE/);
    expect(fileIo).toMatch(/PATH: ''/);
    expect(fileIo).toMatch(/mkdir\(path, \{ mode: 0o700 \}\)/);
    expect(fileIo).toMatch(/realpath\(helperTemp\.path\)/);
    expect(fileIo).toMatch(/cleanupWindowsLockHelperTemp/);
    expect(store).toMatch(/generation/);
    expect(store).toMatch(/antiRollbackFence/);
    expect(store).toMatch(/authentication/);
    expect(store).not.toMatch(/\breadFile\s*\(/);
    expect(secretSource).toMatch(/disposeAfterMs/);
    expect(secretSource).toMatch(/claimed/);
    expect(secretSource).toMatch(/createReadStream/);
    expect(secretSource).toMatch(/async dispose/);
    expect(secretSource).not.toMatch(/\b(readSync|closeSync)\b/);
    expect(contract).toMatch(/RuntimeIngressHttpPreMaterializationSizeFence/);
  });
});

async function sourceTree(relativeDirectory: string): Promise<string> {
  const entries = await readdir(resolve(ROOT, relativeDirectory), { withFileTypes: true });
  const parts = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) return sourceTree(relativePath);
      return entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name) ? source(relativePath) : '';
    })
  );
  return parts.join('\n');
}
