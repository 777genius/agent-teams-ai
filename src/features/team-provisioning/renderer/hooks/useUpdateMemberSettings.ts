import { useCallback, useRef, useState } from 'react';

import type { TeamMemberSettingsApi } from '../../contracts';
import type {
  UpdateMemberSettingsRequest,
  UpdateMemberSettingsResult,
} from '../../contracts/memberSettings';

interface PendingIdentity {
  commandId: string;
  idempotencyKey: string;
  payloadKey: string;
}

type WithoutPendingIdentity<TRequest> = TRequest extends unknown
  ? Omit<TRequest, keyof PendingIdentity>
  : never;
type PendingRequest = WithoutPendingIdentity<UpdateMemberSettingsRequest>;

function createIdentity(payloadKey: string): PendingIdentity {
  const commandId = crypto.randomUUID();
  return { commandId, idempotencyKey: commandId, payloadKey };
}

export function useUpdateMemberSettings(
  updateMemberSettings: TeamMemberSettingsApi['updateMemberSettings']
): {
  saving: boolean;
  save: (request: PendingRequest) => Promise<UpdateMemberSettingsResult>;
  resetIdentity: () => void;
} {
  const [saving, setSaving] = useState(false);
  const identityRef = useRef<PendingIdentity | null>(null);

  const save = useCallback(
    async (request: PendingRequest): Promise<UpdateMemberSettingsResult> => {
      const payloadKey = JSON.stringify(request);
      if (identityRef.current?.payloadKey !== payloadKey) {
        identityRef.current = createIdentity(payloadKey);
      }
      setSaving(true);
      try {
        const { commandId, idempotencyKey } = identityRef.current;
        return await updateMemberSettings({ ...request, commandId, idempotencyKey });
      } finally {
        setSaving(false);
      }
    },
    [updateMemberSettings]
  );

  const resetIdentity = useCallback(() => {
    identityRef.current = null;
  }, []);

  return { saving, save, resetIdentity };
}
