// @vitest-environment node
import { expect, it } from 'vitest';

import { CapturedProviderCredentials } from '../../../src/features/runtime-provider-management/main/adapters/output/CapturedProviderCredentials';

import type { CapturedProviderManagement } from '../../../src/features/agent-backend/main';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';

it('reconciles a lost key ACK on the original owner; cold pending compares the same intent while completed intents allow a fresh UUID', async () => {
  const calls: string[] = [];
  const ids: string[] = [];
  let current = true, effects = 0, phase: 'completed' | 'held' = 'completed';
  let saved: Record<string, JsonValue> | undefined;
  const binding = { profileId: 'TEST-captured', configRevision: 'TEST-original' };
  const snapshot = () => ({ ...binding, commandId: saved!.commandId!, kind: saved!.kind!,
    providerId: saved!.providerId!, phase });
  const target: CapturedProviderManagement = {
    ...binding, targetId: 'a'.repeat(64), isCurrent: () => current,
    async request(operation, payload): Promise<JsonValue> {
      calls.push(operation);
      if (operation === 'credential.pending') return { ok: true,
        value: { generation: 'v2', receipt: saved && phase === 'held' ? snapshot() : null } };
      if (operation === 'credential') {
        if (!current) throw new Error('TEST-current-owner-revoked');
        saved = structuredClone(payload);
        ids.push(String(payload.commandId));
        effects++;
        if (effects === 1) { current = false; throw new Error('TEST-ACK-lost-after-effect'); }
        return { ok: true, value: snapshot() };
      }
      if (operation === 'credential.resume') {
        if (JSON.stringify(payload) !== JSON.stringify(saved)) return { ok: false, code: 'conflict' };
        return { ok: true, value: snapshot() };
      }
      throw new Error('TEST-unexpected');
    },
  };
  const input = { providerId: 'TEST-provider', kind: 'credential.set' as const, key: 'TEST-private' };
  await new CapturedProviderCredentials().execute(target, input);
  expect(calls).toEqual(['credential.pending', 'credential', 'credential.resume']);
  expect(effects).toBe(1);
  current = true;
  await new CapturedProviderCredentials().execute(target, input);
  expect(effects).toBe(2);
  expect(ids[1]).not.toBe(ids[0]);
  phase = 'held';
  await expect(new CapturedProviderCredentials().execute(target, input)).rejects.toThrow('unconfirmed');
  await expect(new CapturedProviderCredentials().execute(target, { ...input, key: 'TEST-changed' })).rejects.toThrow();
  expect(effects).toBe(2);
  expect(calls.slice(-4)).toEqual(['credential.pending', 'credential.resume', 'credential.pending', 'credential.resume']);
});
