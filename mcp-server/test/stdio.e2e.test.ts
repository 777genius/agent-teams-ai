import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

function parseJsonToolResult(result: unknown) {
  const response = result as {
    content?: Array<{ text?: string }>;
    isError?: boolean;
  };
  const text = response.content?.[0]?.text;
  if (response.isError) {
    throw new Error(text ?? 'Tool returned an unspecified error');
  }
  return JSON.parse(text ?? 'null');
}

type TestTeamMember = Record<string, unknown>;

async function writeTeamConfig(
  claudeDir: string,
  teamName: string,
  members: TestTeamMember[] = [
    { name: 'team-lead', agentType: 'team-lead' },
    { name: 'alice', agentType: 'teammate', role: 'developer' },
    { name: 'bob', agentType: 'teammate', role: 'reviewer' },
  ]
) {
  const teamDir = path.join(claudeDir, 'teams', teamName);
  await mkdir(teamDir, { recursive: true });
  await writeFile(
    path.join(teamDir, 'config.json'),
    JSON.stringify(
      {
        name: teamName,
        members,
      },
      null,
      2
    ),
    'utf8'
  );
}

async function startControlServer(
  handler: (request: {
    method?: string;
    url?: string;
    body?: unknown;
  }) => Promise<{ statusCode?: number; body: unknown }> | { statusCode?: number; body: unknown }
) {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        const body = bodyText ? JSON.parse(bodyText) : undefined;
        const result = await handler({ method: req.method, url: req.url, body });
        res.writeHead(result.statusCode ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result.body));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind control server');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}

async function writeBulkTaskRows(claudeDir: string, teamName: string, count: number) {
  const tasksDir = path.join(claudeDir, 'tasks', teamName);
  await mkdir(tasksDir, { recursive: true });

  await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const ordinal = String(index + 1).padStart(3, '0');
      const id = `bulk-${ordinal}`;
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      await writeFile(
        path.join(tasksDir, `${id}.json`),
        JSON.stringify(
          {
            id,
            displayId: id,
            subject: `Bulk inventory task ${ordinal}`,
            description: `Large description that must not be returned in task_list row ${ordinal}`,
            owner: index % 2 === 0 ? 'alice' : 'bob',
            status: index % 3 === 0 ? 'completed' : 'pending',
            reviewState: 'none',
            commentCount: 99,
            comments: [
              {
                id: `comment-${ordinal}`,
                author: 'alice',
                text: 'Large comment that must not be returned in task_list rows',
              },
            ],
            historyEvents: [{ type: 'task_created', status: 'pending', timestamp }],
            workIntervals: [{ startedAt: timestamp }],
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          null,
          2
        ),
        'utf8'
      );
    })
  );
}

async function writeInventoryTaskRow(
  claudeDir: string,
  teamName: string,
  task: {
    id: string;
    owner: string;
    subject: string;
    status?: 'pending' | 'in_progress' | 'completed' | 'deleted';
    createdAt: string;
  }
) {
  const tasksDir = path.join(claudeDir, 'tasks', teamName);
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    path.join(tasksDir, `${task.id}.json`),
    JSON.stringify(
      {
        id: task.id,
        displayId: task.id,
        subject: task.subject,
        description: `Drill-down description for ${task.subject}`,
        owner: task.owner,
        status: task.status ?? 'pending',
        reviewState: 'none',
        comments: [],
        historyEvents: [{ type: 'task_created', status: task.status ?? 'pending', timestamp: task.createdAt }],
        createdAt: task.createdAt,
        updatedAt: task.createdAt,
      },
      null,
      2
    ),
    'utf8'
  );
}

class McpStdIoClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private stdoutBuffer = '';

  constructor(serverPath: string, cwd: string) {
    this.child = spawn('node', [serverPath], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
    });
  }

  async initialize() {
    const response = await this.request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vitest-e2e', version: '1.0.0' },
    });

    this.notify('notifications/initialized');
    return response;
  }

  async listTools() {
    return this.request(2, 'tools/list', {});
  }

  async callTool(name: string, args: Record<string, unknown>, id = 3) {
    return this.request(id, 'tools/call', { name, arguments: args });
  }

  async close() {
    this.child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      this.child.once('exit', () => resolve());
      setTimeout(() => resolve(), 1000).unref();
    });
  }

  private notify(method: string, params?: Record<string, unknown>) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
  }

  private async request(id: number, method: string, params: Record<string, unknown>) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return this.readMessage(id);
  }

  private async readMessage(expectedId: number) {
    const deadline = Date.now() + 15000;

    while (Date.now() < deadline) {
      const newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

        if (!line) {
          continue;
        }

        const parsed = JSON.parse(line) as { id?: number };
        if (parsed.id === expectedId) {
          return parsed;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error(`Timed out waiting for MCP response ${expectedId}`);
  }
}

describe('agent-teams-mcp stdio e2e', () => {
  const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

  let claudeDir: string;

  beforeEach(async () => {
    claudeDir = await mkdtemp(path.join(os.tmpdir(), 'agent-teams-mcp-e2e-'));
  });

  afterEach(async () => {
    await rm(claudeDir, { recursive: true, force: true });
  });

  it('boots over stdio, lists task tools, and executes task lifecycle calls', async () => {
    await writeTeamConfig(claudeDir, 'e2e-team');
    const client = new McpStdIoClient(serverPath, workspaceRoot);

    try {
      const init = await client.initialize();
      expect(init).toHaveProperty('result');

      const tools = (await client.listTools()) as {
        result?: { tools?: Array<{ name: string; description?: string }> };
      };
      const registeredTools = tools.result?.tools ?? [];
      const toolNames = registeredTools.map((tool) => tool.name);
      const taskListTool = registeredTools.find((tool) => tool.name === 'task_list');

      expect(toolNames).toContain('task_create');
      expect(toolNames).toContain('task_start');
      expect(toolNames).toContain('task_briefing');
      expect(toolNames).toContain('member_briefing');
      expect(toolNames).toContain('review_approve');
      expect(toolNames).toContain('lead_briefing');
      expect(taskListTool?.description).toContain(
        'Use it to browse, filter, and drill into inventory, not as a primary working queue.'
      );
      expect(taskListTool?.description).toContain('Deleted tasks are excluded.');

      const createResult = await client.callTool(
        'task_create',
        {
          claudeDir,
          teamName: 'e2e-team',
          subject: 'Smoke task',
          owner: 'alice',
          description: 'Smoke task description',
        },
        3
      );
      const createdTask = parseJsonToolResult((createResult as { result: unknown }).result);

      expect(createdTask.subject).toBe('Smoke task');
      expect(createdTask.owner).toBe('alice');
      expect(typeof createdTask.id).toBe('string');

      const startResult = await client.callTool(
        'task_start',
        {
          claudeDir,
          teamName: 'e2e-team',
          taskId: createdTask.id,
          actor: 'alice',
        },
        4
      );
      const startedTask = parseJsonToolResult((startResult as { result: unknown }).result);

      expect(startedTask.status).toBe('in_progress');
      expect(startedTask.id).toBe(createdTask.id);

      const commentResult = await client.callTool(
        'task_add_comment',
        {
          claudeDir,
          teamName: 'e2e-team',
          taskId: createdTask.id,
          text: 'Working through the smoke task.',
          from: 'alice',
        },
        5
      );
      const commentPayload = parseJsonToolResult((commentResult as { result: unknown }).result);
      expect(commentPayload.task.id).toBe(createdTask.id);
      expect(commentPayload.comment.text).toBe('Working through the smoke task.');

      const reviewCreateResult = await client.callTool(
        'task_create',
        {
          claudeDir,
          teamName: 'e2e-team',
          subject: 'Review task',
          owner: 'alice',
        },
        6
      );
      const reviewTask = parseJsonToolResult((reviewCreateResult as { result: unknown }).result);

      const completeResult = await client.callTool(
        'task_complete',
        {
          claudeDir,
          teamName: 'e2e-team',
          taskId: reviewTask.id,
          actor: 'alice',
        },
        7
      );
      const completedTask = parseJsonToolResult((completeResult as { result: unknown }).result);
      expect(completedTask.status).toBe('completed');

      const reviewRequestResult = await client.callTool(
        'review_request',
        {
          claudeDir,
          teamName: 'e2e-team',
          taskId: reviewTask.id,
          from: 'team-lead',
          reviewer: 'bob',
        },
        8
      );
      const reviewRequestedTask = parseJsonToolResult(
        (reviewRequestResult as { result: unknown }).result
      );
      expect(reviewRequestedTask.reviewState).toBe('review');

      const unassignedCreateResult = await client.callTool(
        'task_create',
        {
          claudeDir,
          teamName: 'e2e-team',
          subject: 'Needs owner assignment',
        },
        9
      );
      const unassignedTask = parseJsonToolResult(
        (unassignedCreateResult as { result: unknown }).result
      );
      expect(unassignedTask.owner).toBeUndefined();

      const taskBriefingResult = await client.callTool(
        'task_briefing',
        {
          claudeDir,
          teamName: 'e2e-team',
          memberName: 'alice',
        },
        10
      );
      const taskBriefingText = (
        ((taskBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(taskBriefingText).toContain('Task briefing for alice:');
      expect(taskBriefingText).toContain(
        'Primary queue for alice. Act only on Actionable items. Awareness items are watch-only context unless the lead reroutes the task or you become the actionOwner.'
      );
      expect(taskBriefingText).toContain(
        'Use task_list only to search/browse inventory rows, not as your working queue.'
      );
      expect(taskBriefingText).toContain('Actionable:');
      expect(taskBriefingText).toContain(`#${createdTask.displayId}`);
      expect(taskBriefingText).toContain('reason=owner_executing');
      expect(taskBriefingText).toContain('Description: Smoke task description');
      expect(taskBriefingText).toContain('Working through the smoke task.');
      expect(taskBriefingText).toContain('Awareness:');
      expect(taskBriefingText).toContain(`#${reviewTask.displayId}`);

      const memberBriefingResult = await client.callTool(
        'member_briefing',
        {
          claudeDir,
          teamName: 'e2e-team',
          memberName: 'alice',
        },
        11
      );
      const memberBriefingText = (
        ((memberBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(memberBriefingText).toContain(
        'Use task_briefing as your primary working queue whenever you need to see assigned work.'
      );
      expect(memberBriefingText).toContain(
        'Use task_list only to search/browse inventory rows, not as your working queue.'
      );
      expect(memberBriefingText).toContain(
        'Awareness items are watch-only context and do not authorize you to start work unless the lead reroutes the task or you become the actionOwner.'
      );

      const reviewerTaskBriefingResult = await client.callTool(
        'task_briefing',
        {
          claudeDir,
          teamName: 'e2e-team',
          memberName: 'bob',
        },
        12
      );
      const reviewerTaskBriefingText = (
        ((reviewerTaskBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(reviewerTaskBriefingText).toContain('Task briefing for bob:');
      expect(reviewerTaskBriefingText).toContain('Actionable:');
      expect(reviewerTaskBriefingText).toContain(`#${reviewTask.displayId}`);
      expect(reviewerTaskBriefingText).toContain('reviewer=bob');
      expect(reviewerTaskBriefingText).toContain('reason=review_requested_waiting_pickup');

      const leadBriefingResult = await client.callTool(
        'lead_briefing',
        {
          claudeDir,
          teamName: 'e2e-team',
        },
        13
      );
      const leadBriefingText = (
        ((leadBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(leadBriefingText).toContain('Lead queue for team-lead on team "e2e-team":');
      expect(leadBriefingText).toContain(
        'Primary lead queue. Sections below already represent lead-owned actions or watch-only context.'
      );
      expect(leadBriefingText).toContain(
        'Use task_list only for search, filtering, and drill-down inventory lookups.'
      );
      expect(leadBriefingText).toContain('Needs owner assignment:');
      expect(leadBriefingText).toContain(`#${unassignedTask.displayId}`);
      expect(leadBriefingText).toContain('reason=owner_missing');
      expect(leadBriefingText).toContain('Watching:');
      expect(leadBriefingText).toContain(`#${reviewTask.displayId}`);

      const inventoryResult = await client.callTool(
        'task_list',
        {
          claudeDir,
          teamName: 'e2e-team',
        },
        14
      );
      const inventoryRows = parseJsonToolResult((inventoryResult as { result: unknown }).result);
      const reviewInventoryRow = inventoryRows.find(
        (row: { id: string }) => row.id === reviewTask.id
      ) as Record<string, unknown> | undefined;
      const unassignedInventoryRow = inventoryRows.find(
        (row: { id: string }) => row.id === unassignedTask.id
      ) as Record<string, unknown> | undefined;
      expect(reviewInventoryRow).toMatchObject({
        id: reviewTask.id,
        subject: 'Review task',
        owner: 'alice',
        status: 'completed',
        reviewState: 'review',
      });
      expect(reviewInventoryRow?.description).toBeUndefined();
      expect(reviewInventoryRow?.comments).toBeUndefined();
      expect(reviewInventoryRow?.historyEvents).toBeUndefined();
      expect(reviewInventoryRow?.workIntervals).toBeUndefined();
      expect(unassignedInventoryRow).toMatchObject({
        id: unassignedTask.id,
        subject: 'Needs owner assignment',
        status: 'pending',
        reviewState: 'none',
      });
      expect(unassignedInventoryRow?.owner).toBeUndefined();

      const filteredListResult = await client.callTool(
        'task_list',
        {
          claudeDir,
          teamName: 'e2e-team',
          reviewState: 'review',
          kanbanColumn: 'review',
        },
        15
      );
      const filteredTasks = parseJsonToolResult((filteredListResult as { result: unknown }).result);
      expect(filteredTasks).toHaveLength(1);
      expect(filteredTasks[0]).toMatchObject({
        id: reviewTask.id,
        status: 'completed',
        reviewState: 'review',
        owner: 'alice',
      });
    } finally {
      await client.close();
    }
  });

  it('fails closed for primary queue and inventory tools when team config is missing over stdio', async () => {
    const client = new McpStdIoClient(serverPath, workspaceRoot);
    const expected =
      'Unknown team "team-lead". Board tools require an existing configured team with config.json.';

    try {
      await client.initialize();

      const leadBriefing = (await client.callTool(
        'lead_briefing',
        {
          claudeDir,
          teamName: 'team-lead',
        },
        40
      )) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
      expect(leadBriefing.result?.isError).toBe(true);
      expect(leadBriefing.result?.content?.[0]?.text).toContain(expected);

      const taskBriefing = (await client.callTool(
        'task_briefing',
        {
          claudeDir,
          teamName: 'team-lead',
          memberName: 'alice',
        },
        41
      )) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
      expect(taskBriefing.result?.isError).toBe(true);
      expect(taskBriefing.result?.content?.[0]?.text).toContain(expected);

      const taskList = (await client.callTool(
        'task_list',
        {
          claudeDir,
          teamName: 'team-lead',
        },
        42
      )) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
      expect(taskList.result?.isError).toBe(true);
      expect(taskList.result?.content?.[0]?.text).toContain(expected);
    } finally {
      await client.close();
    }
  });

  it('caps high-volume task_list inventory over stdio and keeps rows compact', async () => {
    await writeTeamConfig(claudeDir, 'bulk-inventory-team');
    await writeBulkTaskRows(claudeDir, 'bulk-inventory-team', 225);
    const client = new McpStdIoClient(serverPath, workspaceRoot);

    try {
      await client.initialize();

      const tools = (await client.listTools()) as {
        result?: { tools?: Array<{ name: string; description?: string }> };
      };
      const taskListTool = tools.result?.tools?.find((tool) => tool.name === 'task_list');
      expect(taskListTool?.description).toContain('Defaults to 50 rows and caps at 200 rows');

      const defaultInventoryResult = await client.callTool(
        'task_list',
        {
          claudeDir,
          teamName: 'bulk-inventory-team',
        },
        21
      );
      const defaultRows = parseJsonToolResult(
        (defaultInventoryResult as { result: unknown }).result
      ) as Array<Record<string, unknown>>;
      expect(defaultRows).toHaveLength(50);
      for (const row of defaultRows) {
        expect(row.description).toBeUndefined();
        expect(row.comments).toBeUndefined();
        expect(row.historyEvents).toBeUndefined();
        expect(row.workIntervals).toBeUndefined();
        expect(row.commentCount).toBe(1);
      }

      const drillDownResult = await client.callTool(
        'task_get',
        {
          claudeDir,
          teamName: 'bulk-inventory-team',
          taskId: defaultRows[0].id,
        },
        21_1
      );
      const drillDownTask = parseJsonToolResult(
        (drillDownResult as { result: unknown }).result
      ) as Record<string, unknown>;
      expect(drillDownTask.id).toBe(defaultRows[0].id);
      expect(drillDownTask.description).toContain('Large description that must not be returned');
      expect(drillDownTask.comments).toHaveLength(1);
      expect(drillDownTask.historyEvents).toHaveLength(1);
      expect(drillDownTask.workIntervals).toHaveLength(1);

      const smallLimitResult = await client.callTool(
        'task_list',
        {
          claudeDir,
          teamName: 'bulk-inventory-team',
          limit: 7,
        },
        22
      );
      const smallLimitRows = parseJsonToolResult(
        (smallLimitResult as { result: unknown }).result
      ) as Array<Record<string, unknown>>;
      expect(smallLimitRows).toHaveLength(7);

      const filteredLimitResult = await client.callTool(
        'task_list',
        {
          claudeDir,
          teamName: 'bulk-inventory-team',
          owner: 'bob',
          limit: 5,
        },
        23
      );
      const filteredLimitRows = parseJsonToolResult(
        (filteredLimitResult as { result: unknown }).result
      ) as Array<Record<string, unknown>>;
      expect(filteredLimitRows).toHaveLength(5);
      expect(filteredLimitRows.every((row) => row.owner === 'bob')).toBe(true);

      const overLimitResult = await client.callTool(
        'task_list',
        {
          claudeDir,
          teamName: 'bulk-inventory-team',
          limit: 999,
        },
        24
      );
      const overLimitRows = parseJsonToolResult(
        (overLimitResult as { result: unknown }).result
      ) as Array<Record<string, unknown>>;
      expect(overLimitRows).toHaveLength(200);
    } finally {
      await client.close();
    }
  });

  it('applies task_list filters before default caps over stdio', async () => {
    await writeTeamConfig(claudeDir, 'filter-before-cap-team');

    for (let index = 0; index < 60; index += 1) {
      const ordinal = String(index + 1).padStart(3, '0');
      await writeInventoryTaskRow(claudeDir, 'filter-before-cap-team', {
        id: `new-alice-${ordinal}`,
        owner: 'alice',
        subject: `New alice task ${ordinal}`,
        createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString(),
      });
    }

    for (let index = 0; index < 3; index += 1) {
      const ordinal = String(index + 1).padStart(3, '0');
      await writeInventoryTaskRow(claudeDir, 'filter-before-cap-team', {
        id: `old-bob-${ordinal}`,
        owner: 'bob',
        subject: `Old bob task ${ordinal}`,
        createdAt: new Date(Date.UTC(2025, 11, 31, 0, 0, index)).toISOString(),
      });
    }

    const client = new McpStdIoClient(serverPath, workspaceRoot);

    try {
      await client.initialize();

      const defaultInventoryResult = await client.callTool(
        'task_list',
        {
          claudeDir,
          teamName: 'filter-before-cap-team',
        },
        31
      );
      const defaultRows = parseJsonToolResult(
        (defaultInventoryResult as { result: unknown }).result
      ) as Array<Record<string, unknown>>;
      expect(defaultRows).toHaveLength(50);
      expect(defaultRows.some((row) => row.owner === 'bob')).toBe(false);

      const filteredInventoryResult = await client.callTool(
        'task_list',
        {
          claudeDir,
          teamName: 'filter-before-cap-team',
          owner: 'bob',
        },
        32
      );
      const filteredRows = parseJsonToolResult(
        (filteredInventoryResult as { result: unknown }).result
      ) as Array<Record<string, unknown>>;
      expect(filteredRows).toHaveLength(3);
      expect(filteredRows.map((row) => row.id).sort()).toEqual([
        'old-bob-001',
        'old-bob-002',
        'old-bob-003',
      ]);
      expect(filteredRows.every((row) => row.owner === 'bob')).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('keeps task_list as active inventory and leaves deleted drill-down to task_get over stdio', async () => {
    await writeTeamConfig(claudeDir, 'deleted-inventory-team');
    const client = new McpStdIoClient(serverPath, workspaceRoot);

    try {
      await client.initialize();

      const tools = (await client.listTools()) as {
        result?: { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
      };
      const taskListTool = tools.result?.tools?.find((tool) => tool.name === 'task_list');
      expect(taskListTool?.description).toContain('Deleted tasks are excluded.');
      expect(JSON.stringify(taskListTool?.inputSchema)).toContain('"pending"');
      expect(JSON.stringify(taskListTool?.inputSchema)).toContain('"in_progress"');
      expect(JSON.stringify(taskListTool?.inputSchema)).toContain('"completed"');
      expect(JSON.stringify(taskListTool?.inputSchema)).not.toContain('"deleted"');

      const deletedStatusListResult = (await client.callTool(
        'task_list',
        {
          claudeDir,
          teamName: 'deleted-inventory-team',
          status: 'deleted',
        },
        40
      )) as { error?: { code?: number; message?: string } };
      expect(deletedStatusListResult.error?.code).toBe(-32602);
      expect(deletedStatusListResult.error?.message).toContain(
        'expected one of "pending"|"in_progress"|"completed"'
      );

      const createResult = await client.callTool(
        'task_create',
        {
          claudeDir,
          teamName: 'deleted-inventory-team',
          subject: 'Deleted task should not be inventory',
          owner: 'alice',
        },
        41
      );
      const task = parseJsonToolResult((createResult as { result: unknown }).result);

      await client.callTool(
        'task_set_status',
        {
          claudeDir,
          teamName: 'deleted-inventory-team',
          taskId: task.id,
          status: 'deleted',
          actor: 'alice',
        },
        42
      );

      const inventoryResult = await client.callTool(
        'task_list',
        {
          claudeDir,
          teamName: 'deleted-inventory-team',
          owner: 'alice',
        },
        43
      );
      const inventoryRows = parseJsonToolResult(
        (inventoryResult as { result: unknown }).result
      ) as Array<Record<string, unknown>>;
      expect(inventoryRows.find((row) => row.id === task.id)).toBeUndefined();

      const drillDownResult = await client.callTool(
        'task_get',
        {
          claudeDir,
          teamName: 'deleted-inventory-team',
          taskId: task.id,
        },
        44
      );
      const drillDownTask = parseJsonToolResult(
        (drillDownResult as { result: unknown }).result
      ) as Record<string, unknown>;
      expect(drillDownTask.id).toBe(task.id);
      expect(drillDownTask.status).toBe('deleted');
      expect(drillDownTask.deletedAt).toEqual(expect.any(String));
    } finally {
      await client.close();
    }
  });

  it('preserves legacy kanban reviewer fallback over stdio for old boards without review history reviewer', async () => {
    await writeTeamConfig(claudeDir, 'legacy-review-team');
    const client = new McpStdIoClient(serverPath, workspaceRoot);

    try {
      await client.initialize();

      const createResult = await client.callTool(
        'task_create',
        {
          claudeDir,
          teamName: 'legacy-review-team',
          subject: 'Legacy review fallback',
          owner: 'alice',
        },
        21
      );
      const createdTask = parseJsonToolResult((createResult as { result: unknown }).result);

      const completeResult = await client.callTool(
        'task_complete',
        {
          claudeDir,
          teamName: 'legacy-review-team',
          taskId: createdTask.id,
          actor: 'alice',
        },
        22
      );
      const completedTask = parseJsonToolResult((completeResult as { result: unknown }).result);
      expect(completedTask.status).toBe('completed');

      const taskPath = path.join(claudeDir, 'tasks', 'legacy-review-team', `${createdTask.id}.json`);
      const persistedTask = JSON.parse(await readFile(taskPath, 'utf8')) as {
        reviewState?: string;
        historyEvents?: Array<Record<string, unknown>>;
      };
      persistedTask.reviewState = 'review';
      persistedTask.historyEvents = (Array.isArray(persistedTask.historyEvents)
        ? persistedTask.historyEvents
        : []
      ).filter(
        (event) =>
          event.type !== 'review_requested' &&
          event.type !== 'review_started' &&
          event.type !== 'review_approved' &&
          event.type !== 'review_changes_requested'
      );
      await writeFile(taskPath, JSON.stringify(persistedTask, null, 2), 'utf8');

      const kanbanPath = path.join(claudeDir, 'teams', 'legacy-review-team', 'kanban-state.json');
      await writeFile(
        kanbanPath,
        JSON.stringify(
          {
            teamName: 'legacy-review-team',
            reviewers: [],
            tasks: {
              [createdTask.id]: {
                column: 'review',
                reviewer: 'bob',
                movedAt: '2026-01-01T00:00:00.000Z',
              },
            },
            columnOrder: {
              review: [createdTask.id],
            },
          },
          null,
          2
        ),
        'utf8'
      );

      const reviewerBriefingResult = await client.callTool(
        'task_briefing',
        {
          claudeDir,
          teamName: 'legacy-review-team',
          memberName: 'bob',
        },
        23
      );
      const reviewerBriefingText = (
        ((reviewerBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(reviewerBriefingText).toContain('Task briefing for bob:');
      expect(reviewerBriefingText).toContain('Actionable:');
      expect(reviewerBriefingText).toContain(`#${createdTask.displayId}`);
      expect(reviewerBriefingText).toContain('reviewer=bob');
      expect(reviewerBriefingText).not.toContain('review_reviewer_missing');

      const leadBriefingResult = await client.callTool(
        'lead_briefing',
        {
          claudeDir,
          teamName: 'legacy-review-team',
        },
        24
      );
      const leadBriefingText = (
        ((leadBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(leadBriefingText).toContain('Lead queue for team-lead on team "legacy-review-team":');
      expect(leadBriefingText).toContain('Watching:');
      expect(leadBriefingText).toContain(`#${createdTask.displayId}`);
      expect(leadBriefingText).not.toContain('review_reviewer_missing');

      const inventoryResult = await client.callTool(
        'task_list',
        {
          claudeDir,
          teamName: 'legacy-review-team',
          reviewState: 'review',
          kanbanColumn: 'review',
        },
        25
      );
      const inventoryRows = parseJsonToolResult((inventoryResult as { result: unknown }).result);
      expect(inventoryRows).toHaveLength(1);
      expect(inventoryRows[0]).toMatchObject({
        id: createdTask.id,
        owner: 'alice',
        reviewState: 'review',
        status: 'completed',
      });
    } finally {
      await client.close();
    }
  });

  it('surfaces reviewer-assignment gaps and needs-fix review roundtrip over stdio', async () => {
    await writeTeamConfig(claudeDir, 'review-roundtrip-team');
    const client = new McpStdIoClient(serverPath, workspaceRoot);

    try {
      await client.initialize();

      const noReviewerCreateResult = await client.callTool(
        'task_create',
        {
          claudeDir,
          teamName: 'review-roundtrip-team',
          subject: 'Needs reviewer assignment',
          owner: 'alice',
        },
        31
      );
      const noReviewerTask = parseJsonToolResult(
        (noReviewerCreateResult as { result: unknown }).result
      );

      await client.callTool(
        'task_complete',
        {
          claudeDir,
          teamName: 'review-roundtrip-team',
          taskId: noReviewerTask.id,
          actor: 'alice',
        },
        32
      );

      const noReviewerRequestResult = await client.callTool(
        'review_request',
        {
          claudeDir,
          teamName: 'review-roundtrip-team',
          taskId: noReviewerTask.id,
          from: 'team-lead',
        },
        33
      );
      const noReviewerRequestedTask = parseJsonToolResult(
        (noReviewerRequestResult as { result: unknown }).result
      );
      expect(noReviewerRequestedTask.reviewState).toBe('review');

      const leadAssignmentBriefingResult = await client.callTool(
        'lead_briefing',
        {
          claudeDir,
          teamName: 'review-roundtrip-team',
        },
        34
      );
      const leadAssignmentBriefingText = (
        ((leadAssignmentBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(leadAssignmentBriefingText).toContain('Needs reviewer assignment:');
      expect(leadAssignmentBriefingText).toContain(`#${noReviewerTask.displayId}`);
      expect(leadAssignmentBriefingText).toContain('reason=review_reviewer_missing');

      const reviewerEmptyBriefingResult = await client.callTool(
        'task_briefing',
        {
          claudeDir,
          teamName: 'review-roundtrip-team',
          memberName: 'bob',
        },
        35
      );
      const reviewerEmptyBriefingText = (
        ((reviewerEmptyBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(reviewerEmptyBriefingText).toContain('No actionable or awareness tasks for bob.');
      expect(reviewerEmptyBriefingText).not.toContain(`#${noReviewerTask.displayId}`);

      const roundtripCreateResult = await client.callTool(
        'task_create',
        {
          claudeDir,
          teamName: 'review-roundtrip-team',
          subject: 'Needs fixes after review',
          owner: 'alice',
          description: 'Roundtrip description',
        },
        36
      );
      const roundtripTask = parseJsonToolResult((roundtripCreateResult as { result: unknown }).result);

      await client.callTool(
        'task_complete',
        {
          claudeDir,
          teamName: 'review-roundtrip-team',
          taskId: roundtripTask.id,
          actor: 'alice',
        },
        37
      );

      await client.callTool(
        'review_request',
        {
          claudeDir,
          teamName: 'review-roundtrip-team',
          taskId: roundtripTask.id,
          from: 'team-lead',
          reviewer: 'bob',
        },
        38
      );

      await client.callTool(
        'review_start',
        {
          claudeDir,
          teamName: 'review-roundtrip-team',
          taskId: roundtripTask.id,
        },
        39
      );

      const reviewerActiveBriefingResult = await client.callTool(
        'task_briefing',
        {
          claudeDir,
          teamName: 'review-roundtrip-team',
          memberName: 'bob',
        },
        40
      );
      const reviewerActiveBriefingText = (
        ((reviewerActiveBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(reviewerActiveBriefingText).toContain(`#${roundtripTask.displayId}`);
      expect(reviewerActiveBriefingText).toContain('reason=review_in_progress');
      expect(reviewerActiveBriefingText).toContain('reviewer=bob');

      const changesResult = await client.callTool(
        'review_request_changes',
        {
          claudeDir,
          teamName: 'review-roundtrip-team',
          taskId: roundtripTask.id,
          from: 'bob',
          comment: 'Please fix the failing edge case.',
        },
        41
      );
      const changedTask = parseJsonToolResult((changesResult as { result: unknown }).result);
      expect(changedTask.status).toBe('pending');
      expect(changedTask.reviewState).toBe('needsFix');

      const ownerNeedsFixBriefingResult = await client.callTool(
        'task_briefing',
        {
          claudeDir,
          teamName: 'review-roundtrip-team',
          memberName: 'alice',
        },
        42
      );
      const ownerNeedsFixBriefingText = (
        ((ownerNeedsFixBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(ownerNeedsFixBriefingText).toContain(`#${roundtripTask.displayId}`);
      expect(ownerNeedsFixBriefingText).toContain('Actionable:');
      expect(ownerNeedsFixBriefingText).toContain('reason=needs_fix');
      expect(ownerNeedsFixBriefingText).toContain('Description: Roundtrip description');
      expect(ownerNeedsFixBriefingText).toContain('Please fix the failing edge case.');

      const needsFixInventoryResult = await client.callTool(
        'task_list',
        {
          claudeDir,
          teamName: 'review-roundtrip-team',
          owner: 'alice',
          reviewState: 'needsFix',
          status: 'pending',
        },
        43
      );
      const needsFixInventoryRows = parseJsonToolResult(
        (needsFixInventoryResult as { result: unknown }).result
      );
      expect(needsFixInventoryRows).toHaveLength(1);
      expect(needsFixInventoryRows[0]).toMatchObject({
        id: roundtripTask.id,
        owner: 'alice',
        reviewState: 'needsFix',
        status: 'pending',
      });

      const finalLeadBriefingResult = await client.callTool(
        'lead_briefing',
        {
          claudeDir,
          teamName: 'review-roundtrip-team',
        },
        44
      );
      const finalLeadBriefingText = (
        ((finalLeadBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(finalLeadBriefingText).toContain(`#${noReviewerTask.displayId}`);
      expect(finalLeadBriefingText).not.toContain(`#${roundtripTask.displayId}`);
    } finally {
      await client.close();
    }
  });

  it('surfaces self-review invalid as lead-owned and supports relationship inventory filters over stdio', async () => {
    await writeTeamConfig(claudeDir, 'inventory-filters-team');
    const client = new McpStdIoClient(serverPath, workspaceRoot);

    try {
      await client.initialize();

      const baseCreateResult = await client.callTool(
        'task_create',
        {
          claudeDir,
          teamName: 'inventory-filters-team',
          subject: 'Base task',
          owner: 'alice',
        },
        51
      );
      const baseTask = parseJsonToolResult((baseCreateResult as { result: unknown }).result);

      const blockedCreateResult = await client.callTool(
        'task_create',
        {
          claudeDir,
          teamName: 'inventory-filters-team',
          subject: 'Blocked task',
          owner: 'alice',
          blockedBy: [baseTask.id],
        },
        52
      );
      const blockedTask = parseJsonToolResult((blockedCreateResult as { result: unknown }).result);

      const relatedCreateResult = await client.callTool(
        'task_create',
        {
          claudeDir,
          teamName: 'inventory-filters-team',
          subject: 'Related task',
          owner: 'alice',
          related: [baseTask.id],
        },
        53
      );
      const relatedTask = parseJsonToolResult((relatedCreateResult as { result: unknown }).result);

      const blockedInventoryResult = await client.callTool(
        'task_list',
        {
          claudeDir,
          teamName: 'inventory-filters-team',
          blockedBy: `#${baseTask.displayId}`,
        },
        54
      );
      const blockedInventoryRows = parseJsonToolResult(
        (blockedInventoryResult as { result: unknown }).result
      );
      expect(blockedInventoryRows).toHaveLength(1);
      expect(blockedInventoryRows[0]).toMatchObject({
        id: blockedTask.id,
        subject: 'Blocked task',
        blockedBy: [baseTask.id],
      });

      const relatedInventoryResult = await client.callTool(
        'task_list',
        {
          claudeDir,
          teamName: 'inventory-filters-team',
          relatedTo: `#${baseTask.displayId}`,
        },
        55
      );
      const relatedInventoryRows = parseJsonToolResult(
        (relatedInventoryResult as { result: unknown }).result
      );
      expect(relatedInventoryRows).toHaveLength(1);
      expect(relatedInventoryRows[0]).toMatchObject({
        id: relatedTask.id,
        subject: 'Related task',
        related: [baseTask.id],
      });

      const blockedOwnerBriefingResult = await client.callTool(
        'task_briefing',
        {
          claudeDir,
          teamName: 'inventory-filters-team',
          memberName: 'alice',
        },
        55_1
      );
      const blockedOwnerBriefingText = (
        ((blockedOwnerBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(blockedOwnerBriefingText).toContain(`#${baseTask.displayId}`);
      expect(blockedOwnerBriefingText).toContain('Actionable:');
      expect(blockedOwnerBriefingText).toContain(`#${blockedTask.displayId}`);
      expect(blockedOwnerBriefingText).toContain('Awareness:');
      expect(blockedOwnerBriefingText).toContain('reason=dependency_waiting');

      await client.callTool(
        'task_complete',
        {
          claudeDir,
          teamName: 'inventory-filters-team',
          taskId: baseTask.id,
          actor: 'alice',
        },
        55_2
      );

      const unblockedOwnerBriefingResult = await client.callTool(
        'task_briefing',
        {
          claudeDir,
          teamName: 'inventory-filters-team',
          memberName: 'alice',
        },
        55_3
      );
      const unblockedOwnerBriefingText = (
        ((unblockedOwnerBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(unblockedOwnerBriefingText).toContain(`#${blockedTask.displayId}`);
      expect(unblockedOwnerBriefingText).toContain('Actionable:');
      expect(unblockedOwnerBriefingText).toContain('reason=owner_ready');
      expect(unblockedOwnerBriefingText).not.toContain('reason=dependency_waiting');

      const selfReviewCreateResult = await client.callTool(
        'task_create',
        {
          claudeDir,
          teamName: 'inventory-filters-team',
          subject: 'Self review should be invalid',
          owner: 'alice',
        },
        56
      );
      const selfReviewTask = parseJsonToolResult(
        (selfReviewCreateResult as { result: unknown }).result
      );

      await client.callTool(
        'task_complete',
        {
          claudeDir,
          teamName: 'inventory-filters-team',
          taskId: selfReviewTask.id,
          actor: 'alice',
        },
        57
      );

      await client.callTool(
        'review_request',
        {
          claudeDir,
          teamName: 'inventory-filters-team',
          taskId: selfReviewTask.id,
          from: 'team-lead',
          reviewer: 'alice',
        },
        58
      );

      const leadBriefingResult = await client.callTool(
        'lead_briefing',
        {
          claudeDir,
          teamName: 'inventory-filters-team',
        },
        59
      );
      const leadBriefingText = (
        ((leadBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(leadBriefingText).toContain('Needs reviewer assignment:');
      expect(leadBriefingText).toContain(`#${selfReviewTask.displayId}`);
      expect(leadBriefingText).toContain('reason=self_review_invalid');

      const ownerBriefingResult = await client.callTool(
        'task_briefing',
        {
          claudeDir,
          teamName: 'inventory-filters-team',
          memberName: 'alice',
        },
        60
      );
      const ownerBriefingText = (
        ((ownerBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(ownerBriefingText).toContain(`#${selfReviewTask.displayId}`);
      expect(ownerBriefingText).toContain('Awareness:');
      expect(ownerBriefingText).toContain('reason=self_review_invalid');
    } finally {
      await client.close();
    }
  });

  it('routes clarification flags into owner awareness and lead sections over stdio', async () => {
    await writeTeamConfig(claudeDir, 'clarification-team');
    const client = new McpStdIoClient(serverPath, workspaceRoot);

    try {
      await client.initialize();

      const leadClarificationCreateResult = await client.callTool(
        'task_create',
        {
          claudeDir,
          teamName: 'clarification-team',
          subject: 'Need lead answer',
          owner: 'alice',
        },
        71
      );
      const leadClarificationTask = parseJsonToolResult(
        (leadClarificationCreateResult as { result: unknown }).result
      );

      const userClarificationCreateResult = await client.callTool(
        'task_create',
        {
          claudeDir,
          teamName: 'clarification-team',
          subject: 'Need user answer',
          owner: 'alice',
        },
        72
      );
      const userClarificationTask = parseJsonToolResult(
        (userClarificationCreateResult as { result: unknown }).result
      );

      await client.callTool(
        'task_set_clarification',
        {
          claudeDir,
          teamName: 'clarification-team',
          taskId: leadClarificationTask.id,
          value: 'lead',
        },
        73
      );

      await client.callTool(
        'task_set_clarification',
        {
          claudeDir,
          teamName: 'clarification-team',
          taskId: userClarificationTask.id,
          value: 'user',
        },
        74
      );

      const ownerBriefingResult = await client.callTool(
        'task_briefing',
        {
          claudeDir,
          teamName: 'clarification-team',
          memberName: 'alice',
        },
        75
      );
      const ownerBriefingText = (
        ((ownerBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(ownerBriefingText).toContain('Awareness:');
      expect(ownerBriefingText).toContain(`#${leadClarificationTask.displayId}`);
      expect(ownerBriefingText).toContain('reason=waiting_lead_clarification');
      expect(ownerBriefingText).toContain('clarification=lead');
      expect(ownerBriefingText).toContain(`#${userClarificationTask.displayId}`);
      expect(ownerBriefingText).toContain('reason=waiting_user_clarification');
      expect(ownerBriefingText).toContain('clarification=user');

      const leadBriefingResult = await client.callTool(
        'lead_briefing',
        {
          claudeDir,
          teamName: 'clarification-team',
        },
        76
      );
      const leadBriefingText = (
        ((leadBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(leadBriefingText).toContain('Needs clarification from lead:');
      expect(leadBriefingText).toContain(`#${leadClarificationTask.displayId}`);
      expect(leadBriefingText).toContain('reason=waiting_lead_clarification');
      expect(leadBriefingText).toContain('Waiting on user:');
      expect(leadBriefingText).toContain(`#${userClarificationTask.displayId}`);
      expect(leadBriefingText).toContain('reason=waiting_user_clarification');

      const inventoryResult = await client.callTool(
        'task_list',
        {
          claudeDir,
          teamName: 'clarification-team',
          owner: 'alice',
          status: 'pending',
        },
        77
      );
      const inventoryRows = parseJsonToolResult((inventoryResult as { result: unknown }).result);
      const leadClarificationRow = inventoryRows.find(
        (row: { id: string }) => row.id === leadClarificationTask.id
      ) as Record<string, unknown> | undefined;
      const userClarificationRow = inventoryRows.find(
        (row: { id: string }) => row.id === userClarificationTask.id
      ) as Record<string, unknown> | undefined;
      expect(leadClarificationRow?.needsClarification).toBe('lead');
      expect(userClarificationRow?.needsClarification).toBe('user');

      await client.callTool(
        'task_set_clarification',
        {
          claudeDir,
          teamName: 'clarification-team',
          taskId: leadClarificationTask.id,
          value: 'clear',
        },
        78
      );

      const ownerAfterClearBriefingResult = await client.callTool(
        'task_briefing',
        {
          claudeDir,
          teamName: 'clarification-team',
          memberName: 'alice',
        },
        79
      );
      const ownerAfterClearBriefingText = (
        ((ownerAfterClearBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(ownerAfterClearBriefingText).toContain('Actionable:');
      expect(ownerAfterClearBriefingText).toContain(`#${leadClarificationTask.displayId}`);
      expect(ownerAfterClearBriefingText).toContain('reason=owner_ready');
      expect(ownerAfterClearBriefingText).not.toContain('reason=waiting_lead_clarification');
      expect(ownerAfterClearBriefingText).toContain(`#${userClarificationTask.displayId}`);
      expect(ownerAfterClearBriefingText).toContain('reason=waiting_user_clarification');

      const leadAfterClearBriefingResult = await client.callTool(
        'lead_briefing',
        {
          claudeDir,
          teamName: 'clarification-team',
        },
        80
      );
      const leadAfterClearBriefingText = (
        ((leadAfterClearBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(leadAfterClearBriefingText).not.toContain(`#${leadClarificationTask.displayId}`);
      expect(leadAfterClearBriefingText).toContain('Waiting on user:');
      expect(leadAfterClearBriefingText).toContain(`#${userClarificationTask.displayId}`);
    } finally {
      await client.close();
    }
  });

  it('routes lead-owned work and approved terminal awareness over stdio', async () => {
    await writeTeamConfig(claudeDir, 'terminal-routing-team');
    const client = new McpStdIoClient(serverPath, workspaceRoot);

    try {
      await client.initialize();

      const leadOwnedCreateResult = await client.callTool(
        'task_create',
        {
          claudeDir,
          teamName: 'terminal-routing-team',
          subject: 'Lead-owned follow-up task',
          owner: 'team-lead',
        },
        81
      );
      const leadOwnedTask = parseJsonToolResult(
        (leadOwnedCreateResult as { result: unknown }).result
      );

      const leadOwnedBriefingResult = await client.callTool(
        'lead_briefing',
        {
          claudeDir,
          teamName: 'terminal-routing-team',
        },
        82
      );
      const leadOwnedBriefingText = (
        ((leadOwnedBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(leadOwnedBriefingText).toContain('Lead-owned follow-up:');
      expect(leadOwnedBriefingText).toContain(`#${leadOwnedTask.displayId}`);
      expect(leadOwnedBriefingText).toContain('owner=team-lead');
      expect(leadOwnedBriefingText).toContain('actionOwner=lead');
      expect(leadOwnedBriefingText).toContain('reason=owner_ready');

      const unrelatedMemberBriefingResult = await client.callTool(
        'task_briefing',
        {
          claudeDir,
          teamName: 'terminal-routing-team',
          memberName: 'alice',
        },
        83
      );
      const unrelatedMemberBriefingText = (
        ((unrelatedMemberBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(unrelatedMemberBriefingText).toContain('No actionable or awareness tasks for alice.');
      expect(unrelatedMemberBriefingText).not.toContain(`#${leadOwnedTask.displayId}`);

      const approvedCreateResult = await client.callTool(
        'task_create',
        {
          claudeDir,
          teamName: 'terminal-routing-team',
          subject: 'Approved terminal task',
          owner: 'alice',
          description: 'This should become terminal awareness, not work.',
        },
        84
      );
      const approvedTask = parseJsonToolResult((approvedCreateResult as { result: unknown }).result);

      await client.callTool(
        'task_complete',
        {
          claudeDir,
          teamName: 'terminal-routing-team',
          taskId: approvedTask.id,
          actor: 'alice',
        },
        85
      );

      await client.callTool(
        'review_request',
        {
          claudeDir,
          teamName: 'terminal-routing-team',
          taskId: approvedTask.id,
          from: 'team-lead',
          reviewer: 'bob',
        },
        86
      );

      await client.callTool(
        'review_start',
        {
          claudeDir,
          teamName: 'terminal-routing-team',
          taskId: approvedTask.id,
        },
        87
      );

      const approveResult = await client.callTool(
        'review_approve',
        {
          claudeDir,
          teamName: 'terminal-routing-team',
          taskId: approvedTask.id,
          from: 'bob',
          note: 'Approved through stdio e2e.',
          notifyOwner: true,
        },
        88
      );
      const approvedPayload = parseJsonToolResult((approveResult as { result: unknown }).result);
      expect(approvedPayload.reviewState).toBe('approved');

      const ownerBriefingResult = await client.callTool(
        'task_briefing',
        {
          claudeDir,
          teamName: 'terminal-routing-team',
          memberName: 'alice',
        },
        89
      );
      const ownerBriefingText = (
        ((ownerBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(ownerBriefingText).not.toContain('Actionable:');
      expect(ownerBriefingText).toContain('Awareness:');
      expect(ownerBriefingText).toContain(`#${approvedTask.displayId}`);
      expect(ownerBriefingText).toContain('review=approved');
      expect(ownerBriefingText).toContain('actionOwner=none');
      expect(ownerBriefingText).toContain('reason=terminal_approved');
      expect(ownerBriefingText).not.toContain('Description: This should become terminal awareness');

      const leadAfterApprovalBriefingResult = await client.callTool(
        'lead_briefing',
        {
          claudeDir,
          teamName: 'terminal-routing-team',
        },
        90
      );
      const leadAfterApprovalBriefingText = (
        ((leadAfterApprovalBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(leadAfterApprovalBriefingText).toContain(`#${leadOwnedTask.displayId}`);
      expect(leadAfterApprovalBriefingText).not.toContain(`#${approvedTask.displayId}`);

      const approvedInventoryResult = await client.callTool(
        'task_list',
        {
          claudeDir,
          teamName: 'terminal-routing-team',
          reviewState: 'approved',
          kanbanColumn: 'approved',
        },
        91
      );
      const approvedInventoryRows = parseJsonToolResult(
        (approvedInventoryResult as { result: unknown }).result
      );
      expect(approvedInventoryRows).toHaveLength(1);
      expect(approvedInventoryRows[0]).toMatchObject({
        id: approvedTask.id,
        owner: 'alice',
        status: 'completed',
        reviewState: 'approved',
      });
      expect(approvedInventoryRows[0].description).toBeUndefined();
      expect(approvedInventoryRows[0].comments).toBeUndefined();
      expect(approvedInventoryRows[0].historyEvents).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('routes invalid owners and broken dependencies to lead over stdio', async () => {
    await writeTeamConfig(claudeDir, 'repair-team');
    const client = new McpStdIoClient(serverPath, workspaceRoot);

    try {
      await client.initialize();

      const orphanedTaskResult = await client.callTool(
        'task_create',
        {
          claudeDir,
          teamName: 'repair-team',
          subject: 'Owner became invalid',
          owner: 'alice',
        },
        81
      );
      const orphanedTask = parseJsonToolResult((orphanedTaskResult as { result: unknown }).result);

      const membersMetaPath = path.join(claudeDir, 'teams', 'repair-team', 'members.meta.json');
      await writeFile(
        membersMetaPath,
        JSON.stringify(
          {
            version: 1,
            members: [{ name: 'alice', removedAt: 1_776_772_800_000 }],
          },
          null,
          2
        ),
        'utf8'
      );

      const dependencyTaskResult = await client.callTool(
        'task_create',
        {
          claudeDir,
          teamName: 'repair-team',
          subject: 'Dependency to be deleted',
          owner: 'bob',
        },
        82
      );
      const dependencyTask = parseJsonToolResult(
        (dependencyTaskResult as { result: unknown }).result
      );

      const blockedTaskResult = await client.callTool(
        'task_create',
        {
          claudeDir,
          teamName: 'repair-team',
          subject: 'Broken dependency task',
          owner: 'bob',
          blockedBy: [dependencyTask.id],
        },
        83
      );
      const blockedTask = parseJsonToolResult((blockedTaskResult as { result: unknown }).result);

      await client.callTool(
        'task_set_status',
        {
          claudeDir,
          teamName: 'repair-team',
          taskId: dependencyTask.id,
          status: 'deleted',
          actor: 'bob',
        },
        84
      );

      const leadBriefingResult = await client.callTool(
        'lead_briefing',
        {
          claudeDir,
          teamName: 'repair-team',
        },
        85
      );
      const leadBriefingText = (
        ((leadBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(leadBriefingText).toContain('Needs owner assignment:');
      expect(leadBriefingText).toContain(`#${orphanedTask.displayId}`);
      expect(leadBriefingText).toContain('reason=owner_invalid');
      expect(leadBriefingText).toContain('Dependency repair:');
      expect(leadBriefingText).toContain(`#${blockedTask.displayId}`);
      expect(leadBriefingText).toContain('reason=dependency_broken');

      const bobBriefingResult = await client.callTool(
        'task_briefing',
        {
          claudeDir,
          teamName: 'repair-team',
          memberName: 'bob',
        },
        86
      );
      const bobBriefingText = (
        ((bobBriefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(bobBriefingText).toContain('Awareness:');
      expect(bobBriefingText).toContain(`#${blockedTask.displayId}`);
      expect(bobBriefingText).toContain('reason=dependency_broken');
      expect(bobBriefingText).not.toContain('reason=owner_ready');

      const inventoryResult = await client.callTool(
        'task_list',
        {
          claudeDir,
          teamName: 'repair-team',
          owner: 'bob',
        },
        87
      );
      const inventoryRows = parseJsonToolResult((inventoryResult as { result: unknown }).result);
      const blockedRow = inventoryRows.find(
        (row: { id: string }) => row.id === blockedTask.id
      ) as Record<string, unknown> | undefined;
      expect(blockedRow).toMatchObject({
        id: blockedTask.id,
        owner: 'bob',
        blockedBy: [dependencyTask.id],
        status: 'pending',
      });
    } finally {
      await client.close();
    }
  });

  it('guards review lifecycle bypasses and deleted resurrection over stdio', async () => {
    await writeTeamConfig(claudeDir, 'stdio-hardening-team');
    const client = new McpStdIoClient(serverPath, workspaceRoot);

    try {
      await client.initialize();

      const createResult = await client.callTool(
        'task_create',
        {
          claudeDir,
          teamName: 'stdio-hardening-team',
          subject: 'Lifecycle guard task',
          owner: 'alice',
        },
        101
      );
      const task = parseJsonToolResult((createResult as { result: unknown }).result);

      await client.callTool(
        'task_complete',
        {
          claudeDir,
          teamName: 'stdio-hardening-team',
          taskId: task.id,
          actor: 'alice',
        },
        102
      );
      await client.callTool(
        'review_request',
        {
          claudeDir,
          teamName: 'stdio-hardening-team',
          taskId: task.id,
          from: 'team-lead',
          reviewer: 'bob',
        },
        103
      );
      await client.callTool(
        'review_approve',
        {
          claudeDir,
          teamName: 'stdio-hardening-team',
          taskId: task.id,
          from: 'bob',
        },
        104
      );

      const clearResult = await client.callTool(
        'kanban_clear',
        {
          claudeDir,
          teamName: 'stdio-hardening-team',
          taskId: task.id,
        },
        105
      );
      const clearResponse = clearResult as {
        error?: { message?: string };
        result?: { content?: Array<{ text?: string }> };
      };
      const clearErrorText =
        clearResponse.error?.message ?? (clearResponse.result?.content?.[0]?.text ?? '');
      expect(clearErrorText).toContain('reviewState=approved');

      const reopenedResult = await client.callTool(
        'task_set_status',
        {
          claudeDir,
          teamName: 'stdio-hardening-team',
          taskId: task.id,
          status: 'pending',
          actor: 'team-lead',
        },
        106
      );
      const reopened = parseJsonToolResult((reopenedResult as { result: unknown }).result);
      expect(reopened.status).toBe('pending');
      expect(reopened.reviewState).toBe('none');

      const inventoryResult = await client.callTool(
        'task_list',
        {
          claudeDir,
          teamName: 'stdio-hardening-team',
          owner: 'alice',
        },
        107
      );
      const inventoryRows = parseJsonToolResult((inventoryResult as { result: unknown }).result);
      expect(inventoryRows[0]).toMatchObject({
        id: task.id,
        status: 'pending',
        reviewState: 'none',
      });

      const deleteResult = await client.callTool(
        'task_set_status',
        {
          claudeDir,
          teamName: 'stdio-hardening-team',
          taskId: task.id,
          status: 'deleted',
          actor: 'team-lead',
        },
        108
      );
      const deleted = parseJsonToolResult((deleteResult as { result: unknown }).result);
      expect(deleted.status).toBe('deleted');
      expect(deleted.reviewState).toBe('none');

      const startDeletedResult = await client.callTool(
        'task_start',
        {
          claudeDir,
          teamName: 'stdio-hardening-team',
          taskId: task.id,
          actor: 'alice',
        },
        109
      );
      const startDeletedResponse = startDeletedResult as {
        error?: { message?: string };
        result?: { content?: Array<{ text?: string }> };
      };
      const startDeletedErrorText =
        startDeletedResponse.error?.message ?? (startDeletedResponse.result?.content?.[0]?.text ?? '');
      expect(startDeletedErrorText).toContain('use task_restore before starting work');

      const restoreResult = await client.callTool(
        'task_restore',
        {
          claudeDir,
          teamName: 'stdio-hardening-team',
          taskId: task.id,
          actor: 'team-lead',
        },
        110
      );
      const restored = parseJsonToolResult((restoreResult as { result: unknown }).result);
      expect(restored.status).toBe('pending');
      expect(restored.reviewState).toBe('none');

      const restoreAgainResult = await client.callTool(
        'task_restore',
        {
          claudeDir,
          teamName: 'stdio-hardening-team',
          taskId: task.id,
          actor: 'team-lead',
        },
        111
      );
      const restoreAgainResponse = restoreAgainResult as {
        error?: { message?: string };
        result?: { content?: Array<{ text?: string }> };
      };
      const restoreAgainErrorText =
        restoreAgainResponse.error?.message ?? (restoreAgainResponse.result?.content?.[0]?.text ?? '');
      expect(restoreAgainErrorText).toContain('task_restore only restores deleted tasks');
    } finally {
      await client.close();
    }
  });

  it('exposes Codex-native briefing and owner notifications over stdio MCP', async () => {
    await writeTeamConfig(claudeDir, 'stdio-codex-team', [
      { name: 'team-lead', agentType: 'team-lead', providerId: 'codex', model: 'gpt-5.5' },
      {
        name: 'bob',
        agentType: 'teammate',
        role: 'developer',
        providerId: 'codex',
        model: 'gpt-5.4-mini',
      },
    ]);
    const client = new McpStdIoClient(serverPath, workspaceRoot);

    try {
      await client.initialize();

      const briefingResult = await client.callTool(
        'member_briefing',
        {
          claudeDir,
          teamName: 'stdio-codex-team',
          memberName: 'bob',
          runtimeProvider: 'codex',
        },
        201
      );
      const briefingText = (
        ((briefingResult as { result: { content?: Array<{ text?: string }> } }).result
          ?.content?.[0]?.text as string | undefined) ?? ''
      );
      expect(briefingText).toContain('Codex Native visible messaging rule');
      expect(briefingText).toContain('Codex Native task tool rule');
      expect(briefingText).toContain('agent-teams_message_send');
      expect(briefingText).toContain('mcp__agent-teams__task_get');
      expect(briefingText).not.toContain('notify your team lead via SendMessage');

      await client.callTool(
        'task_create',
        {
          claudeDir,
          teamName: 'stdio-codex-team',
          subject: 'Codex stdio assignment',
          owner: 'bob',
          description: 'Verify Codex sees Agent Teams MCP tools over stdio.',
        },
        202
      );

      const inboxRaw = await readFile(
        path.join(claudeDir, 'teams', 'stdio-codex-team', 'inboxes', 'bob.json'),
        'utf8'
      );
      const inbox = JSON.parse(inboxRaw) as Array<{ text?: string }>;
      const assignmentText = inbox[0]?.text ?? '';
      expect(assignmentText).toContain('MCP tool agent-teams_message_send');
      expect(assignmentText).toContain('Codex Native visible messaging rule');
      expect(assignmentText).toContain('mcp__agent-teams__task_get');
      expect(assignmentText).not.toContain('notify your lead via SendMessage');
    } finally {
      await client.close();
    }
  });

  it('forwards work-sync status and report through real stdio MCP JSON-RPC', async () => {
    await writeTeamConfig(claudeDir, 'stdio-work-sync-team', [
      { name: 'team-lead', agentType: 'team-lead' },
      { name: 'alice', agentType: 'teammate', role: 'developer' },
    ]);
    const calls: Array<{ method?: string; url?: string; body?: unknown }> = [];
    const controlServer = await startControlServer(async ({ method, url, body }) => {
      calls.push({ method, url, body });
      if (
        method === 'POST' &&
        url === '/api/teams/stdio-work-sync-team/member-work-sync/alice/refresh'
      ) {
        return {
          body: {
            teamName: 'stdio-work-sync-team',
            memberName: 'alice',
            state: 'needs_sync',
            agenda: {
              teamName: 'stdio-work-sync-team',
              memberName: 'alice',
              generatedAt: '2026-04-29T00:00:00.000Z',
              fingerprint: 'agenda:v1:stdio',
              items: [],
              diagnostics: [],
            },
            reportToken: 'wrs:v1.stdio.token',
            reportTokenExpiresAt: '2026-04-29T00:15:00.000Z',
            evaluatedAt: '2026-04-29T00:00:00.000Z',
            diagnostics: ['no_current_report'],
          },
        };
      }
      if (method === 'POST' && url === '/api/teams/stdio-work-sync-team/member-work-sync/report') {
        return { body: { accepted: true, code: 'accepted', status: body } };
      }
      return { statusCode: 404, body: { error: `Unhandled ${method} ${url}` } };
    });
    const client = new McpStdIoClient(serverPath, workspaceRoot);

    try {
      await client.initialize();

      const statusResult = await client.callTool(
        'member_work_sync_status',
        {
          claudeDir,
          teamName: 'stdio-work-sync-team',
          controlUrl: controlServer.baseUrl,
          from: 'alice',
        },
        203
      );
      const status = parseJsonToolResult((statusResult as { result: unknown }).result);
      expect(status.state).toBe('needs_sync');
      expect(status.agenda.fingerprint).toBe('agenda:v1:stdio');
      expect(status.statusOnlyIncomplete).toBe(true);
      expect(status.nextRequiredToolCall).toMatchObject({
        tool: 'member_work_sync_report',
        arguments: {
          teamName: 'stdio-work-sync-team',
          memberName: 'alice',
          controlUrl: controlServer.baseUrl,
          state: 'caught_up',
          agendaFingerprint: 'agenda:v1:stdio',
          reportToken: 'wrs:v1.stdio.token',
        },
      });

      const reportResult = await client.callTool(
        'member_work_sync_report',
        {
          claudeDir,
          teamName: 'stdio-work-sync-team',
          controlUrl: controlServer.baseUrl,
          memberName: 'alice',
          state: 'still_working',
          agendaFingerprint: 'agenda:v1:stdio',
          reportToken: 'wrs:v1.stdio.token',
          taskIds: ['task-1'],
          note: 'Still working',
          leaseTtlMs: 120000,
        },
        204
      );
      const report = parseJsonToolResult((reportResult as { result: unknown }).result);
      expect(report.accepted).toBe(true);

      expect(calls).toEqual([
        {
          method: 'POST',
          url: '/api/teams/stdio-work-sync-team/member-work-sync/alice/refresh',
          body: {},
        },
        {
          method: 'POST',
          url: '/api/teams/stdio-work-sync-team/member-work-sync/report',
          body: expect.objectContaining({
            memberName: 'alice',
            state: 'still_working',
            agendaFingerprint: 'agenda:v1:stdio',
            reportToken: 'wrs:v1.stdio.token',
            taskIds: ['task-1'],
            note: 'Still working',
            leaseTtlMs: 120000,
          }),
        },
      ]);
    } finally {
      await client.close();
      await controlServer.close();
    }
  });

  it('discovers work-sync control endpoint from env in a real stdio MCP process', async () => {
    await writeTeamConfig(claudeDir, 'stdio-work-sync-env-team', [
      { name: 'team-lead', agentType: 'team-lead' },
      { name: 'alice', agentType: 'teammate', role: 'developer' },
    ]);
    const calls: Array<{ method?: string; url?: string; body?: unknown }> = [];
    const controlServer = await startControlServer(async ({ method, url, body }) => {
      calls.push({ method, url, body });
      if (
        method === 'POST' &&
        url === '/api/teams/stdio-work-sync-env-team/member-work-sync/alice/refresh'
      ) {
        return {
          body: {
            teamName: 'stdio-work-sync-env-team',
            memberName: 'alice',
            state: 'needs_sync',
            agenda: {
              teamName: 'stdio-work-sync-env-team',
              memberName: 'alice',
              generatedAt: '2026-04-29T00:00:00.000Z',
              fingerprint: 'agenda:v1:stdio-env',
              items: [{ taskId: 'task-env-1' }],
              diagnostics: [],
            },
            reportToken: 'wrs:v1.stdio.env.token',
            reportTokenExpiresAt: '2026-04-29T00:15:00.000Z',
            evaluatedAt: '2026-04-29T00:00:00.000Z',
            diagnostics: ['no_current_report'],
          },
        };
      }
      if (
        method === 'POST' &&
        url === '/api/teams/stdio-work-sync-env-team/member-work-sync/report'
      ) {
        return { body: { accepted: true, code: 'accepted', status: body } };
      }
      return { statusCode: 404, body: { error: `Unhandled ${method} ${url}` } };
    });
    const previousControlUrl = process.env.CLAUDE_TEAM_CONTROL_URL;
    process.env.CLAUDE_TEAM_CONTROL_URL = controlServer.baseUrl;
    const client = new McpStdIoClient(serverPath, workspaceRoot);

    try {
      await client.initialize();

      const statusResult = await client.callTool(
        'member_work_sync_status',
        {
          claudeDir,
          teamName: 'stdio-work-sync-env-team',
          from: 'alice',
        },
        205
      );
      const status = parseJsonToolResult((statusResult as { result: unknown }).result);
      expect(status.nextRequiredToolCall).toMatchObject({
        tool: 'member_work_sync_report',
        arguments: {
          teamName: 'stdio-work-sync-env-team',
          memberName: 'alice',
          state: 'still_working',
          agendaFingerprint: 'agenda:v1:stdio-env',
          reportToken: 'wrs:v1.stdio.env.token',
          taskIds: ['task-env-1'],
        },
      });

      const reportResult = await client.callTool(
        'member_work_sync_report',
        {
          claudeDir,
          teamName: 'stdio-work-sync-env-team',
          memberName: 'alice',
          state: 'still_working',
          agendaFingerprint: 'agenda:v1:stdio-env',
          reportToken: 'wrs:v1.stdio.env.token',
          taskIds: ['task-env-1'],
        },
        206
      );
      const report = parseJsonToolResult((reportResult as { result: unknown }).result);
      expect(report.accepted).toBe(true);
      expect(calls.map((call) => call.url)).toEqual([
        '/api/teams/stdio-work-sync-env-team/member-work-sync/alice/refresh',
        '/api/teams/stdio-work-sync-env-team/member-work-sync/report',
      ]);
    } finally {
      if (previousControlUrl === undefined) {
        delete process.env.CLAUDE_TEAM_CONTROL_URL;
      } else {
        process.env.CLAUDE_TEAM_CONTROL_URL = previousControlUrl;
      }
      await client.close();
      await controlServer.close();
    }
  });

  it('falls back from stale explicit work-sync control URL to state file in real stdio MCP', async () => {
    await writeTeamConfig(claudeDir, 'stdio-work-sync-stale-team', [
      { name: 'team-lead', agentType: 'team-lead' },
      { name: 'alice', agentType: 'teammate', role: 'developer' },
    ]);
    const staleCalls: Array<{ method?: string; url?: string }> = [];
    const freshCalls: Array<{ method?: string; url?: string; body?: unknown }> = [];
    const staleServer = await startControlServer(async ({ method, url }) => {
      staleCalls.push({ method, url });
      return { statusCode: 404, body: { error: 'stale control server' } };
    });
    const freshServer = await startControlServer(async ({ method, url, body }) => {
      freshCalls.push({ method, url, body });
      if (
        method === 'POST' &&
        url === '/api/teams/stdio-work-sync-stale-team/member-work-sync/alice/refresh'
      ) {
        return {
          body: {
            teamName: 'stdio-work-sync-stale-team',
            memberName: 'alice',
            state: 'needs_sync',
            agenda: {
              teamName: 'stdio-work-sync-stale-team',
              memberName: 'alice',
              generatedAt: '2026-04-29T00:00:00.000Z',
              fingerprint: 'agenda:v1:stdio-stale-fallback',
              items: [{ taskId: 'task-stale-1' }],
              diagnostics: [],
            },
            reportToken: 'wrs:v1.stdio.stale.token',
            reportTokenExpiresAt: '2026-04-29T00:15:00.000Z',
            evaluatedAt: '2026-04-29T00:00:00.000Z',
            diagnostics: ['no_current_report'],
          },
        };
      }
      if (
        method === 'POST' &&
        url === '/api/teams/stdio-work-sync-stale-team/member-work-sync/report'
      ) {
        return { body: { accepted: true, code: 'accepted', status: body } };
      }
      return { statusCode: 404, body: { error: `Unhandled ${method} ${url}` } };
    });
    await writeFile(
      path.join(claudeDir, 'team-control-api.json'),
      JSON.stringify({ baseUrl: freshServer.baseUrl, updatedAt: new Date().toISOString() }),
      'utf8'
    );
    const client = new McpStdIoClient(serverPath, workspaceRoot);

    try {
      await client.initialize();

      const statusResult = await client.callTool(
        'member_work_sync_status',
        {
          claudeDir,
          teamName: 'stdio-work-sync-stale-team',
          controlUrl: staleServer.baseUrl,
          from: 'alice',
        },
        207
      );
      const status = parseJsonToolResult((statusResult as { result: unknown }).result);
      expect(status.agenda.fingerprint).toBe('agenda:v1:stdio-stale-fallback');

      const reportResult = await client.callTool(
        'member_work_sync_report',
        {
          claudeDir,
          teamName: 'stdio-work-sync-stale-team',
          controlUrl: staleServer.baseUrl,
          memberName: 'alice',
          state: 'still_working',
          agendaFingerprint: 'agenda:v1:stdio-stale-fallback',
          reportToken: 'wrs:v1.stdio.stale.token',
          taskIds: ['task-stale-1'],
        },
        208
      );
      const report = parseJsonToolResult((reportResult as { result: unknown }).result);
      expect(report.accepted).toBe(true);
      expect(staleCalls.map((call) => call.url)).toEqual([
        '/api/teams/stdio-work-sync-stale-team/member-work-sync/alice/refresh',
        '/api/teams/stdio-work-sync-stale-team/member-work-sync/report',
      ]);
      expect(freshCalls.map((call) => call.url)).toEqual([
        '/api/teams/stdio-work-sync-stale-team/member-work-sync/alice/refresh',
        '/api/teams/stdio-work-sync-stale-team/member-work-sync/report',
      ]);
    } finally {
      await client.close();
      await staleServer.close();
      await freshServer.close();
    }
  });

  it('records a pending work-sync report when control API is unavailable in real stdio MCP', async () => {
    await writeTeamConfig(claudeDir, 'stdio-work-sync-pending-team', [
      { name: 'team-lead', agentType: 'team-lead' },
      { name: 'alice', agentType: 'teammate', role: 'developer' },
    ]);
    const previousControlUrl = process.env.CLAUDE_TEAM_CONTROL_URL;
    delete process.env.CLAUDE_TEAM_CONTROL_URL;
    const client = new McpStdIoClient(serverPath, workspaceRoot);

    try {
      await client.initialize();

      const reportResult = await client.callTool(
        'member_work_sync_report',
        {
          claudeDir,
          teamName: 'stdio-work-sync-pending-team',
          memberName: 'alice',
          state: 'still_working',
          agendaFingerprint: 'agenda:v1:offline',
          reportToken: 'wrs:v1.offline.token',
          taskIds: ['task-offline-1'],
        },
        209
      );
      const report = parseJsonToolResult((reportResult as { result: unknown }).result);
      expect(report).toMatchObject({
        accepted: false,
        pendingValidation: true,
        code: 'pending_validation',
      });

      const pendingFile = JSON.parse(
        await readFile(
          path.join(
            claudeDir,
            'teams',
            'stdio-work-sync-pending-team',
            '.member-work-sync',
            'pending-reports.json'
          ),
          'utf8'
        )
      ) as {
        intents?: Record<
          string,
          {
            reason?: string;
            status?: string;
            request?: { memberName?: string; agendaFingerprint?: string; taskIds?: string[] };
          }
        >;
      };
      const intents = Object.values(pendingFile.intents ?? {});
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({
        reason: 'control_api_unavailable',
        status: 'pending',
        request: {
          memberName: 'alice',
          agendaFingerprint: 'agenda:v1:offline',
          taskIds: ['task-offline-1'],
        },
      });
    } finally {
      if (previousControlUrl === undefined) {
        delete process.env.CLAUDE_TEAM_CONTROL_URL;
      } else {
        process.env.CLAUDE_TEAM_CONTROL_URL = previousControlUrl;
      }
      await client.close();
    }
  });
});
