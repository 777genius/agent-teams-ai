import { createHash } from 'node:crypto';

export const PARITY_DIAGNOSTICS = Object.freeze({
  drift: 'phase1-parity-reference-drift',
  ratchet: 'phase1-ratchet-regression',
} as const);

export interface ParityReference {
  readonly id: string;
  readonly owner: string;
  readonly disposition: 'quarantined' | 'decomposed' | 'desktop-only';
  readonly action: string;
  readonly routeOrChannel: string;
  readonly publicEntrypoint: string;
  readonly semanticTest: string;
  readonly sourcePath: string;
  readonly exactLegacySignature: string;
  readonly signatureSha256: string;
}

export interface ContentRatchet {
  readonly id: string;
  readonly needle: string;
  readonly maximumMatches: number;
  readonly expired: boolean;
}

export interface ParityDiagnostic {
  readonly referenceId: string;
  readonly diagnostic: (typeof PARITY_DIAGNOSTICS)[keyof typeof PARITY_DIAGNOSTICS];
}

export const PINNED_PARITY_REFERENCES: readonly ParityReference[] = Object.freeze([
  {
    id: 'legacy-team-list-ipc',
    owner: 'team-lifecycle',
    disposition: 'quarantined',
    action: 'team.lifecycle.list',
    routeOrChannel: 'team:list',
    publicEntrypoint: '@features/team-lifecycle',
    semanticTest:
      'test/features/team-lifecycle/conformance/listTeamLifecycleSummaries.conformance.test.ts',
    sourcePath: 'src/preload/constants/ipcChannels.ts',
    exactLegacySignature: "export const TEAM_LIST = 'team:list';",
    signatureSha256: '8e11ff3104da81f1e170edacb1997ffdfa254e98d3a139c35c5127b0efe74b1e',
  },
  {
    id: 'legacy-team-list-http',
    owner: 'team-lifecycle',
    disposition: 'quarantined',
    action: 'team.lifecycle.list',
    routeOrChannel: 'GET /api/teams',
    publicEntrypoint: '@features/team-lifecycle',
    semanticTest:
      'test/features/team-lifecycle/conformance/listTeamLifecycleSummaries.conformance.test.ts',
    sourcePath: 'src/main/http/teams.ts',
    exactLegacySignature: "app.get('/api/teams', async (_request, reply) => {",
    signatureSha256: '99c7a37a63bcef2ab2c90fe1300cb04d88b0ff58293a9d72f3faeafa5a67d872',
  },
]);

export const PINNED_PARITY_RATCHETS: readonly ContentRatchet[] = Object.freeze([
  {
    id: 'legacy-team-list-channel-count',
    needle: "'team:list'",
    maximumMatches: 1,
    expired: false,
  },
  {
    id: 'legacy-team-list-http-registration-count',
    needle: "app.get('/api/teams'",
    maximumMatches: 1,
    expired: false,
  },
]);

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function countLiteral(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function isCompleteReference(reference: ParityReference): boolean {
  return Boolean(
    reference.id &&
    reference.owner &&
    reference.disposition &&
    reference.action &&
    reference.routeOrChannel &&
    reference.publicEntrypoint &&
    reference.semanticTest &&
    reference.sourcePath &&
    reference.exactLegacySignature &&
    /^[a-f0-9]{64}$/.test(reference.signatureSha256)
  );
}

/** Content is provided explicitly so renamed files cannot escape corpus-wide ratchets. */
export function checkParityReferences(input: {
  readonly references: readonly ParityReference[];
  readonly ratchets: readonly ContentRatchet[];
  readonly sourceByPath: Readonly<Record<string, string>>;
}): readonly ParityDiagnostic[] {
  const diagnostics: ParityDiagnostic[] = [];
  const allSource = Object.values(input.sourceByPath).join('\n');

  for (const reference of input.references) {
    const source = input.sourceByPath[reference.sourcePath];
    if (
      !isCompleteReference(reference) ||
      typeof source !== 'string' ||
      !source.includes(reference.exactLegacySignature) ||
      sha256Text(reference.exactLegacySignature) !== reference.signatureSha256
    ) {
      diagnostics.push({
        referenceId: reference.id || 'missing-reference-id',
        diagnostic: PARITY_DIAGNOSTICS.drift,
      });
    }
  }

  for (const ratchet of input.ratchets) {
    if (ratchet.expired || countLiteral(allSource, ratchet.needle) > ratchet.maximumMatches) {
      diagnostics.push({ referenceId: ratchet.id, diagnostic: PARITY_DIAGNOSTICS.ratchet });
    }
  }

  return diagnostics;
}
