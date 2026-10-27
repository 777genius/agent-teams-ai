import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const { createController, protocols } = require('../src/index.js');

describe('generated visualization briefing protocol', () => {
  let directory = '';
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  it('includes the identical protocol once in lead/member briefings and supports bounded native composition', async () => {
    directory = mkdtempSync(join(tmpdir(), 'visualization-briefing-test-'));
    const teamDir = join(directory, 'teams', 'sandbox-team');
    mkdirSync(join(teamDir, 'inboxes'), { recursive: true });
    mkdirSync(join(directory, 'tasks', 'sandbox-team'), { recursive: true });
    writeFileSync(
      join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'sandbox-team',
        members: [
          { name: 'lead', role: 'team-lead' },
          { name: 'chart-specialist', role: 'developer' },
        ],
      })
    );
    const controller = createController({ teamName: 'sandbox-team', claudeDir: directory });
    const protocol = protocols.buildChatVisualizationProtocolText();
    for (const text of [
      await controller.taskBoard.leadBriefing(),
      await controller.taskBoard.memberBriefing('chart-specialist'),
    ]) {
      expect(text.endsWith(protocol)).toBe(true);
      expect(text.match(/CHAT VISUALIZATION PROTOCOL v1/g)).toHaveLength(1);
      expect(text).toContain('openui-lang');
      expect(text).toContain(
        'built-in OpenUI rendering in the main chat, group chats, and direct messages'
      );
      expect(text).toContain('No separate OpenUI tool, connector, or service is required');
      expect(text).toContain("this conversation's existing message-delivery path");
      expect(text).toContain("A headless teammate's stdout alone does not deliver a chat message");
      expect(text).toContain('Honor explicit requests for a separate file');
      expect(text).toContain(
        "each openui-lang block's source at or below 32,000 UTF-16 code units (JavaScript string.length)"
      );
      expect(text).toContain(
        'the complete enclosing message, including prose and fences, at or below 60,000 in the same units'
      );
      expect(text).toContain(
        'Longer blocks are rejected; longer messages use a raw preview instead of rendering Markdown'
      );
    }
    const native = await controller.taskBoard.memberBriefing('chart-specialist', {
      includeChatVisualizationProtocol: false,
    });
    expect(native).not.toContain('CHAT VISUALIZATION PROTOCOL');
  });
});
