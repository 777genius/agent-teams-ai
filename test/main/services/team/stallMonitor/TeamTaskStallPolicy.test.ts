import { describe, expect, it } from 'vitest';

import { TeamTaskStallPolicy } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallPolicy';

import type {
  TeamTaskStallExactRow,
  TeamTaskStallSnapshot,
} from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallTypes';
import type { BoardTaskActivityRecord } from '../../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityRecord';
import type { ParsedMessage } from '../../../../../src/main/types';
import type { TeamTask } from '../../../../../src/shared/types';

function createParsedMessage(overrides: Partial<ParsedMessage>): ParsedMessage {
  return {
    uuid: 'msg-default',
    parentUuid: null,
    type: 'assistant',
    timestamp: new Date('2026-04-19T12:00:00.000Z'),
    content: '',
    isSidechain: true,
    isMeta: false,
    toolCalls: [],
    toolResults: [],
    ...overrides,
  };
}

function createExactRow(overrides: Partial<TeamTaskStallExactRow> = {}): TeamTaskStallExactRow {
  return {
    filePath: '/tmp/session.jsonl',
    sourceOrder: 1,
    messageUuid: 'msg-touch',
    timestamp: '2026-04-19T12:00:00.000Z',
    parsedMessage: createParsedMessage({ uuid: 'msg-touch' }),
    toolUseIds: [],
    toolResultIds: [],
    ...overrides,
  };
}

function createRecord(overrides: Partial<BoardTaskActivityRecord> = {}): BoardTaskActivityRecord {
  return {
    id: 'rec-1',
    timestamp: '2026-04-19T12:00:00.000Z',
    task: {
      locator: {
        ref: 'task-a',
        refKind: 'canonical',
        canonicalId: 'task-a',
      },
      resolution: 'resolved',
      taskRef: {
        taskId: 'task-a',
        displayId: 'abcd1234',
        teamName: 'demo',
      },
    },
    linkKind: 'board_action',
    targetRole: 'subject',
    actor: {
      memberName: 'alice',
      role: 'member',
      sessionId: 'session-a',
      isSidechain: true,
    },
    actorContext: {
      relation: 'same_task',
    },
    action: {
      canonicalToolName: 'task_start',
      category: 'status',
      toolUseId: 'tool-1',
    },
    source: {
      messageUuid: 'msg-touch',
      filePath: '/tmp/session.jsonl',
      toolUseId: 'tool-1',
      sourceOrder: 1,
    },
    ...overrides,
  };
}

function createSnapshot(overrides: Partial<TeamTaskStallSnapshot>): TeamTaskStallSnapshot {
  return {
    teamName: 'demo',
    scannedAt: '2026-04-19T12:30:00.000Z',
    projectDir: '/tmp/project',
    projectId: 'project-id',
    leadName: 'team-lead',
    transcriptFiles: ['/tmp/session.jsonl'],
    activityReadsEnabled: true,
    exactReadsEnabled: true,
    activeTasks: [],
    deletedTasks: [],
    allTasksById: new Map(),
    inProgressTasks: [],
    reviewOpenTasks: [],
    resolvedReviewersByTaskId: new Map(),
    recordsByTaskId: new Map(),
    freshnessByTaskId: new Map(),
    exactRowsByFilePath: new Map(),
    providerByMemberName: new Map(),
    ...overrides,
  };
}

