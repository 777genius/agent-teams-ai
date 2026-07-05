import { describe, expect, it } from 'vitest';

import {
  buildProvisioningTraceDetail,
  pushUniqueSupportDiagnostics,
} from '../TeamProvisioningDiagnosticsHelpers';

import type { TeamProvisioningSupportDiagnostic } from '@shared/types';

describe('TeamProvisioningDiagnosticsHelpers', () => {
  describe('buildProvisioningTraceDetail', () => {
    it('returns undefined when no extras are present', () => {
      expect(buildProvisioningTraceDetail()).toBeUndefined();
      expect(buildProvisioningTraceDetail({})).toBeUndefined();
    });

    it('joins present fields into a single-line detail', () => {
      expect(
        buildProvisioningTraceDetail({
          pid: 42,
          configReady: true,
          error: 'boom',
          warnings: ['w1', 'w2'],
          launchDiagnostics: [{ id: 'd1' } as never, { id: 'd2' } as never],
        })
      ).toBe('pid=42 | configReady=true | error=boom | warnings=w1; w2 | launchDiagnostics=2');
    });

    it('omits fields that are absent or falsey', () => {
      expect(buildProvisioningTraceDetail({ pid: 7 })).toBe('pid=7');
      expect(buildProvisioningTraceDetail({ configReady: false })).toBeUndefined();
      expect(buildProvisioningTraceDetail({ warnings: [] })).toBeUndefined();
    });
  });

  describe('pushUniqueSupportDiagnostics', () => {
    const diag = (id: string, message = id): TeamProvisioningSupportDiagnostic =>
      ({ id, message }) as unknown as TeamProvisioningSupportDiagnostic;

    it('appends new diagnostics and skips duplicates by id', () => {
      const acc = [diag('a')];
      pushUniqueSupportDiagnostics(acc, [diag('b'), diag('a', 'other'), diag('c')]);
      expect(acc.map((d) => d.id)).toEqual(['a', 'b', 'c']);
    });

    it('shallow-copies pushed entries', () => {
      const acc: TeamProvisioningSupportDiagnostic[] = [];
      const source = diag('x');
      pushUniqueSupportDiagnostics(acc, [source]);
      expect(acc[0]).not.toBe(source);
      expect(acc[0]).toEqual(source);
    });

    it('tolerates undefined incoming', () => {
      const acc = [diag('a')];
      let incoming: TeamProvisioningSupportDiagnostic[] | undefined;
      pushUniqueSupportDiagnostics(acc, incoming);
      expect(acc.map((d) => d.id)).toEqual(['a']);
    });
  });
});
