import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

import type { InboxMessage, TeamConfig } from '../../../src/shared/types/team.ts';

export class Fixtures {
  readonly team = `sentry-inbox-test-${randomUUID().slice(0, 8)}`;
  readonly session = randomUUID();
  readonly leadMessageUuid = randomUUID();
  readonly leadText = 'SENTRY_LEAD_FIXTURE actual persisted lead transcript content';
  readonly bootstrapTimestamp = '2024-12-31T00:00:00.000Z';
  readonly claude: string;
  readonly project: string;
  readonly userData: string;
  readonly inbox: string;
  readonly messages: InboxMessage[] = [];
  readonly root: string;
  constructor(root: string) {
    this.root = root;
    this.claude = path.join(root, 'claude');
    this.project = path.join(root, 'synthetic-project');
    this.userData = path.join(root, 'user-data');
    this.inbox = path.join(this.claude, 'teams', this.team, 'inboxes', 'user.json');
  }
  async prepare() {
    const projectId = this.project.replace(/[^a-zA-Z0-9]/g, '-');
    const teamDirectory = path.dirname(path.dirname(this.inbox));
    await mkdir(path.dirname(this.inbox), { recursive: true });
    await mkdir(path.join(this.claude, 'projects', projectId), { recursive: true });
    await mkdir(path.join(this.claude, 'tasks', this.team), { recursive: true });
    await mkdir(this.project);
    const config: TeamConfig = {
      name: this.team, description: 'Disposable synthetic inbox provenance E2E',
      projectPath: this.project, leadSessionId: this.session,
      members: [
        { name: 'team-lead', agentType: 'team-lead', cwd: this.project, joinedAt: Date.parse(this.bootstrapTimestamp) },
        { name: 'alice', agentType: 'general-purpose', color: 'blue', cwd: this.project, joinedAt: Date.parse(this.bootstrapTimestamp) },
        { name: 'bob', agentType: 'general-purpose', color: 'green', cwd: this.project, joinedAt: Date.parse(this.bootstrapTimestamp) },
      ],
    };
    await writeFile(path.join(teamDirectory, 'config.json'), JSON.stringify(config));
    await writeFile(path.join(teamDirectory, 'sentMessages.json'), JSON.stringify([{
      from: 'user', to: 'bob', text: 'SENTRY_SENT_FIXTURE', read: true,
      messageId: 'sentry-sent-fixture', source: 'user_sent', timestamp: '2025-01-01T00:00:00.000Z',
    } satisfies InboxMessage]));
    await writeFile(path.join(this.claude, 'projects', projectId, `${this.session}.jsonl`), JSON.stringify({
      type: 'assistant', uuid: this.leadMessageUuid, sessionId: this.session, cwd: this.project,
      timestamp: '2025-01-01T00:00:01.000Z', isSidechain: false,
      message: { id: 'sentry-lead-fixture', role: 'assistant', content: [{ type: 'text', text: this.leadText }] },
    }) + '\n');
    await writeFile(path.join(this.claude, 'agent-teams-config.json'), JSON.stringify({
      general: { appLocale: 'en', theme: 'dark', defaultTab: 'dashboard' },
      notifications: { enabled: false, soundEnabled: false },
    }));
    await writeFile(path.join(this.claude, 'CLAUDE.md'), 'Only disposable synthetic test data.\n');
    await writeFile(path.join(this.project, 'CLAUDE.md'), 'Only disposable synthetic test data.\n');
    this.append(130);
    await this.persist();
  }
  append(count: number) {
    const start = this.messages.length;
    for (let index = start; index < start + count; index++) {
      const from = index >= 20 && index < 70 ? 'alice' : 'bob';
      this.messages.push({
        from, to: 'user', text: `SENTRY_${from.toUpperCase()}_${index.toString().padStart(4, '0')}`,
        messageId: `sentry-inbox-${index.toString().padStart(4, '0')}`, read: true,
        // Intentional identical timestamps. Independently check deterministic ID order.
        timestamp: new Date(Date.parse('2025-01-02T00:00:00.000Z') + Math.floor(index / 2) * 1000).toISOString(),
        ...(index === 120 ? { taskRefs: [{ taskId: 'fixture-task', displayId: '42', teamName: this.team }] } : {}),
      });
    }
  }
  async persist() {
    const temporary = `${this.inbox}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.messages));
    await rename(temporary, this.inbox);
  }
  rewriteAlice() {
    const message = this.messages[69];
    if (!message) throw new Error('Expected synthetic Alice message');
    message.text = 'SENTRY_ALICE_REWRITTEN_0069';
  }
  expectedFeedIds() {
    // Independent fixture expectations include actual main-generated bootstrap
    // rows. Their explicit join time is before all durable message sources.
    const nonInbox = [
      { messageId: `bootstrap-start:${this.team}:alice`, timestamp: this.bootstrapTimestamp },
      { messageId: `bootstrap-start:${this.team}:bob`, timestamp: this.bootstrapTimestamp },
      { messageId: 'sentry-sent-fixture', timestamp: '2025-01-01T00:00:00.000Z' },
      { messageId: `lead-thought-${this.leadMessageUuid}`, timestamp: '2025-01-01T00:00:01.000Z' },
    ];
    return [...this.messages, ...nonInbox].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) ||
      (a.messageId ?? '').localeCompare(b.messageId ?? '')).map(message => message.messageId);
  }
  expectedHeadIds() { return this.expectedFeedIds().slice(0, 50); }
}
