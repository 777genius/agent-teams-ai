import { describe, expect, it } from 'vitest';

import {
  extractFlagsFromHelp,
  extractUserFlags,
  findInvalidUserFlags,
  findOptionMissingValue,
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

  it('normalizes the --flag=value form to the bare flag name', () => {
    expect(extractUserFlags('--mcp-config=/evil/config.json')).toEqual(['--mcp-config']);
    expect(extractUserFlags('--dangerously-skip-permissions=1')).toEqual([
      '--dangerously-skip-permissions',
    ]);
    expect(extractUserFlags('--max-turns=5 --model=gpt')).toEqual(['--max-turns', '--model']);
  });

  it('detects protected flags supplied in the --flag=value form (blocklist bypass guard)', () => {
    // A protected flag with an appended =value must still be caught by an exact
    // PROTECTED_CLI_FLAGS membership check; otherwise arg-injection bypasses it.
    const injected = '--mcp-config=/evil/config.json --permission-mode=bypassPermissions';
    const protectedHits = extractUserFlags(injected).filter((flag) =>
      PROTECTED_CLI_FLAGS.has(flag)
    );
    expect(protectedHits).toEqual(['--mcp-config', '--permission-mode']);
  });

  it('reads short flag clusters and attached values like the CLI does', () => {
    expect(extractUserFlags('-rabc')).toEqual(['-r']);
    expect(extractUserFlags('-r=abc')).toEqual(['-r']);
    expect(extractUserFlags('-pr abc')).toEqual(['-p', '-r']);
    expect(extractUserFlags('-pcr abc')).toEqual(['-p', '-c', '-r']);
    // -d takes a value, so the `r` in `-dr` is its value, not a flag.
    expect(extractUserFlags('-dr')).toEqual(['-d']);
    // --max-turns takes a required value, so `-1` is its value, not a flag.
    expect(extractUserFlags('--max-turns -1')).toEqual(['--max-turns']);
  });

  it('skips the value of an option that requires one, even if it starts with a dash', () => {
    expect(extractUserFlags('--append-system-prompt "-review the patch"')).toEqual([
      '--append-system-prompt',
    ]);
    expect(extractUserFlags('-n -rname -p')).toEqual(['-n', '-p']);
    // `-n` at the end of a cluster also takes the next token.
    expect(extractUserFlags('-pn -review')).toEqual(['-p', '-n']);
    // An attached value (`-nfoo`) leaves the next token as a flag.
    expect(extractUserFlags('-nfoo -r abc')).toEqual(['-n', '-r']);
    // An attached value is already part of the token, so the next token is a flag.
    expect(extractUserFlags('--append-system-prompt=x -r abc')).toEqual([
      '--append-system-prompt',
      '-r',
    ]);
  });

  it('keeps a non-letter remainder of a short cluster so validation can report it', () => {
    expect(extractUserFlags('-p1')).toEqual(['-p', '-1']);
    expect(extractUserFlags('-pc2')).toEqual(['-p', '-c', '-2']);
  });
});

describe('findOptionMissingValue', () => {
  it('reports an option that needs a value but ends the args', () => {
    expect(findOptionMissingValue('-n')).toBe('-n');
    expect(findOptionMissingValue('-pn')).toBe('-n');
    expect(findOptionMissingValue('--max-turns')).toBe('--max-turns');
    expect(findOptionMissingValue('--verbose --append-system-prompt')).toBe(
      '--append-system-prompt'
    );
  });

  it('accepts options that have their value', () => {
    expect(findOptionMissingValue('-n name')).toBeUndefined();
    expect(findOptionMissingValue('-pn -dash-name')).toBeUndefined();
    expect(findOptionMissingValue('-nname')).toBeUndefined();
    expect(findOptionMissingValue('--append-system-prompt=x')).toBeUndefined();
    expect(findOptionMissingValue('-p --verbose')).toBeUndefined();
  });
});

describe('findInvalidUserFlags', () => {
  const known = new Set(['--model', '-p', '-n', '--append-system-prompt']);

  it('reports unknown, protected and value-less options once each', () => {
    expect(findInvalidUserFlags('-p --nope --nope', known)).toEqual(['--nope']);
    expect(findInvalidUserFlags('--model x', known)).toEqual(['--model']);
    expect(findInvalidUserFlags('-p --append-system-prompt', known)).toEqual([
      '--append-system-prompt',
    ]);
  });

  it('accepts valid args', () => {
    expect(findInvalidUserFlags('-p -n name --append-system-prompt "-x"', known)).toEqual([]);
    expect(findInvalidUserFlags('', known)).toEqual([]);
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

  it('contains app-managed launch flags but not unrelated user flags', () => {
    expect(PROTECTED_CLI_FLAGS.has('--model')).toBe(true);
    expect(PROTECTED_CLI_FLAGS.has('--effort')).toBe(true);
    expect(PROTECTED_CLI_FLAGS.has('--worktree')).toBe(false);
  });

  it('still reports a protected long flag in a skipped value position', () => {
    // Launch splits --settings out of the raw args, so it must not hide behind a value.
    const hits = (raw: string) =>
      extractUserFlags(raw).filter((flag) => PROTECTED_CLI_FLAGS.has(flag));
    expect(hits(`--append-system-prompt --settings '{"env":{}}' prompt`)).toEqual(['--settings']);
    expect(hits('-n --settings={} x')).toEqual(['--settings']);
    expect(hits('--append-system-prompt "-review the patch"')).toEqual([]);
  });

  it('covers the CLI aliases of protected flags', () => {
    // `claude --help` lists `--disallowedTools, --disallowed-tools` and `-r, --resume`.
    const injected = '--disallowed-tools=Bash -r abc -rabc -pr abc';
    const hits = extractUserFlags(injected).filter((flag) => PROTECTED_CLI_FLAGS.has(flag));
    expect(hits).toEqual(['--disallowed-tools', '-r', '-r', '-r']);
  });
});
