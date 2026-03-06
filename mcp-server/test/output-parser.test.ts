import { describe, it, expect } from 'vitest';
import {
  parseJsonOutput,
  parseOkOutput,
  parseTextOutput,
  formatError,
} from '../src/output-parser.js';

describe('parseJsonOutput', () => {
  it('parses valid JSON object', () => {
    const input = '{"id":"42","subject":"Fix bug"}\n';
    expect(parseJsonOutput(input)).toEqual({ id: '42', subject: 'Fix bug' });
  });

  it('parses valid JSON array', () => {
    const input = '[{"id":"1"},{"id":"2"}]\n';
    expect(parseJsonOutput(input)).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('trims whitespace', () => {
    const input = '  \n  {"ok":true}  \n  ';
    expect(parseJsonOutput(input)).toEqual({ ok: true });
  });

  it('throws on empty output', () => {
    expect(() => parseJsonOutput('')).toThrow('Empty output');
    expect(() => parseJsonOutput('  \n  ')).toThrow('Empty output');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseJsonOutput('not json')).toThrow('Failed to parse');
  });
});

describe('parseOkOutput', () => {
  it('strips "OK " prefix', () => {
    expect(parseOkOutput('OK task #1 status=completed\n')).toBe('task #1 status=completed');
  });

  it('handles bare "OK"', () => {
    expect(parseOkOutput('OK\n')).toBe('OK');
  });

  it('returns as-is for unexpected format', () => {
    expect(parseOkOutput('Something else')).toBe('Something else');
  });

  it('trims whitespace', () => {
    expect(parseOkOutput('  OK kanban #1 cleared  \n')).toBe('kanban #1 cleared');
  });
});

describe('parseTextOutput', () => {
  it('trims and returns text', () => {
    const briefing = '=== Task Briefing for alice ===\nTask #1: Fix bug\n';
    expect(parseTextOutput(briefing)).toBe('=== Task Briefing for alice ===\nTask #1: Fix bug');
  });

  it('handles empty string', () => {
    expect(parseTextOutput('')).toBe('');
  });
});

describe('formatError', () => {
  it('uses stderr when available', () => {
    expect(formatError('Task not found: #42\n', '')).toBe('Task not found: #42');
  });

  it('falls back to stdout', () => {
    expect(formatError('', 'Unexpected error\n')).toBe('Unexpected error');
  });

  it('returns default for empty', () => {
    expect(formatError('', '')).toBe('Unknown teamctl error');
  });
});
