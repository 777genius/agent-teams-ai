const taskStore = require('./taskStore.js');
const runtimeHelpers = require('./runtimeHelpers.js');
const messages = require('./messages.js');
const messageStore = require('./messageStore.js');
const processStore = require('./processStore.js');
const kanbanStore = require('./kanbanStore.js');
const agenda = require('./agenda.js');
const { withTeamBoardLock } = require('./boardLock.js');
const { wrapAgentBlock } = require('./agentBlocks.js');
const { buildCommentNotificationMessage } = require('./taskCommentNotification.js');
const { findRecentDuplicateTask } = require('./taskCreationDeduplication.js');
const {
    createMemberMessagingProtocol,
    isCodexMember,
    isOpenCodeMember,
} = require('./memberMessagingProtocol.js');
const {
    assertKnownTaskActor,
    assertTaskNotDeleted,
    assertTaskOwnerChange,
    assertTaskOwnerMutation,
    isClearOwnerValue,
    isSameMember,
    isSameTaskMember,
    normalizeActorName,
    readMutableTask,
} = require('./taskOwnershipGuards.js');
const { buildAssignmentMessage } = require('./taskAssignmentMessage.js');
const { buildMemberLanguageInstruction } = require('./agentLanguage.js');
const {
    MEMBER_DELEGATE_DESCRIPTION,
    buildActionModeProtocolText,
    buildMemberActionModeProtocol,
    buildMemberFormattingProtocol,
    buildMemberProcessProtocol,
    buildProcessProtocolText,
} = require('./briefingProtocols.js');

function mergeMemberRecord(base, overlay) {
    return {
        ...(base && typeof base === 'object' ? base : {}),
        ...(overlay && typeof overlay === 'object' ? overlay : {}),
    };
}

function warnNonCritical(message, error) {
    if (typeof console === 'undefined' || typeof console.warn !== 'function') {
        return;
    }
    console.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`);
}

// Diagnostics go to stderr, like warnNonCritical above. This package is loaded
// inside the stdio MCP server, where stdout carries the JSON-RPC stream, so a
// console.info/log line here is parsed as a protocol frame and kills the call.
function logNonCritical(message) {
    if (typeof console === 'undefined' || typeof console.warn !== 'function') {
        return;
    }
    console.warn(message);
}

function resolveMemberRuntimeProvider(member) {
    if (isOpenCodeMember(member)) return 'opencode';
    if (isCodexMember(member)) return 'codex';
    return 'native';
}

function maybeNotifyPreviousOwnerOnReassignment(context, previousTask, updatedTask, options = {}) {
    const previousOwner = normalizeActorName(previousTask && previousTask.owner);
    if (
        !previousOwner ||
        previousTask.status === 'completed' ||
        previousTask.status === 'deleted' ||
        isSameMember(previousOwner, updatedTask && updatedTask.owner)
    ) {
        return;
    }

    const leadName = runtimeHelpers.inferLeadName(context.paths);
    const sender = normalizeActorName(options.from) || leadName;
    if (isSameMember(previousOwner, sender)) {
        return;
    }

    const nextOwner = normalizeActorName(updatedTask && updatedTask.owner);
    const taskLabel = `#${updatedTask.displayId || updatedTask.id}`;
    const destination = nextOwner ? `@${nextOwner}` : 'the unassigned queue';
    const leadSessionId = runtimeHelpers.resolveLeadSessionId(context.paths);
    const sendReassignmentMessage = isSameMember(sender, 'user')
        ? messages.sendTrustedMessage
        : messages.sendMessage;

    try {
        sendReassignmentMessage(context, {
            member: previousOwner,
            from: sender,
            text: [
                `Task ${taskLabel} *${updatedTask.subject}* was reassigned away from you to ${destination}.`,
                ``,
                wrapAgentBlock(
                    `This supersedes any earlier assignment notification for this task. Stop work on it and do not modify files, add completion comments, or complete it unless the current owner explicitly asks you to collaborate. If you already made changes, stop at a safe boundary and send the current owner concise handoff context; otherwise stay silent.`
                ),
            ].join('\n'),
            taskRefs: [buildTaskRef(context, updatedTask)],
            summary: `Task ${taskLabel} reassigned away from you`,
            source: 'system_notification',
            ...(leadSessionId ? { leadSessionId } : {}),
        });
    } catch (error) {
        warnNonCritical(`[tasks] reassignment notification failed for task ${updatedTask.id}`, error);
    }
}

function buildTaskRef(context, task) {
    return {
        taskId: task.id,
        displayId: task.displayId || task.id,
        teamName: context.teamName,
    };
}

function mergeTaskRefs(primaryTaskRef, extraTaskRefs) {
    const refs = [primaryTaskRef, ...(Array.isArray(extraTaskRefs) ? extraTaskRefs : [])]
        .filter((ref) => ref && typeof ref === 'object');
    const seen = new Set();
    const merged = [];
    for (const ref of refs) {
        const taskId = typeof ref.taskId === 'string' ? ref.taskId.trim() : '';
        const displayId = typeof ref.displayId === 'string' ? ref.displayId.trim() : '';
        const teamName = typeof ref.teamName === 'string' ? ref.teamName.trim() : '';
        const key = `${teamName || ''}:${taskId || displayId}`;
        if ((!taskId && !displayId) || seen.has(key)) {
            continue;
        }
        seen.add(key);
        merged.push({
            ...(taskId ? { taskId } : {}),
            ...(displayId ? { displayId } : {}),
            ...(teamName ? { teamName } : {}),
        });
    }
    return merged.length > 0 ? merged : undefined;
}

function hasOpenBlockers(context, task) {
    const blockerIds = Array.isArray(task.blockedBy) ? task.blockedBy : [];
    for (const id of blockerIds) {
        try {
            const blocker = taskStore.readTask(context.paths, id, { includeDeleted: true });
            if (blocker.status !== 'completed' && blocker.status !== 'deleted') {
                return true;
            }
        } catch {
            // missing task = not blocking
        }
    }
    return false;
}

