import {
  readOptionalEnv,
  readOptionalEnvArgs,
  readOptionalEnvNumber,
} from '@main/utils/readOptionalEnv';
import { afterEach, describe, expect, it, vi } from 'vitest';

const TEST_ENV = 'AGENT_TEAMS_TEST_OPTIONAL_ENV';

afterEach(() => {
  delete process.env[TEST_ENV];
});

describe('readOptionalEnv', () => {
  it('trims optional values and accepts only positive finite numbers', () => {
    process.env[TEST_ENV] = ' 42 ';
    expect(readOptionalEnv(TEST_ENV)).toBe('42');
    expect(readOptionalEnvNumber(TEST_ENV)).toBe(42);

    process.env[TEST_ENV] = ' 0 ';
    expect(readOptionalEnvNumber(TEST_ENV)).toBeUndefined();
    process.env[TEST_ENV] = 'Infinity';
    expect(readOptionalEnvNumber(TEST_ENV)).toBeUndefined();
    process.env[TEST_ENV] = '   ';
    expect(readOptionalEnv(TEST_ENV)).toBeUndefined();
  });

  it('reads JSON and whitespace argument lists while reporting malformed JSON', () => {
    const warn = vi.fn<(name: string) => void>();
    process.env[TEST_ENV] = '["first", "", 2, "second"]';
    expect(readOptionalEnvArgs(TEST_ENV, warn)).toEqual(['first', 'second']);
    process.env[TEST_ENV] = 'first  second';
    expect(readOptionalEnvArgs(TEST_ENV, warn)).toEqual(['first', 'second']);
    process.env[TEST_ENV] = '[broken';
    expect(readOptionalEnvArgs(TEST_ENV, warn)).toEqual(['[broken']);
    expect(warn).toHaveBeenCalledExactlyOnceWith(TEST_ENV);
  });
});
