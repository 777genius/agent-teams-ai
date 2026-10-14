import { describe, expect, it, vi } from 'vitest';

import { electronTeamPort } from '../../../../scripts/e2e/opencode-native-team-port';

import type { ElectronAPI } from '@shared/types/api';

describe('Electron TEST delivery status privacy boundary', () => {
  it('returns only finite delivery categories and never raw reason or diagnostic data', async () => {
    const secret = 'TEST_PRIVATE_PROVIDER_TEXT_and_C:\\TEST-profile\\auth.json';
    const readStatus = vi.fn(async (_team: string, _message: string) => ({
      providerId: 'opencode',
      messageId: 'original-challenge',
      attempted: true,
      accepted: false,
      delivered: true,
      acceptanceUnknown: false,
      responsePending: true,
      ledgerStatus: 'retry_scheduled',
      responseState: 'not_observed',
      reason: `error:contract_violation: ${secret}`,
      diagnostics: [
        `error:contract_violation: ${secret}`,
        `opencode_message_delivery_exception: ${secret}`,
        secret,
      ],
      ledgerRecordId: secret,
      laneId: secret,
      userVisibleImpact: { reason: secret },
    }));
    const port = electronTeamPort(
      {
        teams: {
          onProvisioningProgress: vi.fn(() => () => undefined),
          getOpenCodeRuntimeDeliveryStatus: readStatus,
        },
      } as unknown as ElectronAPI,
      'test-opencode-privacy',
      '/tmp/TEST-privacy/project'
    );
    try {
      const result = await port.getOpenCodeRuntimeDeliveryStatus('original-challenge');
      expect(result).toEqual({
        attempted: true,
        accepted: false,
        delivered: true,
        acceptanceUnknown: false,
        responsePending: true,
        ledgerStatus: 'retry_scheduled',
        responseState: 'not_observed',
        reasonCode: 'contract_violation',
        diagnosticCodes: [
          'contract_violation',
          'opencode_message_delivery_exception',
          'unclassified',
        ],
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(readStatus).toHaveBeenCalledExactlyOnceWith(
        'test-opencode-privacy',
        'original-challenge'
      );
    } finally {
      port.dispose();
    }
  });
});
