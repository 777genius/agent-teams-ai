import { describe, expect, it, vi } from 'vitest';

import {
  hasWarningOpenCodeRelayDiagnostics,
  OPENCODE_RELAY_DIAGNOSTICS_LOG_DEDUP_MS,
  OPENCODE_RELAY_DIAGNOSTICS_LOG_MAX_TRACKED_KEYS,
  OpenCodeRelayDiagnosticsLogGate,
} from '../OpenCodeRelayDiagnosticsLogGate';

import type { TeamCrossTeamMessagingApi } from '../../../contracts/TeamProvisioningApis';

type FileWatcherRelay = Awaited<
  ReturnType<TeamCrossTeamMessagingApi['relayInboxFileToLiveRecipient']>
>;

const BLOCKED = ['opencode runtime delivery did not complete.'];
const INFORMATIONAL = ['opencode session status busy'];
const BOOTSTRAP_PENDING = [
  'OpenCode runtime bootstrap is not confirmed for researcher. Message was saved and will be retried after runtime check-in.',
];

function note(
  gate: OpenCodeRelayDiagnosticsLogGate,
  overrides: {
    dedupKey?: string;
    prefix?: string;
    diagnostics?: readonly string[];
    deferredUntilBootstrap?: boolean;
    nowMs?: number;
  } = {}
): ReturnType<OpenCodeRelayDiagnosticsLogGate['note']> {
  return gate.note({
    dedupKey: overrides.dedupKey ?? 'demo/researcher',
    prefix: overrides.prefix ?? '[FileWatcher] relay diagnostics for demo/researcher',
    outcome: {
      diagnostics: 'diagnostics' in overrides ? overrides.diagnostics : BLOCKED,
      ...(overrides.deferredUntilBootstrap
        ? { lastDelivery: { deferredUntilBootstrap: true as const } }
        : {}),
    },
    nowMs: overrides.nowMs ?? 0,
  });
}

