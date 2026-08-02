import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const OWNED_PATHS = Object.freeze([
  'src/features/team-approvals/main/ports/HostedTeamApprovalAuthorityPort.ts',
  'src/features/team-approvals/main/adapters/output/HostedTeamApprovalAuthorityAdapter.ts',
  'src/features/team-approvals/main/composition/createHostedTeamApprovalOutputAdapters.ts',
  'src/features/team-approvals/main/hosted.ts',
  'test/features/team-approvals/hosted/HostedTeamApprovalAuthorityAdapter.test.ts',
  'test/features/team-approvals/hosted/createHostedTeamApprovalOutputAdapters.test.ts',
  'test/architecture/hosted-web/phase-9/hosted-team-approval-authority-boundary.test.ts',
]);

const PRODUCTION_PATHS = OWNED_PATHS.filter((path) => path.startsWith('src/'));

function read(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are fixed above
  return readFileSync(path, 'utf8');
}

describe('hosted team approval authority boundary', () => {
  it('keeps the authority adapter to exactly seven admitted feature-owned paths', () => {
    expect(OWNED_PATHS).toHaveLength(7);
    expect(new Set(OWNED_PATHS).size).toBe(7);
    expect(OWNED_PATHS.every(existsSync)).toBe(true);
    expect(
      OWNED_PATHS.every(
        (path) =>
          path.startsWith('src/features/team-approvals/') ||
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

  it('exports only the authority port and composition surface without a standalone mount', () => {
    const hostedEntry = read('src/features/team-approvals/main/hosted.ts');
    const rootEntry = read('src/features/team-approvals/index.ts');
    const mainEntry = read('src/features/team-approvals/main/index.ts');
    const standalone = read('src/main/standalone.ts');

    expect(hostedEntry).toContain('HostedTeamApprovalAuthorityPort');
    expect(hostedEntry).toContain('createHostedTeamApprovalOutputAdapters');
    expect(hostedEntry).not.toContain('HostedTeamApprovalAuthorityAdapter');
    expect(rootEntry).not.toContain('HostedTeamApprovalAuthority');
    expect(mainEntry).not.toContain('HostedTeamApprovalAuthority');
    expect(standalone).not.toContain('createHostedTeamApprovalOutputAdapters');
    expect(standalone).not.toContain('HostedTeamApprovalAuthorityAdapter');
  });

  it('keeps production authority code transport-neutral and free of private mutable owners', () => {
    const source = PRODUCTION_PATHS.map(read).join('\n');

    expect(source).not.toMatch(
      /(?:from\s+['"](?:node:|electron|fastify|@main\/services)|\bTeamsAPI\b|\bServiceHost\b|\bOpenCode\b|\bas\s+(?:unknown|any)\s+as\b)/
    );
    expect(source).not.toMatch(
      /\b(?:TeamDataService|TeamDirectoryService|readFile|writeFile|readdir|mkdir|providerPayload|credential|filesystemPath|projectPath|teamName)\b/i
    );
    expect(source).not.toContain('window.electronAPI');
  });

  it('keeps every admitted production file below the source-size ceiling', () => {
    for (const path of PRODUCTION_PATHS) {
      expect(read(path).split(/\r?\n/).length, path).toBeLessThanOrEqual(800);
    }
  });
});
