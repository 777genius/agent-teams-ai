import { summarizeRetainedHistoryError } from '@main/utils/retainedHistoryRequestDiagnostic';
import { describe, expect, it } from 'vitest';

describe('summarizeRetainedHistoryError', () => {
  it('does not mistake minified or numbered source literals for the terminal failure', () => {
    const literal = 'error: OpenCode strict profile authority source is unavailable';
    const source = ('const embedded="' + literal + '";').repeat(1_500);
    const excerpt = source + '\n31 | ' + literal + '\n';

    const sourceOnly = summarizeRetainedHistoryError(
      Object.assign(new Error('Command failed'), { code: 1, stderr: excerpt })
    );
    expect(sourceOnly).toMatchObject({
      code: 1,
      terminalFound: false,
      reason: 'unclassified',
    });

    const actualFailure = summarizeRetainedHistoryError(
      Object.assign(new Error('Command failed'), {
        code: 1,
        stderr: excerpt + 'error: unrelated terminal failure\n    at privateFunction (/private/file:1:1)\n',
      })
    );
    expect(actualFailure).toMatchObject({
      code: 1,
      terminalFound: true,
      terminalKind: 'Error',
      reason: 'unclassified',
    });
    expect(JSON.stringify(actualFailure)).not.toContain(literal);
    expect(JSON.stringify(actualFailure)).not.toContain('privateFunction');
  });

  it('never returns credentials, prompts, source text, paths, or causes', () => {
    const secret = 'TEST_SECRET_DO_NOT_EMIT_9b7d';
    const prompt = 'TEST_PRIVATE_PROMPT_DO_NOT_EMIT';
    const error = Object.assign(new Error('Command failed: Bearer ' + secret), {
      code: 1,
      stdout: prompt,
      stderr: 'ReferenceError: ' + secret + ' is not defined\n' +
        '    at privateFunction (/private/' + secret + '/bundle.js:1:1)\n',
      cause: new Error('password=' + secret),
    });
    error.stack = prompt + '\n/private/' + secret;

    const diagnostic = summarizeRetainedHistoryError(error);
    expect(diagnostic).toMatchObject({
      diagnosticAvailable: true,
      code: 1,
      terminalSource: 'stderr',
      terminalFound: true,
      terminalKind: 'ReferenceError',
      reason: 'js_reference_error',
    });
    const serialized = JSON.stringify(diagnostic);
    for (const forbidden of [secret, prompt, 'Bearer', 'password=', '/private/', 'privateFunction']) {
      expect(serialized).not.toContain(forbidden);
    }
    for (const forbiddenKey of ['message', 'stack', 'cause', 'stderr', 'stdout', 'path']) {
      expect(diagnostic).not.toHaveProperty(forbiddenKey);
    }
  });

  it('finds a real SQLite terminal error after a large Bun source dump', () => {
    const stderr = 'x'.repeat(131_072) + '\n' +
      '\u001b[31mSQLiteError: unable to open database file\u001b[0m\n' +
      '  code: "SQLITE_CANTOPEN",\n' +
      '  errno: 14,\n' +
      '    at Database (/private/bundle.js:1:1)\n';
    const diagnostic = summarizeRetainedHistoryError(
      Object.assign(new Error('Command failed'), { code: 1, stderr })
    );
    expect(diagnostic).toMatchObject({
      code: 1,
      terminalSource: 'stderr',
      tailTruncated: true,
      terminalFound: true,
      terminalKind: 'SQLiteError',
      terminalCode: 'SQLITE_CANTOPEN',
      terminalErrno: 14,
      reason: 'sqlite_cannot_open',
    });
    expect(JSON.stringify(diagnostic)).not.toContain('/private/');
    expect(JSON.stringify(diagnostic).length).toBeLessThan(1_000);
  });

  it('keeps unknown data explicit while distinguishing local JavaScript error classes', () => {
    const unknown = summarizeRetainedHistoryError(
      Object.assign(new Error('TEST_PRIVATE_UNKNOWN_MESSAGE'), {
        code: 'TEST_PRIVATE_CODE',
        signal: 'TEST_PRIVATE_SIGNAL',
        errno: 'TEST_PRIVATE_ERRNO',
        stderr: 'TEST_PRIVATE_UNKNOWN_STDERR',
        killed: false,
      })
    );
    expect(unknown).toMatchObject({
      diagnosticAvailable: true,
      code: null,
      errno: null,
      signal: null,
      killed: false,
      terminalFound: false,
      terminalKind: 'unknown',
      reason: 'unclassified',
    });
    expect(JSON.stringify(unknown)).not.toContain('TEST_PRIVATE');

    for (const [error, reason] of [
      [new TypeError('TEST_PRIVATE_TYPE'), 'js_type_error'],
      [new ReferenceError('TEST_PRIVATE_REFERENCE'), 'js_reference_error'],
      [new SyntaxError('TEST_PRIVATE_SYNTAX'), 'js_syntax_error'],
    ] as const) {
      const diagnostic = summarizeRetainedHistoryError(error);
      expect(diagnostic).toMatchObject({ terminalFound: false, reason });
      expect(JSON.stringify(diagnostic)).not.toContain('TEST_PRIVATE');
    }
  });
});
