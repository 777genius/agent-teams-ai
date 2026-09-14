import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MEMBER_WORK_SYNC_PRODUCTION_RECOVERY } from '../../../../src/features/member-work-sync/main';

describe('member work sync production recovery', () => {
  it('keeps qualified D0 on and declares protocol 2 without admitting early continuation', () => {
    expect(MEMBER_WORK_SYNC_PRODUCTION_RECOVERY).toEqual({
      recoveryAllocation: { enabled: true },
      recoveryProtocol: { version: 2 },
    });
    const indexSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../../src/main/index.ts'),
      'utf8'
    );
    const featureSource = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../src/features/member-work-sync/main/composition/createMemberWorkSyncFeature.ts'
      ),
      'utf8'
    );
    expect(indexSource).toContain('...MEMBER_WORK_SYNC_PRODUCTION_RECOVERY');
    expect(featureSource).toContain('createUnsupportedMemberWorkSyncRuntimeTicketAdmission');
  });
});
