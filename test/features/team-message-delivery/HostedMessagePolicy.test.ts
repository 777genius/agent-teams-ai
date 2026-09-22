import {
  HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
  parseHostedClientMessageId,
  parseHostedMessageId,
  parseHostedMessageSourceGeneration,
} from '@features/team-message-delivery/contracts/hosted';
import {
  HOSTED_MESSAGE_MAX_TEXT_LENGTH,
  normalizeHostedMessagePersistenceReceipt,
  normalizeHostedTeamMessages,
  parseHostedMessagePageRequest,
  parseSendHostedTeamMessageCommand,
  sanitizeHostedMessageText,
} from '@features/team-message-delivery/core/domain/hostedMessagePolicy';
import { parseCursor, parseTeamId } from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const messageId = parseHostedMessageId(`message_${'b'.repeat(32)}`);
const clientMessageId = parseHostedClientMessageId('client_message_policy-1');
const sourceGeneration = parseHostedMessageSourceGeneration('generation_policy-1');

describe('hostedMessagePolicy', () => {
  it('parses an exact generation-bound page request with opaque values', () => {
    const cursor = parseCursor('cursor_policy-1');
    expect(
      parseHostedMessagePageRequest({
        schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
        teamId,
        cursor,
        expectedSourceGeneration: sourceGeneration,
        limit: 25,
      })
    ).toEqual({
      ok: true,
      value: {
        schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
        teamId,
        cursor,
        expectedSourceGeneration: sourceGeneration,
        limit: 25,
      },
    });
    expect(
      parseHostedMessagePageRequest({
        schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
        teamId,
        cursor: null,
        expectedSourceGeneration: sourceGeneration,
        limit: 25,
      })
    ).toEqual({ ok: false });
    expect(
      parseHostedMessagePageRequest({
        schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
        teamId,
        cursor: null,
        expectedSourceGeneration: null,
        limit: 25,
        projectPath: '/private/project',
      })
    ).toEqual({ ok: false });
  });

  it('accepts only bounded canonical plain text and exact message fields', () => {
    expect(sanitizeHostedMessageText('Hello\nteam')).toBe('Hello\nteam');
    expect(() => sanitizeHostedMessageText(' leading')).toThrow();
    expect(() => sanitizeHostedMessageText('trailing ')).toThrow();
    expect(() => sanitizeHostedMessageText('line\r\nbreak')).toThrow();
    expect(() => sanitizeHostedMessageText('bad\u0000control')).toThrow();
    expect(() => sanitizeHostedMessageText('bad\u009bcontrol')).toThrow();
    expect(() => sanitizeHostedMessageText('bad\u061ccontrol')).toThrow();
    expect(() => sanitizeHostedMessageText('bad\u200econtrol')).toThrow();
    expect(() => sanitizeHostedMessageText('bad\u202econtrol')).toThrow();
    expect(() => sanitizeHostedMessageText('bad\u2066control')).toThrow();
    expect(() =>
      sanitizeHostedMessageText('x'.repeat(HOSTED_MESSAGE_MAX_TEXT_LENGTH + 1))
    ).toThrow();

    const messages = normalizeHostedTeamMessages(
      [
        {
          teamId,
          messageId,
          direction: 'operator',
          text: 'Hello team',
          createdAtMs: 10,
        },
      ],
      teamId
    );
    expect(messages.ok).toBe(true);
    if (messages.ok) {
      expect(messages.value[0]).toEqual({
        teamId,
        messageId,
        direction: 'operator',
        text: 'Hello team',
        createdAtMs: 10,
      });
      expect(Object.isFrozen(messages.value)).toBe(true);
    }
    expect(
      normalizeHostedTeamMessages(
        [
          {
            teamId,
            messageId,
            direction: 'operator',
            text: 'Hello team',
            createdAtMs: 10,
            providerId: 'private',
          },
        ],
        teamId
      )
    ).toEqual({ ok: false });

    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(normalizeHostedTeamMessages(sparse, teamId)).toEqual({ ok: false });
  });

  it('accepts only the simple client-idempotent send command', () => {
    const command = {
      schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
      teamId,
      clientMessageId,
      text: 'Plain text only',
    };
    const parsed = parseSendHostedTeamMessageCommand(command);
    expect(parsed).toEqual({ ok: true, value: command });
    if (parsed.ok) expect(Object.isFrozen(parsed.value)).toBe(true);

    for (const widened of [
      { ...command, recipient: 'member_private' },
      { ...command, authorId: 'member_private' },
      { ...command, attachments: [] },
      { ...command, replyTo: messageId },
    ]) {
      expect(parseSendHostedTeamMessageCommand(widened)).toEqual({ ok: false });
    }
  });

  it('normalizes a matching durable receipt without accepting widened authority data', () => {
    const command = {
      schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
      teamId,
      clientMessageId,
      text: 'Saved message',
    };
    expect(
      normalizeHostedMessagePersistenceReceipt(
        {
          schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
          teamId,
          messageId,
          clientMessageId,
          persistence: 'durable',
        },
        command
      )
    ).toEqual({
      ok: true,
      value: {
        schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
        teamId,
        messageId,
        clientMessageId,
        persistence: 'durable',
      },
    });
    expect(
      normalizeHostedMessagePersistenceReceipt(
        {
          schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
          teamId,
          messageId,
          clientMessageId,
          persistence: 'durable',
          sourcePath: '/private',
        },
        command
      )
    ).toEqual({ ok: false });
  });
});
