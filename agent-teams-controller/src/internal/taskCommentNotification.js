const { extractAgentBlockContents, stripAgentBlocks, wrapAgentBlock } = require('./agentBlocks.js');

/**
 * The inbox message a task comment turns into.
 *
 * Quoting and agent blocks do not compose. `quoteMarkdown` prefixes every line
 * with `> `, which leaves the `<info_for_agent>` markers intact but no longer
 * alone on their lines, so `stripAgentBlocks` matches from the marker onwards
 * and leaves the `> ` that opened the block behind - a dangling blockquote line
 * in the UI. Worse, a comment the board itself wrote (dependency resolved:
 * "start working on it now") then arrives with its instructions quoted AND with
 * a second, separate agent block appended, so the member is told to start the
 * task twice.
 *
 * Observed on a live run: two member inboxes each held a comment notification
 * that ended on a stray `> ` line and carried the same start-the-task
 * instructions twice.
 *
 * So agent-only content is lifted OUT of the comment before quoting and
 * re-emitted, unquoted, in the one agent block this message appends. The quote
 * then holds exactly what a human should read, and the block holds exactly what
 * the agent should act on - each in a form the other side can strip cleanly.
 */
function quoteMarkdown(text) {
  return String(text)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function buildCommentNotificationMessage(context, task, comment) {
  const taskLabel = `#${task.displayId || task.id}`;
  const agentInstructions = [
    ...extractAgentBlockContents(comment.text),
    `Reply to this comment using MCP tool task_add_comment:
{ teamName: "${context.teamName}", taskId: "${task.id}", text: "<your reply>", from: "<your-name>" }`,
  ];
  return [
    `**Comment on task ${taskLabel}** _${task.subject}_`,
    ``,
    quoteMarkdown(stripAgentBlocks(comment.text)),
    ``,
    wrapAgentBlock(agentInstructions.join('\n\n')),
  ].join('\n');
}

module.exports = {
  buildCommentNotificationMessage,
  quoteMarkdown,
};
