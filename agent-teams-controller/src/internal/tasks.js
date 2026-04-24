const taskStore = require('./taskStore.js');
const runtimeHelpers = require('./runtimeHelpers.js');
const messages = require('./messages.js');
const processStore = require('./processStore.js');
const kanbanStore = require('./kanbanStore.js');
const agenda = require('./agenda.js');
const { withTeamBoardLock } = require('./boardLock.js');
const { wrapAgentBlock } = require('./agentBlocks.js');
const {
    createMemberMessagingProtocol,
    isOpenCodeMember,
} = require('./memberMessagingProtocol.js');

function normalizeActorName(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function isClearOwnerValue(value) {
    return value == null || value === 'clear' || value === 'none';
}

function assertKnownTaskActor(context, value, label) {
    return runtimeHelpers.assertExplicitTeamMemberName(context.paths, value, label, {
        allowLeadAliases: true,
    });
}

function assertTaskNotDeleted(task, action) {
    if (task && task.status === 'deleted') {
        throw new Error(`Task #${task.displayId || task.id} is deleted; use task_restore before ${action}`);
    }
}

function isSameMember(left, right) {
    return normalizeActorName(left).toLowerCase() === normalizeActorName(right).toLowerCase();
}

function isSameTaskMember(left, right, leadName) {
    const normalizedLeft = normalizeActorName(left).toLowerCase();
    const normalizedRight = normalizeActorName(right).toLowerCase();
    const normalizedLead = normalizeActorName(leadName).toLowerCase();
    if (!normalizedLeft || !normalizedRight) {
        return false;
    }
    if (normalizedLeft === normalizedRight) {
        return true;
    }
    return (
        (normalizedLeft === 'team-lead' && normalizedRight === normalizedLead) ||
        (normalizedRight === 'team-lead' && normalizedLeft === normalizedLead)
    );
}

function mergeMemberRecord(base, overlay) {
    return {
        ...(base && typeof base === 'object' ? base : {}),
        ...(overlay && typeof overlay === 'object' ? overlay : {}),
    };
}

function quoteMarkdown(text) {
    return String(text)
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
}

function warnNonCritical(message, error) {
    if (typeof console === 'undefined' || typeof console.warn !== 'function') {
        return;
    }
    console.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`);
}

function buildAssignmentMessage(context, task, options = {}) {
    const messagingProtocol = options.messagingProtocol || createMemberMessagingProtocol('native');
    const description =
        typeof options.description === 'string' && options.description.trim() ?
        options.description.trim() :
        typeof task.description === 'string' && task.description.trim() ?
        task.description.trim() :
        '';
    const prompt =
        typeof options.prompt === 'string' && options.prompt.trim() ? options.prompt.trim() : '';
    const taskLabel = `#${task.displayId || task.id}`;
    const lines = [
        `New task assigned to you: ${taskLabel} *${task.subject}*`,
        ``,
        wrapAgentBlock(`If you are idle and this task is ready to start, start it now. If you are busy, blocked, or still need more context, immediately add a short task comment with the reason and your best ETA or what you are waiting on, and keep this task in TODO until you actually begin.`),
    ];

    if (description) {
        lines.push(``, `Description:`, description);
    }

    if (prompt) {
        lines.push(``, `Instructions:`, prompt);
    }

    const notifyLeadExample = messagingProtocol.buildLeadMessageExample({
        teamName: context.teamName,
        leadName: '<lead-name>',
        fromName: '<your-name>',
        text: `#${task.displayId || task.id} done. <2-4 sentence summary>. Full details in task comment <short-commentId-from-step-4>. Moving to next task.`,
        summary: `#${task.displayId || task.id} done`,
    });
    const openCodeVisibleMessageRule =
        messagingProtocol.runtimeProvider === 'opencode'
            ? '\n   For normal visible replies, use agent-teams_message_send. Do not use SendMessage or runtime_deliver_message for ordinary replies.'
            : '';

    lines.push(
        ``,
        wrapAgentBlock(`Use the board MCP tools to work this task correctly:
1. Check the latest full context before starting:
   task_get { teamName: "${context.teamName}", taskId: "${task.id}" }
2. If you are idle and the task is ready to start after checking dependencies and context, call task_start now:
   task_start { teamName: "${context.teamName}", taskId: "${task.id}" }
3. If you are busy on another task, blocked, or still need more context, immediately add a task comment on this task with the reason and your best ETA or what you are waiting on, keep it pending/TODO, and do not call task_start until you truly begin:
   task_add_comment { teamName: "${context.teamName}", taskId: "${task.id}", text: "<reason + ETA or blocker>", from: "<your-name>" }
4. When the work is done, FIRST post a task comment with your full results, THEN mark it completed:
   task_add_comment { teamName: "${context.teamName}", taskId: "${task.id}", text: "<full results>", from: "<your-name>" }
   The response contains comment.id (UUID). Take its first 8 characters as the short commentId.
   task_complete { teamName: "${context.teamName}", taskId: "${task.id}" }
5. After task_complete, notify your lead via ${messagingProtocol.sendLeadPhrase} with a brief summary and a pointer to the full comment (use the short commentId from step 4).
   Example: ${notifyLeadExample}${openCodeVisibleMessageRule}`)
    );

    return lines.join('\n');
}

function buildCommentNotificationMessage(context, task, comment) {
    const taskLabel = `#${task.displayId || task.id}`;
    return [
        `**Comment on task ${taskLabel}** _${task.subject}_`,
        ``,
        quoteMarkdown(comment.text),
        ``,
        wrapAgentBlock(`Reply to this comment using MCP tool task_add_comment:
{ teamName: "${context.teamName}", taskId: "${task.id}", text: "<your reply>", from: "<your-name>" }`),
    ].join('\n');
}

function maybeNotifyAssignedOwner(context, task, options = {}) {
    const owner = normalizeActorName(task.owner);
    if (!owner || task.status === 'deleted') {
        return;
    }

    const leadName = runtimeHelpers.inferLeadName(context.paths);
    const sender = normalizeActorName(options.from) || leadName;
    const leadSessionId = runtimeHelpers.resolveLeadSessionId(context.paths);
    if (isSameMember(owner, leadName) || isSameMember(owner, sender)) {
        return;
    }

    const resolved = runtimeHelpers.resolveTeamMembers(context.paths);
    const ownerMember = (resolved.members || []).find(
        (member) => isSameMember(member && member.name, owner)
    );
    const messagingProtocol = createMemberMessagingProtocol(
        isOpenCodeMember(ownerMember) ? 'opencode' : 'native'
    );

    const summary = options.summary || `New task #${task.displayId || task.id} assigned`;
    try {
        messages.sendMessage(context, {
            member: owner,
            from: sender,
            text: buildAssignmentMessage(context, task, {
                ...options,
                messagingProtocol,
            }),
            taskRefs: Array.isArray(options.taskRefs) && options.taskRefs.length > 0 ? options.taskRefs : undefined,
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
    if (isSameTaskMember(owner, comment.author, leadName)) {
        return;
    }

    const leadSessionId = runtimeHelpers.resolveLeadSessionId(context.paths);
    messages.sendMessage(context, {
        member: owner,
        from: normalizeActorName(comment.author) || leadName,
        text: buildCommentNotificationMessage(context, task, comment),
        taskRefs: Array.isArray(comment.taskRefs) ? comment.taskRefs : undefined,
        summary: `Comment on #${task.displayId || task.id}`,
        source: 'system_notification',
        ...(leadSessionId ? { leadSessionId } : {}),
    });
}

function createTask(context, input) {
    let taskInput = input;
    if (input && typeof input.owner === 'string' && input.owner.trim()) {
        taskInput = {
            ...input,
            owner: assertKnownTaskActor(context, input.owner, 'task owner'),
        };
    }
    const task = withTeamBoardLock(context.paths, () => taskStore.createTask(context.paths, taskInput));
    if (taskInput && taskInput.notifyOwner !== false) {
        maybeNotifyAssignedOwner(context, task, {
            description: taskInput.description,
            prompt: taskInput.prompt,
            taskRefs: [
                ...(Array.isArray(taskInput.descriptionTaskRefs) ? taskInput.descriptionTaskRefs : []),
                ...(Array.isArray(taskInput.promptTaskRefs) ? taskInput.promptTaskRefs : []),
            ],
            from: taskInput.from,
        });
    }
    return task;
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

function setTaskStatus(context, taskId, status, actor) {
    return withTeamBoardLock(context.paths, () => {
        const before = taskStore.readTask(context.paths, taskId, { includeDeleted: true });
        const normalizedStatus = String(status || '').trim();
        if (before.status === 'deleted' && normalizedStatus !== 'deleted') {
            throw new Error(`Task #${before.displayId || before.id} is deleted; use task_restore before changing status`);
        }
        let task = taskStore.setTaskStatus(context.paths, taskId, status, actor);
        if (normalizedStatus === 'deleted' || normalizedStatus === 'in_progress' || normalizedStatus === 'pending') {
            const state = kanbanStore.readKanbanState(context.paths, context.teamName);
            if (hasKanbanReference(state, task.id)) {
                kanbanStore.clearKanban(context.paths, context.teamName, task.id, { nextReviewState: 'none' });
                task = taskStore.readTask(context.paths, task.id, { includeDeleted: true });
            }
        }
        return task;
    });
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
        let task = taskStore.setTaskStatus(context.paths, taskId, 'in_progress', actor);
        const state = kanbanStore.readKanbanState(context.paths, context.teamName);
        if (hasKanbanReference(state, task.id)) {
            kanbanStore.clearKanban(context.paths, context.teamName, task.id, { nextReviewState: 'none' });
            task = taskStore.readTask(context.paths, task.id, { includeDeleted: true });
        }
        return task;
    });
}

function notifyUnblockedOwners(context, completedTask) {
    const blockedIds = Array.isArray(completedTask.blocks) ? completedTask.blocks : [];
    if (blockedIds.length === 0) return;

    const completedLabel = `#${completedTask.displayId || completedTask.id}`;

    for (const blockedId of blockedIds) {
        try {
            const blockedTask = taskStore.readTask(context.paths, blockedId, { includeDeleted: true });
            if (blockedTask.status === 'deleted' || blockedTask.status === 'completed') continue;
            if (!normalizeActorName(blockedTask.owner)) continue;

            const allBlockerIds = Array.isArray(blockedTask.blockedBy) ? blockedTask.blockedBy : [];
            const pendingBlockerTasks = [];
            for (const id of allBlockerIds) {
                if (id === completedTask.id) continue;
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
                `**Dependency resolved** — task ${completedLabel} _${completedTask.subject}_ completed.`,
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
                        `2. Start the task: task_start { teamName: "${context.teamName}", taskId: "${blockedTask.id}" }`
                    )
                );
            }

            // Stable comment ID prevents duplicates when completeTask is called
            // multiple times for the same task (e.g. agent retry). addTaskComment
            // in taskStore.js deduplicates by id (line 485).
            addTaskComment(context, blockedTask.id, {
                id: `dep-resolved-${completedTask.id}-${blockedTask.id}`,
                text: lines.join('\n'),
                from: 'system',
            });
        } catch {
            // Best-effort per blocked task: skip on failure
        }
    }
}

function completeTask(context, taskId, actor) {
    const task = setTaskStatus(context, taskId, 'completed', actor);
    try {
        notifyUnblockedOwners(context, task);
    } catch (error) {
        warnNonCritical(`[tasks] dependency-resolution follow-up failed for task ${task.id}`, error);
    }
    return task;
}

function softDeleteTask(context, taskId, actor) {
    return withTeamBoardLock(context.paths, () => {
        let task = taskStore.setTaskStatus(context.paths, taskId, 'deleted', actor);
        const state = kanbanStore.readKanbanState(context.paths, context.teamName);
        if (hasKanbanReference(state, task.id)) {
            kanbanStore.clearKanban(context.paths, context.teamName, task.id, { nextReviewState: 'none' });
            task = taskStore.readTask(context.paths, task.id, { includeDeleted: true });
        }
        return task;
    });
}

function restoreTask(context, taskId, actor) {
    return withTeamBoardLock(context.paths, () => {
        const before = taskStore.readTask(context.paths, taskId, { includeDeleted: true });
        if (before.status !== 'deleted') {
            throw new Error(`Task #${before.displayId || before.id} is not deleted; task_restore only restores deleted tasks`);
        }
        let task = taskStore.setTaskStatus(context.paths, taskId, 'pending', actor || 'user');
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

function setTaskOwner(context, taskId, owner) {
    const { previousTask, updatedTask } = withTeamBoardLock(context.paths, () => {
        const before = taskStore.readTask(context.paths, taskId, { includeDeleted: true });
        const nextOwner = isClearOwnerValue(owner)
            ? owner
            : assertKnownTaskActor(context, owner, 'task owner');
        const after = taskStore.setTaskOwner(context.paths, taskId, nextOwner);
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

    return updatedTask;
}

function updateTaskFields(context, taskId, fields) {
    return withTeamBoardLock(context.paths, () =>
        taskStore.updateTaskFields(context.paths, taskId, fields)
    );
}

function addTaskComment(context, taskId, flags) {
    const result = withTeamBoardLock(context.paths, () =>
        taskStore.addTaskComment(context.paths, taskId, flags.text, {
            author: typeof flags.from === 'string' && flags.from.trim() ?
                flags.from.trim() : runtimeHelpers.inferLeadName(context.paths),
            ...(flags.id ? { id: flags.id } : {}),
            ...(flags.createdAt ? { createdAt: flags.createdAt } : {}),
            ...(flags.type ? { type: flags.type } : {}),
            ...(Array.isArray(flags.taskRefs) ? { taskRefs: flags.taskRefs } : {}),
            ...(Array.isArray(flags.attachments) ? { attachments: flags.attachments } : {}),
        })
    );

    try {
        maybeNotifyTaskOwnerOnComment(context, result.task, result.comment, {
            inserted: result.inserted,
            notifyOwner: flags.notifyOwner,
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

function attachTaskFile(context, taskId, flags) {
    const canonicalTaskId = resolveTaskId(context, taskId);
    const saved = runtimeHelpers.saveTaskAttachmentFile(context.paths, canonicalTaskId, flags);
    const task = withTeamBoardLock(context.paths, () =>
        taskStore.addTaskAttachmentMeta(context.paths, canonicalTaskId, saved.meta)
    );
    return {
        ...saved.meta,
        task,
    };
}

function attachCommentFile(context, taskId, commentId, flags) {
    const canonicalTaskId = resolveTaskId(context, taskId);
    const saved = runtimeHelpers.saveTaskAttachmentFile(context.paths, canonicalTaskId, flags);
    const task = withTeamBoardLock(context.paths, () =>
        taskStore.addCommentAttachmentMeta(context.paths, canonicalTaskId, commentId, saved.meta)
    );
    return {
        ...saved.meta,
        task,
    };
}

function addTaskAttachmentMeta(context, taskId, meta) {
    return withTeamBoardLock(context.paths, () =>
        taskStore.addTaskAttachmentMeta(context.paths, taskId, meta)
    );
}

function removeTaskAttachment(context, taskId, attachmentId) {
    return withTeamBoardLock(context.paths, () =>
        taskStore.removeTaskAttachment(context.paths, taskId, attachmentId)
    );
}

function setNeedsClarification(context, taskId, value) {
    return withTeamBoardLock(context.paths, () =>
        taskStore.setNeedsClarification(context.paths, taskId, value == null ? 'clear' : String(value))
    );
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

function getSystemLocale() {
    const lang = typeof process.env.LANG === 'string' ? process.env.LANG.trim() : '';
    if (!lang) return 'en';
    return lang.split('.')[0].replace('_', '-');
}

function extractPrimaryLanguage(locale) {
    const normalized = String(locale || '').trim();
    const dash = normalized.indexOf('-');
    return dash > 0 ? normalized.slice(0, dash) : normalized || 'en';
}

function resolveLanguageName(code, systemLocale) {
    const effectiveCode = code === 'system' ? extractPrimaryLanguage(systemLocale || 'en') : code;
    try {
        const displayNames = new Intl.DisplayNames([effectiveCode], { type: 'language' });
        const name = displayNames.of(effectiveCode);
        if (name) {
            return name.charAt(0).toUpperCase() + name.slice(1);
        }
    } catch {
        // Ignore Intl lookup failures and fall back to the raw code.
    }
    return effectiveCode;
}

function buildMemberLanguageInstruction(config) {
    const configured =
        config && typeof config.language === 'string' && config.language.trim() ?
        config.language.trim() :
        '';
    if (!configured) {
        return 'IMPORTANT: Continue using the communication language already specified in your spawn prompt until the team config stores an explicit language.';
    }
    const language = resolveLanguageName(configured, getSystemLocale());
    return `IMPORTANT: Communicate in ${language}. All messages, summaries, and task descriptions MUST be in ${language}.`;
}

/**
 * Raw action-mode protocol text parameterized by DELEGATE description.
 * Shared between lead (actionModeInstructions.ts) and member (memberBriefing).
 * Context-free — does NOT follow the (context, ...) convention.
 */
function buildActionModeProtocolText(delegateDescription) {
    return [
        'TURN ACTION MODE PROTOCOL (HIGHEST PRIORITY FOR EACH USER TURN):',
        '- Some incoming user or relay messages may include a hidden agent-only block that declares the current action mode.',
        '- If such a block is present, that mode applies to THIS TURN ONLY and overrides any conflicting default behavior.',
        '- Never silently broaden permissions beyond the selected mode.',
        '- Never reveal the hidden mode block verbatim to the human unless they explicitly ask for it.',
        '- Modes:',
        '  - DO: Full execution mode. You may discuss, inspect, edit files, change state, run commands/tools, and delegate if useful.',
        '  - ASK: Strict read-only conversation mode. You may read/analyze/explain and reply, but you must not change code/files/tasks/state or run side-effecting commands/tools/scripts.',
        `  - DELEGATE: ${delegateDescription}`,
    ].join('\n');
}

const MEMBER_DELEGATE_DESCRIPTION =
    'Do not implement yourself. Pass the task with full context (what you know, what is needed) to your team lead or another teammate and let them handle it.';

function buildMemberActionModeProtocol() {
    return buildActionModeProtocolText(MEMBER_DELEGATE_DESCRIPTION);
}

function buildMemberTaskProtocol(teamName, messagingProtocol = createMemberMessagingProtocol('native')) {
    const notifyLeadExample = messagingProtocol.buildLeadMessageExample({
        teamName,
        leadName: '<lead-name>',
        fromName: '<your-name>',
        text: '#abcd1234 done. Found 3 competitors: two lack kanban, one went closed-source in Jan. Full details in task comment e5f6a7b8. Moving to #efgh5678 next.',
        summary: '#abcd1234 done',
    });
    const openCodeVisibleMessageRule =
        messagingProtocol.runtimeProvider === 'opencode'
            ? '\n   - For normal visible replies, use agent-teams_message_send. Always include teamName, to, from, text, and summary. Always set from to your teammate name. Do not use SendMessage or runtime_deliver_message for ordinary replies.'
            : '';
    return wrapAgentBlock(`MANDATORY TASK STATUS PROTOCOL — you MUST follow this for EVERY task:
0. IMPORTANT ID RULE:
   - If a board/task snapshot shows a canonical taskId, prefer using that exact value in MCP tool calls.
   - task_briefing may show short display labels like #abcd1234; MCP task tools also accept that short task ref.
   - Human-facing summaries should use the short display label like #abcd1234 for readability.
1. If you are about to do implementation/fix work on a task yourself, make sure the owner reflects the actual implementer:
   - If the task is unassigned or assigned to someone else, FIRST reassign it to yourself with MCP tool task_set_owner:
     { teamName: "${teamName}", taskId: "<taskId>", owner: "<your-name>" }
   - Do this only when you are genuinely taking over the work.
   - Reviewing, approving, or leaving comments does NOT require changing ownership.
2. Use MCP tool task_start to mark task started:
   { teamName: "${teamName}", taskId: "<taskId>" }
   - Start the task ONLY when you are actually beginning work on it.
   - Do NOT start multiple tasks at once unless the team lead explicitly directs parallel work.
3. Use MCP tool task_complete BEFORE sending your final reply:
   { teamName: "${teamName}", taskId: "<taskId>" }
   - CRITICAL: Before calling task_complete, you MUST post a task comment with your results via task_add_comment. Save the comment.id from the response — you will need it in the next step. The task comment is the primary delivery channel — the user reads results on the task board. A direct message to the lead is NOT a substitute: direct messages are ephemeral and not visible on the board. If you only send a direct message without a task comment, the user will never see your work.
   - If a new task comment means you must do more real work on that same task, FIRST add a short task comment saying what you are going to do, THEN run task_start again before doing the follow-up work.
   - After that follow-up work finishes, add a short task comment with the result, what changed, or what you verified.
   - After that, run task_complete again before your reply.
   - Never do comment-driven implementation/fix work while the task is still shown as pending, review, completed, or approved.
   - After task_complete, send a notification to your team lead via ${messagingProtocol.sendLeadPhrase}. Use the comment.id you saved earlier (first 8 characters). Your message must include: (a) which task is done, (b) a brief summary of the outcome (2-4 sentences), (c) a pointer to the full comment so the lead can fetch it, (d) what you will do next. Do NOT duplicate the entire results.
     Example: ${notifyLeadExample}${openCodeVisibleMessageRule}
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
    - Keep any task you have not actually started in pending/TODO (use task_set_status pending if it was moved too early).
    - If you need more context for an in_progress task, you MAY call task_get, but it is not mandatory when task_briefing already gives enough detail.
    - Before starting a needsFix or pending task, call task_get for that specific task first.
    - If you are the one doing the implementation/fixes and the owner is missing or someone else, run task_set_owner to yourself immediately before task_start.
    - Then run task_start only when you truly begin.
    - If you complete fixes for a needsFix task, mark it completed and then send it back through review_request when ready for another review pass.
Failure to follow this protocol means the task board will show incorrect status.`);
}

/**
 * Raw process-registration protocol text (no agent-block wrapping).
 * Shared between member briefing and lead provisioning prompt (DRY).
 * Context-free — does NOT follow the (context, ...) convention.
 */
function buildProcessProtocolText(teamName) {
    return `BACKGROUND SERVICE PROCESS REGISTRATION — this is ONLY for extra background services started by teammates (dev server, watcher, database, etc.). It is NOT a list of teammate agents themselves.
1. Launch with & to get PID:
   pnpm dev &
2. Register immediately with MCP tool process_register (--port and --url are optional, use when the process listens on a port):
   { teamName: "${teamName}", pid: <PID>, label: "<description>", from: "<your-name>", port?: <PORT>, url?: "http://localhost:<PORT>", command?: "<command>" }
3. VERIFY registration succeeded (MANDATORY — never skip this step) using MCP tool process_list:
   { teamName: "${teamName}" }
   process_list shows ONLY registered background services for the team. It does NOT show whether teammate agents themselves are alive.
4. When stopping a process, use MCP tool process_stop:
   { teamName: "${teamName}", pid: <PID> }
5. To fully remove a process record (e.g. after it has been stopped and is no longer needed), use MCP tool process_unregister:
   { teamName: "${teamName}", pid: <PID> }
If verification in step 3 fails or the process is missing from the list, re-register it.`;
}

function buildMemberProcessProtocol(teamName) {
    return wrapAgentBlock(buildProcessProtocolText(teamName));
}

function buildMemberFormattingProtocol() {
    return wrapAgentBlock(`Hidden internal instructions rule (IMPORTANT):
- If you send internal operational instructions to another agent/teammate that the human user must NOT see in the UI, wrap ONLY that hidden part in:
  <info_for_agent>
  ... hidden instructions only ...
  </info_for_agent>
- Keep normal human-readable coordination outside the block.
- NEVER use agent-only blocks in messages to "user".`);
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
        options.runtimeProvider || (isOpenCodeMember(effectiveMember) ? 'opencode' : 'native')
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

    const activeProcesses = processStore
        .listProcesses(context.paths)
        .filter(
            (entry) =>
            entry &&
            entry.alive &&
            normalizeMemberName(entry.registeredBy) === normalizeMemberName(requestedMemberName)
        );

    const taskQueue = await taskBriefing(context, requestedMemberName);
    const completionNotifyExample = messagingProtocol.buildLeadMessageExample({
        teamName: context.teamName,
        leadName,
        fromName: requestedMemberName,
        text: '#abcd1234 done. Found 3 competitors, two lack kanban. Full details in task comment e5f6a7b8. Moving to #efgh5678.',
        summary: '#abcd1234 done',
    });
    const lines = [
        `Member briefing for ${requestedMemberName} on team "${context.teamName}" (${context.teamName}).`,
        `Role: ${role}.`,
        `CRITICAL: If a task gets a new comment and you are going to do additional implementation/fix/follow-up work on that same task, FIRST leave a short task comment saying what you are about to do, THEN move it to in_progress with task_start, THEN do the work, and when finished leave a short result comment and move it to done with task_complete. Never skip this comment -> reopen -> work -> comment -> done cycle.`,
        `CRITICAL: When you finish a task, your results (findings, research report, analysis, code changes summary, or any deliverable) MUST be posted as a task comment via task_add_comment BEFORE calling task_complete. Save the comment.id from the response — you will need it in the next step. The task comment is the primary delivery channel — the user reads results on the task board. A direct message to the lead is NOT a substitute: direct messages are ephemeral and not visible on the board. If you only send a direct message without a task comment, the user will never see your work.`,
        `After task_complete, notify your team lead via ${messagingProtocol.sendLeadPhrase}. Use the comment.id you saved (first 8 characters). Include: task ref, brief summary (2-4 sentences), pointer to full comment, and next step. Example: ${completionNotifyExample}`,
        ...(messagingProtocol.runtimeProvider === 'opencode'
            ? [
                'OpenCode visible messaging rule: call agent-teams_message_send for normal replies to the human user, lead, or same-team teammates. Always include teamName, to, from, text, and summary. Do not use SendMessage or runtime_deliver_message for ordinary replies.',
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
        withTeamBoardLock(context.paths, () => taskStore.updateTask(context.paths, taskRef, updater)),
    updateTaskFields,
};
