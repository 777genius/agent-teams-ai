const taskStore = require('./taskStore.js');
const runtimeHelpers = require('./runtimeHelpers.js');
const messages = require('./messages.js');
const processStore = require('./processStore.js');
const { wrapAgentBlock } = require('./agentBlocks.js');

function normalizeActorName(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
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

function quoteMarkdown(text) {
    return String(text)
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
}

function buildAssignmentMessage(context, task, options = {}) {
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
        `New task assigned to you: ${taskLabel} "${task.subject}".`,
        ``,
        `*If you are idle and this task is ready to start, start it now. If you are busy, blocked, or still need more context, immediately add a short task comment with the reason and your best ETA or what you are waiting on, and keep this task in TODO until you actually begin.*`,
    ];

    if (description) {
        lines.push(``, `Description:`, description);
    }

    if (prompt) {
        lines.push(``, `Instructions:`, prompt);
    }

    lines.push(
        ``,
        wrapAgentBlock(`Use the board MCP tools to work this task correctly:
1. Check the latest full context before starting:
   task_get { teamName: "${context.teamName}", taskId: "${task.id}" }
2. If you are idle and the task is ready to start after checking dependencies and context, call task_start now:
   task_start { teamName: "${context.teamName}", taskId: "${task.id}" }
3. If you are busy on another task, blocked, or still need more context, immediately add a task comment on this task with the reason and your best ETA or what you are waiting on, keep it pending/TODO, and do not call task_start until you truly begin:
   task_add_comment { teamName: "${context.teamName}", taskId: "${task.id}", text: "<reason + ETA or blocker>", from: "<your-name>" }
4. When the work is done, mark it completed:
   task_complete { teamName: "${context.teamName}", taskId: "${task.id}" }`)
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

    const summary = options.summary || `New task #${task.displayId || task.id} assigned`;
    messages.sendMessage(context, {
        member: owner,
        from: sender,
        text: buildAssignmentMessage(context, task, options),
        taskRefs: Array.isArray(options.taskRefs) && options.taskRefs.length > 0 ? options.taskRefs : undefined,
        summary,
        source: 'system_notification',
        ...(leadSessionId ? { leadSessionId } : {}),
    });
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
    const task = taskStore.createTask(context.paths, input);
    if (input && input.notifyOwner !== false) {
        maybeNotifyAssignedOwner(context, task, {
            description: input.description,
            prompt: input.prompt,
            taskRefs: [
                ...(Array.isArray(input.descriptionTaskRefs) ? input.descriptionTaskRefs : []),
                ...(Array.isArray(input.promptTaskRefs) ? input.promptTaskRefs : []),
            ],
            from: input.from,
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
    return taskStore.setTaskStatus(context.paths, taskId, status, actor);
}

function startTask(context, taskId, actor) {
    const task = setTaskStatus(context, taskId, 'in_progress', actor);
    // Clear stale kanban entry (e.g. 'approved' or 'review') when task is reopened
    try {
        const kanbanStore = require('./kanbanStore.js');
        const state = kanbanStore.readKanbanState(context.paths, context.teamName);
        if (state.tasks[task.id]) {
            delete state.tasks[task.id];
            kanbanStore.writeKanbanState(context.paths, context.teamName, state);
        }
    } catch {
        // Best-effort: task status already updated, kanban cleanup failure is non-fatal
    }
    return task;
}

function completeTask(context, taskId, actor) {
    return setTaskStatus(context, taskId, 'completed', actor);
}

function softDeleteTask(context, taskId, actor) {
    return setTaskStatus(context, taskId, 'deleted', actor);
}

function restoreTask(context, taskId, actor) {
    return setTaskStatus(context, taskId, 'pending', actor || 'user');
}

function setTaskOwner(context, taskId, owner) {
    const previousTask = taskStore.readTask(context.paths, taskId, { includeDeleted: true });
    const updatedTask = taskStore.setTaskOwner(context.paths, taskId, owner);

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
    return taskStore.updateTaskFields(context.paths, taskId, fields);
}

function addTaskComment(context, taskId, flags) {
    const result = taskStore.addTaskComment(context.paths, taskId, flags.text, {
        author: typeof flags.from === 'string' && flags.from.trim() ?
            flags.from.trim() : runtimeHelpers.inferLeadName(context.paths),
        ...(flags.id ? { id: flags.id } : {}),
        ...(flags.createdAt ? { createdAt: flags.createdAt } : {}),
        ...(flags.type ? { type: flags.type } : {}),
        ...(Array.isArray(flags.taskRefs) ? { taskRefs: flags.taskRefs } : {}),
        ...(Array.isArray(flags.attachments) ? { attachments: flags.attachments } : {}),
    });

    try {
        maybeNotifyTaskOwnerOnComment(context, result.task, result.comment, {
            inserted: result.inserted,
            notifyOwner: flags.notifyOwner,
        });
    } catch (notifyError) {
        // Best-effort: comment is already persisted, notification failure must not fail the call
        if (typeof console !== 'undefined' && console.warn) {
            console.warn(
                `[tasks] owner notification failed for task ${taskId}: ${String(notifyError)}`
            );
        }
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
    const task = taskStore.addTaskAttachmentMeta(context.paths, canonicalTaskId, saved.meta);
    return {
        ...saved.meta,
        task,
    };
}

function attachCommentFile(context, taskId, commentId, flags) {
    const canonicalTaskId = resolveTaskId(context, taskId);
    const saved = runtimeHelpers.saveTaskAttachmentFile(context.paths, canonicalTaskId, flags);
    const task = taskStore.addCommentAttachmentMeta(context.paths, canonicalTaskId, commentId, saved.meta);
    return {
        ...saved.meta,
        task,
    };
}

function addTaskAttachmentMeta(context, taskId, meta) {
    return taskStore.addTaskAttachmentMeta(context.paths, taskId, meta);
}

function removeTaskAttachment(context, taskId, attachmentId) {
    return taskStore.removeTaskAttachment(context.paths, taskId, attachmentId);
}

function setNeedsClarification(context, taskId, value) {
    return taskStore.setNeedsClarification(context.paths, taskId, value == null ? 'clear' : String(value));
}

function linkTask(context, taskId, targetId, linkType) {
    return taskStore.linkTask(context.paths, taskId, targetId, String(linkType));
}

function unlinkTask(context, taskId, targetId, linkType) {
    return taskStore.unlinkTask(context.paths, taskId, targetId, String(linkType));
}

async function taskBriefing(context, memberName) {
    return taskStore.formatTaskBriefing(context.paths, context.teamName, String(memberName));
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

function buildMemberTaskProtocol(teamName) {
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
   - CRITICAL: Before calling task_complete, you MUST post a task comment with your results (findings, research report, analysis, code changes summary, or any deliverable). The task comment is the primary delivery channel — the user reads results on the task board. A SendMessage to the lead is NOT a substitute: direct messages are ephemeral and not visible on the board. If you only SendMessage without a task comment, the user will never see your work.
   - If a new task comment means you must do more real work on that same task, FIRST add a short task comment saying what you are going to do, THEN run task_start again before doing the follow-up work.
   - After that follow-up work finishes, add a short task comment with the result, what changed, or what you verified.
   - After that, run task_complete again before your reply.
   - Never do comment-driven implementation/fix work while the task is still shown as pending, review, completed, or approved.
   - After task_complete, send a notification to your team lead via SendMessage that includes: (a) which task is done (#<displayId>), (b) a brief summary of the outcome/key findings (2-4 sentences — enough to understand the gist without reading the full comment), (c) mention that the full detailed results are in the task comment (include the commentId returned by task_add_comment so the lead can reference it, e.g. "Full report in task comment <commentId>"), (d) what you will do next. Do NOT duplicate the entire results — keep it concise.
   - After task_complete, if the task needs review AND the team has a member whose role includes reviewing (e.g. "reviewer", "tech-lead", "qa"), IMMEDIATELY call review_request to move it to the review column and notify the reviewer:
     { teamName: "${teamName}", taskId: "<taskId>", from: "<your-name>", reviewer: "<reviewer-name>" }
     Do NOT leave a completed task without sending it to review when review is expected and a reviewer exists.
     If no team member has a reviewer role, skip review_request — the task stays completed.
3b. When you BEGIN reviewing a task, FIRST call review_start to ensure it appears in the REVIEW column:
   { teamName: "${teamName}", taskId: "<taskId>", from: "<your-name>" }
   This is MANDATORY before review_approve or review_request_changes. Without this step, the kanban board may not show the task in REVIEW during your review.
4. If you are asked to review and the task is accepted, move it to APPROVED (not DONE) with MCP tool review_approve:
   { teamName: "${teamName}", taskId: "<taskId>", note?: "<optional note>", notifyOwner: true }
   CRITICAL: Text comments like "approved" or "LGTM" do NOT change the kanban board. You MUST call review_approve to move a task from REVIEW to APPROVED. Without the tool call the task stays stuck in the REVIEW column.
5. If review fails and changes are needed, use MCP tool review_request_changes:
   { teamName: "${teamName}", taskId: "<taskId>", comment: "<what to fix>" }
6. NEVER skip status updates. A task is NOT done until completed status is written.
   - Never "bulk-complete" a batch of tasks at the end. Update status incrementally as you work.
7. To reply to a comment on a task, use MCP tool task_add_comment:
   { teamName: "${teamName}", taskId: "<taskId>", text: "<your reply>", from: "<your-name>" }
8. When discussing a task with a teammate and you have important findings, decisions, blockers, or progress updates — record them as a task comment:
   { teamName: "${teamName}", taskId: "<taskId>", text: "<summary of your finding or decision>", from: "<your-name>" }
   Do NOT comment on trivial coordination messages. Only comment when the information is valuable context for the task.
9. When sending a message about a specific task, include its short display label like #<displayId> in your SendMessage summary field for traceability.
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
   c) STEP 3 — THEN, send a message to your team lead via SendMessage so they notice it promptly.
   IMPORTANT: Always update the task board BEFORE sending the message. The flag + task comment are what make the request durable and visible on the board.
   d) The flag is auto-cleared when the lead adds a task comment on your task.
      If the lead replies via SendMessage instead, clear the flag yourself once you have the answer:
      { teamName: "${teamName}", taskId: "<taskId>", value: "clear" }
   e) Do NOT set clarification to "user" yourself — only the team lead escalates to the user.
13. DEPENDENCY AWARENESS:
    When your task has blockedBy dependencies, check if they are completed before starting.
    When you complete a task that blocks others, mention this in your completion message so blocked teammates can proceed.
14. TASK QUEUE DISCIPLINE:
    - Use task_briefing as a compact queue view of your assigned tasks.
    - task_briefing may include full description/comments only for in_progress tasks; needsFix/pending/review/completed entries may be minimal on purpose.
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
    return `BACKGROUND PROCESS REGISTRATION — when you start a background process (dev server, watcher, database, etc.):
1. Launch with & to get PID:
   pnpm dev &
2. Register immediately with MCP tool process_register (--port and --url are optional, use when the process listens on a port):
   { teamName: "${teamName}", pid: <PID>, label: "<description>", from: "<your-name>", port?: <PORT>, url?: "http://localhost:<PORT>", command?: "<command>" }
3. VERIFY registration succeeded (MANDATORY — never skip this step) using MCP tool process_list:
   { teamName: "${teamName}" }
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

async function memberBriefing(context, memberName) {
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
    const member =
        resolved.members.find((entry) => normalizeMemberName(entry && entry.name) === requestedMemberKey) ||
        null;
    if (!member) {
        throw new Error(
            `Member not found in team metadata or inboxes: ${requestedMemberName}`
        );
    }
    const leadName = runtimeHelpers.inferLeadName(context.paths);
    const effectiveMember = member;

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
    const lines = [
        `Member briefing for ${requestedMemberName} on team "${context.teamName}" (${context.teamName}).`,
        `Role: ${role}.`,
        `CRITICAL: If a task gets a new comment and you are going to do additional implementation/fix/follow-up work on that same task, FIRST leave a short task comment saying what you are about to do, THEN move it to in_progress with task_start, THEN do the work, and when finished leave a short result comment and move it to done with task_complete. Never skip this comment -> reopen -> work -> comment -> done cycle.`,
        `CRITICAL: When you finish a task, your results (findings, research report, analysis, code changes summary, or any deliverable) MUST be posted as a task comment BEFORE calling task_complete. The task comment is the primary delivery channel — the user reads results on the task board. A SendMessage to the lead is NOT a substitute: direct messages are ephemeral and not visible on the board. If you only SendMessage without a task comment, the user will never see your work.`,
        `After task_complete, send a notification to your team lead via SendMessage: include which task is done (#<displayId>), a brief summary of the outcome/key findings (2-4 sentences), mention that full details are in the task comment (include the commentId from the task_add_comment response), and what you will do next. Do NOT duplicate the entire results — keep it concise.`,
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
        `2. Use task_briefing as your compact queue view whenever you need to see assigned work.`,
        `3. Before starting a pending or needs-fix task, call task_get for that specific task if you need the full context. A newly assigned task must not remain silently pending/TODO: if you are idle and the task is ready to start, start it now; if it must wait because another task is already active, because it is blocked, or because you still need more context, add a short task comment with the reason + ETA or what you are waiting on and keep it pending/TODO until you actually begin.`,
        `4. If this briefing was requested during reconnect, resume in_progress work first, then needs-fix tasks, then pending tasks.`,
        `5. If you cannot obtain the context you need, notify your team lead ("${leadName}") and wait instead of guessing.`
    );

    lines.push(
        '',
        buildMemberActionModeProtocol(),
        '',
        buildMemberFormattingProtocol(),
        '',
        buildMemberTaskProtocol(context.teamName),
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
    listTasks,
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
        taskStore.updateTask(context.paths, taskRef, updater),
    updateTaskFields,
};