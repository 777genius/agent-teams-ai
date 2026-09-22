const { wrapAgentBlock } = require('./agentBlocks.js');

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

module.exports = {
    MEMBER_DELEGATE_DESCRIPTION,
    buildActionModeProtocolText,
    buildMemberActionModeProtocol,
    buildMemberFormattingProtocol,
    buildMemberProcessProtocol,
    buildProcessProtocolText,
};
