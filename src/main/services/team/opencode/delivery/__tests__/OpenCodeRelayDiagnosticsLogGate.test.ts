import { describe, expect, it, vi } from 'vitest';

import {
  hasWarningOpenCodeRelayDiagnostics,
  OPENCODE_RELAY_DIAGNOSTICS_LOG_DEDUP_MS,
  OPENCODE_RELAY_DIAGNOSTICS_LOG_MAX_TRACKED_KEYS,
  OpenCodeRelayDiagnosticsLogGate,
} from '../OpenCodeRelayDiagnosticsLogGate';

const BLOCKED = ['opencode runtime delivery did not complete.'];
const INFORMATIONAL = ['opencode session status busy'];

function note(
  gate: OpenCodeRelayDiagnosticsLogGate,
  overrides: {
    dedupKey?: string;
    prefix?: string;
    diagnostics?: readonly string[];
    nowMs?: number;
  } = {}
): ReturnType<OpenCodeRelayDiagnosticsLogGate['note']> {
  return gate.note({
    dedupKey: overrides.dedupKey ?? 'demo/researcher',
    prefix: overrides.prefix ?? '[FileWatcher] relay diagnostics for demo/researcher',
    diagnostics: 'diagnostics' in overrides ? overrides.diagnostics : BLOCKED,
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
        diagnostics: BLOCKED,
        nowMs: 0,
      });
      gate.log(writer, {
        dedupKey: 'demo/reviewer',
        prefix: 'relay diagnostics for demo/reviewer',
        diagnostics: INFORMATIONAL,
        nowMs: 0,
      });

      expect(writer.warn).toHaveBeenCalledExactlyOnceWith(
        `relay diagnostics for demo/researcher: ${BLOCKED[0]}`
      );
      expect(writer.debug).toHaveBeenCalledExactlyOnceWith(
        `relay diagnostics for demo/reviewer: ${INFORMATIONAL[0]}`
      );
    });

    it('writes nothing at all when the gate returns no line', () => {
      const gate = new OpenCodeRelayDiagnosticsLogGate();
      const writer = { warn: vi.fn(), debug: vi.fn() };
      const input = {
        dedupKey: 'demo/researcher',
        prefix: 'relay diagnostics for demo/researcher',
        diagnostics: BLOCKED,
        nowMs: 0,
      };

      gate.log(writer, { ...input, diagnostics: undefined });
      gate.log(writer, input);
      gate.log(writer, { ...input, nowMs: 15_000 });

      expect(writer.warn).toHaveBeenCalledTimes(1);
      expect(writer.debug).not.toHaveBeenCalled();
    });
  });
});
