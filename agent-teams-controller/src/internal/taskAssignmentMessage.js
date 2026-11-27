const { wrapAgentBlock } = require('./agentBlocks.js');
const { createMemberMessagingProtocol } = require('./memberMessagingProtocol.js');

function buildAssignmentMessage(context, task, options = {}) {
    const bound = context.boundTaskTools === true;
    const messagingProtocol = bound
        ? createMemberMessagingProtocol(options.messagingProtocol?.runtimeProvider || 'native', true)
        : options.messagingProtocol || createMemberMessagingProtocol('native');
    const example = (tool, payload, legacy) => bound
        ? messagingProtocol.boundTeamToolExample(tool, { taskId: task.id, ...payload })
        : legacy;
    const taskGet = bound
        ? `task_get ${JSON.stringify({ taskId: task.id })}`
        : `task_get { teamName: "${context.teamName}", taskId: "${task.id}" }`;
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
        text: `#${task.displayId || task.id} done. <2-4 sentence summary>. Full details in task comment <short-commentId-from-step-5>. Moving to next task.`,
        summary: `#${task.displayId || task.id} done`,
    });
    const runtimeVisibleMessageRule = messagingProtocol.visibleMessageRule
        ? `\n   ${messagingProtocol.visibleMessageRule}`
        : '';
    const runtimeTaskToolHint = messagingProtocol.taskToolHint
        ? `\n   ${messagingProtocol.taskToolHint}`
        : '';

    lines.push(
        ``,
        wrapAgentBlock(`${bound ? 'Team and actor come from your authenticated connection. Use a new commandId for each distinct write and keep it unchanged when retrying that original result.\n' : ''}Use the board MCP tools to work this task correctly:
1. Check the latest full context before starting:
   ${taskGet}
   If task_get returns groupChatId, it is task context metadata, not membership or reply routing. Refresh group_chat_list before proactive group sends. To create a group-associated task, ${bound ? 'pass groupChatId to task_create; the creating actor comes from your authenticated connection.' : 'pass groupChatId plus your configured non-user createdBy/from actor.'}
2. Assignment notifications can become stale after a reassignment or completion. After task_get, compare task.owner with your configured teammate name and check task.status. If task.owner is empty or belongs to someone else, or task.status is completed or deleted, do not start or reopen the task, modify files for it, add a completion comment, or complete it. Stop and wait unless the current owner explicitly asks you to collaborate on fresh follow-up work.
3. If you are still the current owner, are idle, and the task is ready to start after checking dependencies and context, call task_start now:
   ${example('task_start', {}, `task_start { teamName: "${context.teamName}", taskId: "${task.id}", actor: "<your-name>" }`)}
4. If you are still the current owner but are busy on another task, blocked, or still need more context, immediately add a task comment on this task with the reason and your best ETA or what you are waiting on, keep it pending/TODO, and do not call task_start until you truly begin:
   ${example('task_add_comment', { text: '<reason + ETA or blocker>' }, `task_add_comment { teamName: "${context.teamName}", taskId: "${task.id}", text: "<reason + ETA or blocker>", from: "<your-name>" }`)}
5. When the work is done, FIRST post a task comment with your full results, THEN mark it completed:
   ${example('task_add_comment', { text: '<full results>' }, `task_add_comment { teamName: "${context.teamName}", taskId: "${task.id}", text: "<full results>", from: "<your-name>" }`)}
   The response contains comment.id (UUID). Take its first 8 characters as the short commentId.
   ${example('task_complete', {}, `task_complete { teamName: "${context.teamName}", taskId: "${task.id}", actor: "<your-name>" }`)}
6. After task_complete, notify your lead via ${messagingProtocol.sendLeadPhrase} with a brief summary and a pointer to the full comment (use the short commentId from step 5).
   Example: ${notifyLeadExample}${runtimeVisibleMessageRule}${runtimeTaskToolHint}`)
    );

    return lines.join('\n');
}

module.exports = {
    buildAssignmentMessage,
};