function maybeNotifyAssignedOwner(context, task, options = {}) {
    const owner = normalizeActorName(task.owner);
    if (!owner || task.status === 'deleted') {
        return;
    }

    // Waking the owner of a task whose blockers are still open spends a whole
    // turn on work that cannot start: the owner reads "start now", checks the
    // board, and reports back that it is blocked. For an on-demand local model
    // it also costs a model load. notifyUnblockedOwners() already posts a
    // dependency-resolved comment when the last blocker completes or is
    // deleted, and that comment notification wakes the owner exactly when work
    // can begin.
    if (hasOpenBlockers(context, task)) {
        return;
    }

    const leadName = runtimeHelpers.inferLeadName(context.paths);
    const sender = normalizeActorName(options.from) || leadName;
    const leadSessionId = runtimeHelpers.resolveLeadSessionId(context.paths);
    if (isSameMember(owner, sender)) {
        return;
    }

    const resolved = runtimeHelpers.resolveTeamMembers(context.paths);
    const ownerMember = (resolved.members || []).find(
        (member) => isSameMember(member && member.name, owner)
    );
    const messagingProtocol = createMemberMessagingProtocol(resolveMemberRuntimeProvider(ownerMember));

    const summary = options.summary || `New task #${task.displayId || task.id} assigned`;
    try {
        const sendAssignmentMessage = isSameMember(sender, 'user')
            ? messages.sendTrustedMessage
            : messages.sendMessage;
        sendAssignmentMessage(context, {
            member: owner,
            from: sender,
            text: buildAssignmentMessage(context, task, {
                ...options,
                messagingProtocol,
            }),
            taskRefs: mergeTaskRefs(buildTaskRef(context, task), options.taskRefs),
            summary,
            source: 'system_notification',
            ...(leadSessionId ? { leadSessionId } : {}),
        });
    } catch (error) {
        warnNonCritical(`[tasks] assignment notification failed for task ${task.id}`, error);
    }
}

function maybeNotifyTaskOwnerOnComment(context, task, comment, options = {}) {
    if (!options.inserted || options.notifyOwner === false) {
        return;
    }
    if (!task || task.status === 'deleted') {
        return;
    }
    if (comment.type && comment.type !== 'regular') {
        return;
    }

    const owner = normalizeActorName(task.owner);
    if (!owner) {
        return;
    }

    const leadName = runtimeHelpers.inferLeadName(context.paths);
    const rawAuthor = normalizeActorName(comment.author);
    const sender = rawAuthor.toLowerCase() === 'system' ? leadName : rawAuthor || leadName;
    if (isSameTaskMember(owner, sender, leadName)) {
        return;
    }

    const leadSessionId = runtimeHelpers.resolveLeadSessionId(context.paths);
    messages.sendMessage(context, {
        member: owner,
        from: sender,
        text: buildCommentNotificationMessage(context, task, comment),
        taskRefs: Array.isArray(comment.taskRefs) ? comment.taskRefs : undefined,
        summary: `Comment on #${task.displayId || task.id}`,
        source: 'system_notification',
        ...(leadSessionId ? { leadSessionId } : {}),
    });
}

function createTask(context, input) {
    assertTaskCreationCommandScope(context, input);
    let taskInput = input;
    if (input && typeof input.owner === 'string' && input.owner.trim()) {
        taskInput = {
            ...input,
            owner: assertKnownTaskActor(context, input.owner, 'task owner'),
        };
    }
    const { task, deduplicated } = withTeamBoardLock(context.paths, () => {
        const duplicate = findRecentDuplicateTask(context, taskInput);
        if (duplicate) {
            return { task: duplicate, deduplicated: true };
        }
        return { task: taskStore.createTask(context.paths, taskInput), deduplicated: false };
    });
    if (deduplicated) {
        logNonCritical(
            `[tasks] deduplicated task_create for #${task.displayId || task.id}: matching semantic creation payload within 10 minutes`
        );
        return task;
    }
    if (taskInput && taskInput.notifyOwner !== false) {
        maybeNotifyAssignedOwner(context, task, {
            description: taskInput.description,
            prompt: taskInput.prompt,
            taskRefs: [
                ...(Array.isArray(taskInput.descriptionTaskRefs) ? taskInput.descriptionTaskRefs : []),
                ...(Array.isArray(taskInput.promptTaskRefs) ? taskInput.promptTaskRefs : []),
            ],
            from: taskInput.from || taskInput.createdBy,
        });
    }
    return task;
}

function reconcileTaskCreation(context, input) {
    assertTaskCreationCommandScope(context, input);
    return withTeamBoardLock(context.paths, () =>
        taskStore.reconcileTaskCreation(context.paths, input)
    );
}

function assertTaskCreationCommandScope(context, input) {
    if (!input || !input.creationCommand) {
        return;
    }
    const scopeKey =
        typeof input.creationCommand.scopeKey === 'string' ?
            input.creationCommand.scopeKey.trim() :
            '';
    if (scopeKey !== context.teamName) {
        throw new Error('Task creation command conflict: scope does not match team');
    }
}

function getTask(context, taskId) {
    return taskStore.readTask(context.paths, taskId, { includeDeleted: true });
}

function getTaskComment(context, taskId, commentId) {
    const normalizedCommentId = String(commentId || '').trim();
    if (!normalizedCommentId) {
        throw new Error('Missing commentId');
    }
    const task = taskStore.readTask(context.paths, taskId, { includeDeleted: true });
    const comments = Array.isArray(task.comments) ? task.comments : [];

    // Exact match first, then prefix match (allows short IDs like first 8 chars)
    const comment =
        comments.find((c) => c && c.id === normalizedCommentId) ||
        comments.find((c) => c && typeof c.id === 'string' && c.id.startsWith(normalizedCommentId));
    if (!comment) {
        throw new Error(`Comment ${normalizedCommentId} not found on task #${task.displayId || task.id}`);
    }
    return {
        comment,
        task: {
            id: task.id,
            displayId: task.displayId,
            subject: task.subject,
            status: task.status,
            owner: task.owner,
            commentCount: comments.length,
        },
    };
}

function listTasks(context) {
    return taskStore.listTasks(context.paths);
}

function listDeletedTasks(context) {
    return taskStore.listTasks(context.paths, { includeDeleted: true }).filter(
        (task) => task.status === 'deleted'
    );
}

function resolveTaskId(context, taskRef) {
    return taskStore.resolveTaskRef(context.paths, taskRef, { includeDeleted: true });
}