describe('TeamTaskStallPolicy', () => {
  const policy = new TeamTaskStallPolicy();

  it('does not treat malformed empty completedAt as an open work interval', () => {
    const task: TeamTask = {
      id: 'task-closed-empty',
      displayId: 'feed0000',
      subject: 'Malformed closed interval',
      owner: 'alice',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-04-19T11:50:00.000Z', completedAt: '' }],
    };

    const evaluation = policy.evaluateWork({
      now: new Date('2026-04-19T12:30:00.000Z'),
      task,
      snapshot: createSnapshot({
        activeTasks: [task],
        allTasksById: new Map([[task.id, task]]),
        inProgressTasks: [task],
      }),
    });

    expect(evaluation).toMatchObject({
      status: 'skip',
      taskId: 'task-closed-empty',
      skipReason: 'no_open_work_interval',
    });
  });

  it('alerts for work stall after turn ended and threshold elapsed', () => {
    const task: TeamTask = {
      id: 'task-a',
      displayId: 'abcd1234',
      subject: 'Task A',
      owner: 'alice',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-04-19T11:50:00.000Z' }],
    };
    const record = createRecord();
    const snapshot = createSnapshot({
      activeTasks: [task],
      allTasksById: new Map([['task-a', task]]),
      inProgressTasks: [task],
      recordsByTaskId: new Map([['task-a', [record]]]),
      exactRowsByFilePath: new Map([
        [
          '/tmp/session.jsonl',
          [
            createExactRow({
              messageUuid: 'msg-touch',
              toolUseIds: ['tool-1'],
            }),
            createExactRow({
              sourceOrder: 2,
              messageUuid: 'msg-turn-end',
              systemSubtype: 'turn_duration',
              parsedMessage: createParsedMessage({
                uuid: 'msg-turn-end',
                type: 'system',
              }),
            }),
          ],
        ],
      ]),
    });

    const evaluation = policy.evaluateWork({
      now: new Date('2026-04-19T12:30:00.000Z'),
      task,
      snapshot,
    });

    expect(evaluation).toMatchObject({
      status: 'alert',
      taskId: 'task-a',
      branch: 'work',
      signal: 'turn_ended_after_touch',
    });
  });

  it.each([
    ['completed', { status: 'completed' }],
    ['approved', { status: 'in_progress', reviewState: 'approved' }],
    ['soft-deleted', { status: 'in_progress', deletedAt: '2026-04-19T12:05:00.000Z' }],
  ] as const)('does not treat %s blockers as active stall blockers', (_label, blockerState) => {
    const blocker: TeamTask = {
      id: 'task-blocker',
      displayId: 'block123',
      subject: 'Finished dependency',
      ...blockerState,
    };
    const task: TeamTask = {
      id: 'task-a',
      displayId: 'abcd1234',
      subject: 'Task A',
      owner: 'alice',
      status: 'in_progress',
      blockedBy: [` ${blocker.id} `],
      workIntervals: [{ startedAt: '2026-04-19T11:50:00.000Z' }],
    };
    const snapshot = createSnapshot({
      activeTasks: [task],
      allTasksById: new Map([
        [task.id, task],
        [blocker.id, blocker],
      ]),
      inProgressTasks: [task],
      recordsByTaskId: new Map([[task.id, [createRecord()]]]),
      exactRowsByFilePath: new Map([
        [
          '/tmp/session.jsonl',
          [
            createExactRow({
              messageUuid: 'msg-touch',
              toolUseIds: ['tool-1'],
            }),
            createExactRow({
              sourceOrder: 2,
              messageUuid: 'msg-turn-end',
              systemSubtype: 'turn_duration',
              parsedMessage: createParsedMessage({
                uuid: 'msg-turn-end',
                type: 'system',
              }),
            }),
          ],
        ],
      ]),
    });

    const evaluation = policy.evaluateWork({
      now: new Date('2026-04-19T12:30:00.000Z'),
      task,
      snapshot,
    });

    expect(evaluation).toMatchObject({
      status: 'alert',
      taskId: 'task-a',
      branch: 'work',
      signal: 'turn_ended_after_touch',
    });
  });

  it.each([
    ['in-progress', { status: 'in_progress' }],
    ['completed in review', { status: 'completed', reviewState: 'review' }],
  ] as const)('still skips work tasks with %s blockers', (_label, blockerState) => {
    const blocker: TeamTask = {
      id: 'task-blocker',
      displayId: 'block123',
      subject: 'Unfinished dependency',
      ...blockerState,
    };
    const task: TeamTask = {
      id: 'task-a',
      displayId: 'abcd1234',
      subject: 'Task A',
      owner: 'alice',
      status: 'in_progress',
      blockedBy: [blocker.id],
      workIntervals: [{ startedAt: '2026-04-19T11:50:00.000Z' }],
    };

    const evaluation = policy.evaluateWork({
      now: new Date('2026-04-19T12:30:00.000Z'),
      task,
      snapshot: createSnapshot({
        activeTasks: [task, blocker],
        allTasksById: new Map([
          [task.id, task],
          [blocker.id, blocker],
        ]),
        inProgressTasks: [task, blocker],
      }),
    });

    expect(evaluation).toMatchObject({
      status: 'skip',
      taskId: 'task-a',
      skipReason: 'task_blocked',
    });
  });

  it('keeps work tasks blocked when a blocker id cannot be resolved', () => {
    const task: TeamTask = {
      id: 'task-a',
      displayId: 'abcd1234',
      subject: 'Task A',
      owner: 'alice',
      status: 'in_progress',
      blockedBy: ['missing-blocker'],
      workIntervals: [{ startedAt: '2026-04-19T11:50:00.000Z' }],
    };

    const evaluation = policy.evaluateWork({
      now: new Date('2026-04-19T12:30:00.000Z'),
      task,
      snapshot: createSnapshot({
        activeTasks: [task],
        allTasksById: new Map([[task.id, task]]),
        inProgressTasks: [task],
      }),
    });

    expect(evaluation).toMatchObject({
      status: 'skip',
      taskId: 'task-a',
      skipReason: 'task_blocked',
    });
  });

  it.each([
    ['turn_ended_after_touch', 4],
    ['touch_then_other_turns', 5],
    ['mid_turn_after_touch', 10],
  ] as const)('uses the aggressive work threshold for %s', (signal, thresholdMinutes) => {
    const task: TeamTask = {
      id: 'task-work-threshold',
      displayId: 'abcd4444',
      subject: 'Work threshold',
      owner: 'alice',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-04-19T11:50:00.000Z' }],
    };
    const turnEndRow = createExactRow({
      sourceOrder: 2,
      messageUuid: 'msg-turn-end',
      systemSubtype: 'turn_duration',
      parsedMessage: createParsedMessage({
        uuid: 'msg-turn-end',
        type: 'system',
      }),
    });
    const laterAssistantRow = createExactRow({
      sourceOrder: 3,
      messageUuid: 'msg-later',
      parsedMessage: createParsedMessage({
        uuid: 'msg-later',
        type: 'assistant',
      }),
    });
    const postTouchRows =
      signal === 'touch_then_other_turns'
        ? [turnEndRow, laterAssistantRow]
        : signal === 'mid_turn_after_touch'
          ? [laterAssistantRow]
          : [turnEndRow];
    const snapshot = createSnapshot({
      activeTasks: [task],
      allTasksById: new Map([[task.id, task]]),
      inProgressTasks: [task],
      recordsByTaskId: new Map([[task.id, [createRecord()]]]),
      exactRowsByFilePath: new Map([
        [
          '/tmp/session.jsonl',
          [
            createExactRow({
              messageUuid: 'msg-touch',
              toolUseIds: ['tool-1'],
            }),
            ...postTouchRows,
          ],
        ],
      ]),
    });
    const touchAtMs = Date.parse('2026-04-19T12:00:00.000Z');

    expect(
      policy.evaluateWork({
        now: new Date(touchAtMs + thresholdMinutes * 60_000 - 1),
        task,
        snapshot,
      })
    ).toMatchObject({
      status: 'skip',
      skipReason: 'below_threshold',
    });
    expect(
      policy.evaluateWork({
        now: new Date(touchAtMs + thresholdMinutes * 60_000),
        task,
        snapshot,
      })
    ).toMatchObject({
      status: 'alert',
      signal,
    });
  });

  it('alerts OpenCode-owned tasks faster after weak start-only task comments', () => {
    const task: TeamTask = {
      id: 'task-open-weak',
      displayId: 'feed1111',
      subject: 'OpenCode weak start',
      owner: 'alice',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-04-19T11:50:00.000Z' }],
      comments: [
        {
          id: 'comment-weak',
          author: 'alice',
          text: 'Начинаю работу.',
          createdAt: '2026-04-19T12:00:00.000Z',
          type: 'regular',
        },
      ],
    };
    const record = createRecord({
      task: {
        locator: {
          ref: 'task-open-weak',
          refKind: 'canonical',
          canonicalId: 'task-open-weak',
        },
        resolution: 'resolved',
        taskRef: {
          taskId: 'task-open-weak',
          displayId: 'feed1111',
          teamName: 'demo',
        },
      },
      action: {
        canonicalToolName: 'task_add_comment',
        category: 'comment',
        toolUseId: 'tool-weak',
        details: { commentId: 'comment-weak' },
      },
      source: {
        messageUuid: 'msg-touch',
        filePath: '/tmp/session.jsonl',
        toolUseId: 'tool-weak',
        sourceOrder: 1,
      },
    });
    const snapshot = createSnapshot({
      activeTasks: [task],
      allTasksById: new Map([[task.id, task]]),
      inProgressTasks: [task],
      providerByMemberName: new Map([['alice', 'opencode']]),
      recordsByTaskId: new Map([[task.id, [record]]]),
      exactRowsByFilePath: new Map([
        [
          '/tmp/session.jsonl',
          [
            createExactRow({
              messageUuid: 'msg-touch',
              toolUseIds: ['tool-weak'],
            }),
            createExactRow({
              sourceOrder: 2,
              messageUuid: 'msg-turn-end',
              systemSubtype: 'turn_duration',
              parsedMessage: createParsedMessage({
                uuid: 'msg-turn-end',
                type: 'system',
              }),
            }),
          ],
        ],
      ]),
    });

    const touchAtMs = Date.parse('2026-04-19T12:00:00.000Z');

    expect(
      policy.evaluateWork({
        now: new Date(touchAtMs + 100_000 - 1),
        task,
        snapshot,
      })
    ).toMatchObject({
      status: 'skip',
      taskId: 'task-open-weak',
      skipReason: 'below_threshold',
    });
    expect(
      policy.evaluateWork({
        now: new Date(touchAtMs + 100_000),
        task,
        snapshot,
      })
    ).toMatchObject({
      status: 'alert',
      taskId: 'task-open-weak',
      progressSignal: 'weak_start_only',
      reason: 'Potential work stall after weak start-only task comment.',
    });
  });

  it('uses normal work thresholds for weak comments from non-OpenCode owners', () => {
    const task: TeamTask = {
      id: 'task-codex-weak',
      displayId: 'feed2222',
      subject: 'Codex weak start',
      owner: 'alice',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-04-19T11:50:00.000Z' }],
      comments: [
        {
          id: 'comment-weak',
          author: 'alice',
          text: 'Will start.',
          createdAt: '2026-04-19T12:00:00.000Z',
          type: 'regular',
        },
      ],
    };
    const record = createRecord({
      task: {
        locator: {
          ref: 'task-codex-weak',
          refKind: 'canonical',
          canonicalId: 'task-codex-weak',
        },
        resolution: 'resolved',
        taskRef: {
          taskId: 'task-codex-weak',
          displayId: 'feed2222',
          teamName: 'demo',
        },
      },
      action: {
        canonicalToolName: 'task_add_comment',
        category: 'comment',
        toolUseId: 'tool-weak',
        details: { commentId: 'comment-weak' },
      },
      source: {
        messageUuid: 'msg-touch',
        filePath: '/tmp/session.jsonl',
        toolUseId: 'tool-weak',
        sourceOrder: 1,
      },
    });
    const snapshot = createSnapshot({
      activeTasks: [task],
      allTasksById: new Map([[task.id, task]]),
      inProgressTasks: [task],
      providerByMemberName: new Map([['alice', 'codex']]),
      recordsByTaskId: new Map([[task.id, [record]]]),
      exactRowsByFilePath: new Map([
        [
          '/tmp/session.jsonl',
          [
            createExactRow({
              messageUuid: 'msg-touch',
              toolUseIds: ['tool-weak'],
            }),
            createExactRow({
              sourceOrder: 2,
              messageUuid: 'msg-turn-end',
              systemSubtype: 'turn_duration',
              parsedMessage: createParsedMessage({
                uuid: 'msg-turn-end',
                type: 'system',
              }),
            }),
          ],
        ],
      ]),
    });

    const evaluation = policy.evaluateWork({
      now: new Date('2026-04-19T12:03:00.000Z'),
      task,
      snapshot,
    });

    expect(evaluation).toMatchObject({
      status: 'skip',
      taskId: 'task-codex-weak',
      skipReason: 'below_threshold',
    });
  });

  it('does not apply weak-start threshold to concrete task comments', () => {
    const task: TeamTask = {
      id: 'task-open-strong',
      displayId: 'feed3333',
      subject: 'OpenCode concrete progress',
      owner: 'alice',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-04-19T11:50:00.000Z' }],
      comments: [
        {
          id: 'comment-strong',
          author: 'alice',
          text: 'Found the failing test in src/app.ts and reproduced it with pnpm test.',
          createdAt: '2026-04-19T12:00:00.000Z',
          type: 'regular',
        },
      ],
    };
    const record = createRecord({
      task: {
        locator: {
          ref: 'task-open-strong',
          refKind: 'canonical',
          canonicalId: 'task-open-strong',
        },
        resolution: 'resolved',
        taskRef: {
          taskId: 'task-open-strong',
          displayId: 'feed3333',
          teamName: 'demo',
        },
      },
      action: {
        canonicalToolName: 'task_add_comment',
        category: 'comment',
        toolUseId: 'tool-strong',
        details: { commentId: 'comment-strong' },
      },
      source: {
        messageUuid: 'msg-touch',
        filePath: '/tmp/session.jsonl',
        toolUseId: 'tool-strong',
        sourceOrder: 1,
      },
    });
    const snapshot = createSnapshot({
      activeTasks: [task],
      allTasksById: new Map([[task.id, task]]),
      inProgressTasks: [task],
      providerByMemberName: new Map([['alice', 'opencode']]),
      recordsByTaskId: new Map([[task.id, [record]]]),
      exactRowsByFilePath: new Map([
        [
          '/tmp/session.jsonl',
          [
            createExactRow({
              messageUuid: 'msg-touch',
              toolUseIds: ['tool-strong'],
            }),
            createExactRow({
              sourceOrder: 2,
              messageUuid: 'msg-turn-end',
              systemSubtype: 'turn_duration',
              parsedMessage: createParsedMessage({
                uuid: 'msg-turn-end',
                type: 'system',
              }),
            }),
          ],
        ],
      ]),
    });

    const evaluation = policy.evaluateWork({
      now: new Date('2026-04-19T12:03:00.000Z'),
      task,
      snapshot,
    });

    expect(evaluation).toMatchObject({
      status: 'skip',
      taskId: 'task-open-strong',
      skipReason: 'below_threshold',
    });
  });

  it('treats an OpenCode lane that settled after the touch as a turn end (4 min, not 10)', () => {
    const task: TeamTask = {
      id: 'task-open-settled',
      displayId: 'feed4444',
      subject: 'OpenCode silent after concrete progress',
      owner: 'Worker',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-04-19T11:50:00.000Z' }],
      comments: [
        {
          id: 'comment-strong',
          author: 'Worker',
          text: 'Found the failing test in src/app.ts and reproduced it with pnpm test.',
          createdAt: '2026-04-19T12:00:00.000Z',
          type: 'regular',
        },
      ],
    };
    const record = createRecord({
      task: {
        locator: {
          ref: 'task-open-settled',
          refKind: 'canonical',
          canonicalId: 'task-open-settled',
        },
        resolution: 'resolved',
        taskRef: {
          taskId: 'task-open-settled',
          displayId: 'feed4444',
          teamName: 'demo',
        },
      },
      actor: { memberName: 'Worker', role: 'member', sessionId: 'session-1', isSidechain: true },
      action: {
        canonicalToolName: 'task_add_comment',
        category: 'comment',
        toolUseId: 'tool-strong',
        details: { commentId: 'comment-strong' },
      },
      source: {
        messageUuid: 'msg-touch',
        filePath: 'opencode-runtime:demo:worker',
        toolUseId: 'tool-strong',
        sourceOrder: 1,
      },
    });
    // The orchestrator projection has no turn-end row: only the touch and an
    // empty assistant message after it.
    const exactRowsByFilePath = new Map([
      [
        'opencode-runtime:demo:worker',
        [
          createExactRow({
            messageUuid: 'msg-touch',
            toolUseIds: ['tool-strong'],
          }),
          createExactRow({
            sourceOrder: 2,
            messageUuid: 'msg-empty-assistant',
            parsedMessage: createParsedMessage({ uuid: 'msg-empty-assistant' }),
          }),
        ],
      ],
    ]);
    const baseSnapshot = {
      activeTasks: [task],
      allTasksById: new Map([[task.id, task]]),
      inProgressTasks: [task],
      providerByMemberName: new Map([['worker', 'opencode' as const]]),
      recordsByTaskId: new Map([[task.id, [record]]]),
      exactRowsByFilePath,
    };

    // Without lane state the classifier sees a mid-turn touch: 10-minute threshold.
    const withoutLaneState = policy.evaluateWork({
      now: new Date('2026-04-19T12:05:00.000Z'),
      task,
      snapshot: createSnapshot(baseSnapshot),
    });
    expect(withoutLaneState).toMatchObject({ status: 'skip', skipReason: 'below_threshold' });

    // The lane settled after the touch: the turn ended, 4-minute threshold applies.
    const settled = policy.evaluateWork({
      now: new Date('2026-04-19T12:05:00.000Z'),
      task,
      snapshot: createSnapshot({
        ...baseSnapshot,
        openCodeLaneIdleSinceByMemberName: new Map([['worker', '2026-04-19T12:00:30.000Z']]),
      }),
    });
    expect(settled).toMatchObject({
      status: 'alert',
      branch: 'work',
      signal: 'turn_ended_after_touch',
      memberName: 'Worker',
    });
    expect(settled.reason).toContain('OpenCode lane idle since 2026-04-19T12:00:30.000Z');

    // A lane that went idle BEFORE the touch says nothing about this turn.
    const staleIdle = policy.evaluateWork({
      now: new Date('2026-04-19T12:05:00.000Z'),
      task,
      snapshot: createSnapshot({
        ...baseSnapshot,
        openCodeLaneIdleSinceByMemberName: new Map([['worker', '2026-04-19T11:59:00.000Z']]),
      }),
    });
    expect(staleIdle).toMatchObject({ status: 'skip', skipReason: 'below_threshold' });

    // A non-OpenCode owner is not reclassified by lane state at all: the very
    // same settle sample must leave the 10-minute mid-turn threshold in place.
    const nonOpenCodeOwner = policy.evaluateWork({
      now: new Date('2026-04-19T12:05:00.000Z'),
      task,
      snapshot: createSnapshot({
        ...baseSnapshot,
        providerByMemberName: new Map([['worker', 'anthropic' as const]]),
        openCodeLaneIdleSinceByMemberName: new Map([['worker', '2026-04-19T12:00:30.000Z']]),
      }),
    });
    expect(nonOpenCodeOwner).toMatchObject({ status: 'skip', skipReason: 'below_threshold' });

    // A lane still generating is never nudged, even past the 10-minute threshold.
    const active = policy.evaluateWork({
      now: new Date('2026-04-19T12:11:00.000Z'),
      task,
      snapshot: createSnapshot({
        ...baseSnapshot,
        openCodeLaneIdleSinceByMemberName: new Map(),
        openCodeLaneActiveMemberNames: new Set(['worker']),
      }),
    });
    expect(active).toMatchObject({ status: 'skip', skipReason: 'lane_active' });
  });

  it('leaves a non-OpenCode owner untouched by lane turn state', () => {
    const task: TeamTask = {
      id: 'task-anthropic-lane-noise',
      displayId: 'feed6666',
      subject: 'Anthropic owner with a same-named OpenCode lane sample',
      owner: 'worker',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-04-19T11:50:00.000Z' }],
    };
    const evaluation = policy.evaluateWork({
      now: new Date('2026-04-19T12:11:00.000Z'),
      task,
      snapshot: createSnapshot({
        activeTasks: [task],
        allTasksById: new Map([[task.id, task]]),
        inProgressTasks: [task],
        providerByMemberName: new Map([['worker', 'anthropic']]),
        openCodeLaneActiveMemberNames: new Set(['worker']),
      }),
    });
    // The OpenCode-only guards must not swallow a non-OpenCode owner's stall.
    expect(evaluation).toMatchObject({
      status: 'skip',
      skipReason: 'non_instrumented_run',
    });
  });

  it('does not nudge an OpenCode owner without progress evidence while its lane is active', () => {
    const task: TeamTask = {
      id: 'task-open-active',
      displayId: 'feed5555',
      subject: 'OpenCode no evidence, lane busy',
      owner: 'alice',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-04-19T11:50:00.000Z' }],
    };
    const evaluation = policy.evaluateWork({
      now: new Date('2026-04-19T12:00:00.000Z'),
      task,
      snapshot: createSnapshot({
        activeTasks: [task],
        allTasksById: new Map([[task.id, task]]),
        inProgressTasks: [task],
        providerByMemberName: new Map([['alice', 'opencode']]),
        openCodeLaneActiveMemberNames: new Set(['alice']),
      }),
    });
    expect(evaluation).toMatchObject({ status: 'skip', skipReason: 'lane_active' });
  });

  it('alerts OpenCode-owned tasks with no instrumented owner progress after threshold', () => {
    const task: TeamTask = {
      id: 'task-open-no-progress',
      displayId: 'feed4444',
      subject: 'OpenCode no progress',
      owner: 'alice',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-04-19T12:00:00.000Z' }],
    };
    const snapshot = createSnapshot({
      activeTasks: [task],
      allTasksById: new Map([[task.id, task]]),
      inProgressTasks: [task],
      providerByMemberName: new Map([['alice', 'opencode']]),
    });

    const evaluation = policy.evaluateWork({
      now: new Date('2026-04-19T12:07:00.000Z'),
      task,
      snapshot,
    });

    expect(evaluation).toMatchObject({
      status: 'alert',
      taskId: 'task-open-no-progress',
      branch: 'work',
      signal: 'mid_turn_after_touch',
      progressSignal: 'unknown',
      reason: 'Potential OpenCode task stall without owner progress evidence.',
    });
    expect(evaluation.epochKey).toContain('opencode_no_owner_progress');
  });

  it('lets the work branch keep alerting while the pickup gate is off', () => {
    vi.stubEnv('CLAUDE_TEAM_PENDING_PICKUP_STALL_REMEDIATION_ENABLED', '0');

    const inProgress: TeamTask = {
      id: 'task-open-no-progress',
      displayId: 'feed4444',
      subject: 'OpenCode no progress',
      owner: 'alice',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-04-19T12:00:00.000Z' }],
    };
    const pending: TeamTask = {
      id: 'task-pending',
      displayId: 'feed5555',
      subject: 'Never started',
      owner: 'alice',
      status: 'pending',
      createdAt: '2026-04-19T12:00:00.000Z',
    };
    const snapshot = createSnapshot({
      activeTasks: [inProgress, pending],
      allTasksById: new Map([
        [inProgress.id, inProgress],
        [pending.id, pending],
      ]),
      inProgressTasks: [inProgress],
      pendingPickupTasks: [pending],
      providerByMemberName: new Map([['alice', 'opencode']]),
    });
    const now = new Date('2026-04-19T12:07:00.000Z');

    expect(policy.evaluatePendingPickup({ now, task: pending, snapshot })).toMatchObject({
      status: 'skip',
      skipReason: 'pickup_remediation_disabled',
    });
    expect(policy.evaluateWork({ now, task: inProgress, snapshot })).toMatchObject({
      status: 'alert',
      taskId: 'task-open-no-progress',
      branch: 'work',
      signal: 'mid_turn_after_touch',
    });

    vi.unstubAllEnvs();
  });

  it('keeps non-OpenCode no-progress tasks on the existing non-instrumented skip path', () => {
    const task: TeamTask = {
      id: 'task-codex-no-progress',
      displayId: 'feed5555',
      subject: 'Codex no progress',
      owner: 'alice',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-04-19T12:00:00.000Z' }],
    };

    const evaluation = policy.evaluateWork({
      now: new Date('2026-04-19T12:30:00.000Z'),
      task,
      snapshot: createSnapshot({
        activeTasks: [task],
        allTasksById: new Map([[task.id, task]]),
        inProgressTasks: [task],
        providerByMemberName: new Map([['alice', 'codex']]),
      }),
    });

    expect(evaluation).toMatchObject({
      status: 'skip',
      taskId: 'task-codex-no-progress',
      skipReason: 'non_instrumented_run',
    });
  });

  it('alerts OpenCode-owned tasks with records but no owner work touch after threshold', () => {
    const task: TeamTask = {
      id: 'task-open-no-touch',
      displayId: 'feed6666',
      subject: 'OpenCode no owner touch',
      owner: 'alice',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-04-19T12:00:00.000Z' }],
    };
    const record = createRecord({
      actor: {
        memberName: 'bob',
        role: 'member',
        sessionId: 'session-b',
        isSidechain: true,
      },
    });

    const evaluation = policy.evaluateWork({
      now: new Date('2026-04-19T12:07:00.000Z'),
      task,
      snapshot: createSnapshot({
        activeTasks: [task],
        allTasksById: new Map([[task.id, task]]),
        inProgressTasks: [task],
        providerByMemberName: new Map([['alice', 'opencode']]),
        recordsByTaskId: new Map([[task.id, [record]]]),
      }),
    });

    expect(evaluation).toMatchObject({
      status: 'alert',
      taskId: 'task-open-no-touch',
      reason: 'Potential OpenCode task stall without owner work touch.',
    });
  });

  it('fails closed on review branch when review has not started yet', () => {
    const task: TeamTask = {
      id: 'task-b',
      displayId: 'deadbeef',
      subject: 'Task B',
      status: 'completed',
      reviewState: 'review',
      historyEvents: [
        {
          id: 'evt-review-requested',
          type: 'review_requested',
          timestamp: '2026-04-19T12:00:00.000Z',
          from: 'none',
          to: 'review',
        },
      ],
    };

    const evaluation = policy.evaluateReview({
      now: new Date('2026-04-19T12:30:00.000Z'),
      task,
      snapshot: createSnapshot({
        activeTasks: [task],
        allTasksById: new Map([['task-b', task]]),
        reviewOpenTasks: [task],
      }),
    });

    expect(evaluation).toMatchObject({
      status: 'skip',
      taskId: 'task-b',
      skipReason: 'no_open_review_window',
    });
  });

  it('fails closed on review branch when reviewer cannot be resolved after review has started', () => {
    const task: TeamTask = {
      id: 'task-b2',
      displayId: 'deadbe12',
      subject: 'Task B2',
      status: 'completed',
      reviewState: 'review',
      historyEvents: [
        {
          id: 'evt-review-started',
          type: 'review_started',
          timestamp: '2026-04-19T12:01:00.000Z',
          from: 'review',
          to: 'review',
        },
      ],
    };

    const evaluation = policy.evaluateReview({
      now: new Date('2026-04-19T12:30:00.000Z'),
      task,
      snapshot: createSnapshot({
        activeTasks: [task],
        allTasksById: new Map([['task-b2', task]]),
        reviewOpenTasks: [task],
      }),
    });

    expect(evaluation).toMatchObject({
      status: 'skip',
      taskId: 'task-b2',
      skipReason: 'reviewer_unresolved',
    });
  });

  it('does not treat review_requested alone as started-review evidence', () => {
    const task: TeamTask = {
      id: 'task-review-requested-only',
      displayId: 'feedbeef',
      subject: 'Task review requested only',
      status: 'completed',
      reviewState: 'review',
      historyEvents: [
        {
          id: 'evt-review-requested',
          type: 'review_requested',
          timestamp: '2026-04-19T12:00:00.000Z',
          from: 'none',
          to: 'review',
          reviewer: 'bob',
        },
      ],
    };

    const evaluation = policy.evaluateReview({
      now: new Date('2026-04-19T12:30:00.000Z'),
      task,
      snapshot: createSnapshot({
        activeTasks: [task],
        allTasksById: new Map([['task-review-requested-only', task]]),
        reviewOpenTasks: [task],
        resolvedReviewersByTaskId: new Map([
          [
            'task-review-requested-only',
            { reviewer: 'bob', source: 'history_review_requested_reviewer' },
          ],
        ]),
      }),
    });

    expect(evaluation).toMatchObject({
      status: 'skip',
      taskId: 'task-review-requested-only',
      skipReason: 'no_open_review_window',
    });
  });

  it('alerts for started-review stall after explicit review_start evidence', () => {
    const task: TeamTask = {
      id: 'task-c',
      displayId: 'c0ffee12',
      subject: 'Task C',
      status: 'completed',
      reviewState: 'review',
      historyEvents: [
        {
          id: 'evt-review-requested',
          type: 'review_requested',
          timestamp: '2026-04-19T12:00:00.000Z',
          from: 'none',
          to: 'review',
          reviewer: 'bob',
        },
        {
          id: 'evt-review-started',
          type: 'review_started',
          timestamp: '2026-04-19T12:01:00.000Z',
          from: 'review',
          to: 'review',
          actor: 'bob',
        },
      ],
    };
    const record = createRecord({
      id: 'rec-review',
      timestamp: '2026-04-19T12:01:00.000Z',
      actor: {
        memberName: 'bob',
        role: 'member',
        sessionId: 'session-b',
        isSidechain: true,
      },
      actorContext: {
        relation: 'same_task',
        activePhase: 'review',
      },
      action: {
        canonicalToolName: 'review_start',
        category: 'review',
        toolUseId: 'tool-review',
      },
      source: {
        messageUuid: 'msg-review-touch',
        filePath: '/tmp/review.jsonl',
        toolUseId: 'tool-review',
        sourceOrder: 1,
      },
    });

    const evaluation = policy.evaluateReview({
      now: new Date('2026-04-19T12:20:30.000Z'),
      task,
      snapshot: createSnapshot({
        activeTasks: [task],
        allTasksById: new Map([['task-c', task]]),
        reviewOpenTasks: [task],
        resolvedReviewersByTaskId: new Map([
          ['task-c', { reviewer: 'bob', source: 'history_review_started_actor' }],
        ]),
        recordsByTaskId: new Map([['task-c', [record]]]),
        exactRowsByFilePath: new Map([
          [
            '/tmp/review.jsonl',
            [
              createExactRow({
                filePath: '/tmp/review.jsonl',
                messageUuid: 'msg-review-touch',
                toolUseIds: ['tool-review'],
              }),
              createExactRow({
                filePath: '/tmp/review.jsonl',
                sourceOrder: 2,
                messageUuid: 'msg-review-turn-end',
                systemSubtype: 'turn_duration',
                parsedMessage: createParsedMessage({
                  uuid: 'msg-review-turn-end',
                  type: 'system',
                }),
              }),
            ],
          ],
        ]),
      }),
    });

    expect(evaluation).toMatchObject({
      status: 'alert',
      taskId: 'task-c',
      branch: 'review',
      signal: 'turn_ended_after_touch',
    });
  });

  it.each([
    ['turn_ended_after_touch', 5],
    ['touch_then_other_turns', 6],
    ['mid_turn_after_touch', 12],
  ] as const)('uses the aggressive review threshold for %s', (signal, thresholdMinutes) => {
    const task: TeamTask = {
      id: 'task-review-threshold',
      displayId: 'c0ffee55',
      subject: 'Review threshold',
      status: 'completed',
      reviewState: 'review',
      historyEvents: [
        {
          id: 'evt-review-started',
          type: 'review_started',
          timestamp: '2026-04-19T12:00:00.000Z',
          from: 'review',
          to: 'review',
          actor: 'bob',
        },
      ],
    };
    const turnEndRow = createExactRow({
      filePath: '/tmp/review-threshold.jsonl',
      sourceOrder: 2,
      messageUuid: 'msg-review-threshold-end',
      systemSubtype: 'turn_duration',
      parsedMessage: createParsedMessage({
        uuid: 'msg-review-threshold-end',
        type: 'system',
      }),
    });
    const laterAssistantRow = createExactRow({
      filePath: '/tmp/review-threshold.jsonl',
      sourceOrder: 3,
      messageUuid: 'msg-review-threshold-later',
      parsedMessage: createParsedMessage({
        uuid: 'msg-review-threshold-later',
        type: 'assistant',
      }),
    });
    const postTouchRows =
      signal === 'touch_then_other_turns'
        ? [turnEndRow, laterAssistantRow]
        : signal === 'mid_turn_after_touch'
          ? [laterAssistantRow]
          : [turnEndRow];
    const record = createRecord({
      timestamp: '2026-04-19T12:00:00.000Z',
      actor: {
        memberName: 'bob',
        role: 'member',
        sessionId: 'session-b',
        isSidechain: true,
      },
      actorContext: {
        relation: 'same_task',
        activePhase: 'review',
      },
      action: {
        canonicalToolName: 'review_start',
        category: 'review',
        toolUseId: 'tool-review-threshold',
      },
      source: {
        messageUuid: 'msg-review-threshold',
        filePath: '/tmp/review-threshold.jsonl',
        toolUseId: 'tool-review-threshold',
        sourceOrder: 1,
      },
    });
    const snapshot = createSnapshot({
      activeTasks: [task],
      allTasksById: new Map([[task.id, task]]),
      reviewOpenTasks: [task],
      resolvedReviewersByTaskId: new Map([
        [task.id, { reviewer: 'bob', source: 'history_review_started_actor' }],
      ]),
      recordsByTaskId: new Map([[task.id, [record]]]),
      exactRowsByFilePath: new Map([
        [
          '/tmp/review-threshold.jsonl',
          [
            createExactRow({
              filePath: '/tmp/review-threshold.jsonl',
              messageUuid: 'msg-review-threshold',
              toolUseIds: ['tool-review-threshold'],
            }),
            ...postTouchRows,
          ],
        ],
      ]),
    });
    const touchAtMs = Date.parse('2026-04-19T12:00:00.000Z');

    expect(
      policy.evaluateReview({
        now: new Date(touchAtMs + thresholdMinutes * 60_000 - 1),
        task,
        snapshot,
      })
    ).toMatchObject({
      status: 'skip',
      skipReason: 'below_threshold',
    });
    expect(
      policy.evaluateReview({
        now: new Date(touchAtMs + thresholdMinutes * 60_000),
        task,
        snapshot,
      })
    ).toMatchObject({
      status: 'alert',
      signal,
    });
  });

  it('alerts for started-review stall when review_started actor is missing but same-task reviewer touch exists after the review start', () => {
    const task: TeamTask = {
      id: 'task-d',
      displayId: 'ddaa5511',
      subject: 'Task D',
      status: 'completed',
      reviewState: 'review',
      historyEvents: [
        {
          id: 'evt-review-requested',
          type: 'review_requested',
          timestamp: '2026-04-19T12:00:00.000Z',
          from: 'none',
          to: 'review',
          reviewer: 'bob',
        },
        {
          id: 'evt-review-started',
          type: 'review_started',
          timestamp: '2026-04-19T12:01:00.000Z',
          from: 'review',
          to: 'review',
        },
      ],
    };
    const record = createRecord({
      id: 'rec-review-comment',
      timestamp: '2026-04-19T12:02:00.000Z',
      actor: {
        memberName: 'bob',
        role: 'member',
        sessionId: 'session-b',
        isSidechain: true,
      },
      actorContext: {
        relation: 'same_task',
        activePhase: 'review',
      },
      action: {
        canonicalToolName: 'task_add_comment',
        category: 'comment',
        toolUseId: 'tool-review-comment',
      },
      source: {
        messageUuid: 'msg-review-comment',
        filePath: '/tmp/review-missing-actor.jsonl',
        toolUseId: 'tool-review-comment',
        sourceOrder: 1,
      },
    });

    const evaluation = policy.evaluateReview({
      now: new Date('2026-04-19T12:20:30.000Z'),
      task,
      snapshot: createSnapshot({
        activeTasks: [task],
        allTasksById: new Map([['task-d', task]]),
        reviewOpenTasks: [task],
        resolvedReviewersByTaskId: new Map([
          ['task-d', { reviewer: 'bob', source: 'history_review_requested_reviewer' }],
        ]),
        recordsByTaskId: new Map([['task-d', [record]]]),
        exactRowsByFilePath: new Map([
          [
            '/tmp/review-missing-actor.jsonl',
            [
              createExactRow({
                filePath: '/tmp/review-missing-actor.jsonl',
                messageUuid: 'msg-review-comment',
                toolUseIds: ['tool-review-comment'],
              }),
              createExactRow({
                filePath: '/tmp/review-missing-actor.jsonl',
                sourceOrder: 2,
                messageUuid: 'msg-review-turn-end',
                systemSubtype: 'turn_duration',
                parsedMessage: createParsedMessage({
                  uuid: 'msg-review-turn-end',
                  type: 'system',
                }),
              }),
            ],
          ],
        ]),
      }),
    });

    expect(evaluation).toMatchObject({
      status: 'alert',
      taskId: 'task-d',
      branch: 'review',
      signal: 'turn_ended_after_touch',
    });
  });
});
