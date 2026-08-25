import {
  decodeReplayCursor,
  encodeReplayCursor,
  type EventJournalWatermark,
  isReplayCursor,
  ReplayCursorError,
  validateReplayCursor,
} from '@features/coordination-events';
import { describe, expect, it } from 'vitest';

const WATERMARK: EventJournalWatermark = {
  schemaVersion: 1,
  deploymentId: 'deployment-α',
  eventEpoch: 'epoch-1',
  retentionFloorSequence: 0,
  highWatermarkSequence: 8,
};

describe('opaque coordination replay cursors', () => {
  it('round-trips a canonical position without exposing incrementable cursor fields', () => {
    const cursor = encodeReplayCursor({
      deploymentId: WATERMARK.deploymentId,
      eventEpoch: WATERMARK.eventEpoch,
      eventSequence: 4,
    });

    expect(cursor).toMatch(/^cev1\.[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain(WATERMARK.deploymentId);
    expect(cursor).not.toContain(WATERMARK.eventEpoch);
    expect(decodeReplayCursor(cursor)).toEqual({
      cursorVersion: 1,
      deploymentId: WATERMARK.deploymentId,
      eventEpoch: WATERMARK.eventEpoch,
      eventSequence: 4,
    });
    expect(isReplayCursor(cursor)).toBe(true);
  });

  it.each([
    '',
    ' cev1.WzEsImQiLCJlIiwwXQ',
    'cev1',
    'cev1.',
    'cev1.***',
    'cev1.WzEsImQiLCJlIiwwXQ=',
    'not-a-cursor',
  ])('rejects malformed or non-canonical cursor %j', (cursor) => {
    expect(() => decodeReplayCursor(cursor)).toThrowError(
      expect.objectContaining<Partial<ReplayCursorError>>({
        code: 'invalid_replay_cursor',
      })
    );
    expect(isReplayCursor(cursor)).toBe(false);
  });

  it('distinguishes unknown cursor versions from malformed cursors', () => {
    const cursor = encodeReplayCursor({
      deploymentId: 'deployment-1',
      eventEpoch: 'epoch-1',
      eventSequence: 0,
    });

    expect(() => decodeReplayCursor(cursor.replace(/^cev1/, 'cev2'))).toThrowError(
      expect.objectContaining<Partial<ReplayCursorError>>({
        code: 'unsupported_replay_cursor_version',
      })
    );
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid sequence %s at construction',
    (eventSequence) => {
      expect(() =>
        encodeReplayCursor({
          deploymentId: 'deployment-1',
          eventEpoch: 'epoch-1',
          eventSequence,
        })
      ).toThrowError(
        expect.objectContaining<Partial<ReplayCursorError>>({
          code: 'invalid_replay_cursor',
        })
      );
    }
  );

  it('never emits a cursor that exceeds its own encoded size bound', () => {
    const multibyteIdentity = '\u0800'.repeat(256);

    expect(() =>
      encodeReplayCursor({
        deploymentId: multibyteIdentity,
        eventEpoch: multibyteIdentity,
        eventSequence: 0,
      })
    ).toThrowError(
      expect.objectContaining<Partial<ReplayCursorError>>({
        code: 'invalid_replay_cursor',
      })
    );
  });

  it('fails closed for foreign deployment, foreign epoch, stale, and ahead cursors', () => {
    const cursor = (deploymentId: string, eventEpoch: string, eventSequence: number) =>
      encodeReplayCursor({ deploymentId, eventEpoch, eventSequence });

    expect(() =>
      validateReplayCursor(cursor('another-deployment', 'epoch-1', 4), WATERMARK)
    ).toThrowError(
      expect.objectContaining<Partial<ReplayCursorError>>({
        code: 'replay_cursor_deployment_mismatch',
      })
    );
    expect(() =>
      validateReplayCursor(cursor('deployment-α', 'old-epoch', 4), WATERMARK)
    ).toThrowError(
      expect.objectContaining<Partial<ReplayCursorError>>({
        code: 'replay_cursor_epoch_mismatch',
      })
    );

    const retained: EventJournalWatermark = {
      ...WATERMARK,
      retentionFloorSequence: 3,
    };
    expect(() => validateReplayCursor(cursor('deployment-α', 'epoch-1', 2), retained)).toThrowError(
      expect.objectContaining<Partial<ReplayCursorError>>({
        code: 'replay_cursor_stale',
      })
    );
    expect(() =>
      validateReplayCursor(cursor('deployment-α', 'epoch-1', 9), WATERMARK)
    ).toThrowError(
      expect.objectContaining<Partial<ReplayCursorError>>({
        code: 'replay_cursor_ahead',
      })
    );
  });

  it('accepts exactly the retention floor and high watermark boundaries', () => {
    const watermark: EventJournalWatermark = {
      ...WATERMARK,
      retentionFloorSequence: 3,
    };
    const atFloor = encodeReplayCursor({
      deploymentId: watermark.deploymentId,
      eventEpoch: watermark.eventEpoch,
      eventSequence: 3,
    });
    const atHigh = encodeReplayCursor({
      deploymentId: watermark.deploymentId,
      eventEpoch: watermark.eventEpoch,
      eventSequence: 8,
    });

    expect(validateReplayCursor(atFloor, watermark).eventSequence).toBe(3);
    expect(validateReplayCursor(atHigh, watermark).eventSequence).toBe(8);
  });

  it('rejects unknown watermark versions and impossible retained ranges', () => {
    expect(() =>
      validateReplayCursor(
        encodeReplayCursor({
          deploymentId: WATERMARK.deploymentId,
          eventEpoch: WATERMARK.eventEpoch,
          eventSequence: 4,
        }),
        {
          ...WATERMARK,
          schemaVersion: 2,
        } as unknown as EventJournalWatermark
      )
    ).toThrowError(
      expect.objectContaining<Partial<ReplayCursorError>>({
        code: 'invalid_journal_watermark',
      })
    );

    expect(() =>
      validateReplayCursor(
        encodeReplayCursor({
          deploymentId: WATERMARK.deploymentId,
          eventEpoch: WATERMARK.eventEpoch,
          eventSequence: 4,
        }),
        {
          ...WATERMARK,
          retentionFloorSequence: 9,
        }
      )
    ).toThrowError(
      expect.objectContaining<Partial<ReplayCursorError>>({
        code: 'invalid_journal_watermark',
      })
    );
  });

  it('rejects an accessor-bearing journal watermark without invoking the accessor', () => {
    let highWatermarkReads = 0;
    const accessorWatermark = Object.defineProperty({ ...WATERMARK }, 'highWatermarkSequence', {
      enumerable: true,
      get() {
        highWatermarkReads += 1;
        return WATERMARK.highWatermarkSequence;
      },
    }) as EventJournalWatermark;

    expect(() =>
      validateReplayCursor(
        encodeReplayCursor({
          deploymentId: WATERMARK.deploymentId,
          eventEpoch: WATERMARK.eventEpoch,
          eventSequence: 4,
        }),
        accessorWatermark
      )
    ).toThrowError(
      expect.objectContaining<Partial<ReplayCursorError>>({
        code: 'invalid_journal_watermark',
      })
    );
    expect(highWatermarkReads).toBe(0);
  });
});