function setTaskStatus(context, taskId, status, actor, options = {}) {
    const { task, becameDeleted } = withTeamBoardLock(context.paths, () => {
        const before = taskStore.readTask(context.paths, taskId, { includeDeleted: true });
        const normalizedStatus = String(status || '').trim();
        if (before.status === 'deleted' && normalizedStatus !== 'deleted') {
            throw new Error(`Task #${before.displayId || before.id} is deleted; use task_restore before changing status`);
        }
        const actorForWrite =
            options.trustedInternalWrite === true
                ? actor
                : assertTaskOwnerMutation(context, before, actor, `set its status to ${normalizedStatus}`, {
                      allowLeadOverride:
                          normalizedStatus !== 'in_progress' && normalizedStatus !== 'completed',
                  });
        let task = taskStore.setTaskStatus(context.paths, taskId, status, actorForWrite);
        if (normalizedStatus === 'deleted' || normalizedStatus === 'in_progress' || normalizedStatus === 'pending') {
            const state = kanbanStore.readKanbanState(context.paths, context.teamName);
            if (hasKanbanReference(state, task.id)) {
                kanbanStore.clearKanban(context.paths, context.teamName, task.id, { nextReviewState: 'none' });
                task = taskStore.readTask(context.paths, task.id, { includeDeleted: true });
            }
        }
        return { task, becameDeleted: before.status !== 'deleted' && task.status === 'deleted' };
    });
    if (becameDeleted) {
        runDeletedTaskFollowUps(context, task);
    }
    return task;
}

function retractQueuedNotificationsForDeletedTask(context, task) {
    try {
        const retractedCount = messages.retractUnreadTaskNotifications(context, {
            taskId: task.id,
            displayId: task.displayId || task.id,
        });
        logNonCritical(
            `[tasks] retracted ${retractedCount} queued notification(s) for deleted task ${task.id}`
        );
    } catch (error) {
        warnNonCritical(`[tasks] notification retraction failed for deleted task ${task.id}`, error);
    }
}

/**
 * What the board owes the rest of the team once a task becomes deleted.
 * Retraction runs first: it drops unread notices that name this task, and the
 * dependency notice names it too. Deleting a blocker then clears the way for
 * its dependents exactly as completing it does, and maybeNotifyAssignedOwner()
 * stayed silent for as long as that blocker was open - so without the second
 * half, dropping the only blocker leaves its dependent pending, assigned, and
 * announced to nobody.
 */
function runDeletedTaskFollowUps(context, task) {
    retractQueuedNotificationsForDeletedTask(context, task);
    try {
        notifyUnblockedOwners(context, task, { resolution: 'deleted' });
    } catch (error) {
        warnNonCritical(
            `[tasks] dependency-resolution follow-up failed for deleted task ${task.id}`,
            error
        );
    }
}

function hasKanbanReference(state, taskId) {
    if (state.tasks && state.tasks[taskId]) {
        return true;
    }
    if (!state.columnOrder || typeof state.columnOrder !== 'object') {
        return false;
    }
    return Object.values(state.columnOrder).some(
        (orderedTaskIds) =>
            Array.isArray(orderedTaskIds) && orderedTaskIds.some((entry) => String(entry) === String(taskId))
    );
}

function startTask(context, taskId, actor) {
    return withTeamBoardLock(context.paths, () => {
        const before = taskStore.readTask(context.paths, taskId, { includeDeleted: true });
        assertTaskNotDeleted(before, 'starting work');
        const actorForWrite = assertTaskOwnerMutation(context, before, actor, 'start it');
        let task = taskStore.setTaskStatus(context.paths, taskId, 'in_progress', actorForWrite);
        const state = kanbanStore.readKanbanState(context.paths, context.teamName);
        if (hasKanbanReference(state, task.id)) {
            kanbanStore.clearKanban(context.paths, context.teamName, task.id, { nextReviewState: 'none' });
            task = taskStore.readTask(context.paths, task.id, { includeDeleted: true });
        }
        return task;
    });
}

/**
 * Tell the owner of every task this one was blocking that it is out of the way.
 * A blocker leaves the way in two ways - it is completed, or it is deleted -
 * and `options.resolution` decides which of the two the owner is told about.
 */
function notifyUnblockedOwners(context, resolvedTask, options = {}) {
    const blockedIds = Array.isArray(resolvedTask.blocks) ? resolvedTask.blocks : [];
    if (blockedIds.length === 0) return;

    const resolution = options.resolution === 'deleted' ? 'deleted' : 'completed';
    const completedLabel = `#${resolvedTask.displayId || resolvedTask.id}`;

    for (const blockedId of blockedIds) {
        try {
            const blockedTask = taskStore.readTask(context.paths, blockedId, { includeDeleted: true });
            if (blockedTask.status === 'deleted' || blockedTask.status === 'completed') continue;
            if (!normalizeActorName(blockedTask.owner)) continue;

            const allBlockerIds = Array.isArray(blockedTask.blockedBy) ? blockedTask.blockedBy : [];
            const pendingBlockerTasks = [];
            for (const id of allBlockerIds) {
                if (id === resolvedTask.id) continue;
                try {
                    const t = taskStore.readTask(context.paths, id, { includeDeleted: true });
                    if (t.status !== 'completed' && t.status !== 'deleted') {
                        pendingBlockerTasks.push(t);
                    }
                } catch { /* missing task = not blocking */ }
            }

            const allResolved = pendingBlockerTasks.length === 0;
            const blockedLabel = `#${blockedTask.displayId || blockedTask.id}`;

            const lines = [
                `**Dependency resolved** — task ${completedLabel} _${resolvedTask.subject}_ ${resolution}.`,
                ``,
                allResolved
                    ? `All blockers for ${blockedLabel} are resolved — this task is ready to start.`
                    : `${allBlockerIds.length - pendingBlockerTasks.length} of ${allBlockerIds.length} blockers resolved. Still waiting on: ${pendingBlockerTasks.map((t) => `#${t.displayId || t.id}`).join(', ')}.`,
            ];

            if (allResolved) {
                lines.push(
                    ``,
                    wrapAgentBlock(
                        `All dependencies for this task are now resolved.\n` +
                        `If you are idle, start working on it now:\n` +
                        `1. Check the full context: task_get { teamName: "${context.teamName}", taskId: "${blockedTask.id}" }\n` +
                        `2. Start the task: task_start { teamName: "${context.teamName}", taskId: "${blockedTask.id}", actor: "${blockedTask.owner}" }`
                    )
                );
            }

            // Stable comment ID prevents duplicates when completeTask is called
            // multiple times for the same task (e.g. agent retry), and when a
            // blocker that already completed is later deleted. addTaskComment
            // in taskStore.js deduplicates by id (line 485).
            addTaskCommentWithOptions(
                context,
                blockedTask.id,
                {
                    id: `dep-resolved-${resolvedTask.id}-${blockedTask.id}`,
                    text: lines.join('\n'),
                    from: 'system',
                },
                { trustedInternalWrite: true }
            );
        } catch {
            // Best-effort per blocked task: skip on failure
        }
    }
}

