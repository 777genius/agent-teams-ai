import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareDesktopProofMode } from './desktop-proof-mode.ts';
import {
  startDesktopApprovalModel,
  APPROVAL_TURNS,
  APPROVAL_ANSWER,
} from './desktop-approval-model.ts';
import { CONTEXT_MARKER } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
const toolNames = ['Bash', 'Read', 'Write', 'AskUserQuestion', 'mcp__team__message_send'];
const contract =
  'message_send tool to="user", including commandId and text. Do not reuse the incoming messageId as a reply commandId';
const input = (turn: string) => JSON.stringify({ messageId, text: turn }) + '\n' + contract;
const messageId = '745c45ca-9d6e-4b56-849b-42e25ed85d7a';
async function request(url: string, messages: unknown[]) {
  const response = await fetch(url + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      output_config: { effort: 'medium' },
      system: CONTEXT_MARKER,
      tools: toolNames.map((name) => ({ name })),
      messages,
    }),
  });
  return { status: response.status, text: await response.text() };
}
function action(text: string): Record<string, unknown> {
  const values = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
  const block = values.find((value) => value.type === 'content_block_start')
    ?.content_block as Record<string, unknown>;
  assert.ok(block);
  if (block.type === 'tool_use') {
    const delta = values.find((value) => value.type === 'content_block_delta')?.delta as Record<
      string,
      unknown
    >;
    return {
      ...block,
      input: JSON.parse(String(delta.partial_json)) as unknown,
    };
  }
  return block;
}
// Detects deny→allow substitution, empty-question-answer fallback and a repeated turn/tool effect.
test('finite approval model verifies real tool result meanings and emits one canonical reply for each input', async () => {
  const model = await startDesktopApprovalModel({
    workspace: () => '/private/TEST-approval',
  });
  try {
    for (const turn of APPROVAL_TURNS) {
      const messages: unknown[] = [{ role: 'user', content: input(turn) }];
      const expected =
        turn === 'M06_DENY_COMMAND'
          ? ['Bash']
          : turn.includes('QUESTION')
            ? ['AskUserQuestion']
            : ['Read', 'Write'];
      for (const [step, name] of [...expected, 'mcp__team__message_send'].entries()) {
        const response = await request(model.url, messages);
        assert.equal(response.status, 200, response.text);
        const tool = action(response.text);
        assert.equal(tool.name, name);
        assert.equal(tool.id, `m06_${turn.toLowerCase()}_${step}`);
        if (name === 'Write')
          assert.match(
            String((tool.input as Record<string, unknown>).file_path),
            /^\/private\/TEST-approval\//
          );
        if (name === 'mcp__team__message_send')
          assert.equal((tool.input as Record<string, unknown>).text, `DONE_${turn}`);
        messages.push({ role: 'assistant', content: [tool] });
        const denied = step === 0 && (turn === 'M06_DENY_COMMAND' || turn === 'M06_DENY_QUESTION');
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: tool.id,
              is_error: denied,
              content:
                name === 'mcp__team__message_send'
                  ? JSON.stringify({ phase: 'completed' })
                  : turn === 'M06_ANSWER_QUESTION'
                    ? APPROVAL_ANSWER
                    : denied
                      ? 'Denied by original operator'
                      : 'TEST native result',
            },
          ],
        });
      }
      const final = await request(model.url, messages);
      assert.equal(final.status, 200, final.text);
      assert.equal(action(final.text).type, 'text');
    }
    assert.equal(model.observations.length, 21);
    assert.equal(model.approvalReceipts.length, 15);
    assert.deepEqual(model.failures, []);
    assert.equal(model.approvalReceipts.filter((row) => row.toolResultError === true).length, 2);
    assert.equal(model.approvalReceipts.filter((row) => row.answer === APPROVAL_ANSWER).length, 1);
    const repeated = await request(model.url, [
      {
        role: 'user',
        content: input(APPROVAL_TURNS[0]),
      },
    ]);
    assert.equal(repeated.status, 400, 'no duplicate input replay');
  } finally {
    await model.close();
  }
});
test('question Deny cannot silently become a successful empty answer', async () => {
  const model = await startDesktopApprovalModel({
    workspace: () => '/private/TEST-approval',
  });
  try {
    const messages: unknown[] = [
      {
        role: 'user',
        content: input('M06_DENY_QUESTION'),
      },
    ];
    const first = await request(model.url, messages);
    assert.equal(first.status, 200);
    const tool = action(first.text);
    messages.push(
      { role: 'assistant', content: [tool] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: tool.id,
            is_error: false,
            content: '{}',
          },
        ],
      }
    );
    const result = await request(model.url, messages);
    assert.equal(result.status, 400);
    assert.equal(model.approvalReceipts.length, 0);
    assert.equal(model.failures.length, 1);
  } finally {
    await model.close();
  }
});

