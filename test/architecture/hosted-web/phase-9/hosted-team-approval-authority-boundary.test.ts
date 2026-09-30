import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const OWNED_PATHS = Object.freeze([
  'src/features/internal-storage/contracts/hostedTeamApprovalAuthorityStorageContracts.ts',
  'src/features/internal-storage/contracts/index.ts',
  'src/features/internal-storage/main/application/hostedTeamApprovalAuthorityStorage.ts',
  'src/features/internal-storage/main/application/hostedTeamApprovalAuthorityStorageOutputs.ts',
  'src/features/internal-storage/main/application/internalStorageBackupContract.ts',
  'src/features/internal-storage/main/composition/createInternalStorageFeature.ts',
  'src/features/internal-storage/main/index.ts',
  'src/features/internal-storage/main/infrastructure/InternalStorageWorkerClient.ts',
  'src/features/internal-storage/main/infrastructure/worker/hostedTeamApprovalAuthorityStorageMigration.ts',
  'src/features/internal-storage/main/infrastructure/worker/hostedTeamApprovalAuthorityStorageOps.ts',
  'src/features/internal-storage/main/infrastructure/worker/internalStorageMigrations.ts',
  'src/features/internal-storage/main/infrastructure/worker/internalStorageSchema.ts',
  'src/features/internal-storage/main/infrastructure/worker/internalStorageWorkerProtocol.ts',
  'src/features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore.ts',
  'src/features/team-approvals/main/adapters/output/InternalStorageHostedTeamApprovalAuthority.ts',
  'src/features/team-approvals/main/composition/createDurableHostedTeamApprovalAuthority.ts',
  'src/features/team-approvals/main/hosted.ts',
  'src/features/team-approvals/main/ports/HostedTeamApprovalAuthorityStoragePort.ts',
  'test/features/internal-storage/HostedTeamApprovalAuthorityStorage.test.ts',
  'test/features/team-approvals/hosted/InternalStorageHostedTeamApprovalAuthority.test.ts',
  'test/architecture/hosted-web/phase-9/hosted-team-approval-authority-boundary.test.ts',
]);

const PRODUCTION_PATHS = OWNED_PATHS.filter((path) => path.startsWith('src/'));

function read(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are fixed above
  return readFileSync(path, 'utf8');
}

