import { useCallback, useRef, useState } from 'react';

import { api } from '@renderer/api';

import type {
  UpdateMemberSettingsRequest,
  UpdateMemberSettingsResult,
} from '../../contracts/memberSettings';

interface PendingIdentity {
  commandId: string;
  idempotencyKey: string;
}

function createIdentity(): PendingIdentity {
  const commandId = crypto.randomUUID();
  return { commandId, idempotencyKey: commandId };
}

export function useUpdateMemberSettings(): {
  saving: boolean;
  save: (
    request: Omit<UpdateMemberSettingsRequest, keyof PendingIdentity>
  ) => Promise<UpdateMemberSettingsResult>;
  resetIdentity: () => void;
} {
  const [saving, setSaving] = useState(false);
  const identityRef = useRef<PendingIdentity | null>(null);

  const save = useCallback(
    async (
      request: Omit<UpdateMemberSettingsRequest, keyof PendingIdentity>
    ): Promise<UpdateMemberSettingsResult> => {
      identityRef.current ??= createIdentity();
      setSaving(true);
      try {
        return await api.teams.updateMemberSettings({ ...request, ...identityRef.current });
      } finally {
        setSaving(false);
      }
    },
    []
  );

  const resetIdentity = useCallback(() => {
    identityRef.current = null;
  }, []);

  return { saving, save, resetIdentity };
}
