import assert from 'node:assert/strict';
import { join } from 'node:path';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};

/** Finite response script for the existing localhost Anthropic server; native Claude runs every tool. */
export function ordinarySubagentScript(workspace: string, parentStopRequested: () => boolean = () => false) {
  const requests: { turn: string; step: number; tools: string[]; previousToolError: boolean }[] = [];
  const counts = new Map<string, number>();
  let sequence = 0;
  return {
    requests,
    respond(body: Row, tools: string[]): Row {
      assert.ok(requests.length < 32, 'finite ordinary subagent request budget');
      const messages = (Array.isArray(body.messages) ? body.messages : []).map(record);
      const texts = messages.filter(message => message.role === 'user').flatMap(message => typeof message.content === 'string' ? [message.content] :
        Array.isArray(message.content) ? message.content.map(record).filter(block => block.type === 'text').map(block => String(block.text)) : []);
      const marker = texts.toReversed().map(text => /TEST_CHILD_(EFFECT|STOP|DENY)|NATIVE_SOLO_(EFFECT|STOP|DENY|NEIGHBOR_ONE|NEIGHBOR_TWO)/.exec(text)?.[0]).find(Boolean);
      assert.ok(marker, 'actual model request belongs to an explicit TEST parent/child input');
      const turn = marker, step = counts.get(turn) ?? 0;
      counts.set(turn, step + 1);
      const results = messages.flatMap(message => Array.isArray(message.content) ? message.content.map(record).filter(block => block.type === 'tool_result') : []);
      const previousToolError = results.at(-1)?.is_error === true;
      requests.push({ turn, step, tools, previousToolError });
      const tool = (name: string, input: Row): Row => ({ type: 'tool_use', id: `native_solo_${++sequence}`, name, input });
      if (turn.startsWith('NATIVE_SOLO_NEIGHBOR')) {
        if (step === 0) { assert.ok(tools.includes('Bash')); return tool('Bash', { command: `printf '${turn}\\n' >> neighbor-effect.txt`, description: 'Write a TEST neighbor proof' }); }
        assert.equal(previousToolError, false); return { type: 'text', text: `DONE_${turn}` };
      }
      if (turn.startsWith('NATIVE_SOLO_')) {
        if (step === 0) {
          assert.ok(tools.includes('Agent'), 'actual native catalog contains ordinary Agent');
          return tool('Agent', { prompt: turn.replace('NATIVE_SOLO_', 'TEST_CHILD_'), description: 'TEST ordinary child', subagent_type: 'host-ordinary', run_in_background: false });
        }
        if (turn === 'NATIVE_SOLO_STOP' && parentStopRequested())
          assert.equal(previousToolError, true, 'actual requested parent stop interrupts its running Agent tool');
        else assert.equal(previousToolError, turn === 'NATIVE_SOLO_DENY', 'actual ASK/DO policy decided the Agent tool result');
        return { type: 'text', text: `DONE_${turn}` };
      }
      assert.notEqual(turn, 'TEST_CHILD_DENY', 'ASK mode must deny before any actual child inference');
      assert.equal(tools.some(name => name.startsWith('mcp__team__')), false, 'native child receives no Team MCP catalog/grants');
      assert.equal(tools.includes('Agent'), false, 'child cannot create more children');
      if (turn === 'TEST_CHILD_EFFECT') {
        if (step === 0) { assert.ok(tools.includes('Write')); return tool('Write', { file_path: join(workspace, 'child-effect.txt'), content: 'TEST_ACTUAL_ORDINARY_CHILD_EFFECT\n' }); }
        if (step === 1) { assert.equal(previousToolError, false); return tool('mcp__team__message_send', { commandId: 'TEST-child-forbidden', to: 'user', text: 'TEST_FORBIDDEN_CHILD_TEAM_MESSAGE', actor: 'user' }); }
        assert.equal(previousToolError, true, 'native child Team MCP attempt is rejected before any Team effect');
        return { type: 'text', text: 'TEST_CHILD_REPORT_COMPLETE' };
      }
      assert.equal(turn, 'TEST_CHILD_STOP');
      if (step === 0) {
        assert.ok(tools.includes('Bash'));
        return tool('Bash', { command: 'i=0; while test "$i" -lt 100; do printf "tick\\n" >> child-running.txt; i=$((i+1)); sleep 0.15; done', description: 'Finite TEST-owned child process for parent stop proof' });
      }
      return { type: 'text', text: 'TEST_CHILD_STOP_FINISHED' };
    },
  };
}