/**
 * Tell the lead the board is finished.
 *
 * A task with dependents wakes them through notifyUnblockedOwners, and every
 * teammate briefing asks the owner to message the lead after task_complete -
 * but that is prompt compliance. Observed on a live mixed run: the reviewer
 * messaged the lead BEFORE completing and sent its completion note to the user
 * instead, so the last task closed with the lead idle. Every task was done, the
 * lead was never woken again, and the run never produced its final message.
 *
 * The last task reaching a terminal state notifies the lead exactly once, from
 * the board itself rather than from anyone's good behaviour.
 */
function notifyLeadWhenBoardCompleted(context, completedTask) {
    let tasks;
    try {
        tasks = taskStore.listTasks(context.paths);
    } catch {
        return;
    }
    if (!Array.isArray(tasks) || tasks.length === 0) return;
    // Work in review or waiting for a fix is not finished, even though the task
    // itself already carries the completed status.
    const open = tasks.filter(
        (task) =>
            task &&
            task.status !== 'deleted' &&
            (task.status !== 'completed' ||
                task.reviewState === 'review' ||
                task.reviewState === 'needsFix')
    );
    if (open.length > 0) return;

    const leadName = runtimeHelpers.inferLeadName(context.paths);
    if (!leadName) return;
    // The owner of the last task is already looking at this board event.
    if (isSameMember(normalizeActorName(completedTask.owner), leadName)) return;

    const completedLabel = `#${completedTask.displayId || completedTask.id}`;
    const text = [
        `**Board complete** — ${completedLabel} _${completedTask.subject}_ was the last open task.`,
        ``,
        `Every task on this board is completed. Verify the board yourself before you rely on this notice.`,
        wrapAgentBlock(
            `This is the board's own completion signal, not a teammate report.\n` +
            `If the work the user asked for is finished, send them your final message now.\n` +
            `If something is still missing, create the follow-up task instead.`
        ),
    ].join('\n');

    try {
        messageStore.sendInboxMessage(context.paths, {
            member: leadName,
            from: 'system',
            // Stable per completing task, and appendInboxRow refuses a second
            // row carrying a messageId the inbox already holds, so a repeated
            // task_complete cannot produce a second notice.
            messageId: `board-complete:${context.teamName}:${completedTask.id}`,
            text,
            summary: `Board complete — ${completedLabel} was the last open task`,
            source: 'system_notification',
            taskRefs: [buildTaskRef(context, completedTask)].filter(Boolean),
        });
    } catch (error) {
        warnNonCritical(`[tasks] board-completion notice failed for task ${completedTask.id}`, error);
    }
}

function completeTask(context, taskId, actor) {
    const task = setTaskStatus(context, taskId, 'completed', actor);
    try {
        notifyUnblockedOwners(context, task);
    } catch (error) {
        warnNonCritical(`[tasks] dependency-resolution follow-up failed for task ${task.id}`, error);
    }
    try {
        notifyLeadWhenBoardCompleted(context, task);
    } catch (error) {
        warnNonCritical(`[tasks] board-completion follow-up failed for task ${task.id}`, error);
    }
    return task;
}

function softDeleteTask(context, taskId, actor) {
    const { task, becameDeleted } = withTeamBoardLock(context.paths, () => {
        const before = taskStore.readTask(context.paths, taskId, { includeDeleted: true });
        const actorForWrite = assertTaskOwnerMutation(context, before, actor, 'delete it', {
            allowLeadOverride: true,
        });
        let task = taskStore.setTaskStatus(context.paths, taskId, 'deleted', actorForWrite);
        const state = kanbanStore.readKanbanState(context.paths, context.teamName);
        if (hasKanbanReference(state, task.id)) {
            kanbanStore.clearKanban(context.paths, context.teamName, task.id, { nextReviewState: 'none' });
            task = taskStore.readTask(context.paths, task.id, { includeDeleted: true });
        }
        return { task, becameDeleted: before.status !== 'deleted' };
    });
    if (becameDeleted) {
        runDeletedTaskFollowUps(context, task);
    }
    return task;
}

function restoreTask(context, taskId, actor) {
    return withTeamBoardLock(context.paths, () => {
        const before = taskStore.readTask(context.paths, taskId, { includeDeleted: true });
        if (before.status !== 'deleted') {
            throw new Error(`Task #${before.displayId || before.id} is not deleted; task_restore only restores deleted tasks`);
        }
        const actorForWrite = assertTaskOwnerMutation(context, before, actor, 'restore it', {
            allowLeadOverride: true,
        });
        let task = taskStore.setTaskStatus(context.paths, taskId, 'pending', actorForWrite || 'user');
        const state = kanbanStore.readKanbanState(context.paths, context.teamName);
        if (hasKanbanReference(state, task.id)) {
            kanbanStore.clearKanban(context.paths, context.teamName, task.id, { nextReviewState: 'none' });
            task = taskStore.readTask(context.paths, task.id, { includeDeleted: true });
        }
        if (task.reviewState !== 'none') {
            task = taskStore.updateTask(context.paths, task.id, (current) => {
                current.reviewState = 'none';
                return current;
            });
        }
        return task;
    });
}

function setTaskOwner(context, taskId, owner, actor) {
    const { previousTask, updatedTask } = withTeamBoardLock(context.paths, () => {
        const before = readMutableTask(context, taskId, 'changing owner');
        const nextOwner = isClearOwnerValue(owner)
            ? owner
            : assertKnownTaskActor(context, owner, 'task owner');
        const actorForWrite = assertTaskOwnerChange(context, before, nextOwner, actor);
        const after = taskStore.setTaskOwner(context.paths, taskId, nextOwner, actorForWrite);
        return {
            previousTask: before,
            updatedTask: after,
        };
    });

    if (
        owner != null &&
        normalizeActorName(updatedTask.owner) &&
        !isSameMember(previousTask.owner, updatedTask.owner)
    ) {
        maybeNotifyAssignedOwner(context, updatedTask, {
            summary: `Task #${updatedTask.displayId || updatedTask.id} assigned`,
        });
    }

    maybeNotifyPreviousOwnerOnReassignment(context, previousTask, updatedTask, {
        from: actor,
    });

    return updatedTask;
}

function updateTaskFields(context, taskId, fields) {
    return withTeamBoardLock(context.paths, () => {
        readMutableTask(context, taskId, 'updating task fields');
        return taskStore.updateTaskFields(context.paths, taskId, fields);
    });
}

