import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkParityReferences,
  PARITY_DIAGNOSTICS,
  PINNED_PARITY_RATCHETS,
  PINNED_PARITY_REFERENCES,
} from '../../../../../scripts/hosted-web/phase-1/check-parity-references';
import { createParityDriftFixture, ratchetRegressionFixture } from '../fixtures/ratchet-regression';

// The full src corpus, so a duplicated channel/route literal in ANY file trips the ratchet.
// Keys are normalized to forward slashes so pinned reference.sourcePath values match on Windows.
const sourceByPath = Object.fromEntries(
  readdirSync('src', { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name))
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return [path.replaceAll('\\', '/'), readFileSync(path, 'utf8')];
    })
);

describe('P1.1C parity reference scanner', () => {
  it('pins complete ADR-19/20 references and content counts', () => {
    expect(
      checkParityReferences({
        references: PINNED_PARITY_REFERENCES,
        ratchets: PINNED_PARITY_RATCHETS,
        sourceByPath,
      })
    ).toEqual([]);
  });

  it('fails a missing semantic reference with the frozen parity diagnostic', () => {
    const references = [
      createParityDriftFixture(PINNED_PARITY_REFERENCES[0]),
      PINNED_PARITY_REFERENCES[1],
    ];
    expect(
      checkParityReferences({ references, ratchets: PINNED_PARITY_RATCHETS, sourceByPath })
    ).toContainEqual({
      referenceId: PINNED_PARITY_REFERENCES[0].id,
      diagnostic: PARITY_DIAGNOSTICS.drift,
    });
  });

  it('fails an expired quarantine and detects debt after a source rename', () => {
    const renamedSources = {
      ...sourceByPath,
      'renamed/duplicate-channel.ts': "export const duplicate = 'team:list';",
    };
    const findings = checkParityReferences({
      references: PINNED_PARITY_REFERENCES,
      ratchets: [...PINNED_PARITY_RATCHETS, ratchetRegressionFixture],
      sourceByPath: renamedSources,
    });

    expect(findings).toContainEqual({
      referenceId: 'legacy-team-list-channel-count',
      diagnostic: PARITY_DIAGNOSTICS.ratchet,
    });
    expect(findings).toContainEqual({
      referenceId: ratchetRegressionFixture.id,
      diagnostic: PARITY_DIAGNOSTICS.ratchet,
    });
  });
});