describe('hosted team approval authority boundary', () => {
  it('keeps v1 durability to exactly twenty-one admitted feature-owned paths', () => {
    expect(OWNED_PATHS).toHaveLength(21);
    expect(new Set(OWNED_PATHS).size).toBe(21);
    expect(OWNED_PATHS.every(existsSync)).toBe(true);
    expect(
      OWNED_PATHS.every(
        (path) =>
          path.startsWith('src/features/internal-storage/') ||
          path.startsWith('src/features/team-approvals/') ||
          path.startsWith('test/features/internal-storage/') ||
          path.startsWith('test/features/team-approvals/') ||
          path ===
            'test/architecture/hosted-web/phase-9/hosted-team-approval-authority-boundary.test.ts'
      )
    ).toBe(true);
  });

  it('defines exactly one narrow three-operation authority over existing application values', () => {
    const port = read('src/features/team-approvals/main/ports/HostedTeamApprovalAuthorityPort.ts');

    expect(port.match(/\breadPendingPage\s*\(/g)).toHaveLength(1);
    expect(port.match(/\breadPreviewByOpaqueRef\s*\(/g)).toHaveLength(1);
    expect(port.match(/\bcompareAndClaimDecision\s*\(/g)).toHaveLength(1);
    expect(port.match(/\bcontext:\s*QueryContext\b/g)).toHaveLength(3);
    expect(port).toContain('HostedTeamApprovalPageSourceRequest');
    expect(port).toContain('HostedTeamApprovalPageSourceResult');
    expect(port).toContain('HostedTeamApprovalPreviewSourceRequest');
    expect(port).toContain('HostedTeamApprovalPreviewSourceResult');
    expect(port).toContain('HostedTeamApprovalDecisionAdmissionResult');
  });

  it('assigns live scope, pending claim, idempotency, audit, preview, and handoff to authority', () => {
    const port = read('src/features/team-approvals/main/ports/HostedTeamApprovalAuthorityPort.ts');

    expect(port).toContain('revalidates the exact QueryContext scope');
    expect(port).toContain('currently pending approvals');
    expect(port).toContain('team, approval, and generation');
    expect(port).toContain('idempotency matching');
    expect(port).toContain('one-decision claim');
    expect(port).toContain('redacted audit commit atomically');
    expect(port).toContain('persisted-before-delivery handoff');
  });

  it('keeps durable scope, CAS, redacted audit, and recoverable outbox in the SQLite boundary', () => {
    const contracts = read(
      'src/features/internal-storage/contracts/hostedTeamApprovalAuthorityStorageContracts.ts'
    );
    const operations = read(
      'src/features/internal-storage/main/infrastructure/worker/hostedTeamApprovalAuthorityStorageOps.ts'
    );
    const migration = read(
      'src/features/internal-storage/main/infrastructure/worker/hostedTeamApprovalAuthorityStorageMigration.ts'
    );

    expect(contracts).toContain('authorityGeneration');
    expect(contracts).toContain('restoreGeneration');
    expect(contracts).toContain('idempotencyKey');
    expect(contracts).toContain('payloadHash');
    expect(operations).toContain('.immediate()');
    expect(operations).toContain('hosted_team_approval_audit');
    expect(operations).toContain('hosted_team_approval_delivery_outbox');
    expect(operations).toContain('idempotency_mismatch');
    expect(operations).toContain('delivery_generation');
    expect(migration).toContain('hosted_team_approval_records');
    expect(migration).toContain('hosted_team_approval_idempotency');
  });

  it('maps one authority adapter to all three output ports and shares that same instance', () => {
    const adapter = read(
      'src/features/team-approvals/main/adapters/output/HostedTeamApprovalAuthorityAdapter.ts'
    );
    const composition = read(
      'src/features/team-approvals/main/composition/createHostedTeamApprovalOutputAdapters.ts'
    );

    expect(adapter).toContain('HostedTeamApprovalPageSourcePort,');
    expect(adapter).toContain('HostedTeamApprovalPreviewSourcePort,');
    expect(adapter).toContain('HostedTeamApprovalDecisionAdmissionPort');
    expect(adapter.match(/authority\.readPendingPage\(/g)).toHaveLength(1);
    expect(adapter.match(/authority\.readPreviewByOpaqueRef\(/g)).toHaveLength(1);
    expect(adapter.match(/authority\.compareAndClaimDecision\(/g)).toHaveLength(1);
    expect(composition).toContain('pageSource: adapter');
    expect(composition).toContain('previewSource: adapter');
    expect(composition).toContain('decisionAdmission: adapter');
  });

  it('exports the durable factory without a standalone production mount', () => {
    const hostedEntry = read('src/features/team-approvals/main/hosted.ts');
    const rootEntry = read('src/features/team-approvals/index.ts');
    const mainEntry = read('src/features/team-approvals/main/index.ts');
    const standalone = read('src/main/standalone.ts');

    expect(hostedEntry).toContain('HostedTeamApprovalAuthorityPort');
    expect(hostedEntry).toContain('createHostedTeamApprovalOutputAdapters');
    expect(hostedEntry).toContain('createDurableHostedTeamApprovalAuthority');
    expect(hostedEntry).not.toContain('HostedTeamApprovalAuthorityAdapter');
    expect(hostedEntry).not.toContain('InternalStorageHostedTeamApprovalAuthority');
    expect(rootEntry).not.toContain('createDurableHostedTeamApprovalAuthority');
    expect(mainEntry).not.toContain('createDurableHostedTeamApprovalAuthority');
    expect(standalone).not.toContain('createHostedTeamApprovalOutputAdapters');
    expect(standalone).not.toContain('HostedTeamApprovalAuthorityAdapter');
    expect(standalone).not.toContain('createDurableHostedTeamApprovalAuthority');
    expect(standalone).not.toContain('InternalStorageHostedTeamApprovalAuthority');
  });

  it('keeps generic storage contracts provider-neutral and runtime ownership external', () => {
    const contracts = read(
      'src/features/internal-storage/contracts/hostedTeamApprovalAuthorityStorageContracts.ts'
    );
    const authoritySource = OWNED_PATHS.filter((path) =>
      path.startsWith('src/features/team-approvals/')
    )
      .map(read)
      .join('\n');
    const storageOperations = read(
      'src/features/internal-storage/main/infrastructure/worker/hostedTeamApprovalAuthorityStorageOps.ts'
    );

    expect(contracts).not.toMatch(
      /(?:OpenCode|TeamsAPI|ServiceHost|electron|child_process|spawn|fork)/
    );
    expect(authoritySource).not.toMatch(
      /\b(?:TeamsAPI|ServiceHost|OpenCode|child_process|spawn|fork|filesystemPath|projectPath|teamName)\b/
    );
    expect(storageOperations).not.toMatch(/\b(?:spawn|fork|child_process|exec|Worker)\b/);
    expect(storageOperations).toContain('never launches, owns, or invokes a runtime');
  });

  it('keeps every admitted production file below the source-size ceiling', () => {
    for (const path of PRODUCTION_PATHS) {
      expect(read(path).split(/\r?\n/).length, path).toBeLessThanOrEqual(800);
    }
  });
});
