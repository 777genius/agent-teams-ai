import type { RuntimeControlProviderId } from './RuntimeControlProvider';

export type RuntimeControlAckState = 'accepted' | 'delivered' | 'duplicate' | 'recorded';

export type RuntimeControlAckLocation = Readonly<Record<string, string | number | boolean | null>>;

export interface RuntimeControlAck<
  TProviderId extends RuntimeControlProviderId = RuntimeControlProviderId,
> {
  ok: true;
  providerId: TProviderId;
  teamName: string;
  runId: string;
  state: RuntimeControlAckState;
  memberName?: string;
  runtimeSessionId?: string;
  idempotencyKey?: string;
  location?: RuntimeControlAckLocation;
  diagnostics: string[];
  observedAt: string;
}

export type OpenCodeRuntimeControlAck = RuntimeControlAck<'opencode'>;
