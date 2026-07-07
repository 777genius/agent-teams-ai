import {
  parseAgentTaskEvent,
  parseAgentTaskRequest,
  parseAgentTaskResult,
} from "./agent-task-codec";
import { compareAgentTaskRoundMembers } from "../domain/round-members";
import type {
  AgentTaskEvent,
  AgentTaskRequest,
  AgentTaskResult,
  AgentTaskRoundMemberIdentity,
} from "../domain/agent-task-contracts";

export type AgentTaskCertificationCheck = {
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly safeMessage: string;
};

export type AgentTaskCertificationReport = {
  readonly status: "passed" | "failed";
  readonly checks: readonly AgentTaskCertificationCheck[];
};

export type AgentTaskCertificationInput = {
  readonly request: unknown;
  readonly result: unknown;
  readonly events?: readonly unknown[];
  readonly forbiddenSecrets?: readonly string[];
  readonly requireRoundMemberIdentity?: boolean;
  readonly requireRoundMemberIndependence?: boolean;
  readonly requireTerminalEvent?: boolean;
  readonly distinctFromRoundMember?: AgentTaskRoundMemberIdentity;
};

export function certifyAgentTaskExchange(
  input: AgentTaskCertificationInput,
): AgentTaskCertificationReport {
  const checks: AgentTaskCertificationCheck[] = [];
  const request = validate("request", checks, () =>
    parseAgentTaskRequest(input.request),
  );
  const result = validate("result", checks, () =>
    parseAgentTaskResult(input.result),
  );
  const events = validate("events", checks, () =>
    (input.events ?? []).map((event) => parseAgentTaskEvent(event)),
  );

  if (request && result) {
    addPassed(checks, "request-result", "Request and result use the agent-task protocol.");
  }
  if (events) {
    checkTerminalEvent(events, result ?? null, input.requireTerminalEvent === true, checks);
    checkEventOrder(events, checks);
  }
  checkRoundMember(
    request,
    {
      ...(input.distinctFromRoundMember === undefined
        ? {}
        : { distinctFromRoundMember: input.distinctFromRoundMember }),
      requireRoundMemberIdentity: input.requireRoundMemberIdentity === true,
      requireRoundMemberIndependence:
        input.requireRoundMemberIndependence === true,
    },
    checks,
  );
  checkSecretLeaks(
    {
      request,
      result,
      events,
    },
    input.forbiddenSecrets ?? [],
    checks,
  );

  return {
    status: checks.some((check) => check.status === "failed")
      ? "failed"
      : "passed",
    checks,
  };
}

function checkRoundMember(
  request: AgentTaskRequest | null,
  input: {
    readonly distinctFromRoundMember?: AgentTaskRoundMemberIdentity;
    readonly requireRoundMemberIdentity: boolean;
    readonly requireRoundMemberIndependence: boolean;
  },
  checks: AgentTaskCertificationCheck[],
): void {
  const member = request?.context?.round?.member;
  if (!member) {
    if (input.requireRoundMemberIdentity) {
      addFailed(
        checks,
        "round-member",
        "Missing request.context.round.member identity.",
      );
    } else {
      addPassed(checks, "round-member", "No round member required.");
    }
    return;
  }
  addPassed(checks, "round-member", "Round member identity is present.");

  if (!input.requireRoundMemberIndependence) return;
  const other =
    input.distinctFromRoundMember ?? request?.context?.round?.adversaryOf;
  if (!other) {
    addFailed(
      checks,
      "round-member-independence",
      "Missing adversarial round member identity to compare against.",
    );
    return;
  }
  const result = compareAgentTaskRoundMembers(member, other);
  if (!result.ok) {
    addFailed(checks, "round-member-independence", result.safeMessage);
    return;
  }
  addPassed(
    checks,
    "round-member-independence",
    "Round member is independent from its adversarial counterpart.",
  );
}

export function assertAgentTaskCertification(
  input: AgentTaskCertificationInput,
): void {
  const report = certifyAgentTaskExchange(input);
  if (report.status === "passed") return;
  const failures = report.checks
    .filter((check) => check.status === "failed")
    .map((check) => `${check.name}: ${check.safeMessage}`)
    .join("; ");
  throw new Error(`agent_task_certification_failed: ${failures}`);
}

function validate<T>(
  name: string,
  checks: AgentTaskCertificationCheck[],
  fn: () => T,
): T | null {
  try {
    const value = fn();
    addPassed(checks, name, `${name} is protocol-valid.`);
    return value;
  } catch (error) {
    addFailed(
      checks,
      name,
      error instanceof Error ? error.message : `${name} is invalid.`,
    );
    return null;
  }
}

function checkTerminalEvent(
  events: readonly AgentTaskEvent[],
  result: AgentTaskResult | null,
  required: boolean,
  checks: AgentTaskCertificationCheck[],
): void {
  const terminal = [...events].reverse().find((event) => event.type === "completed");
  if (!terminal) {
    if (required) {
      addFailed(checks, "terminal-event", "Missing completed terminal event.");
    } else {
      addPassed(checks, "terminal-event", "No terminal event required.");
    }
    return;
  }
  if (result && JSON.stringify(terminal.result) !== JSON.stringify(result)) {
    addFailed(
      checks,
      "terminal-event",
      "Completed event result does not match the returned result.",
    );
    return;
  }
  addPassed(checks, "terminal-event", "Completed event matches the returned result.");
}

function checkEventOrder(
  events: readonly AgentTaskEvent[],
  checks: AgentTaskCertificationCheck[],
): void {
  let previous = 0;
  for (const [index, event] of events.entries()) {
    const current = Date.parse(event.occurredAt);
    if (Number.isNaN(current) || current < previous) {
      addFailed(
        checks,
        "event-order",
        `Event ${index} occurred before a prior event.`,
      );
      return;
    }
    previous = current;
  }
  addPassed(checks, "event-order", "Events are timestamp ordered.");
}

function checkSecretLeaks(
  input: {
    readonly request: AgentTaskRequest | null;
    readonly result: AgentTaskResult | null;
    readonly events: readonly AgentTaskEvent[] | null;
  },
  secrets: readonly string[],
  checks: AgentTaskCertificationCheck[],
): void {
  const meaningfulSecrets = secrets.filter((secret) => secret.length >= 4);
  if (meaningfulSecrets.length === 0) {
    addPassed(checks, "secret-redaction", "No forbidden secrets supplied.");
    return;
  }
  const haystack = JSON.stringify({
    result: input.result,
    events: input.events,
  });
  const leaked = meaningfulSecrets.find((secret) => haystack.includes(secret));
  if (leaked) {
    addFailed(
      checks,
      "secret-redaction",
      `Output contains forbidden secret with length ${leaked.length}.`,
    );
    return;
  }
  addPassed(checks, "secret-redaction", "No forbidden secrets found in output.");
}

function addPassed(
  checks: AgentTaskCertificationCheck[],
  name: string,
  safeMessage: string,
): void {
  checks.push({ name, status: "passed", safeMessage });
}

function addFailed(
  checks: AgentTaskCertificationCheck[],
  name: string,
  safeMessage: string,
): void {
  checks.push({ name, status: "failed", safeMessage });
}
