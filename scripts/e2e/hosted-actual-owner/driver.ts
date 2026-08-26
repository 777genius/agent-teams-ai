import { appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type ActualOwnerIntegration } from './contracts';
import { deriveProofRows, writeEvidenceIndex } from './evidence';
import { actualOwnerPreflight } from './preflight';
import { spawnOwnedProcess, stopOwnedProcess, type OwnedProcess } from './processes';
import { claimExactlyOneRun, createRunSandbox } from './sandbox';
import { atomicPrivateFile, canonicalJson } from './secure-files';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function waitForProduct(origin: string, product: OwnedProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (product.child.exitCode !== null)
      throw new Error('actual_owner_product_exited_before_ready');
    const response = await fetch(new URL('/api/hosted/v1/readiness', origin), {
      redirect: 'manual',
      signal: AbortSignal.timeout(1_000),
    }).catch(() => null);
    if (response?.status === 200) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('actual_owner_product_readiness_timeout');
}

export async function runActualOwnerE2E(integration: ActualOwnerIntegration): Promise<string> {
  if (!integration.finalRunAuthorized) throw new Error('actual_owner_final_run_not_authorized');
  await actualOwnerPreflight(repositoryRoot, integration);
  const sandbox = await createRunSandbox(integration.controllerNonce);
  await claimExactlyOneRun(sandbox);
  const browserManifestPath = join(sandbox.root, 'browser-manifest.json');
  const browserResultsPath = join(sandbox.evidenceRoot, 'browser-results.json');
  await atomicPrivateFile(
    browserManifestPath,
    canonicalJson({
      schemaVersion: 1,
      purpose: 'agent-teams.hosted-actual-owner-e2e.browser/v1',
      nonce: integration.controllerNonce,
      productOrigin: integration.productOrigin,
      chromiumExecutable: integration.browser.chromiumExecutable,
      ownerStorageState: integration.ownerStorageState,
      nonOwnerStorageState: integration.nonOwnerStorageState,
      teamA: integration.browser.teamA,
      runA: integration.browser.runA,
      teamB: integration.browser.teamB,
      runB: integration.browser.runB,
      csrfHeader: integration.browser.csrfHeader,
      csrfToken: integration.browser.csrfToken,
      evidenceRoot: sandbox.evidenceRoot,
      resultsPath: browserResultsPath,
    }),
    sandbox.root
  );

  const environment = Object.freeze({
    NODE_ENV: 'test',
    HOSTED_ACTUAL_OWNER_E2E: '1',
    HOSTED_ACTUAL_OWNER_E2E_NONCE: integration.controllerNonce,
    HOSTED_ACTUAL_OWNER_E2E_SANDBOX: sandbox.root,
    HOSTED_ACTUAL_OWNER_E2E_EVIDENCE_ROOT: sandbox.evidenceRoot,
    HOSTED_ACTUAL_OWNER_E2E_BROWSER_MANIFEST: browserManifestPath,
    HOSTED_ACTUAL_OWNER_E2E_OPENCODE_EXECUTABLE: integration.openCode.executable,
    HOSTED_ACTUAL_OWNER_E2E_OPENCODE_SHA256: integration.openCode.executableSha256,
    HOSTED_ACTUAL_OWNER_E2E_PROVIDER_URL: integration.provider.baseUrl,
  });
  const processes: OwnedProcess[] = [];
  let primaryError: unknown = null;
  let completed = false;
  const cleanupErrors: unknown[] = [];
  try {
    const product = await spawnOwnedProcess({
      role: 'product',
      executable: integration.product.executable,
      argv: integration.product.argv,
      cwd: repositoryRoot,
      runRoot: sandbox.root,
      environment,
    });
    processes.push(product);
    await waitForProduct(integration.productOrigin, product);
    const owner = await spawnOwnedProcess({
      role: 'orchestrator',
      executable: integration.orchestrator.entry,
      argv: [...integration.orchestrator.argv, '--runtime-manifest', browserManifestPath],
      cwd: dirname(integration.orchestrator.entry),
      runRoot: sandbox.root,
      environment,
    });
    processes.push(owner);
    const playwright = await spawnOwnedProcess({
      role: 'browser',
      executable: process.execPath,
      argv: [
        join(repositoryRoot, 'node_modules/@playwright/test/cli.js'),
        'test',
        join(repositoryRoot, 'test/e2e/hosted-web/actual-owner-approval.spec.ts'),
        '--workers=1',
      ],
      cwd: repositoryRoot,
      runRoot: sandbox.root,
      environment,
    });
    processes.push(playwright);
    const exitCode = await new Promise<number | null>((resolveExit) =>
      playwright.child.once('exit', resolveExit)
    );
    if (exitCode !== 0) throw new Error(`actual_owner_browser_failed:${exitCode ?? 'signal'}`);
    completed = true;
  } catch (error) {
    primaryError = error;
  } finally {
    for (const process of [...processes].reverse()) {
      try {
        await stopOwnedProcess(process, primaryError !== null);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (completed && cleanupErrors.length === 0) {
      await appendFile(
        join(sandbox.evidenceRoot, 'supervisor.ndjson'),
        `${JSON.stringify({
          schemaVersion: 1,
          scenario: 'cleanup-normal',
          recordId: `cleanup:${integration.controllerNonce}`,
          passed: true,
          effectCount: 0,
          raw: { survivors: 0, processCount: processes.length },
        })}\n`,
        { encoding: 'utf8', mode: 0o600 }
      );
    }
  }
  if (primaryError !== null) {
    throw primaryError instanceof Error
      ? primaryError
      : new Error('actual_owner_run_failed', { cause: primaryError });
  }
  if (cleanupErrors.length > 0)
    throw new AggregateError(cleanupErrors, 'actual_owner_cleanup_failed');
  const evidenceIndex = join(sandbox.evidenceRoot, 'evidence-index.json');
  await writeEvidenceIndex(
    evidenceIndex,
    sandbox.evidenceRoot,
    await deriveProofRows(sandbox.evidenceRoot)
  );
  return evidenceIndex;
}
