import {
  projectRuntimeLiveness,
  sanitizeProcessCommandForDiagnostics,
  sanitizeRuntimeProjectionProcessCommand,
} from '@main/services/team/runtime-projection';
import { describe, expect, it } from 'vitest';

describe('runtime projection command redaction', () => {
  it('redacts a valid Bash case command substitution through its outer close parenthesis', () => {
    const sentinel = 'simple-case-secret-sentinel';
    const command =
      `node runtime --token $(case x in x) printf '%s' ${sentinel};; esac) ` +
      '--verbose --team-name demo';

    const sanitized = sanitizeRuntimeProjectionProcessCommand(command);

    expect(sanitized).toBe('node runtime --token [redacted] --verbose --team-name demo');
    expect(sanitized).not.toContain(sentinel);
  });

  it('redacts a valid nested Bash case/extglob value without leaking its sentinel', () => {
    const sentinel = 'projection-secret-sentinel';
    const command =
      `node runtime --token $(case x in (@(esac|x)) case y in (@(case|y)) ` +
      `printf '%s' ${sentinel};; esac ;;& (@(x)) :;; esac) --verbose --team-name demo`;

    const sanitized = sanitizeRuntimeProjectionProcessCommand(command);

    expect(sanitized).toBe('node runtime --token [redacted] --verbose --team-name demo');
    expect(sanitized).not.toContain(sentinel);
  });

  it.each(['<', '>'])(
    'redacts a %s(...) process-substitution value as one shell word',
    (operator) => {
      const sentinel = `process-substitution-${operator === '<' ? 'input' : 'output'}-sentinel`;
      const command =
        `node runtime --token ${operator}(printf '%s' ${sentinel}) ` + '--verbose --team-name demo';

      const sanitized = sanitizeRuntimeProjectionProcessCommand(command);

      expect(sanitized).toBe('node runtime --token [redacted] --verbose --team-name demo');
      expect(sanitized).not.toContain(sentinel);
    }
  );

  it('fails closed when a heredoc body imitates the end of the secret shell word', () => {
    const sentinel = 'heredoc-body-secret-sentinel';
    const command =
      `node runtime --token "$(cat <<EOF\n)" ${sentinel}\nEOF\n)" ` + '--verbose --team-name demo';

    const sanitized = sanitizeRuntimeProjectionProcessCommand(command);

    expect(sanitized).toBe('node runtime --token [redacted]');
    expect(sanitized).not.toContain(sentinel);
  });

  it('redacts a valid here-string value while preserving safe trailing arguments', () => {
    const sentinel = 'here-string-secret-sentinel';
    const command =
      `node runtime --token "$(cat <<< "${sentinel}")" ` + '--verbose --team-name demo';

    const sanitized = sanitizeRuntimeProjectionProcessCommand(command);

    expect(sanitized).toBe('node runtime --token [redacted] --verbose --team-name demo');
    expect(sanitized).not.toContain(sentinel);
  });

  it('does not consume short or long option boundaries when a secret value is missing', () => {
    expect(sanitizeRuntimeProjectionProcessCommand('node runtime --token -v --safe ok')).toBe(
      'node runtime --token [redacted] -v --safe ok'
    );
    expect(sanitizeRuntimeProjectionProcessCommand('node runtime --token -- --safe ok')).toBe(
      'node runtime --token [redacted] -- --safe ok'
    );
  });

  it('marks terminal secret flags and empty equals forms as redacted', () => {
    expect(sanitizeRuntimeProjectionProcessCommand('node runtime --authorization')).toBe(
      'node runtime --authorization [redacted]'
    );
    expect(sanitizeRuntimeProjectionProcessCommand('node runtime --token=')).toBe(
      'node runtime --token=[redacted]'
    );
  });

  it('does not treat assignments or longer option names as secret flags', () => {
    const command =
      'node runtime tokenization=enabled AUTH=--token --tokenizer=safe --label=AUTH_TOKEN=value';

    expect(sanitizeRuntimeProjectionProcessCommand(command)).toBe(command);
  });

  it('preserves equals and quoted-value behavior', () => {
    expect(
      sanitizeRuntimeProjectionProcessCommand(
        'node runtime --api-key="fixture value" --password secret --safe ok'
      )
    ).toBe('node runtime --api-key=[redacted] --password [redacted] --safe ok');
  });

  it('bounds malformed nesting and oversized benign commands while failing secret values closed', () => {
    const malformed = `node runtime --token $(${'('.repeat(100_000)}sentinel --safe ok`;
    const malformedResult = sanitizeRuntimeProjectionProcessCommand(malformed);

    expect(malformedResult).toBe('node runtime --token [redacted]');
    expect(malformedResult).not.toContain('sentinel');

    const oversizedResult = sanitizeRuntimeProjectionProcessCommand(
      `node runtime ${'x'.repeat(1_000_000)}`
    );
    expect(oversizedResult).toHaveLength(500);
    expect(oversizedResult?.startsWith('node runtime ')).toBe(true);
  });

  it('keeps process-table diagnostics and liveness projection wired to the hardened sanitizer', () => {
    const command = 'node runtime --token wiring-sentinel --team-name demo';
    const expected = 'node runtime --token [redacted] --team-name demo';

    expect(sanitizeProcessCommandForDiagnostics(command)).toBe(expected);
    expect(
      projectRuntimeLiveness({
        process: {
          pid: 4242,
          running: true,
          identityVerified: true,
          pidSource: 'agent_process_table',
          command,
        },
      }).processCommand
    ).toBe(expected);
  });
});
