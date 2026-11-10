import { describe, expect, it } from 'vitest';

import {
  extractOutputText,
  formatToolOutputForDisplay,
} from '../../../src/renderer/components/chat/items/linkedTool/renderHelpers';

describe('renderHelpers', () => {
  describe('extractOutputText', () => {
    it('should return plain string content as-is', () => {
      expect(extractOutputText('hello world')).toBe('hello world');
    });

    it('should pretty-print string content that is valid JSON', () => {
      const json = '{"name":"test","value":42}';
      expect(extractOutputText(json)).toBe('{\n  "name": "test",\n  "value": 42\n}');
    });

    it('should extract text from content block arrays', () => {
      const content = [{ type: 'text', text: 'hello world' }];
      expect(extractOutputText(content)).toBe('hello world');
    });

    it('should extract and pretty-print JSON from content block arrays', () => {
      const inner = { teams: [{ id: '1', name: 'Test' }] };
      const content = [{ type: 'text', text: JSON.stringify(inner) }];
      expect(extractOutputText(content)).toBe(JSON.stringify(inner, null, 2));
    });

    it('should handle serialized content block arrays (string wrapping content blocks)', () => {
      // This is what SemanticStepExtractor produces when content is an array
      const inner = { teams: [{ id: '1', name: 'Test' }] };
      const contentBlocks = [{ type: 'text', text: JSON.stringify(inner) }];
      const serialized = JSON.stringify(contentBlocks);

      const result = extractOutputText(serialized);
      expect(result).toBe(JSON.stringify(inner, null, 2));
    });

    it('should handle serialized content blocks with plain text', () => {
      const contentBlocks = [{ type: 'text', text: 'Some plain text\nwith newlines' }];
      const serialized = JSON.stringify(contentBlocks);

      const result = extractOutputText(serialized);
      expect(result).toBe('Some plain text\nwith newlines');
    });

    it('should join multiple content blocks with newlines', () => {
      const content = [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ];
      expect(extractOutputText(content)).toBe('first\nsecond');
    });

    it('should stringify non-text content blocks', () => {
      const content = [{ type: 'image', url: 'http://example.com/img.png' }];
      const result = extractOutputText(content);
      expect(result).toContain('"type": "image"');
    });
  });

  describe('formatToolOutputForDisplay', () => {
    it('unwraps Agent Teams task comment responses for display', () => {
      const raw = JSON.stringify({
        agent_teams_task_add_comment_response: {
          comment: {
            attachments: [],
            author: 'bob',
            createdAt: '2026-04-27T20:05:44.248Z',
            id: '40203f1f-44e2-45e0-b6a8-2b812fb7ac12',
            text: 'Создана папка `944` и файл `calculator.js`.',
          },
          taskId: '03561cb3-55d3-46c1-9f06-b928750936a9',
          teamName: 'forge-labs-9',
        },
      });

      const result = formatToolOutputForDisplay('agent-teams_task_add_comment', raw);

      expect(result).toContain('Task comment added');
      expect(result).toContain('Team: forge-labs-9');
      expect(result).toContain('Comment ID: 40203f1f-44e2-45e0-b6a8-2b812fb7ac12');
      expect(result).toContain('Создана папка `944`');
      expect(result).not.toContain('agent_teams_task_add_comment_response');
    });

    it('does not rewrite non Agent Teams JSON output', () => {
      const raw = JSON.stringify({ agent_teams_task_add_comment_response: { ok: true } });

      expect(formatToolOutputForDisplay('bash', raw)).toBe(raw);
    });

    it('keeps Agent Teams error payloads raw for debugging', () => {
      const raw = JSON.stringify({
        agent_teams_task_add_comment_response: {
          error: 'Task not found',
          taskId: 'missing',
        },
      });

      expect(formatToolOutputForDisplay('agent-teams_task_add_comment', raw)).toBe(raw);
    });
  });
});
