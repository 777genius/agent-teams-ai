import { describe, expect, it } from 'vitest';

import {
  asRuntimeRecord,
  buildRuntimeToolMetadataDiagnostics,
  mergeRuntimeDiagnostics,
  normalizeRuntimeIso,
  normalizeRuntimeMetadataString,
  normalizeRuntimePositiveInteger,
  normalizeRuntimeStringArray,
  optionalRuntimeString,
  parseRuntimeToolMetadata,
  requireRuntimeString,
  runtimeTaskRefs,
  structuredTaskRefs,
  teamToolTaskRefs,
} from '../TeamProvisioningRuntimeMetadata';

describe('TeamProvisioningRuntimeMetadata', () => {
  describe('asRuntimeRecord', () => {
    it('returns the object for valid records', () => {
      const value = { a: 1 };
      expect(asRuntimeRecord(value)).toBe(value);
    });

    it('throws for non-objects and arrays', () => {
      expect(() => asRuntimeRecord(null)).toThrow('must be an object');
      expect(() => asRuntimeRecord('x')).toThrow('must be an object');
      expect(() => asRuntimeRecord([1, 2])).toThrow('must be an object');
    });
  });

  describe('requireRuntimeString', () => {
    it('trims and returns non-empty strings', () => {
      expect(requireRuntimeString('  hi  ', 'field')).toBe('hi');
    });

    it('throws naming the field for missing/blank values', () => {
      expect(() => requireRuntimeString('', 'sessionId')).toThrow('missing sessionId');
      expect(() => requireRuntimeString('   ', 'sessionId')).toThrow('missing sessionId');
      expect(() => requireRuntimeString(42, 'sessionId')).toThrow('missing sessionId');
    });
  });

  describe('optionalRuntimeString', () => {
    it('returns trimmed value or undefined', () => {
      expect(optionalRuntimeString(' x ')).toBe('x');
      expect(optionalRuntimeString('   ')).toBeUndefined();
      expect(optionalRuntimeString(5)).toBeUndefined();
    });
  });

  describe('normalizeRuntimeIso', () => {
    it('normalizes a valid date to ISO', () => {
      expect(normalizeRuntimeIso('2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00.000Z');
    });

    it('returns the fallback for invalid or missing dates', () => {
      expect(normalizeRuntimeIso('nope', 'fb')).toBe('fb');
      expect(normalizeRuntimeIso(undefined, 'fb')).toBe('fb');
    });
  });

  describe('normalizeRuntimeStringArray', () => {
    it('keeps only non-empty strings', () => {
      expect(normalizeRuntimeStringArray(['a', '', '  ', 'b', 3, null])).toEqual(['a', 'b']);
      expect(normalizeRuntimeStringArray('not-an-array')).toEqual([]);
    });
  });

  describe('normalizeRuntimePositiveInteger', () => {
    it('truncates positive finite numbers, rejects others', () => {
      expect(normalizeRuntimePositiveInteger(12.9)).toBe(12);
      expect(normalizeRuntimePositiveInteger(0)).toBeUndefined();
      expect(normalizeRuntimePositiveInteger(-3)).toBeUndefined();
      expect(normalizeRuntimePositiveInteger(Number.NaN)).toBeUndefined();
      expect(normalizeRuntimePositiveInteger('5')).toBeUndefined();
    });
  });

  describe('normalizeRuntimeMetadataString', () => {
    it('trims and truncates to maxLength', () => {
      expect(normalizeRuntimeMetadataString('  abcdef  ', 3)).toBe('abc');
      expect(normalizeRuntimeMetadataString('   ', 3)).toBeUndefined();
    });
  });

  describe('parseRuntimeToolMetadata', () => {
    it('extracts and normalizes known fields', () => {
      expect(
        parseRuntimeToolMetadata({
          runtimePid: 100.7,
          processCommand: '  node index.js  ',
          runtimeVersion: 'v1',
          hostPid: 5,
          cwd: '/repo',
          ignored: 'x',
        })
      ).toEqual({
        runtimePid: 100,
        processCommand: 'node index.js',
        runtimeVersion: 'v1',
        hostPid: 5,
        cwd: '/repo',
      });
    });

    it('returns an empty object for invalid input', () => {
      expect(parseRuntimeToolMetadata(null)).toEqual({});
      expect(parseRuntimeToolMetadata([1])).toEqual({});
    });

    it('omits fields that fail normalization', () => {
      expect(parseRuntimeToolMetadata({ runtimePid: -1, cwd: '   ' })).toEqual({});
    });
  });

  describe('buildRuntimeToolMetadataDiagnostics', () => {
    it('returns empty for undefined metadata', () => {
      expect(buildRuntimeToolMetadataDiagnostics(undefined)).toEqual([]);
    });

    it('lists present fields as diagnostics', () => {
      const diagnostics = buildRuntimeToolMetadataDiagnostics({
        runtimePid: 100,
        runtimeVersion: 'v1',
        hostPid: 5,
        cwd: '/repo',
      });
      expect(diagnostics).toContain('runtime pid: 100');
      expect(diagnostics).toContain('runtime version: v1');
      expect(diagnostics).toContain('runtime host pid: 5');
      expect(diagnostics).toContain('runtime cwd: /repo');
    });
  });

  describe('runtimeTaskRefs', () => {
    it('maps string refs to task refs scoped to the team', () => {
      expect(runtimeTaskRefs('team-a', ['t1', 't2'])).toEqual([
        { teamName: 'team-a', taskId: 't1', displayId: 't1' },
        { teamName: 'team-a', taskId: 't2', displayId: 't2' },
      ]);
      expect(runtimeTaskRefs('team-a', [])).toBeUndefined();
      expect(runtimeTaskRefs('team-a', 'x')).toBeUndefined();
    });
  });

  describe('structuredTaskRefs', () => {
    it('keeps only fully-specified refs', () => {
      expect(
        structuredTaskRefs([
          { taskId: ' a ', displayId: ' 1 ', teamName: ' t ' },
          { taskId: 'b', displayId: '', teamName: 't' },
          null,
        ])
      ).toEqual([{ taskId: 'a', displayId: '1', teamName: 't' }]);
      expect(structuredTaskRefs([])).toBeUndefined();
      expect(structuredTaskRefs('x')).toBeUndefined();
    });
  });

  describe('teamToolTaskRefs', () => {
    it('prefers structured refs, falling back to string refs', () => {
      expect(teamToolTaskRefs('team-a', [{ taskId: 'a', displayId: '1', teamName: 't' }])).toEqual([
        { taskId: 'a', displayId: '1', teamName: 't' },
      ]);
      expect(teamToolTaskRefs('team-a', ['s1'])).toEqual([
        { teamName: 'team-a', taskId: 's1', displayId: 's1' },
      ]);
      expect(teamToolTaskRefs('team-a', [])).toBeUndefined();
    });
  });

  describe('mergeRuntimeDiagnostics', () => {
    it('merges, dedupes, and drops blanks', () => {
      expect(mergeRuntimeDiagnostics(['a'], ['b', 'a', '  '], 'c')).toEqual(['a', 'b', 'c']);
      let previous: string[] | undefined;
      let fallback: string | undefined;
      expect(mergeRuntimeDiagnostics(previous, [], fallback)).toBeUndefined();
    });
  });
});
