// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { importStoppedLegacyTeam } from '../../../src/features/agent-backend/main/application/importStoppedLegacyTeam';
import { LegacyStoppedImportHold } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/createLegacyStoppedTeamSource';
import { createStoppedImportDiagnostic } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/createStoppedImportDiagnostic';
import { formatPersistentLogMessage } from '../../../src/main/utils/persistentAppLog';
import { addLogSink, createLogger } from '../../../src/shared/utils/logger';

import type {
  DesktopBackendFeature,
  LegacyStoppedSourceOwners,
} from '../../../src/features/agent-backend/main';
import type {
  StoppedImportDiagnostic,
  StoppedImportDiagnosticSink,
  StoppedImportPrepareObservation,
} from '../../../src/features/agent-backend/main/infrastructure/stopped-import/createStoppedImportDiagnostic';

const prepared = vi.hoisted(() => vi.fn());
vi.mock(
  '../../../src/features/agent-backend/main/infrastructure/stopped-import/prepareStoppedLegacyImport',
  () => ({ prepareStoppedLegacyImport: prepared })
);

const receipt = {
  commandId: 'TEST-original',
  phase: 'published' as 'published' | 'held',
  source: { sourceId: 'TEST-source', snapshotDigest: 'a'.repeat(64) },
  record: {
    contextId: 'TEST-private-context',
    teamName: 'TEST-private-team',
    binding: { handleId: 'TEST-private-handle' },
  },
};

function fixture() {
  prepared.mockReset();
  prepared.mockResolvedValue({
    contextId: receipt.record.contextId,
    sourceId: receipt.source.sourceId,
    snapshotDigest: receipt.source.snapshotDigest,
    teamName: receipt.record.teamName,
  });
  const client = {
    list: vi.fn(async () => [] as (typeof receipt)[]),
    lookup: vi.fn(async () => null as typeof receipt | null),
    publish: vi.fn(async () => receipt),
    retry: vi.fn(async () => receipt),
  };
  const registerPublished = vi.fn(async () => {});
  const captureStoppedImport = vi.fn(async () => ({ client, authority: {}, registerPublished }));
  const source = {
    sourceOwnerId: 'TEST-private-owner',
    sourceId: receipt.source.sourceId,
    contextId: receipt.record.contextId,
    teamName: receipt.record.teamName,
    roots: [],
    isCurrent: () => true,
  };
  const observations: StoppedImportDiagnostic[] = [];
  const observeFailure = vi.fn((observation: StoppedImportDiagnostic) => {
    observations.push(observation);
  });
  const options = {
    feature: { captureStoppedImport } as unknown as DesktopBackendFeature,
    contextId: receipt.record.contextId,
    request: { teamName: receipt.record.teamName, action: 'prepare' },
    guard: { isCurrent: () => true },
    owners: {} as LegacyStoppedSourceOwners,
    captureSource: vi.fn(() => source),
    observeFailure,
  };
  return {
    options,
    client,
    registerPublished,
    captureStoppedImport,
    source,
    observations,
    observeFailure,
  };
}

