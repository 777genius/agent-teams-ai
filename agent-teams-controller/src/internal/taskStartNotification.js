const { wrapAgentBlock } = require('./agentBlocks.js');

function buildTaskStartNotification(teamName, task, taskLabel, notification, leadName, toolProtocol = 'legacy') {
  const taskGet = toolProtocol === 'captured-team'
    ? `task_get { taskId: ${JSON.stringify(task.id)} }`
    : `task_get { teamName: "${teamName}", taskId: "${task.id}" }`;
  const taskComplete = toolProtocol === 'captured-team'
    ? `task_complete { taskId: ${JSON.stringify(task.id)}, commandId: "<new stable completion command ID>" }`
    : `task_complete { teamName: "${teamName}", taskId: "${task.id}", actor: "${task.owner}" }`;
  if (notification === 'user') {
    const parts = [`**start working on task now** ${taskLabel} "${task.subject}"`];
    if (task.description?.trim()) {
      parts.push(`\nDetails:\n${task.description.trim()}`);
    }
    if (task.prompt?.trim()) {
      parts.push(`\nInstructions:\n${task.prompt.trim()}`);
    }
    parts.push(
      '',
      wrapAgentBlock(
        [
          `This start notification can become stale after reassignment or completion. Before modifying anything, fetch the current task and verify that task.owner is your configured teammate name and task.status is pending or in_progress. If the owner changed or the task is completed/deleted, do not start or reopen it, modify files, add a completion comment, or complete it; stop unless the current owner explicitly asks you to collaborate on fresh follow-up work.`,
          `Begin work on this task immediately. Keep it moving until it is completed or clearly blocked. Do not leave it idle.`,
          `To fetch the full task context (description, comments, attachments) use:`,
          taskGet,
          `When done, update task status:`,
          taskComplete,
        ].join('\n')
      )
    );
    return {
      member: task.owner,
      from: 'user',
      text: parts.join('\n'),
      taskRefs: task.descriptionTaskRefs,
      summary: `Start working on ${taskLabel}`,
      source: 'system_notification',
    };
  }
  const parts = [`**start working on task now** ${taskLabel} "${task.subject}"`];
  if (task.description?.trim()) {
    parts.push(`\nDetails:\n${task.description.trim()}`);
  }
  parts.push(
    '',
    wrapAgentBlock(
      [
        `Begin work on this task immediately. Keep it moving until it is completed or clearly blocked. Do not leave it idle.`,
        `Update task status using the board MCP tools:`,
        taskComplete,
      ].join('\n')
    )
  );

  return {
    member: task.owner,
    from: leadName,
    text: parts.join('\n'),
    taskRefs: task.descriptionTaskRefs,
    summary: `Start working on ${taskLabel}`,
    source: 'system_notification',
  };
}

module.exports = { buildTaskStartNotification };
