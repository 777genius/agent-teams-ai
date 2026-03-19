import { describe, expect, it } from 'vitest';

import {
  buildToolSummary,
  formatToolSummary,
  formatToolSummaryFromMap,
  parseToolSummary,
} from '@shared/utils/toolSummary';

describe('toolSummary', () => {
  describe('parseToolSummary simple format regex', () => {
    it('parses "3 tools"', () => {
      const r = parseToolSummary('3 tools');
      expect(r).toEqual({ total: 3, byName: {} });
    });

    it('parses "1 tool"', () => {
      const r = parseToolSummary('1 tool');
      expect(r).toEqual({ total: 1, byName: {} });
    });

    it('returns null for invalid format', () => {
      expect(parseToolSummary('invalid')).toBeNull();
      expect(parseToolSummary('')).toBeNull();
      expect(parseToolSummary(undefined)).toBeNull();
    });
  });

  describe('parseToolSummary legacy format regex', () => {
    it('parses "3 tools (Read, 2 Edit)"', () => {
      const r = parseToolSummary('3 tools (Read, 2 Edit)');
      expect(r).not.toBeNull();
      expect(r!.total).toBe(3);
      expect(r!.byName).toEqual({ Read: 1, Edit: 2 });
    });

    it('parses "1 tool (Bash)"', () => {
      const r = parseToolSummary('1 tool (Bash)');
      expect(r).not.toBeNull();
      expect(r!.total).toBe(1);
      expect(r!.byName).toEqual({ Bash: 1 });
    });

    it('parses tool names with spaces "2 tools (2 Web Search)"', () => {
      const r = parseToolSummary('2 tools (2 Web Search)');
      expect(r).not.toBeNull();
      expect(r!.total).toBe(2);
      expect(r!.byName['Web Search']).toBe(2);
    });
  });

  describe('buildToolSummary', () => {
    it('returns "1 tool" for single tool_use', () => {
      const content = [{ type: 'tool_use', name: 'Read', input: {} }];
      expect(buildToolSummary(content)).toBe('1 tool');
    });

    it('returns "3 tools" for multiple', () => {
      const content = [
        { type: 'tool_use', name: 'Read', input: {} },
        { type: 'tool_use', name: 'Edit', input: {} },
        { type: 'tool_use', name: 'Read', input: {} },
      ];
      expect(buildToolSummary(content)).toBe('3 tools');
    });

    it('returns undefined for empty', () => {
      expect(buildToolSummary([])).toBeUndefined();
    });
  });

  describe('formatToolSummary', () => {
    it('formats singular and plural', () => {
      expect(formatToolSummary({ total: 1, byName: {} })).toBe('1 tool');
      expect(formatToolSummary({ total: 2, byName: {} })).toBe('2 tools');
    });
  });

  describe('formatToolSummaryFromMap', () => {
    it('returns undefined for empty map', () => {
      expect(formatToolSummaryFromMap(new Map())).toBeUndefined();
    });

    it('formats from map', () => {
      const m = new Map([['Read', 2], ['Edit', 1]]);
      expect(formatToolSummaryFromMap(m)).toBe('3 tools');
    });
  });
});