describe('stopped import refusal diagnostics at the actual application boundary', () => {
  it('keeps successful publication and registration silent', async () => {
    const f = fixture();
    expect(await importStoppedLegacyTeam(f.options)).toEqual({
      ok: true,
      selection: 'host-team:TEST-private-handle',
    });
    expect(f.client.publish).toHaveBeenCalledTimes(1);
    expect(f.registerPublished).toHaveBeenCalledExactlyOnceWith(receipt.record);
    expect(f.observations).toEqual([]);
  });

  it('records the Host-capture refusal without exception text or private request identifiers', async () => {
    const f = fixture();
    const readMessage = vi.fn(() => 'PRIVATE-token-path');
    const error = Object.defineProperty(new Error(), 'message', { get: readMessage });
    Object.assign(error, { code: 'EACCES', path: '/PRIVATE/path', token: 'PRIVATE-token' });
    f.captureStoppedImport.mockRejectedValue(error);
    expect(await importStoppedLegacyTeam(f.options)).toEqual({
      ok: false,
      reason: 'held',
      outcome: 'not-dispatched',
    });
    expect(f.observations).toEqual([
      {
        source: 'application',
        phase: 'host-capture',
        category: 'denied',
        outcome: 'not-dispatched',
      },
    ]);
    expect(readMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(f.observations)).not.toMatch(/PRIVATE|TEST-private/);
    expect(f.client.list).not.toHaveBeenCalled();
    expect(f.client.publish).not.toHaveBeenCalled();
  });

  it('preserves the expected native-custody refusal that offers the original runtime', async () => {
    const f = fixture();
    prepared.mockRejectedValue(new LegacyStoppedImportHold('native-custody-unverified'));
    expect(await importStoppedLegacyTeam(f.options)).toEqual({
      ok: false,
      reason: 'native-custody-unverified',
      outcome: 'not-dispatched',
    });
    expect(f.observations).toEqual([
      {
        source: 'application',
        phase: 'prepare',
        category: 'native-custody-unverified',
        outcome: 'not-dispatched',
      },
    ]);
    expect(f.client.publish).not.toHaveBeenCalled();
    expect(f.client.retry).not.toHaveBeenCalled();
  });

  it('retains one closed prepare boundary through the original logger and persistent message formatter', async () => {
    const f = fixture(),
      messages: string[] = [];
    prepared.mockImplementationOnce(
      async (options: { observation: StoppedImportPrepareObservation }) => {
        options.observation.boundary = 'source-fence-before-callback';
        throw Object.assign(new Error('PRIVATE-fence-path-token'), { code: 'hold' });
      }
    );
    const remove = addLogSink((entry) => {
      if (entry.namespace === 'StoppedTeamImport')
        messages.push(formatPersistentLogMessage(entry.args));
    });
    try {
      expect(
        await importStoppedLegacyTeam({
          ...f.options,
          observeFailure: (observation) => {
            f.observeFailure(observation);
            createLogger('StoppedTeamImport').diagnostic(
              'Stopped Team import refusal',
              observation
            );
          },
        })
      ).toEqual({ ok: false, reason: 'held', outcome: 'not-dispatched' });
      const expected = {
        source: 'application',
        phase: 'prepare',
        category: 'held',
        outcome: 'not-dispatched',
        prepareBoundary: 'source-fence-before-callback',
      };
      expect(f.observations).toEqual([expected]);
      expect(messages).toEqual(['Stopped Team import refusal ' + JSON.stringify(expected)]);
      expect(messages.join()).not.toMatch(/PRIVATE|TEST-private/);
      expect(f.client.publish).not.toHaveBeenCalled();
      expect(f.client.retry).not.toHaveBeenCalled();
    } finally {
      remove();
    }
  });

  it('distinguishes duplicate receipts before any publication or recovery lookup', async () => {
    const f = fixture();
    f.client.list.mockResolvedValue([receipt, receipt]);
    expect(await importStoppedLegacyTeam(f.options)).toEqual({
      ok: false,
      reason: 'held',
      outcome: 'not-dispatched',
    });
    expect(f.observations).toEqual([
      {
        source: 'application',
        phase: 'receipts',
        category: 'receipt-conflict',
        outcome: 'not-dispatched',
      },
    ]);
    expect(f.client.lookup).not.toHaveBeenCalled();
    expect(f.client.publish).not.toHaveBeenCalled();
  });

  it('retains UNKNOWN after a lost publication ACK and exactly the original reconciliation', async () => {
    const f = fixture();
    f.client.publish.mockRejectedValue(new Error('PRIVATE-lost-ACK'));
    expect(await importStoppedLegacyTeam(f.options)).toEqual({
      ok: false,
      reason: 'unknown',
      outcome: 'unknown',
    });
    expect(f.observations).toEqual([
      {
        source: 'application',
        phase: 'receipt',
        category: 'receipt-absent',
        outcome: 'unknown',
      },
    ]);
    expect(f.client.publish).toHaveBeenCalledTimes(1);
    expect(f.client.lookup).toHaveBeenCalledTimes(2);
    expect(f.client.lookup.mock.calls[1]).toEqual(f.client.lookup.mock.calls[0]);
    expect(f.client.retry).not.toHaveBeenCalled();
    expect(f.registerPublished).not.toHaveBeenCalled();
  });

  it('does not manufacture a final refusal when the original lost ACK is recovered', async () => {
    const f = fixture();
    f.client.publish.mockRejectedValue(new Error('PRIVATE-lost-ACK'));
    f.client.lookup.mockResolvedValueOnce(null).mockResolvedValueOnce(receipt);
    expect(await importStoppedLegacyTeam(f.options)).toEqual({
      ok: true,
      selection: 'host-team:TEST-private-handle',
    });
    expect(f.client.publish).toHaveBeenCalledTimes(1);
    expect(f.client.lookup).toHaveBeenCalledTimes(2);
    expect(f.client.retry).not.toHaveBeenCalled();
    expect(f.observations).toEqual([]);
  });

  it('observes registration failure after publication without clearing its UNKNOWN outcome', async () => {
    const f = fixture();
    f.registerPublished.mockRejectedValue(Object.assign(new Error('PRIVATE'), { code: 'EPERM' }));
    expect(await importStoppedLegacyTeam(f.options)).toEqual({
      ok: false,
      reason: 'unknown',
      outcome: 'unknown',
    });
    expect(f.observations).toEqual([
      {
        source: 'application',
        phase: 'register',
        category: 'denied',
        outcome: 'unknown',
      },
    ]);
    expect(f.client.publish).toHaveBeenCalledTimes(1);
    expect(f.client.retry).not.toHaveBeenCalled();
  });

  it('keeps a held receipt distinct from an absent receipt without retrying prepare', async () => {
    const f = fixture();
    f.client.list.mockResolvedValue([{ ...receipt, phase: 'held' }]);
    expect(await importStoppedLegacyTeam(f.options)).toEqual({
      ok: false,
      reason: 'held',
      outcome: 'not-dispatched',
    });
    expect(f.observations).toEqual([
      {
        source: 'application',
        phase: 'receipt',
        category: 'receipt-held',
        outcome: 'not-dispatched',
      },
    ]);
    expect(prepared).not.toHaveBeenCalled();
    expect(f.client.publish).not.toHaveBeenCalled();
    expect(f.client.retry).not.toHaveBeenCalled();
  });

  for (const failure of ['throw', 'reject', 'getter'] as const) {
    it('keeps the original result when the diagnostic sink fails by ' + failure, async () => {
      const f = fixture();
      f.captureStoppedImport.mockRejectedValue(
        Object.assign(new Error('PRIVATE'), { code: 'hold' })
      );
      const failedSink: StoppedImportDiagnosticSink = () => {
        if (failure === 'throw') throw new Error('PRIVATE-observer');
        return Promise.reject(new Error('PRIVATE-observer'));
      };
      const options = { ...f.options, observeFailure: failedSink };
      if (failure === 'getter') {
        Object.defineProperty(options, 'observeFailure', {
          get: () => {
            throw new Error('PRIVATE-observer-getter');
          },
        });
      }
      expect(await importStoppedLegacyTeam(options)).toEqual({
        ok: false,
        reason: 'held',
        outcome: 'not-dispatched',
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(f.client.publish).not.toHaveBeenCalled();
      expect(f.client.retry).not.toHaveBeenCalled();
    });
  }
});

describe('private stopped import diagnostic vocabulary and observer lifetime', () => {
  it('reads only own data labels and does not invoke error field getters', () => {
    const sink = vi.fn();
    const getter = vi.fn(() => 'EACCES');
    const error = Object.create({ code: 'EACCES', reason: 'source-changed' });
    for (const key of ['reason', 'code', 'name', 'message', 'stack', 'cause']) {
      Object.defineProperty(error, key, { get: getter });
    }
    createStoppedImportDiagnostic('application', sink)('host-capture', error, 'not-dispatched');
    expect(getter).not.toHaveBeenCalled();
    expect(sink).toHaveBeenCalledExactlyOnceWith({
      source: 'application',
      phase: 'host-capture',
      category: 'unknown',
      outcome: 'not-dispatched',
    });
  });

  it('contains throwing Proxy traps without forwarding arbitrary private code strings', () => {
    const sink = vi.fn();
    const error = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('PRIVATE-descriptor');
        },
        getPrototypeOf: () => {
          throw new Error('PRIVATE-prototype');
        },
      }
    );
    createStoppedImportDiagnostic('desktop', sink)('source-owner', error, 'not-dispatched');
    expect(sink).toHaveBeenCalledExactlyOnceWith({
      source: 'desktop',
      phase: 'source-owner',
      category: 'unknown',
      outcome: 'not-dispatched',
    });
    const other = vi.fn();
    createStoppedImportDiagnostic('application', other)(
      'host-capture',
      { code: 'PRIVATE-unknown-code', message: 'PRIVATE' },
      'not-dispatched'
    );
    expect(other.mock.calls[0]?.[0].category).toBe('unknown');
    expect(JSON.stringify(other.mock.calls)).not.toContain('PRIVATE');
  });

  it('emits one closed record for an original boundary despite a second attempted observation', () => {
    const sink = vi.fn();
    const observe = createStoppedImportDiagnostic('application', sink);
    observe('publish', { code: 'ETIMEDOUT' }, 'unknown');
    observe('register', { code: 'EACCES' }, 'unknown');
    expect(sink).toHaveBeenCalledExactlyOnceWith({
      source: 'application',
      phase: 'publish',
      category: 'deadline',
      outcome: 'unknown',
    });
  });

  it('drops a forged source phase or arbitrary explicit category without calling the sink', () => {
    const sink = vi.fn();
    createStoppedImportDiagnostic('desktop', sink)('publish', undefined, 'unknown');
    createStoppedImportDiagnostic('application', sink)(
      'host-capture',
      undefined,
      'not-dispatched',
      'PRIVATE' as never
    );
    expect(sink).not.toHaveBeenCalled();
  });

  it('never invokes a prepare slot getter or forwards an unlisted boundary or wrong phase', () => {
    const getter = vi.fn(() => 'PRIVATE-boundary'),
      sink = vi.fn();
    const hostile = Object.defineProperty({}, 'boundary', { get: getter });
    createStoppedImportDiagnostic('application', sink)(
      'prepare',
      { code: 'hold' },
      'not-dispatched',
      undefined,
      hostile
    );
    expect(getter).not.toHaveBeenCalled();
    expect(sink).toHaveBeenCalledExactlyOnceWith({
      source: 'application',
      phase: 'prepare',
      category: 'held',
      outcome: 'not-dispatched',
    });
    sink.mockClear();
    createStoppedImportDiagnostic('application', sink)(
      'prepare',
      undefined,
      'not-dispatched',
      undefined,
      { boundary: 'PRIVATE-boundary' as never }
    );
    createStoppedImportDiagnostic('application', sink)('publish', undefined, 'unknown', undefined, {
      boundary: 'snapshot-staging',
    });
    createStoppedImportDiagnostic('desktop', sink)(
      'request',
      undefined,
      'not-dispatched',
      undefined,
      { boundary: 'snapshot-staging' }
    );
    expect(sink).not.toHaveBeenCalled();
  });
});
