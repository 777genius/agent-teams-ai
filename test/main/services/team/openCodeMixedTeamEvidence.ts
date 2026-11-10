import assert from 'node:assert/strict';

type JsonRecord = Record<string, unknown>;

export async function assertOwnedSmokeEnvironment(
  env: NodeJS.ProcessEnv,
  kind: 'FULL' | 'MIXED'
): Promise<void> {
  // The JS-only runner owns this contract; use a typed dynamic import without a new declaration file.
  const runnerUrl = new URL(
    '../../../../scripts/prove-opencode-full-team.mjs',
    import.meta.url
  ).href;
  const runner: {
    assertOwnedSmokeEnvironment: (env: NodeJS.ProcessEnv, kind: string) => void;
  } = await import(runnerUrl);
  runner.assertOwnedSmokeEnvironment(env, kind);
}

// Read structured assistant tool evidence, never substring-match a user prompt or raw JSON dump.
export function successfulTools(
  transcript: unknown
): { name: string; input: JsonRecord; output: string }[] {
  const data = record(record(transcript)?.data);
  const messages = data?.messages;
  if (!Array.isArray(messages)) return [];
  const calls: { name: string; input: JsonRecord; output: string }[] = [];
  for (const rawMessage of messages) {
    const message = record(rawMessage);
    if (message?.role !== 'assistant' || !Array.isArray(message.contentBlocks)) continue;
    const blocks = message.contentBlocks
      .map(record)
      .filter((block): block is JsonRecord => block !== null);
    for (const block of blocks) {
      if (
        block.type !== 'tool_use' ||
        typeof block.name !== 'string' ||
        typeof block.id !== 'string' ||
        !block.id ||
        !record(block.input)
      )
        continue;
      const result = blocks.find(
        (candidate) =>
          candidate.type === 'tool_result' &&
          candidate.toolUseId === block.id &&
          candidate.isError !== true &&
          candidate.status === 'completed'
      );
      if (result)
        calls.push({
          name: block.name,
          input: record(block.input)!,
          output: String(result.contentText ?? ''),
        });
    }
  }
  return calls;
}
export function assertTranscriptModel(transcript: unknown, selected: string): void {
  const messages = record(record(transcript)?.data)?.messages;
  assert.ok(Array.isArray(messages), 'Transcript messages unavailable');
  const assistants = messages.map(record).filter((message) => message?.role === 'assistant');
  assert.ok(assistants.length > 0, 'Assistant inference unavailable');
  for (const message of assistants) {
    assert.equal(`${message!.providerId}/${message!.modelId}`, selected, 'Exact model proof missing');
  }
}

export function assertTranscriptSession(transcript: unknown, sessionId: unknown): void {
  assert.ok(typeof sessionId === 'string' && sessionId.length > 0, 'Expected session missing');
  const data = record(record(transcript)?.data);
  assert.ok(data, 'Transcript unavailable');
  assert.equal(data.sessionId, sessionId, 'Transcript session mismatch');
  const messages = data.messages;
  assert.ok(Array.isArray(messages), 'Transcript messages unavailable');
  for (const message of messages.map(record)) {
    if (message?.sessionId !== undefined) assert.equal(message.sessionId, sessionId);
  }
}

type ToolEvidence = ReturnType<typeof successfulTools>[number];
export function isTeamTool(tool: ToolEvidence, name: 'task_complete' | 'message_send'): boolean {
  return [name, `agent-teams_${name}`, `agent_teams_${name}`, `mcp__agent-teams__${name}`].includes(
    tool.name
  );
}
export function hasTaskCompletion(
  tools: ToolEvidence[],
  teamName: string,
  taskId: string,
  actor: string
) {
  return tools.some(
    (tool) =>
      isTeamTool(tool, 'task_complete') &&
      tool.input.teamName === teamName &&
      tool.input.taskId === taskId &&
      tool.input.actor === actor
  );
}
export function hasMessage(
  tools: ToolEvidence[],
  teamName: string,
  from: string,
  to: string,
  text: string
) {
  return tools.some(
    (tool) =>
      isTeamTool(tool, 'message_send') &&
      tool.input.teamName === teamName &&
      tool.input.from === from &&
      tool.input.to === to &&
      tool.input.text === text
  );
}
export function hasExecution(tools: ToolEvidence[], marker: string) {
  return tools.some(
    (tool) =>
      ['bash', 'shell', 'exec'].includes(tool.name) && tool.output.split(/\r?\n/).includes(marker)
  );
}

// Stop can clear the tracked run, but may not hide a missing member or another active run.
export function assertStoppedSnapshot(snapshot: unknown, runId: unknown, names: readonly string[]) {
  const value = record(snapshot);
  assert.ok(typeof runId === 'string' && runId.length > 0);
  assert.ok(value?.runId === null || value?.runId === runId, 'Unexpected stopped run');
  const members = record(value?.members);
  for (const name of names) assert.equal(record(members?.[name])?.alive, false);
}

export async function finalizeProof(write: () => Promise<void>, reset: () => void): Promise<void> {
  try {
    await write();
  } finally {
    reset();
  }
}

export async function closeOnSetupFailure<T>(
  resource: { close: () => Promise<unknown> },
  setup: () => Promise<T>
): Promise<T> {
  try {
    return await setup();
  } catch {
    // Do not expose setup/provider errors, and close even when setup only partially succeeded.
    try {
      await resource.close();
    } catch {
      throw new Error('Owned control API setup failed; close not confirmed');
    }
    throw new Error('Owned control API setup failed');
  }
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

export function relayMetadata(value: unknown) {
  const root = record(value) ?? {};
  const delivery = record(root.lastDelivery) ?? {};
  const number = (item: unknown) =>
    typeof item === 'number' && Number.isFinite(item) ? item : null;
  const boolean = (item: unknown) => (typeof item === 'boolean' ? item : null);
  return {
    attempted: number(root.attempted),
    relayed: number(root.relayed),
    failed: number(root.failed),
    accepted: boolean(delivery.accepted),
    responsePending: boolean(delivery.responsePending),
    acceptanceUnknown: boolean(delivery.acceptanceUnknown),
    ledgerStatus: [
      'pending',
      'accepted',
      'responded',
      'unanswered',
      'retry_scheduled',
      'retried',
      'failed_retryable',
      'failed_terminal',
    ].includes(String(delivery.ledgerStatus))
      ? delivery.ledgerStatus
      : null,
    terminalFailure:
      delivery.ledgerStatus === 'failed_terminal' &&
      delivery.accepted !== true &&
      delivery.acceptanceUnknown !== true &&
      delivery.responsePending !== true,
  };
}
