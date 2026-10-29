import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

import { McpStdIoClient } from './McpStdIoClient';

it('supplies the embedded protocol and preserves a supplied gallery through real MCP inbox delivery', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'mcp-visualization-protocol-test-'));
  const teamName = 'visualization-sandbox';
  const teamDir = join(sandbox, 'teams', teamName);
  await mkdir(join(teamDir, 'inboxes'), { recursive: true });
  await mkdir(join(sandbox, 'tasks', teamName), { recursive: true });
  await writeFile(
    join(teamDir, 'config.json'),
    JSON.stringify({
      name: teamName,
      members: [
        { name: 'team-lead', agentType: 'team-lead', providerId: 'opencode' },
        { name: 'alice', role: 'developer', providerId: 'opencode' },
      ],
    })
  );
  const client = new McpStdIoClient(
    fileURLToPath(new URL('../dist/index.js', import.meta.url)),
    sandbox,
    ['--transport', 'stdio'],
    { AGENT_TEAMS_MCP_CLAUDE_DIR: sandbox }
  );
  try {
    const initialized = (await client.initialize()) as {
      result?: { protocolVersion?: string };
      error?: unknown;
    };
    expect(initialized.error).toBeUndefined();
    expect(initialized.result?.protocolVersion).toBeTruthy();
    for (const tool of ['lead_briefing', 'member_briefing']) {
      const response = (await client.callTool(tool, {
        claudeDir: sandbox,
        teamName,
        ...(tool === 'member_briefing'
          ? { memberName: 'alice', includeActiveProcesses: false }
          : {}),
      })) as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: unknown };
      expect(response.error).toBeUndefined();
      expect(response.result?.isError).not.toBe(true);
      const briefing = response.result?.content?.[0]?.text ?? '';
      expect(briefing).toContain('CHAT VISUALIZATION PROTOCOL v1');
      expect(briefing).toContain('openui-lang');
      expect(briefing).toContain('Stack(children: Card[])');
      expect(briefing).toContain('built-in OpenUI rendering');
      expect(briefing).toContain('No separate OpenUI tool, connector, or service is required');
      expect(briefing.match(/CHAT VISUALIZATION PROTOCOL v1/g)).toHaveLength(1);
    }

    // Deterministic transport proof, not a live model test. The renderer contract
    // test parses and validates this same complete fixture against the actual UI library.
    const gallery = await readFile(
      new URL('./fixtures/visualization-gallery.openui', import.meta.url),
      'utf8'
    );
    const expectedReplies: Record<string, unknown>[] = [];
    for (const [from, fence] of [
      ['team-lead', 'openui-lang'],
      ['alice', 'openui'],
    ]) {
      const relayOfMessageId = randomUUID();
      await writeFile(
        join(teamDir, 'inboxes', `${from}.json`),
        JSON.stringify([
          {
            messageId: relayOfMessageId,
            from: 'user',
            to: from,
            text: 'Show the supplied gallery here in the chat.',
            timestamp: new Date().toISOString(),
            source: 'user_sent',
            read: false,
          },
        ])
      );
      const text = `Галерея от ${from}.\n\n\`\`\`${fence}\n${gallery.trimEnd()}\n\`\`\`\n\nВсе данные учебные.`;
      const envelope = {
        from,
        to: 'user',
        source: 'runtime_delivery',
        relayOfMessageId,
        text,
        summary: `OpenUI gallery from ${from}`,
      };
      const response = (await client.callTool('message_send', {
        teamName,
        ...envelope,
      })) as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: unknown };
      expect(response.error).toBeUndefined();
      expect(response.result?.isError).not.toBe(true);
      const receipt = JSON.parse(response.result?.content?.[0]?.text ?? '{}') as {
        deliveredToInbox?: boolean;
        messageId?: string;
        message?: Record<string, unknown>;
      };
      expect(receipt.deliveredToInbox).toBe(true);
      expect(receipt.messageId).toBeTruthy();
      expect(receipt.message).toMatchObject(envelope);

      const inbox = JSON.parse(
        await readFile(join(teamDir, 'inboxes', 'user.json'), 'utf8')
      ) as Record<string, unknown>[];
      const persisted = inbox.filter((message) => message.relayOfMessageId === relayOfMessageId);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toEqual(receipt.message);
      expect(persisted[0].text).toBe(text);
      expect(persisted[0].text).not.toContain('<info_for_agent>');
      expectedReplies.push(persisted[0]);
    }
    expect(JSON.parse(await readFile(join(teamDir, 'inboxes', 'user.json'), 'utf8'))).toEqual(
      expectedReplies
    );
  } finally {
    await client.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});