// The actual composition must allocate only this local response server; no fixture/principal is read early.
test('approval mode selects its manual-session proof lane and keeps ordinary modes unchanged', async () => {
  const mode = await prepareDesktopProofMode('approval-ui', () => {
    throw new Error('fixture root cannot be read until a native request');
  });
  try {
    assert.equal(mode.approvalUiMode, true);
    assert.equal(mode.nativeStopMode, true);
    assert.equal(mode.uiMode, true);
    assert.equal(mode.launchDialogMode, false);
    assert.equal(mode.conversationMode, false);
    assert.equal(mode.taskBoardUiMode, false);
    assert.ok(mode.model && 'approvalReceipts' in mode.model);
    assert.deepEqual(mode.model.observations, []);
    const ordinary = await prepareDesktopProofMode('team-ui', () => {
      throw new Error('ordinary mode allocates no model');
    });
    assert.equal(ordinary.approvalUiMode, false);
    assert.equal(ordinary.nativeStopMode, false);
    assert.equal(ordinary.model, undefined);
  } finally {
    await mode.model?.close();
  }
});

test('approval TEST fixture seeds exact private bytes and an empty native auto-allow list without Runtime effects', async (t) => {
  const { readFile, realpath, rm, readdir } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');
  const { prepareDesktopBackendFixture } = await import('./desktop-backend-fixture.ts');
  const repo = dirname(await realpath(join(import.meta.dirname, '../../packages')));
  const claude = await realpath(
    join(
      repo,
      'node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.305/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
    )
  );
  const fixture = await prepareDesktopBackendFixture(repo, {
    approvalUi: true,
    seedUiTask: true,
    pnpmEntry: '/opt/homebrew/Cellar/node@24/24.18.0/lib/node_modules/corepack/dist/pnpm.js',
    nativeClaude: {
      path: claude,
      sha256: 'ea3ea3c08d2a9634a4651e687fcf900d410c489bce2b00f22bd7352b91ba704f',
      modelUrl: 'http://127.0.0.1:9',
    },
  });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const profile = JSON.parse(await readFile(fixture.profilePath, 'utf8')) as {
    runtime: {
      members: { nativeTools: string[]; autoAllowedTools: string[] }[];
    };
  };
  assert.deepEqual(profile.runtime.members[0]!.nativeTools, [
    'Read',
    'Write',
    'Bash',
    'AskUserQuestion',
  ]);
  assert.deepEqual(profile.runtime.members[0]!.autoAllowedTools, []);
  assert.equal(
    await readFile(join(fixture.root, 'workspace/approval-preview.txt'), 'utf8'),
    'TEST_ORIGINAL_PRIVATE_BYTES\n'
  );
  assert.equal(
    await readFile(join(fixture.root, 'workspace/approval-auto.txt'), 'utf8'),
    'TEST_AUTO_ORIGINAL\n'
  );
  assert.equal(
    await readFile(join(fixture.root, 'workspace/approval-auto-next.txt'), 'utf8'),
    'TEST_AUTO_NEXT_ORIGINAL\n'
  );
  assert.deepEqual((await readdir(join(fixture.root, 'workspace'))).sort(), [
    'approval-auto-next.txt',
    'approval-auto.txt',
    'approval-preview.txt',
  ]);
  await assert.rejects(readdir(join(fixture.root, 'hoststore/runtime-sessions')), {
    code: 'ENOENT',
  });
});
