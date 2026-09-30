import * as agentTeamsControllerModule from 'agent-teams-controller';

type ControllerModule = typeof import('agent-teams-controller') & {
  default?: typeof import('agent-teams-controller');
};

const { hostedTaskCommand } =
  (agentTeamsControllerModule as ControllerModule).default ?? agentTeamsControllerModule;

export const HOSTED_TASK_COMMAND_FLAG = '--hosted-task-command';
const CLAUDE_DIR_ENV = 'AGENT_TEAMS_MCP_CLAUDE_DIR';
const MAX_INPUT_BYTES = 64 * 1024;

export const HOSTED_TASK_COMMAND_EXIT = {
  answered: 0,
  failed: 1,
  invalidRequest: 2,
} as const;

async function readBoundedInput(input: NodeJS.ReadableStream): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_INPUT_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function invalidRequest(output: NodeJS.WritableStream, message: string): number {
  output.write(
    `${JSON.stringify({ schemaVersion: 1, error: { kind: 'invalid_request', message } })}\n`
  );
  return HOSTED_TASK_COMMAND_EXIT.invalidRequest;
}

/**
 * One hosted task command per process: one JSON object on stdin, one JSON line on stdout.
 * The MCP server never starts in this mode. Diagnostics go to stderr only.
 */
export async function runHostedTaskCommandMode(io: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
}): Promise<number> {
  const claudeDir = io.env[CLAUDE_DIR_ENV]?.trim();
  if (!claudeDir) return invalidRequest(io.output, `${CLAUDE_DIR_ENV} is required`);
  const text = await readBoundedInput(io.input);
  if (text === null) return invalidRequest(io.output, 'input exceeds 64 KiB');
  let request: unknown;
  try {
    request = JSON.parse(text);
  } catch {
    return invalidRequest(io.output, 'input is not JSON');
  }
  try {
    const response = hostedTaskCommand.executeHostedTaskCommand(request, { claudeDir });
    io.output.write(`${JSON.stringify(response)}\n`);
    return HOSTED_TASK_COMMAND_EXIT.answered;
  } catch (error) {
    if (error instanceof hostedTaskCommand.HostedTaskCommandInputError) {
      return invalidRequest(io.output, error.message);
    }
    console.error(
      `hosted task command failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return HOSTED_TASK_COMMAND_EXIT.failed;
  }
}
