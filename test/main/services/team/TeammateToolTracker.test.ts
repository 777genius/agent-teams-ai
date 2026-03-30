import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { TeammateToolTracker } from '@main/services/team/TeammateToolTracker';

import type { TeamChangeEvent } from '@shared/types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

async function createSubagentLog(
  rootDir: string,
  sessionId: string,
  fileName = 'agent-worker.jsonl'
): Promise<string> {
  const subagentsDir = path.join(rootDir, sessionId, 'subagents');
  await mkdir(subagentsDir, { recursive: true });
  const filePath = path.join(subagentsDir, fileName);
  await writeFile(filePath, '', 'utf8');
  return filePath;
}

async function waitForCondition(check: () => void, attempts = 20): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      check();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('TeammateToolTracker', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('emits unresolved teammate tools on initial enable', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'teammate-tool-tracker-'));
    tempDirs.push(rootDir);
    const filePath = await createSubagentLog(rootDir, 'session-a');

    await writeFile(
      filePath,
      `${JSON.stringify({
        timestamp: '2026-03-28T10:00:00.000Z',
        type: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/index.ts' } }],
      })}\n`,
      'utf8'
    );

    const listAttributedSubagentFiles = vi.fn(async () => [
      {
        memberName: 'alice',
        sessionId: 'session-a',
        filePath,
        mtimeMs: Date.now(),
      },
    ]);
    const enableTracking = vi.fn(async () => ({
      projectFingerprint: null,
      logSourceGeneration: null,
    }));
    const disableTracking = vi.fn(async () => ({
      projectFingerprint: null,
      logSourceGeneration: null,
    }));
    const events: TeamChangeEvent[] = [];

    const tracker = new TeammateToolTracker(
      { listAttributedSubagentFiles } as never,
      { enableTracking, disableTracking } as never,
      (event) => events.push(event)
    );

    await tracker.setTracking('my-team', true);

    expect(enableTracking).toHaveBeenCalledWith('my-team', 'tool_activity');
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].detail ?? '');
    expect(payload).toMatchObject({
      action: 'start',
      activity: {
        memberName: 'alice',
        toolUseId: 'member_log:session-a:tool-1',
        toolName: 'Read',
        source: 'member_log',
      },
    });
  });

  it('emits finish when appended tool_result arrives and preserves chunk carry across boundaries', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'teammate-tool-tracker-'));
    tempDirs.push(rootDir);
    const filePath = await createSubagentLog(rootDir, 'session-b');

    await writeFile(
      filePath,
      `${JSON.stringify({
        timestamp: '2026-03-28T10:00:00.000Z',
        type: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/index.ts' } }],
      })}\n`,
      'utf8'
    );

    const listAttributedSubagentFiles = vi.fn(async () => [
      {
        memberName: 'alice',
        sessionId: 'session-b',
        filePath,
        mtimeMs: Date.now(),
      },
    ]);
    const events: TeamChangeEvent[] = [];
    const tracker = new TeammateToolTracker(
      { listAttributedSubagentFiles } as never,
      { enableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })), disableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })) } as never,
      (event) => events.push(event)
    );

    await tracker.setTracking('my-team', true);
    expect(events).toHaveLength(1);

    const resultLine = JSON.stringify({
      timestamp: '2026-03-28T10:00:01.000Z',
      type: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }],
    });
    const splitAt = Math.floor(resultLine.length / 2);
    await appendFile(filePath, resultLine.slice(0, splitAt), 'utf8');
    tracker.handleLogSourceChange('my-team');
    await waitForCondition(() => {
      expect(events).toHaveLength(1);
    });

    await appendFile(filePath, `${resultLine.slice(splitAt)}\n`, 'utf8');
    tracker.handleLogSourceChange('my-team');
    await waitForCondition(() => {
      expect(events).toHaveLength(2);
    });
    const payload = JSON.parse(events[1].detail ?? '');
    expect(payload).toMatchObject({
      action: 'finish',
      memberName: 'alice',
      toolUseId: 'member_log:session-b:tool-1',
      resultPreview: 'done',
    });
  });

  it('resets only removed file tools when one of multiple files disappears', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'teammate-tool-tracker-'));
    tempDirs.push(rootDir);
    const firstFile = await createSubagentLog(rootDir, 'session-c', 'agent-a.jsonl');
    const secondFile = await createSubagentLog(rootDir, 'session-d', 'agent-b.jsonl');

    const runningLine = (toolId: string) =>
      `${JSON.stringify({
        timestamp: '2026-03-28T10:00:00.000Z',
        type: 'assistant',
        content: [{ type: 'tool_use', id: toolId, name: 'Read', input: { file_path: `${toolId}.ts` } }],
      })}\n`;

    await writeFile(firstFile, runningLine('tool-a'), 'utf8');
    await writeFile(secondFile, runningLine('tool-b'), 'utf8');

    const attributedFiles = [
      { memberName: 'alice', sessionId: 'session-c', filePath: firstFile, mtimeMs: Date.now() },
      { memberName: 'alice', sessionId: 'session-d', filePath: secondFile, mtimeMs: Date.now() },
    ];
    const listAttributedSubagentFiles = vi.fn(async () => [...attributedFiles]);
    const events: TeamChangeEvent[] = [];
    const tracker = new TeammateToolTracker(
      { listAttributedSubagentFiles } as never,
      { enableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })), disableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })) } as never,
      (event) => events.push(event)
    );

    await tracker.setTracking('my-team', true);
    expect(events).toHaveLength(2);

    attributedFiles.shift();
    tracker.handleLogSourceChange('my-team');
    await waitForCondition(() => {
      expect(events).toHaveLength(3);
    });

    const payload = JSON.parse(events[2].detail ?? '');
    expect(payload).toMatchObject({
      action: 'reset',
      memberName: 'alice',
      toolUseIds: ['member_log:session-c:tool-a'],
    });
  });

  it('resets truncated file tools and replays only currently unresolved tools after full resync', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'teammate-tool-tracker-'));
    tempDirs.push(rootDir);
    const filePath = await createSubagentLog(rootDir, 'session-e');

    const toolALine = JSON.stringify({
      timestamp: '2026-03-28T10:00:00.000Z',
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'tool-a', name: 'Read', input: { file_path: 'a.ts' } }],
    });
    const toolAResult = JSON.stringify({
      timestamp: '2026-03-28T10:00:01.000Z',
      type: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-a', content: 'done-a' }],
    });
    await writeFile(filePath, `${toolALine}\n${toolAResult}\n`, 'utf8');

    const listAttributedSubagentFiles = vi.fn(async () => [
      {
        memberName: 'alice',
        sessionId: 'session-e',
        filePath,
        mtimeMs: Date.now(),
      },
    ]);
    const events: TeamChangeEvent[] = [];
    const tracker = new TeammateToolTracker(
      { listAttributedSubagentFiles } as never,
      { enableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })), disableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })) } as never,
      (event) => events.push(event)
    );

    await tracker.setTracking('my-team', true);
    expect(events).toHaveLength(0);

    const toolBLine = JSON.stringify({
      timestamp: '2026-03-28T10:00:02.000Z',
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'tool-b', name: 'Bash', input: { command: 'echo ok' } }],
    });
    await writeFile(filePath, `${toolBLine}\n`, 'utf8');

    tracker.handleLogSourceChange('my-team');
    await waitForCondition(() => {
      expect(events).toHaveLength(1);
    });

    const payload = JSON.parse(events[0].detail ?? '');
    expect(payload).toMatchObject({
      action: 'start',
      activity: {
        memberName: 'alice',
        toolUseId: 'member_log:session-e:tool-b',
        toolName: 'Bash',
      },
    });
  });

  it('resets old ownership and replays unresolved tools when file attribution changes', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'teammate-tool-tracker-'));
    tempDirs.push(rootDir);
    const filePath = await createSubagentLog(rootDir, 'session-f');

    await writeFile(
      filePath,
      `${JSON.stringify({
        timestamp: '2026-03-28T10:00:00.000Z',
        type: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/index.ts' } }],
      })}\n`,
      'utf8'
    );

    let currentMemberName = 'alice';
    const listAttributedSubagentFiles = vi.fn(async () => [
      {
        memberName: currentMemberName,
        sessionId: 'session-f',
        filePath,
        mtimeMs: Date.now(),
      },
    ]);
    const events: TeamChangeEvent[] = [];
    const tracker = new TeammateToolTracker(
      { listAttributedSubagentFiles } as never,
      { enableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })), disableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })) } as never,
      (event) => events.push(event)
    );

    await tracker.setTracking('my-team', true);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].detail ?? '')).toMatchObject({
      action: 'start',
      activity: { memberName: 'alice', toolUseId: 'member_log:session-f:tool-1' },
    });

    currentMemberName = 'bob';
    tracker.handleLogSourceChange('my-team');
    await waitForCondition(() => {
      expect(events).toHaveLength(3);
    });

    const resetPayload = JSON.parse(events[1].detail ?? '');
    const replayPayload = JSON.parse(events[2].detail ?? '');
    expect(resetPayload).toMatchObject({
      action: 'reset',
      memberName: 'alice',
      toolUseIds: ['member_log:session-f:tool-1'],
    });
    expect(replayPayload).toMatchObject({
      action: 'start',
      activity: { memberName: 'bob', toolUseId: 'member_log:session-f:tool-1' },
    });
  });

  it('drops late refresh results when tracking is disabled during in-flight scan', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'teammate-tool-tracker-'));
    tempDirs.push(rootDir);
    const filePath = await createSubagentLog(rootDir, 'session-g');

    await writeFile(
      filePath,
      `${JSON.stringify({
        timestamp: '2026-03-28T10:00:00.000Z',
        type: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/index.ts' } }],
      })}\n`,
      'utf8'
    );

    const deferred = createDeferred<
      Array<{ memberName: string; sessionId: string; filePath: string; mtimeMs: number }>
    >();
    const listAttributedSubagentFiles = vi.fn(() => deferred.promise);
    const enableTracking = vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null }));
    const disableTracking = vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null }));
    const events: TeamChangeEvent[] = [];
    const tracker = new TeammateToolTracker(
      { listAttributedSubagentFiles } as never,
      { enableTracking, disableTracking } as never,
      (event) => events.push(event)
    );

    const enablePromise = tracker.setTracking('my-team', true);
    await Promise.resolve();
    const disablePromise = tracker.setTracking('my-team', false);

    deferred.resolve([
      {
        memberName: 'alice',
        sessionId: 'session-g',
        filePath,
        mtimeMs: Date.now(),
      },
    ]);

    await Promise.all([enablePromise, disablePromise]);

    expect(events).toHaveLength(0);
    expect(enableTracking).toHaveBeenNthCalledWith(1, 'my-team', 'tool_activity');
    expect(disableTracking).toHaveBeenNthCalledWith(1, 'my-team', 'tool_activity');
  });
});