describe('OpenCodeRelayDiagnosticsLogGate', () => {
  it('writes the first occurrence of a condition and renders the prefix with it', () => {
    const line = note(new OpenCodeRelayDiagnosticsLogGate());

    expect(line).toMatchObject({ level: 'warn' });
    expect(line?.message).toBe(
      `[FileWatcher] relay diagnostics for demo/researcher: ${BLOCKED[0]}`
    );
  });

  it('says nothing when a relay reported no diagnostics', () => {
    const gate = new OpenCodeRelayDiagnosticsLogGate();

    expect(note(gate, { diagnostics: undefined })).toBeNull();
    expect(note(gate, { diagnostics: [] })).toBeNull();
  });

  /**
   * One blocked lane refuses every message queued behind it with the identical
   * diagnostic. Keying the window on the rendered line would let that queue walk
   * past it one message id at a time, so the signature is the diagnostics alone
   * and the prefix is presentation.
   */
  it('holds the window against a changing prefix on the same condition', () => {
    const gate = new OpenCodeRelayDiagnosticsLogGate();
    note(gate, { prefix: 'wake for demo/researcher/210f0017' });

    expect(note(gate, { prefix: 'wake for demo/researcher/3a396156', nowMs: 15_000 })).toBeNull();
    expect(note(gate, { prefix: 'wake for demo/researcher/510baaaf', nowMs: 30_000 })).toBeNull();
  });

  it('writes again once the window has passed', () => {
    const gate = new OpenCodeRelayDiagnosticsLogGate();
    note(gate);

    expect(note(gate, { nowMs: OPENCODE_RELAY_DIAGNOSTICS_LOG_DEDUP_MS - 1 })).toBeNull();
    expect(note(gate, { nowMs: OPENCODE_RELAY_DIAGNOSTICS_LOG_DEDUP_MS })).not.toBeNull();
  });

  // A transition is always news: the condition the operator is watching changed.
  it('writes a changed condition immediately', () => {
    const gate = new OpenCodeRelayDiagnosticsLogGate();
    note(gate);

    const changed = note(gate, {
      diagnostics: ['opencode returned an empty assistant turn.'],
      nowMs: 1_000,
    });

    expect(changed).toMatchObject({ level: 'warn' });
  });

  it('keeps separate windows per dedup key', () => {
    const gate = new OpenCodeRelayDiagnosticsLogGate();
    note(gate, { dedupKey: 'demo/researcher' });

    expect(note(gate, { dedupKey: 'demo/reviewer', nowMs: 1_000 })).not.toBeNull();
  });

  it('forgets the oldest window rather than tracking keys without bound', () => {
    const gate = new OpenCodeRelayDiagnosticsLogGate();
    for (let index = 0; index < OPENCODE_RELAY_DIAGNOSTICS_LOG_MAX_TRACKED_KEYS; index += 1) {
      note(gate, { dedupKey: `demo/member-${index}` });
    }

    note(gate, { dedupKey: 'demo/one-too-many' });

    // Everything still tracked keeps its window.
    expect(note(gate, { dedupKey: 'demo/member-1', nowMs: 1_000 })).toBeNull();
    // The oldest key was evicted to make room, so its condition is news again.
    expect(note(gate, { dedupKey: 'demo/member-0', nowMs: 1_000 })).not.toBeNull();
  });

  /**
   * Eviction reads insertion order, and a `Map` keeps a re-set key at the position
   * it first went in at. So the key whose window was refreshed a moment ago is the
   * one eviction reaches first, and the busiest lane in the process - the one the
   * window exists to quieten - is the one that loses its window and writes again.
   */
  it('evicts the key logged longest ago, not the one refreshed most recently', () => {
    const gate = new OpenCodeRelayDiagnosticsLogGate(OPENCODE_RELAY_DIAGNOSTICS_LOG_DEDUP_MS, 2);
    const CHANGED = ['opencode api error: session not found'];
    note(gate, { dedupKey: 'demo/refreshed' });
    note(gate, { dedupKey: 'demo/quiet', nowMs: 1_000 });
    // A changed condition writes immediately and reopens the window for that key,
    // which makes it the most recently logged key of the two.
    note(gate, { dedupKey: 'demo/refreshed', diagnostics: CHANGED, nowMs: 2_000 });

    note(gate, { dedupKey: 'demo/newcomer', nowMs: 3_000 });

    // The refreshed key kept its place and its window.
    expect(
      note(gate, { dedupKey: 'demo/refreshed', diagnostics: CHANGED, nowMs: 4_000 })
    ).toBeNull();
    // The key nobody has logged since is the one that made room.
    expect(note(gate, { dedupKey: 'demo/quiet', nowMs: 4_000 })).not.toBeNull();
  });

  /**
   * Negative control. Expected control flow must not file itself under the
   * durable warning channel, no matter how often the lane repeats it.
   */
  it('reports an informational-only condition at debug, never at warn', () => {
    const line = note(new OpenCodeRelayDiagnosticsLogGate(), { diagnostics: INFORMATIONAL });

    expect(line).toMatchObject({ level: 'debug' });
    expect(hasWarningOpenCodeRelayDiagnostics(INFORMATIONAL)).toBe(false);
  });

  /**
   * The inverse control, and the reason severity is decided over the whole list
   * rather than the first entry: one diagnostic that is not expected control
   * flow is enough to make the line durable, wherever it sits in the list.
   */
  it('raises the whole line to warn for a single non-informational diagnostic', () => {
    const mixed = [...INFORMATIONAL, 'opencode api error: session not found'];

    expect(note(new OpenCodeRelayDiagnosticsLogGate(), { diagnostics: mixed })).toMatchObject({
      level: 'warn',
    });
    expect(hasWarningOpenCodeRelayDiagnostics(mixed)).toBe(true);
  });

  /**
   * A bootstrap deferral with an armed retry keeps the stopped-lane wording, which
   * is off the informational allowlist. The flag on the relay's last delivery, not
   * the text, keeps it off the warning channel; the same text without the flag is
   * a lane nothing will retry and stays a warning.
   */
  it('keeps an armed bootstrap deferral off warn and still warns for the unarmed miss', () => {
    const gate = new OpenCodeRelayDiagnosticsLogGate();

    expect(note(gate, { diagnostics: BOOTSTRAP_PENDING, deferredUntilBootstrap: true })).toEqual({
      level: 'debug',
      message: `[FileWatcher] relay diagnostics for demo/researcher: ${BOOTSTRAP_PENDING[0]}`,
    });
    expect(hasWarningOpenCodeRelayDiagnostics(BOOTSTRAP_PENDING)).toBe(true);
    // The same text losing its armed retry inside the window is news, not a repeat.
    expect(note(gate, { diagnostics: BOOTSTRAP_PENDING, nowMs: 5_000 })).toMatchObject({
      level: 'warn',
    });
    expect(note(gate, { diagnostics: BOOTSTRAP_PENDING, nowMs: 10_000 })).toBeNull();
  });

  it('forgets everything on clear', () => {
    const gate = new OpenCodeRelayDiagnosticsLogGate();
    note(gate);
    gate.clear();

    expect(note(gate, { nowMs: 1_000 })).not.toBeNull();
  });

  /**
   * What the caller in `src/main/index.ts` delegates: the line is written when
   * the gate returns one, at the level it chose, and nothing at all is written
   * when it returns null. Keeping this in the gate is what makes it assertable;
   * `src/main/index.ts` is not reachable from a unit test.
   */
  describe('log', () => {
    it('writes the line the gate returned, at the level the gate chose', () => {
      const gate = new OpenCodeRelayDiagnosticsLogGate();
      const writer = { warn: vi.fn(), debug: vi.fn() };

      gate.log(writer, {
        dedupKey: 'demo/researcher',
        prefix: 'relay diagnostics for demo/researcher',
        outcome: { diagnostics: BLOCKED },
        nowMs: 0,
      });
      gate.log(writer, {
        dedupKey: 'demo/reviewer',
        prefix: 'relay diagnostics for demo/reviewer',
        outcome: { diagnostics: INFORMATIONAL },
        nowMs: 0,
      });

      expect(writer.warn).toHaveBeenCalledExactlyOnceWith(
        `relay diagnostics for demo/researcher: ${BLOCKED[0]}`
      );
      expect(writer.debug).toHaveBeenCalledExactlyOnceWith(
        `relay diagnostics for demo/reviewer: ${INFORMATIONAL[0]}`
      );
    });

    /**
     * The FileWatcher path in `src/main/index.ts` hands the gate the whole
     * `relayInboxFileToLiveRecipient` result. Typed as that result, so the flag
     * it reads cannot drift off the contract unnoticed.
     */
    it('reads the bootstrap deferral flag off a FileWatcher relay result', () => {
      const gate = new OpenCodeRelayDiagnosticsLogGate();
      const writer = { warn: vi.fn(), debug: vi.fn() };
      const relay = (deferredUntilBootstrap: boolean): FileWatcherRelay => ({
        kind: 'opencode_member',
        relayed: 0,
        diagnostics: BOOTSTRAP_PENDING,
        lastDelivery: {
          delivered: false,
          reason: 'opencode_runtime_not_active',
          ...(deferredUntilBootstrap ? { deferredUntilBootstrap: true as const } : {}),
          diagnostics: BOOTSTRAP_PENDING,
        },
      });

      gate.log(writer, {
        dedupKey: 'demo/researcher',
        prefix: '[FileWatcher] relay diagnostics for demo/researcher',
        outcome: relay(true),
        nowMs: 0,
      });
      gate.log(writer, {
        dedupKey: 'demo/reviewer',
        prefix: '[FileWatcher] relay diagnostics for demo/reviewer',
        outcome: relay(false),
        nowMs: 0,
      });

      expect(writer.debug).toHaveBeenCalledExactlyOnceWith(
        `[FileWatcher] relay diagnostics for demo/researcher: ${BOOTSTRAP_PENDING[0]}`
      );
      expect(writer.warn).toHaveBeenCalledExactlyOnceWith(
        `[FileWatcher] relay diagnostics for demo/reviewer: ${BOOTSTRAP_PENDING[0]}`
      );
    });

    it('writes nothing at all when the gate returns no line', () => {
      const gate = new OpenCodeRelayDiagnosticsLogGate();
      const writer = { warn: vi.fn(), debug: vi.fn() };
      const input = {
        dedupKey: 'demo/researcher',
        prefix: 'relay diagnostics for demo/researcher',
        outcome: { diagnostics: BLOCKED },
        nowMs: 0,
      };

      gate.log(writer, { ...input, outcome: undefined });
      gate.log(writer, input);
      gate.log(writer, { ...input, nowMs: 15_000 });

      expect(writer.warn).toHaveBeenCalledTimes(1);
      expect(writer.debug).not.toHaveBeenCalled();
    });
  });
});
