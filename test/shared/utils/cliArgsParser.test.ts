import { describe, expect, it } from 'vitest';

import {
  extractFlagsFromHelp,
  extractUserFlags,
  parseCliArgs,
  PROTECTED_CLI_FLAGS,
} from '@shared/utils/cliArgsParser';

describe('parseCliArgs', () => {
  it('returns empty array for undefined', () => {
    expect(parseCliArgs(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseCliArgs('')).toEqual([]);
  });

  it('splits simple flags and values', () => {
    expect(parseCliArgs('--verbose --max-turns 5')).toEqual(['--verbose', '--max-turns', '5']);
  });

  it('handles double-quoted strings', () => {
    expect(parseCliArgs('--message "hello world"')).toEqual(['--message', 'hello world']);
  });

  it('handles single-quoted strings', () => {
    expect(parseCliArgs("--message 'it works'")).toEqual(['--message', 'it works']);
  });

  it('trims leading/trailing whitespace', () => {
    expect(parseCliArgs('  --verbose  ')).toEqual(['--verbose']);
  });

  it('handles multiple consecutive spaces', () => {
    expect(parseCliArgs('--foo    --bar   baz')).toEqual(['--foo', '--bar', 'baz']);
  });

  it('handles tabs as separators', () => {
    expect(parseCliArgs('--foo\t--bar')).toEqual(['--foo', '--bar']);
  });

  it('handles mixed quotes', () => {
    expect(parseCliArgs(`--a "hello 'inner'" --b 'world "nested"'`)).toEqual([
      '--a',
      "hello 'inner'",
      '--b',
      'world "nested"',
    ]);
  });

  it('handles short flags', () => {
    expect(parseCliArgs('-p "prompt text" -w name')).toEqual(['-p', 'prompt text', '-w', 'name']);
  });

  it('handles flag=value format', () => {
    expect(parseCliArgs('--model=opus-4')).toEqual(['--model=opus-4']);
  });

  it('handles empty quoted strings', () => {
    expect(parseCliArgs('--value ""')).toEqual(['--value', '']);
  });
});

describe('extractFlagsFromHelp', () => {
  const SAMPLE_HELP = `
Usage: claude [options] [prompt]

Options:
  -p, --print             Print response without interactive mode
  -w, --worktree [name]   Run in a git worktree
  --model <model>         Specify the model to use
  --max-turns <number>    Maximum conversation turns
  --verbose               Enable verbose logging
  --dangerously-skip-permissions  Skip permission checks
  --input-format <format> Input format (text, stream-json)
  --output-format <format> Output format
  --no-session-persistence Don't persist session
  -h, --help              Display this help
  -V, --version           Display version

For more information, visit https://docs.anthropic.com
This is a non-interactive tool for automated workflows.
  `;

  it('extracts long flags', () => {
    const flags = extractFlagsFromHelp(SAMPLE_HELP);
    expect(flags.has('--model')).toBe(true);
    expect(flags.has('--max-turns')).toBe(true);
    expect(flags.has('--verbose')).toBe(true);
    expect(flags.has('--dangerously-skip-permissions')).toBe(true);
    expect(flags.has('--input-format')).toBe(true);
    expect(flags.has('--output-format')).toBe(true);
    expect(flags.has('--no-session-persistence')).toBe(true);
    expect(flags.has('--worktree')).toBe(true);
  });

  it('extracts short flags', () => {
    const flags = extractFlagsFromHelp(SAMPLE_HELP);
    expect(flags.has('-p')).toBe(true);
    expect(flags.has('-w')).toBe(true);
    expect(flags.has('-h')).toBe(true);
    expect(flags.has('-V')).toBe(true);
  });

  it('does not match hyphens in regular text', () => {
    const flags = extractFlagsFromHelp(SAMPLE_HELP);
    // "non-interactive" should not produce --non or -n from hyphenated words
    expect(flags.has('--non')).toBe(false);
  });

  it('returns empty set for empty input', () => {
    expect(extractFlagsFromHelp('').size).toBe(0);
  });
});

describe('extractUserFlags', () => {
  it('extracts flags from mixed input', () => {
    expect(extractUserFlags('--verbose --max-turns 5 foo')).toEqual([
      '--verbose',
      '--max-turns',
    ]);
  });

  it('extracts short flags', () => {
    expect(extractUserFlags('-p -w')).toEqual(['-p', '-w']);
  });

  it('returns empty for empty string', () => {
    expect(extractUserFlags('')).toEqual([]);
  });

  it('returns empty when no flags present', () => {
    expect(extractUserFlags('hello world')).toEqual([]);
  });
});

describe('PROTECTED_CLI_FLAGS', () => {
  it('contains expected flags', () => {
    expect(PROTECTED_CLI_FLAGS.has('--input-format')).toBe(true);
    expect(PROTECTED_CLI_FLAGS.has('--output-format')).toBe(true);
    expect(PROTECTED_CLI_FLAGS.has('--mcp-config')).toBe(true);
    expect(PROTECTED_CLI_FLAGS.has('--disallowedTools')).toBe(true);
    expect(PROTECTED_CLI_FLAGS.has('--verbose')).toBe(true);
  });

  it('does not contain user-facing flags', () => {
    expect(PROTECTED_CLI_FLAGS.has('--model')).toBe(false);
    expect(PROTECTED_CLI_FLAGS.has('--effort')).toBe(false);
    expect(PROTECTED_CLI_FLAGS.has('--worktree')).toBe(false);
  });
});
