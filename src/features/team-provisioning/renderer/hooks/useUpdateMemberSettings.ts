import { useCallback, useRef, useState } from 'react';

import { api } from '@renderer/api';

import type {
  UpdateMemberSettingsRequest,
  UpdateMemberSettingsResult,
} from '../../contracts/memberSettings';

interface PendingIdentity {
  commandId: string;
  idempotencyKey: string;
  payloadKey: string;
}

type PendingRequest = UpdateMemberSettingsRequest extends infer TRequest
  ? TRequest extends UpdateMemberSettingsRequest
    ? Omit<TRequest, keyof PendingIdentity>
    : never
  : never;

function createIdentity(payloadKey: string): PendingIdentity {
  const commandId = crypto.randomUUID();
  return { commandId, idempotencyKey: commandId, payloadKey };
}

export function useUpdateMemberSettings(): {
  saving: boolean;
  save: (request: PendingRequest) => Promise<UpdateMemberSettingsResult>;
  resetIdentity: () => void;
} {
  const [saving, setSaving] = useState(false);
  const identityRef = useRef<PendingIdentity | null>(null);

  const save = useCallback(async (request: PendingRequest): Promise<UpdateMemberSettingsResult> => {
    const payloadKey = JSON.stringify(request);
    if (identityRef.current?.payloadKey !== payloadKey) {
      identityRef.current = createIdentity(payloadKey);
    }
    setSaving(true);
    try {
      const { commandId, idempotencyKey } = identityRef.current;
      return await api.teams.updateMemberSettings({
        ...request,
        commandId,
        idempotencyKey,
      } as UpdateMemberSettingsRequest);
    } finally {
      setSaving(false);
    }
  }, []);

  const resetIdentity = useCallback(() => {
    identityRef.current = null;
  }, []);

  return { saving, save, resetIdentity };
}