function addTaskCommentWithOptions(context, taskId, flags, options = {}) {
    const commentFlags = flags || {};
    const fromRequiredForAgentTool =
        context.allowUserMessageSender === false && options.trustedInternalWrite !== true;
    if (
        fromRequiredForAgentTool &&
        !(typeof commentFlags.from === 'string' && commentFlags.from.trim())
    ) {
        throw new Error('task_add_comment requires from to be your configured teammate name.');
    }
    const author = runtimeHelpers.resolveTaskCommentAuthorName(
        context.paths,
        commentFlags.from,
        'task comment author',
        {
            allowReservedAuthors: !fromRequiredForAgentTool,
            allowLeadAliases: !fromRequiredForAgentTool,
            allowProviderAliases: !fromRequiredForAgentTool,
        }
    );
    const result = withTeamBoardLock(context.paths, () => {
        readMutableTask(context, taskId, 'adding a comment');
        const insertResult = taskStore.addTaskComment(context.paths, taskId, commentFlags.text, {
            author,
            ...(commentFlags.id ? { id: commentFlags.id } : {}),
            ...(commentFlags.createdAt ? { createdAt: commentFlags.createdAt } : {}),
            ...(commentFlags.type ? { type: commentFlags.type } : {}),
            ...(Array.isArray(commentFlags.taskRefs) ? { taskRefs: commentFlags.taskRefs } : {}),
            ...(Array.isArray(commentFlags.attachments) ? { attachments: commentFlags.attachments } : {}),
        });
        // A comment is evidence or coordination, not a start command. Pending
        // work must move to in_progress only through the explicit task_start
        // operation, so blocker/busy notes cannot accidentally consume a turn.
        return insertResult;
    });

    try {
        maybeNotifyTaskOwnerOnComment(context, result.task, result.comment, {
            inserted: result.inserted,
            notifyOwner: commentFlags.notifyOwner,
        });
    } catch (notifyError) {
        warnNonCritical(`[tasks] owner notification failed for task ${taskId}`, notifyError);
    }

    return {
        commentId: result.comment.id,
        taskId: result.task.id,
        subject: result.task.subject,
        owner: result.task.owner,
        task: result.task,
        comment: result.comment,
    };
}

function addTaskComment(context, taskId, flags) {
    return addTaskCommentWithOptions(context, taskId, flags);
}

function attachTaskFile(context, taskId, flags) {
    const canonicalTaskId = resolveTaskId(context, taskId);
    withTeamBoardLock(context.paths, () => readMutableTask(context, canonicalTaskId, 'adding an attachment'));
    const saved = runtimeHelpers.saveTaskAttachmentFile(context.paths, canonicalTaskId, flags);
    const task = withTeamBoardLock(context.paths, () => {
        readMutableTask(context, canonicalTaskId, 'adding an attachment');
        return taskStore.addTaskAttachmentMeta(context.paths, canonicalTaskId, saved.meta);
    });
    return {
        ...saved.meta,
        task,
    };
}

function attachCommentFile(context, taskId, commentId, flags) {
    const canonicalTaskId = resolveTaskId(context, taskId);
    withTeamBoardLock(context.paths, () => readMutableTask(context, canonicalTaskId, 'adding a comment attachment'));
    const saved = runtimeHelpers.saveTaskAttachmentFile(context.paths, canonicalTaskId, flags);
    const task = withTeamBoardLock(context.paths, () => {
        readMutableTask(context, canonicalTaskId, 'adding a comment attachment');
        return taskStore.addCommentAttachmentMeta(context.paths, canonicalTaskId, commentId, saved.meta);
    });
    return {
        ...saved.meta,
        task,
    };
}

function addTaskAttachmentMeta(context, taskId, meta) {
    return withTeamBoardLock(context.paths, () => {
        readMutableTask(context, taskId, 'adding an attachment');
        return taskStore.addTaskAttachmentMeta(context.paths, taskId, meta);
    });
}

function removeTaskAttachment(context, taskId, attachmentId) {
    return withTeamBoardLock(context.paths, () => {
        readMutableTask(context, taskId, 'removing an attachment');
        return taskStore.removeTaskAttachment(context.paths, taskId, attachmentId);
    });
}

function setNeedsClarification(context, taskId, value) {
    return withTeamBoardLock(context.paths, () => {
        readMutableTask(context, taskId, 'changing clarification');
        return taskStore.setNeedsClarification(context.paths, taskId, value == null ? 'clear' : String(value));
    });
}

function linkTask(context, taskId, targetId, linkType) {
    return withTeamBoardLock(context.paths, () =>
        taskStore.linkTask(context.paths, taskId, targetId, String(linkType))
    );
}

function unlinkTask(context, taskId, targetId, linkType) {
    return withTeamBoardLock(context.paths, () =>
        taskStore.unlinkTask(context.paths, taskId, targetId, String(linkType))
    );
}

async function taskBriefing(context, memberName) {
    return agenda.formatTaskBriefing(context.paths, context.teamName, String(memberName));
}

async function leadBriefing(context) {
    return agenda.formatLeadBriefing(context.paths, context.teamName);
}

function listTaskInventory(context, filters = {}) {
    return agenda.listTaskInventory(context.paths, context.teamName, filters);
}

