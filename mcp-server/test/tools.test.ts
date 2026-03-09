import fs from 'fs';
import os from 'os';
import path from 'path';

import { registerTools } from '../src/tools';

type RegisteredTool = {
  name: string;
  parameters?: { safeParse: (value: unknown) => { success: boolean } };
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown;
};

function collectTools() {
  const tools = new Map<string, RegisteredTool>();

  registerTools({
    addTool(config: RegisteredTool) {
      tools.set(config.name, config);
    },
  } as never);

  return tools;
}

function parseJsonToolResult(result: unknown) {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text;
  return JSON.parse(text);
}

describe('agent-teams-mcp tools', () => {
  const tools = collectTools();
  const expectedToolNames = [
    'cross_team_get_outbox',
    'cross_team_list_targets',
    'cross_team_send',
    'kanban_add_reviewer',
    'kanban_clear',
    'kanban_get',
    'kanban_list_reviewers',
    'kanban_remove_reviewer',
    'kanban_set_column',
    'message_send',
    'process_list',
    'process_register',
    'process_stop',
    'process_unregister',
    'review_approve',
    'review_request',
    'review_request_changes',
    'task_add_comment',
    'task_attach_comment_file',
    'task_attach_file',
    'task_briefing',
    'task_complete',
    'task_create',
    'task_get',
    'task_link',
    'task_list',
    'task_set_clarification',
    'task_set_owner',
    'task_set_status',
    'task_start',
    'task_unlink',
  ] as const;

  function getTool(name: string) {
    const tool = tools.get(name);
    expect(tool).toBeDefined();
    return tool!;
  }

  function makeClaudeDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-mcp-'));
  }

  it('registers the full expected MCP tool surface', () => {
    expect([...tools.keys()].sort()).toEqual([...expectedToolNames]);
  });

  it('covers task lifecycle, attachments, relationships, kanban, and review flows', async () => {
    const claudeDir = makeClaudeDir();
    const teamName = 'alpha';
    const attachmentPath = path.join(claudeDir, 'note.txt');
    fs.writeFileSync(attachmentPath, 'ship it');

    const dependencyTask = parseJsonToolResult(
      await getTool('task_create').execute({
        claudeDir,
        teamName,
        subject: 'Dependency',
      })
    );

    const createdTask = parseJsonToolResult(
      await getTool('task_create').execute({
        claudeDir,
        teamName,
        subject: 'Review MCP adapter',
        owner: 'alice',
      })
    );
    expect(createdTask.status).toBe('pending');

    const listedTasks = parseJsonToolResult(
      await getTool('task_list').execute({
        claudeDir,
        teamName,
      })
    );
    expect(listedTasks).toHaveLength(2);

    const linked = parseJsonToolResult(
      await getTool('task_link').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
        targetId: dependencyTask.id,
        relationship: 'blocked-by',
      })
    );
    expect(linked.blockedBy).toContain(dependencyTask.id);

    const unlinked = parseJsonToolResult(
      await getTool('task_unlink').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
        targetId: dependencyTask.id,
        relationship: 'blocked-by',
      })
    );
    expect(unlinked.blockedBy ?? []).not.toContain(dependencyTask.id);

    const owned = parseJsonToolResult(
      await getTool('task_set_owner').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
        owner: 'alice',
      })
    );
    expect(owned.owner).toBe('alice');

    const commented = parseJsonToolResult(
      await getTool('task_add_comment').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
        text: 'Need one more check',
        from: 'lead',
      })
    );

    const commentId = commented.commentId;
    expect(commentId).toBeTruthy();

    const ownerInboxPath = path.join(claudeDir, 'teams', teamName, 'inboxes', 'alice.json');
    const ownerInbox = JSON.parse(fs.readFileSync(ownerInboxPath, 'utf8'));
    expect(ownerInbox.at(-1).summary).toContain(`#${createdTask.displayId}`);
    expect(ownerInbox.at(-1).text).toContain('Need one more check');

    const attachment = parseJsonToolResult(
      await getTool('task_attach_comment_file').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
        commentId,
        filePath: attachmentPath,
        mode: 'copy',
      })
    );

    expect(attachment.filename).toBe('note.txt');

    const taskAttachment = parseJsonToolResult(
      await getTool('task_attach_file').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
        filePath: attachmentPath,
        mode: 'copy',
      })
    );
    expect(taskAttachment.filename).toBe('note.txt');

    await getTool('task_set_clarification').execute({
      claudeDir,
      teamName,
      taskId: createdTask.id,
      value: 'user',
    });

    const loadedTask = parseJsonToolResult(
      await getTool('task_get').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
      })
    );

    expect(loadedTask.needsClarification).toBe('user');
    expect(loadedTask.comments).toHaveLength(1);
    expect(loadedTask.comments[0].attachments).toHaveLength(1);
    expect(loadedTask.attachments).toHaveLength(1);

    const started = parseJsonToolResult(
      await getTool('task_start').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
        actor: 'alice',
      })
    );
    expect(started.status).toBe('in_progress');

    await getTool('task_set_status').execute({
      claudeDir,
      teamName,
      taskId: createdTask.id,
      status: 'completed',
    });

    parseJsonToolResult(
      await getTool('kanban_add_reviewer').execute({
        claudeDir,
        teamName,
        reviewer: 'alice',
      })
    );
    const reviewers = parseJsonToolResult(
      await getTool('kanban_list_reviewers').execute({
        claudeDir,
        teamName,
      })
    );
    expect(reviewers).toEqual(['alice']);

    const reviewRequested = parseJsonToolResult(
      await getTool('review_request').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
        from: 'lead',
        reviewer: 'alice',
        leadSessionId: 'session-review-1',
      })
    );

    expect(reviewRequested.reviewState).toBe('review');
    const reviewerInboxPath = path.join(claudeDir, 'teams', teamName, 'inboxes', 'alice.json');
    const reviewerInbox = JSON.parse(fs.readFileSync(reviewerInboxPath, 'utf8'));
    expect(reviewerInbox.at(-1).leadSessionId).toBe('session-review-1');

    const approved = parseJsonToolResult(
      await getTool('review_approve').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
        from: 'lead',
        note: 'Looks good',
        notifyOwner: true,
        leadSessionId: 'session-review-1',
      })
    );
    expect(approved.reviewState).toBe('approved');
    {
      const approvedInboxPath = path.join(claudeDir, 'teams', teamName, 'inboxes', 'alice.json');
      const approvedInbox = JSON.parse(fs.readFileSync(approvedInboxPath, 'utf8'));
      expect(approvedInbox.at(-1).leadSessionId).toBe('session-review-1');
    }

    const kanbanState = parseJsonToolResult(
      await getTool('kanban_get').execute({
        claudeDir,
        teamName,
      })
    );
    expect(kanbanState.tasks[createdTask.id].column).toBe('approved');

    const briefing = await getTool('task_briefing').execute({
      claudeDir,
      teamName,
      memberName: 'alice',
    });
    expect((briefing as { content: Array<{ text: string }> }).content[0]?.text).toContain(
      'Review MCP adapter'
    );
  });

  it('keeps owner-backed MCP tasks pending by default, supports explicit startImmediately, sends owner notifications, and returns compact task_briefing output', async () => {
    const claudeDir = makeClaudeDir();
    const teamName = 'gamma';

    const queuedTask = parseJsonToolResult(
      await getTool('task_create').execute({
        claudeDir,
        teamName,
        subject: 'Queued work',
        description: 'Pending description should stay out of briefing details',
        owner: 'alice',
        prompt: 'Read the plan before starting.',
      })
    );
    expect(queuedTask.status).toBe('pending');

    const activeTask = parseJsonToolResult(
      await getTool('task_create').execute({
        claudeDir,
        teamName,
        subject: 'Active work',
        description: 'This one is already in progress',
        owner: 'alice',
        startImmediately: true,
      })
    );
    expect(activeTask.status).toBe('in_progress');

    await getTool('task_add_comment').execute({
      claudeDir,
      teamName,
      taskId: activeTask.id,
      text: 'Investigating the active task now.',
      from: 'alice',
    });

    const completedTask = parseJsonToolResult(
      await getTool('task_create').execute({
        claudeDir,
        teamName,
        subject: 'Done work',
        description: 'Completed description should also stay compact',
        owner: 'alice',
      })
    );
    await getTool('task_complete').execute({
      claudeDir,
      teamName,
      taskId: completedTask.id,
      actor: 'alice',
    });

    const unassignedTask = parseJsonToolResult(
      await getTool('task_create').execute({
        claudeDir,
        teamName,
        subject: 'Assign later',
      })
    );
    await getTool('task_set_owner').execute({
      claudeDir,
      teamName,
      taskId: unassignedTask.id,
      owner: 'alice',
    });

    const queuedByHashRef = parseJsonToolResult(
      await getTool('task_get').execute({
        claudeDir,
        teamName,
        taskId: `#${queuedTask.displayId}`,
      })
    );
    expect(queuedByHashRef.id).toBe(queuedTask.id);

    const ownerInboxPath = path.join(claudeDir, 'teams', teamName, 'inboxes', 'alice.json');
    const ownerInbox = JSON.parse(fs.readFileSync(ownerInboxPath, 'utf8'));
    expect(ownerInbox).toHaveLength(4);
    expect(ownerInbox[0].summary).toContain(`#${queuedTask.displayId}`);
    expect(ownerInbox[0].text).toContain('task_get');
    expect(ownerInbox[0].text).toContain('task_start');
    expect(ownerInbox[0].text).toContain('Read the plan before starting.');
    expect(ownerInbox[3].summary).toContain(`#${unassignedTask.displayId}`);

    const briefing = (await getTool('task_briefing').execute({
      claudeDir,
      teamName,
      memberName: 'alice',
    })) as { content: Array<{ text: string }> };
    const briefingText = briefing.content[0]?.text ?? '';
    expect(briefingText).toContain('In progress:');
    expect(briefingText).toContain(`#${activeTask.displayId}`);
    expect(briefingText).toContain('Description: This one is already in progress');
    expect(briefingText).toContain('Investigating the active task now.');
    expect(briefingText).toContain('Pending:');
    expect(briefingText).toContain(`#${queuedTask.displayId}`);
    expect(briefingText).not.toContain('Pending description should stay out of briefing details');
    expect(briefingText).toContain('Completed:');
    expect(briefingText).toContain(`#${completedTask.displayId}`);
    expect(briefingText).not.toContain('Completed description should also stay compact');
  });

  it('covers review_request_changes and full process lifecycle tools', async () => {
    const claudeDir = makeClaudeDir();
    const teamName = 'beta';

    const createdTask = parseJsonToolResult(
      await getTool('task_create').execute({
        claudeDir,
        teamName,
        subject: 'Needs revision',
        owner: 'bob',
      })
    );

    await getTool('task_complete').execute({
      claudeDir,
      teamName,
      taskId: createdTask.id,
      actor: 'bob',
    });

    await getTool('review_request').execute({
      claudeDir,
      teamName,
      taskId: createdTask.id,
      from: 'lead',
      reviewer: 'alice',
      leadSessionId: 'session-review-2',
    });

    const changesRequested = parseJsonToolResult(
      await getTool('review_request_changes').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
        from: 'alice',
        comment: 'Please revise this section.',
        leadSessionId: 'session-review-2',
      })
    );

    expect(changesRequested.status).toBe('pending');
    expect(changesRequested.reviewState).toBe('needsFix');
    const ownerInboxPath = path.join(claudeDir, 'teams', teamName, 'inboxes', 'bob.json');
    const ownerInbox = JSON.parse(fs.readFileSync(ownerInboxPath, 'utf8'));
    expect(ownerInbox.at(-1).leadSessionId).toBe('session-review-2');
    expect(ownerInbox.at(-1).text).toContain('moved back to pending');

    const taskByHashRef = parseJsonToolResult(
      await getTool('task_get').execute({
        claudeDir,
        teamName,
        taskId: `#${createdTask.displayId}`,
      })
    );
    expect(taskByHashRef.reviewState).toBe('needsFix');

    const listedTasks = parseJsonToolResult(
      await getTool('task_list').execute({
        claudeDir,
        teamName,
      })
    );
    expect(listedTasks.find((task: { id: string }) => task.id === createdTask.id)?.reviewState).toBe(
      'needsFix'
    );

    const kanbanCleared = parseJsonToolResult(
      await getTool('kanban_clear').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
      })
    );
    expect(kanbanCleared.tasks[createdTask.id]).toBeUndefined();

    const pid = process.pid;

    const registered = parseJsonToolResult(
      await getTool('process_register').execute({
        claudeDir,
        teamName,
        pid,
        label: 'vite',
        command: 'pnpm dev',
        from: 'lead',
        port: 3000,
      })
    );

    expect(registered.pid).toBe(pid);
    expect(registered.label).toBe('vite');

    const listed = parseJsonToolResult(
      await getTool('process_list').execute({
        claudeDir,
        teamName,
      })
    );

    expect(listed).toHaveLength(1);
    expect(listed[0].pid).toBe(pid);

    const stopped = parseJsonToolResult(
      await getTool('process_stop').execute({
        claudeDir,
        teamName,
        pid,
      })
    );

    expect(stopped.pid).toBe(pid);
    expect(typeof stopped.stoppedAt).toBe('string');

    const unregistered = parseJsonToolResult(
      await getTool('process_unregister').execute({
        claudeDir,
        teamName,
        pid,
      })
    );
    expect(unregistered).toEqual([]);
  });

  it('persists full message metadata through message_send', async () => {
    const claudeDir = makeClaudeDir();
    const teamName = 'gamma';

    const sent = parseJsonToolResult(
      await getTool('message_send').execute({
        claudeDir,
        teamName,
        to: 'alice',
        text: 'Check this',
        from: 'lead',
        summary: 'Metadata test',
        source: 'system_notification',
        leadSessionId: 'session-42',
        attachments: [{ id: 'att-1', filename: 'note.txt', mimeType: 'text/plain', size: 4 }],
      })
    );

    expect(sent.deliveredToInbox).toBe(true);
    const inboxPath = path.join(claudeDir, 'teams', teamName, 'inboxes', 'alice.json');
    const rows = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
    expect(rows[0].source).toBe('system_notification');
    expect(rows[0].leadSessionId).toBe('session-42');
    expect(rows[0].attachments[0].filename).toBe('note.txt');
  });

  it('exposes zod schemas that reject obviously invalid payloads', () => {
    expect(
      getTool('task_create').parameters?.safeParse({
        teamName: 'demo',
        claudeDir: '/tmp/demo',
      }).success
    ).toBe(false);

    expect(
      getTool('process_register').parameters?.safeParse({
        teamName: 'demo',
        pid: 0,
        label: '',
      }).success
    ).toBe(false);
  });

  it('task_add_comment succeeds even when owner inbox write fails', async () => {
    const claudeDir = makeClaudeDir();
    const teamName = 'resilience';

    const task = parseJsonToolResult(
      await getTool('task_create').execute({
        claudeDir,
        teamName,
        subject: 'Comment resilience test',
        owner: 'alice',
        notifyOwner: false,
      })
    );

    // Corrupt the inbox file to force notification failure
    const inboxDir = path.join(claudeDir, 'teams', teamName, 'inboxes');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, 'alice.json'), 'BROKEN JSON');

    const commented = parseJsonToolResult(
      await getTool('task_add_comment').execute({
        claudeDir,
        teamName,
        taskId: task.id,
        text: 'Comment should persist despite broken inbox',
        from: 'bob',
      })
    );

    expect(commented.commentId).toBeTruthy();

    // Verify the comment is actually persisted on the task
    const reloaded = parseJsonToolResult(
      await getTool('task_get').execute({
        claudeDir,
        teamName,
        taskId: task.id,
      })
    );

    expect(reloaded.comments).toHaveLength(1);
    expect(reloaded.comments[0].text).toBe('Comment should persist despite broken inbox');
  });
});
