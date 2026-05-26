import { SessionContentFilter } from '@main/services/discovery/SessionContentFilter';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import type { ChatHistoryEntry } from '@main/types';

function userEntry(overrides: Partial<ChatHistoryEntry>): ChatHistoryEntry {
  return {
    uuid: 'user-1',
    type: 'user',
    timestamp: '2026-04-12T15:36:14.250Z',
    message: {
      role: 'user',
      content: 'Human: I tested the feature looks good',
    },
    ...overrides,
  } as ChatHistoryEntry;
}

describe('SessionContentFilter', () => {
  describe('hasNonNoiseMessages', () => {
    it('returns false for a file containing only synthetic user replay text', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-content-filter-'));
      try {
        const filePath = path.join(tempDir, 'session.jsonl');
        fs.writeFileSync(
          filePath,
          `${JSON.stringify(
            userEntry({
              isReplay: true,
              isSynthetic: true,
            })
          )}\n`,
          'utf8'
        );

        await expect(SessionContentFilter.hasNonNoiseMessages(filePath)).resolves.toBe(false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('returns true for a file containing ordinary human replay text', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-content-filter-'));
      try {
        const filePath = path.join(tempDir, 'session.jsonl');
        fs.writeFileSync(
          filePath,
          `${JSON.stringify(
            userEntry({
              isReplay: true,
            })
          )}\n`,
          'utf8'
        );

        await expect(SessionContentFilter.hasNonNoiseMessages(filePath)).resolves.toBe(true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('isDisplayableEntry', () => {
    it('does not treat synthetic user text replay as displayable content', () => {
      expect(
        SessionContentFilter.isDisplayableEntry(
          userEntry({
            isReplay: true,
            isSynthetic: true,
          })
        )
      ).toBe(false);
    });

    it('keeps synthetic tool-result rows with sourceToolUseID displayable', () => {
      expect(
        SessionContentFilter.isDisplayableEntry(
          userEntry({
            isMeta: true,
            isReplay: true,
            isSynthetic: true,
            sourceToolUseID: 'tool-1',
          })
        )
      ).toBe(true);
    });

    it('keeps ordinary user text displayable even when it starts with Human', () => {
      expect(
        SessionContentFilter.isDisplayableEntry(
          userEntry({
            isReplay: true,
          })
        )
      ).toBe(true);
    });

    it('does not treat structured synthetic protocol replay as displayable content', () => {
      expect(
        SessionContentFilter.isDisplayableEntry(
          userEntry({
            isReplay: true,
            isSynthetic: true,
            protocolKind: 'teammate-message',
            message: {
              role: 'user',
              content: 'plain protocol payload',
            },
          })
        )
      ).toBe(false);
    });

    it('does not treat structured synthetic protocol rows as displayable content without replay', () => {
      expect(
        SessionContentFilter.isDisplayableEntry(
          userEntry({
            isMeta: true,
            isSynthetic: true,
            protocolKind: 'teammate-message',
            message: {
              role: 'user',
              content: 'plain protocol payload',
            },
          })
        )
      ).toBe(false);
    });

    it('does not treat structured task notifications as displayable human content', () => {
      expect(
        SessionContentFilter.isDisplayableEntry(
          userEntry({
            origin: { kind: 'task-notification' },
            protocolKind: 'task-notification',
            message: {
              role: 'user',
              content: '<task-notification>done</task-notification>',
            },
          })
        )
      ).toBe(false);
    });

    it('keeps non-synthetic teammate protocol rows displayable for attribution', () => {
      expect(
        SessionContentFilter.isDisplayableEntry(
          userEntry({
            protocolKind: 'teammate-message',
            message: {
              role: 'user',
              content:
                '<teammate-message teammate_id="alice">Looks good</teammate-message>',
            },
          })
        )
      ).toBe(true);
    });

    it('keeps synthetic user tool results displayable as AI response flow', () => {
      expect(
        SessionContentFilter.isDisplayableEntry(
          userEntry({
            isMeta: true,
            isSynthetic: true,
            sourceToolUseID: 'tool-1',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-1',
                  content: 'result text',
                },
              ],
            },
          })
        )
      ).toBe(true);
    });

    it('keeps non-replay synthetic meta text displayable as AI response flow', () => {
      expect(
        SessionContentFilter.isDisplayableEntry(
          userEntry({
            isMeta: true,
            isSynthetic: true,
            sourceToolUseID: 'tool-1',
            message: {
              role: 'user',
              content: 'Base directory for this skill: /tmp/skill',
            },
          })
        )
      ).toBe(true);
    });

    it('keeps synthetic replay command output displayable', () => {
      expect(
        SessionContentFilter.isDisplayableEntry(
          userEntry({
            isMeta: true,
            isReplay: true,
            isSynthetic: true,
            message: {
              role: 'user',
              content: '<local-command-stdout>Set model to sonnet</local-command-stdout>',
            },
          })
        )
      ).toBe(true);
    });
  });
});