function buildMemberTaskProtocol(teamName, messagingProtocol = createMemberMessagingProtocol('native')) {
    const notifyLeadExample = messagingProtocol.buildLeadMessageExample({
        teamName,
        leadName: '<lead-name>',
        fromName: '<your-name>',
        text: '#abcd1234 done. Found 3 competitors: two lack kanban, one went closed-source in Jan. Full details in task comment <comment-id>. Moving on to my next task.',
        summary: '#abcd1234 done',
    });
    const runtimeVisibleMessageRule = messagingProtocol.visibleMessageRule
        ? `\n   - ${messagingProtocol.visibleMessageRule}`
        : '';
    const runtimeTaskToolHint = messagingProtocol.taskToolHint
        ? `\n   - ${messagingProtocol.taskToolHint}`
        : '';
    return wrapAgentBlock(`MANDATORY TASK STATUS PROTOCOL — you MUST follow this for EVERY task:
0. IMPORTANT ID RULE:
   - If a board/task snapshot shows a canonical taskId, prefer using that exact value in MCP tool calls.
   - task_briefing may show short display labels like #abcd1234; MCP task tools also accept that short task ref.
   - Human-facing summaries should use the short display label like #abcd1234 for readability.
1. If you are about to do implementation/fix work on a task yourself, make sure the owner reflects the actual implementer:
   - If the task is unassigned, FIRST claim it for yourself with MCP tool task_set_owner:
     { teamName: "${teamName}", taskId: "<taskId>", owner: "<your-name>", actor: "<your-name>" }
   - If the task belongs to someone else, do NOT take it yourself. Ask the current owner or team lead to hand it off. The team lead may explicitly reassign it with task_set_owner.
   - Do this only when you are genuinely taking over the work. Collaboration alone does not grant lifecycle ownership.
   - Reviewing, approving, or leaving comments does NOT require changing ownership.
2. Use MCP tool task_start to mark task started:
   { teamName: "${teamName}", taskId: "<taskId>", actor: "<your-name>" }
   - Start the task ONLY when you are actually beginning work on it.
   - Do NOT start multiple tasks at once unless the team lead explicitly directs parallel work.
3. Use MCP tool task_complete BEFORE sending your final reply:
   { teamName: "${teamName}", taskId: "<taskId>", actor: "<your-name>" }
   - CRITICAL: Before calling task_complete, you MUST post a task comment with your results via task_add_comment. Save the comment.id from the response — you will need it in the next step. The task comment is the primary delivery channel — the user reads results on the task board. A direct message to the lead is NOT a substitute: direct messages are ephemeral and not visible on the board. If you only send a direct message without a task comment, the user will never see your work.
   - If a new task comment means you must do more real work on that same task, FIRST add a short task comment saying what you are going to do, THEN run task_start again before doing the follow-up work.
   - After that follow-up work finishes, add a short task comment with the result, what changed, or what you verified.
   - After that, run task_complete again before your reply.
   - Never do comment-driven implementation/fix work while the task is still shown as pending, review, completed, or approved.
   - A task comment NEVER changes task status. If the comment you just posted says the work is done, your VERY NEXT tool call in this same turn must be task_complete for that task. Never end a turn with a completion note sitting on a task that is still in_progress.
   - After task_complete, send a notification to your team lead via ${messagingProtocol.sendLeadPhrase}. Use the comment.id you saved earlier (first 8 characters). Your message must include: (a) which task is done, (b) a brief summary of the outcome (2-4 sentences), (c) a pointer to the full comment so the lead can fetch it, (d) what you will do next. Do NOT duplicate the entire results.
     Example: ${notifyLeadExample}${runtimeVisibleMessageRule}${runtimeTaskToolHint}
   - After task_complete, call review_request ONLY when review is explicitly expected for THIS task and a concrete reviewer is already known.
     Example:
     { teamName: "${teamName}", taskId: "<taskId>", from: "<your-name>", reviewer: "<reviewer-name>" }
     Do NOT infer mandatory review just from free-form teammate roles like "reviewer", "qa", or "tech-lead".
     If review is not explicitly requested yet or the reviewer is still undecided, leave the task completed and wait.
3b. When you BEGIN reviewing a task, FIRST call review_start to ensure it appears in the REVIEW column:
   { teamName: "${teamName}", taskId: "<taskId>", from: "<your-name>" }
   This is MANDATORY before review_approve or review_request_changes. Without this step, the kanban board may not show the task in REVIEW during your review.
4. If you are asked to review and the task is accepted, move it to APPROVED (not DONE) with MCP tool review_approve:
   { teamName: "${teamName}", taskId: "<taskId>", from: "<your-name>", note?: "<optional note>", notifyOwner: true }
   CRITICAL: Text comments like "approved" or "LGTM" do NOT change the kanban board. You MUST call review_approve to move a task from REVIEW to APPROVED. Without the tool call the task stays stuck in the REVIEW column.
5. If review fails and changes are needed, use MCP tool review_request_changes:
   { teamName: "${teamName}", taskId: "<taskId>", from: "<your-name>", comment: "<what to fix>" }
6. NEVER skip status updates. A task is NOT done until completed status is written.
   - Never "bulk-complete" a batch of tasks at the end. Update status incrementally as you work.
7. To reply to a comment on a task, use MCP tool task_add_comment:
   { teamName: "${teamName}", taskId: "<taskId>", text: "<your reply>", from: "<your-name>" }
8. When discussing a task with a teammate and you have important findings, decisions, blockers, or progress updates — record them as a task comment:
   { teamName: "${teamName}", taskId: "<taskId>", text: "<summary of your finding or decision>", from: "<your-name>" }
   Do NOT comment on trivial coordination messages. Only comment when the information is valuable context for the task.
9. When sending a message about a specific task, include its short display label like #<displayId> in your ${messagingProtocol.sendToolName} summary field for traceability.
   - If the message is NOT about a real board task, do NOT include any # task label.
   - Never invent placeholder task refs such as #00000000 or #<displayId>, and never copy an id straight out of an example: anything in angle brackets is a placeholder you must replace with the real value, and an example id is not a real board id.
10. In ALL human-facing or teammate-facing message text, when you mention a task reference, ALWAYS write it with a leading # (for example: #abcd1234, not abcd1234 or "task abcd1234").
11. Review workflow clarity (IMPORTANT):
   - The work task (e.g. #1) is the thing that must end up APPROVED after review.
   - If you are reviewing work for task #X, run review_approve/review_request_changes on #X (the work task).
   - Do NOT approve a separate "review task" (e.g. #2 created just to ask for a review) — that will put the wrong task into APPROVED.
   - Typical flow:
     a) Owner finishes work on #X -> task_complete #X -> review_request #X (moves to review column, notifies reviewer)
     b) Reviewer begins reviewing -> review_start #X (ensures task is in REVIEW column on kanban)
     c) Reviewer accepts -> review_approve #X
     d) Reviewer rejects -> review_request_changes #X (moves back to pending with needsFix)
12. CLARIFICATION PROTOCOL (CRITICAL — MANDATORY):
   When you are blocked and need information to continue a task, you MUST do ALL steps below — skipping the board update or comment breaks traceability:
   a) STEP 1 — FIRST, set the clarification flag with MCP tool task_set_clarification:
      { teamName: "${teamName}", taskId: "<taskId>", value: "lead" }
   b) STEP 2 — THEN, add a task comment describing exactly what you need:
      { teamName: "${teamName}", taskId: "<taskId>", text: "question / blocker / missing info", from: "<your-name>" }
   c) STEP 3 — THEN, send a message to your team lead via ${messagingProtocol.sendLeadPhrase} so they notice it promptly.
   IMPORTANT: Always update the task board BEFORE sending the message. The flag + task comment are what make the request durable and visible on the board.
   d) The clarification flag is durable until it is cleared explicitly.
      When the blocker is truly resolved, clear the flag yourself with:
      { teamName: "${teamName}", taskId: "<taskId>", value: "clear" }
   e) Do NOT set clarification to "user" yourself — only the team lead escalates to the user.
13. DEPENDENCY AWARENESS:
    When your task has blockedBy dependencies, check if they are completed before starting.
    When you complete a task that blocks others, blocked task owners are notified automatically via a task comment.
14. TASK QUEUE DISCIPLINE:
    - task_briefing is your primary working queue for assigned tasks.
    - Use task_list only to search/browse inventory rows. Do NOT use task_list as your working queue.
    - task_briefing may include full description/comments only for in_progress tasks; needsFix/pending/review/completed entries may be minimal on purpose.
    - Act only on Actionable items from task_briefing.
    - Awareness items are watch-only context. Do NOT start work from Awareness unless the lead reroutes the task or you become the actionOwner first.
    - Finish existing in_progress tasks first.
    - A newly assigned task must NOT remain silently pending/TODO. If you are idle and the task is ready to start, start it now. If it must wait because you are still busy on another task, blocked, or still need more context, immediately add a short task comment on that waiting task with the reason and your best ETA or what you are waiting on.
    - Keep any task you have not actually started in pending/TODO (use task_set_status with status pending and actor "<your-name>" if it was moved too early).
    - If you need more context for an in_progress task, you MAY call task_get, but it is not mandatory when task_briefing already gives enough detail.
    - Before starting a needsFix or pending task, call task_get for that specific task first.
    - If you are the one doing the implementation/fixes and the owner is missing, self-claim with task_set_owner immediately before task_start. If someone else owns it, ask that owner or the lead to hand it off instead of taking it yourself.
    - Then run task_start only when you truly begin.
    - If you complete fixes for a needsFix task, mark it completed and then send it back through review_request when ready for another review pass.
15. MEMBER WORK SYNC REPORTING:
    - member_work_sync_status and member_work_sync_report are only for reporting whether you have seen the current actionable-work agenda. They do NOT start, complete, approve, or comment on tasks.
    - Never use member_work_sync_report instead of task_start, task_complete, review_approve, review_request_changes, task_set_clarification, or task_add_comment.
    - When you are about to stop, wait, or go idle because you believe your current work queue is handled, first call member_work_sync_status for yourself.
    - If the returned agenda has actionable items and you are actively continuing work on them, call member_work_sync_report with state "still_working", that exact agendaFingerprint, and the returned reportToken.
    - If you are blocked, report "blocked" only when the board already has blocker or clarification evidence for the listed task, and include the returned reportToken.
    - If the returned agenda is empty, report "caught_up" with that exact agendaFingerprint and the returned reportToken.
    - Do not report more than once for the same agendaFingerprint unless your state changed.
Failure to follow this protocol means the task board will show incorrect status.`);
}

