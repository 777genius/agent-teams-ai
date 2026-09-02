const {
  extractAgentBlockContents,
  stripAgentBlocks,
  wrapAgentBlock,
} = require('../src/internal/agentBlocks.js');
const { buildCommentNotificationMessage } = require('../src/internal/taskCommentNotification.js');

const CONTEXT = { teamName: 'docs-team' };
const TASK = {
  id: 'b46e9832-b36a-5d09-9231-7c98bb147cca',
  displayId: 'b46e9832',
  subject: 'Write docs/PROJECT_SUMMARY.md from both comments',
};

/** The dependency-resolved comment the board writes for a blocked task. */
function depResolvedCommentText() {
  return [
    '**Dependency resolved** — task #354bc876 _Post top 3 risks as a comment on this task_ completed.',
    '',
    `All blockers for #${TASK.displayId} are resolved — this task is ready to start.`,
    '',
    wrapAgentBlock(
      [
        'All dependencies for this task are now resolved.',
        'If you are idle, start working on it now:',
        `1. Check the full context: task_get { teamName: "${CONTEXT.teamName}", taskId: "${TASK.id}" }`,
        `2. Start the task: task_start { teamName: "${CONTEXT.teamName}", taskId: "${TASK.id}", actor: "bob" }`,
      ].join('\n')
    ),
  ].join('\n');
}

describe('buildCommentNotificationMessage', () => {
  it('quotes a plain comment and appends the reply instructions', () => {
    const message = buildCommentNotificationMessage(CONTEXT, TASK, {
      text: 'Top 3 risks:\n1. Token in env\n2. No retries',
    });

    expect(message).toContain(`**Comment on task #${TASK.displayId}** _${TASK.subject}_`);
    expect(message).toContain('> Top 3 risks:\n> 1. Token in env\n> 2. No retries');
    expect(message).toContain('Reply to this comment using MCP tool task_add_comment:');
  });

  /**
   * Observed on a live run: the comment was quoted whole, so the `<info_for_agent>`
   * markers survived with a `> ` in front of them. Stripping matched from the
   * marker onwards and left the `> ` that opened the block behind, and the
   * member got the start-the-task instructions twice - once inside the quote,
   * once in the appended block.
   */
  it('lifts agent blocks out of the quote instead of quoting them', () => {
    const message = buildCommentNotificationMessage(CONTEXT, TASK, {
      text: depResolvedCommentText(),
    });

    expect(message).not.toContain('> <info_for_agent>');
    expect(extractAgentBlockContents(message)).toHaveLength(1);
    // Both instruction sets survive, in the one block, where the markers parse.
    expect(message).toContain('If you are idle, start working on it now:');
    expect(message).toContain('Reply to this comment using MCP tool task_add_comment:');
  });

  it('leaves no dangling blockquote line in the UI-visible text', () => {
    const visible = stripAgentBlocks(
      buildCommentNotificationMessage(CONTEXT, TASK, { text: depResolvedCommentText() })
    );

    expect(visible).not.toContain('<info_for_agent>');
    expect(visible.split('\n').at(-1)?.trim()).not.toBe('>');
    expect(visible.endsWith('this task is ready to start.')).toBe(true);
  });

  it('does not repeat the start-the-task instructions', () => {
    const message = buildCommentNotificationMessage(CONTEXT, TASK, {
      text: depResolvedCommentText(),
    });

    expect(message.split('If you are idle, start working on it now:')).toHaveLength(2);
  });
});