function normalizeMemberName(value) {
    return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : '';
}

async function memberBriefing(context, memberName, options = {}) {
    const requestedMemberName = String(memberName).trim();
    const requestedMemberKey = normalizeMemberName(requestedMemberName);
    const resolved = runtimeHelpers.resolveTeamMembers(context.paths);
    const config = resolved.config || {};
    if (!requestedMemberName) {
        throw new Error('Missing member name');
    }
    if (resolved.removedNames && resolved.removedNames.has(requestedMemberKey)) {
        throw new Error(`Member is removed from the team: ${requestedMemberName}`);
    }
    let member =
        resolved.members.find((entry) => normalizeMemberName(entry && entry.name) === requestedMemberKey) ||
        null;
    if (!member) {
        const runtimeIdentity = runtimeHelpers.getCurrentRuntimeMemberIdentity();
        const runtimeAgentName = normalizeMemberName(runtimeIdentity && runtimeIdentity.agentName);
        const runtimeAgentId = String((runtimeIdentity && runtimeIdentity.agentId) || '').trim().toLowerCase();
        const runtimeTeamName = String((runtimeIdentity && runtimeIdentity.teamName) || '').trim().toLowerCase();
        const requestedAgentId = `${requestedMemberKey}@${String(context.teamName || '').trim().toLowerCase()}`;
        const isCurrentRuntimeMember =
            requestedMemberKey &&
            ((runtimeAgentName && runtimeAgentName === requestedMemberKey) ||
                (runtimeAgentId && runtimeAgentId === requestedAgentId)) &&
            (!runtimeTeamName || runtimeTeamName === String(context.teamName || '').trim().toLowerCase());
        if (isCurrentRuntimeMember) {
            const configMembers = Array.isArray(config.members) ? config.members : [];
            const configMember =
                configMembers.find((entry) => normalizeMemberName(entry && entry.name) === requestedMemberKey) ||
                null;
            const metaMember =
                Array.isArray(resolved.members)
                    ? resolved.members.find((entry) => normalizeMemberName(entry && entry.name) === requestedMemberKey)
                    : null;
            member = mergeMemberRecord(
                {
                    name: requestedMemberName,
                    ...(runtimeIdentity && runtimeIdentity.agentName
                        ? { name: String(runtimeIdentity.agentName).trim() }
                        : {}),
                    ...(typeof config.projectPath === 'string' && config.projectPath.trim()
                        ? { cwd: config.projectPath.trim() }
                        : {}),
                },
                mergeMemberRecord(configMember || {}, metaMember || {})
            );
        }
    }
    if (!member) {
        throw new Error(
            `Member not found in team metadata or inboxes: ${requestedMemberName}`
        );
    }
    const leadName = runtimeHelpers.inferLeadName(context.paths);
    const effectiveMember = member;
    const messagingProtocol = createMemberMessagingProtocol(
        options.runtimeProvider || resolveMemberRuntimeProvider(effectiveMember)
    );

    const role =
        typeof effectiveMember.role === 'string' && effectiveMember.role.trim() ?
        effectiveMember.role.trim() :
        typeof effectiveMember.agentType === 'string' && effectiveMember.agentType.trim() ?
        effectiveMember.agentType.trim() :
        'team member';
    const workflow =
        typeof effectiveMember.workflow === 'string' && effectiveMember.workflow.trim() ?
        effectiveMember.workflow.trim() :
        '';
    const cwd =
        typeof effectiveMember.cwd === 'string' && effectiveMember.cwd.trim() ?
        effectiveMember.cwd.trim() :
        typeof config.projectPath === 'string' && config.projectPath.trim() ?
        config.projectPath.trim() :
        '';

    const includeActiveProcesses = options.includeActiveProcesses !== false;
    const activeProcesses = includeActiveProcesses ?
        processStore
            .listProcesses(context.paths)
            .filter(
                (entry) =>
                entry &&
                entry.alive &&
                normalizeMemberName(entry.registeredBy) === normalizeMemberName(requestedMemberName)
            ) :
        [];

    const taskQueue = await taskBriefing(context, requestedMemberName);
    const completionNotifyExample = messagingProtocol.buildLeadMessageExample({
        teamName: context.teamName,
        leadName,
        fromName: requestedMemberName,
        text: '#abcd1234 done. Found 3 competitors, two lack kanban. Full details in task comment <comment-id>. Moving on to my next task.',
        summary: '#abcd1234 done',
    });
    const lines = [
        `Member briefing for ${requestedMemberName} on team "${context.teamName}" (${context.teamName}).`,
        `Role: ${role}.`,
        `CRITICAL: If a task gets a new comment and you are going to do additional implementation/fix/follow-up work on that same task, FIRST leave a short task comment saying what you are about to do, THEN move it to in_progress with task_start, THEN do the work, and when finished leave a short result comment and move it to done with task_complete. Never skip this comment -> reopen -> work -> comment -> done cycle.`,
        `CRITICAL: When you finish a task, your results (findings, research report, analysis, code changes summary, or any deliverable) MUST be posted as a task comment via task_add_comment BEFORE calling task_complete. Save the comment.id from the response — you will need it in the next step. The task comment is the primary delivery channel — the user reads results on the task board. A direct message to the lead is NOT a substitute: direct messages are ephemeral and not visible on the board. If you only send a direct message without a task comment, the user will never see your work.`,
        `After task_complete, notify your team lead via ${messagingProtocol.sendLeadPhrase}. Use the comment.id you saved (first 8 characters); <comment-id> in the example below is a placeholder, never send it literally. Include: task ref, brief summary (2-4 sentences), pointer to full comment, and next step. Example: ${completionNotifyExample}`,
        ...(messagingProtocol.runtimeProvider !== 'native'
            ? [
                messagingProtocol.visibleMessageRule,
                `${messagingProtocol.runtimeProvider === 'opencode' ? 'OpenCode' : 'Codex Native'} bootstrap silence rule: if this briefing was requested because the desktop app attached or reconnected you, do not send readiness, understood, idle, or no-task acknowledgements to the user, lead, or teammates.`,
                'This briefing already includes your current Task briefing. If it shows no actionable tasks, stop and wait silently. Do not call task_briefing again in the same bootstrap turn just to check for work.',
                'Use agent-teams_message_send only for actual app-delivered messages, actionable task coordination, blockers, or task results.',
                messagingProtocol.taskToolHint,
                'For cross-team replies or messages to another team, call agent-teams_cross_team_send with toTeam/fromMember. Do not put "cross_team_send" or a remote team name into message_send.to.',
            ]
            : []),
        `CRITICAL: A newly assigned task must NOT remain silently pending/TODO. If you are idle and the task is ready to start, start it now. If it must wait because you are already finishing another task, blocked, or still need more context, leave a short task comment on the waiting task immediately with the reason and your best ETA or what you are waiting on, keep it in pending/TODO, and only move it to in_progress with task_start when you truly begin.`,
        `Team lead: ${leadName}.`,
        buildMemberLanguageInstruction(config),
        `You must NOT start work, claim tasks, or improvise task/process protocol before reading and following this briefing.`,
    ];

    if (workflow) {
        lines.push('', 'Workflow:', workflow);
    }

    if (cwd) {
        lines.push('', `Working directory: ${cwd}`);
        lines.push('If an assigned task requires implementation, fixes, review follow-up, or concrete investigation, you may inspect, read/search, and edit files in this working directory as needed. Stay within the task scope, repository rules, and normal permission boundaries.');
    }

    lines.push(
        '',
        `Bootstrap flow:`,
        `1. Use this briefing as your durable rules source.`,
        `2. Use task_briefing as your primary working queue whenever you need to see assigned work. Use task_list only to search/browse inventory rows, not as your working queue.`,
        `3. Act only on Actionable items in task_briefing. Awareness items are watch-only context and do not authorize you to start work unless the lead reroutes the task or you become the actionOwner.`,
        `4. Before starting a pending or needs-fix task, call task_get for that specific task if you need the full context. A newly assigned task must not remain silently pending/TODO: if you are idle and the task is ready to start, start it now; if it must wait because another task is already active, because it is blocked, or because you still need more context, add a short task comment with the reason + ETA or what you are waiting on and keep it pending/TODO until you actually begin.`,
        `5. If this briefing was requested during reconnect, resume in_progress work first, then needs-fix tasks, then pending tasks.`,
        `6. If you cannot obtain the context you need, notify your team lead ("${leadName}") and wait instead of guessing.`
    );

    lines.push(
        '',
        buildMemberActionModeProtocol(),
        '',
        buildMemberFormattingProtocol(),
        '',
        buildMemberTaskProtocol(context.teamName, messagingProtocol),
        '',
        buildMemberProcessProtocol(context.teamName)
    );

    if (activeProcesses.length > 0) {
        lines.push('', 'Active registered processes owned by you:');
        for (const entry of activeProcesses) {
            const bits = [`- ${entry.label} (pid ${entry.pid})`];
            if (entry.port != null) bits.push(`port ${entry.port}`);
            if (entry.url) bits.push(`url ${entry.url}`);
            if (entry.command) bits.push(`command ${entry.command}`);
            lines.push(bits.join(', '));
        }
    }

    lines.push('', taskQueue);
    return lines.join('\n');
}

module.exports = {
    addTaskAttachmentMeta,
    addTaskComment,
    appendHistoryEvent: taskStore.appendHistoryEvent,
    attachTaskFile,
    attachCommentFile,
    completeTask,
    createTask,
    getTask,
    getTaskComment,
    linkTask,
    listDeletedTasks,
    listTaskInventory,
    listTasks,
    leadBriefing,
    removeTaskAttachment,
    reconcileTaskCreation,
    resolveTaskId,
    restoreTask,
    setNeedsClarification,
    setTaskOwner,
    setTaskStatus,
    softDeleteTask,
    startTask,
    buildActionModeProtocolText,
    MEMBER_DELEGATE_DESCRIPTION,
    buildProcessProtocolText,
    memberBriefing,
    taskBriefing,
    unlinkTask,
    updateTask: (context, taskRef, updater) =>
        withTeamBoardLock(context.paths, () => {
            readMutableTask(context, taskRef, 'updating task');
            return taskStore.updateTask(context.paths, taskRef, updater);
        }),
    updateTaskFields,
};
