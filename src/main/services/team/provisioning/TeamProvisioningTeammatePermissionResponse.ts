import { buildTeammatePermissionUpdatedInput } from './TeamProvisioningToolApprovalFlow';

import type { InboxMessage, TeamChangeEvent, TeamConfig } from '@shared/types';
import type { PermissionSuggestion } from '@shared/utils/inboxNoise';

export interface TeamProvisioningTeammatePermissionRun {
  runId: string;
  teamName: string;
  request?: {
    members: {
      name: string;
      role?: string;
    }[];
  };
  child?: {
    stdin?: {
      writable?: boolean;
      write(data: string, callback?: (err?: Error | null) => void): unknown;
    } | null;
  } | null;
}

export interface TeamProvisioningTeammatePermissionResponseLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface TeamProvisioningTeammatePermissionResponsePorts {
  readConfigForStrictDecision(teamName: string): Promise<TeamConfig | null>;
  addPermissionRulesToSettings(
    settingsPath: string,
    toolNames: string[],
    behavior: string
  ): Promise<number>;
  persistInboxMessage(teamName: string, recipient: string, message: InboxMessage): void;
  emitTeamChange(event: TeamChangeEvent): void;
  logger: TeamProvisioningTeammatePermissionResponseLogger;
  nowIso(): string;
  nowMs(): number;
  joinPath(...parts: string[]): string;
  teammateOperationalToolNames: readonly string[];
}

export interface RespondToTeammatePermissionInput {
  run: TeamProvisioningTeammatePermissionRun;
  agentId: string;
  requestId: string;
  allow: boolean;
  message?: string;
  permissionSuggestions?: PermissionSuggestion[];
  toolName?: string;
  toolInput?: Record<string, unknown>;
}

interface SendTeammatePermissionResponseInput {
  run: TeamProvisioningTeammatePermissionRun;
  agentId: string;
  requestId: string;
  allow: boolean;
  message?: string;
  permissionUpdates?: unknown[];
  toolName?: string;
  toolInput?: Record<string, unknown>;
}

export async function respondToTeammatePermission(
  input: RespondToTeammatePermissionInput,
  ports: TeamProvisioningTeammatePermissionResponsePorts
): Promise<void> {
  const { run, agentId, requestId, allow, message, toolName, toolInput } = input;

  if (!allow) {
    ports.logger.info(`[${run.teamName}] Denied teammate ${agentId} permission ${requestId}`);
    sendTeammatePermissionResponse(
      {
        run,
        agentId,
        requestId,
        allow: false,
        message,
        toolName,
      },
      ports
    );
    return;
  }

  const suggestions = input.permissionSuggestions ?? [];
  const sendSuccessResponse = (): void => {
    sendTeammatePermissionResponse(
      {
        run,
        agentId,
        requestId,
        allow: true,
        message,
        permissionUpdates: suggestions,
        toolName,
        toolInput,
      },
      ports
    );
  };

  // Apply permission_suggestions: add tool rules to project settings file.
  if (suggestions.length === 0) {
    ports.logger.info(
      `[${run.teamName}] No permission_suggestions for ${requestId}; sending allow responses only`
    );
  } else {
    // Resolve project cwd from team config
    let projectCwd: string | undefined;
    try {
      const config = await ports.readConfigForStrictDecision(run.teamName);
      projectCwd = config?.projectPath ?? config?.members?.[0]?.cwd;
    } catch {
      // best-effort
    }

    if (!projectCwd) {
      ports.logger.warn(
        `[${run.teamName}] Cannot resolve project cwd for permission rule; sending allow responses only`
      );
    } else {
      for (const suggestion of suggestions) {
        // Handle "setMode" suggestions (e.g. Write/Edit tools suggest acceptEdits mode)
        // FACT: Write/Edit permission_requests have permission_suggestions:
        //   { type: "setMode", mode: "acceptEdits", destination: "session" }
        // Since we can't change session mode of a subprocess, we translate to addRules.
        if (suggestion.type === 'setMode') {
          const mode = typeof suggestion.mode === 'string' ? suggestion.mode : '';
          let toolNames: string[] = [];
          if (mode === 'acceptEdits') {
            toolNames = ['Edit', 'Write', 'NotebookEdit'];
          } else if (mode === 'bypassPermissions') {
            // Broad approval - add common tools
            toolNames = ['Edit', 'Write', 'NotebookEdit', 'Bash', 'Read', 'Grep', 'Glob'];
          }
          if (toolNames.length > 0) {
            const settingsPath = ports.joinPath(projectCwd, '.claude', 'settings.local.json');
            try {
              await ports.addPermissionRulesToSettings(settingsPath, toolNames, 'allow');
              ports.logger.info(
                `[${run.teamName}] Applied setMode "${mode}" for ${agentId}: ${toolNames.join(', ')} in ${settingsPath}`
              );
            } catch (error) {
              ports.logger.error(
                `[${run.teamName}] Failed to apply setMode: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }
          }
          continue;
        }

        if (suggestion.type !== 'addRules' || !Array.isArray(suggestion.rules)) continue;

        let toolNames = suggestion.rules
          .map((rule) => rule.toolName)
          .filter((name): name is string => typeof name === 'string' && name.length > 0);
        if (toolNames.length === 0) continue;

        // Expand teammate-safe operational tools only.
        // This removes the bootstrap/task workflow race without accidentally granting
        // admin/runtime tools like team_stop or kanban_clear.
        if (toolNames.some((name) => ports.teammateOperationalToolNames.includes(name))) {
          const merged = new Set([...toolNames, ...ports.teammateOperationalToolNames]);
          toolNames = Array.from(merged);
        }

        const behavior = suggestion.behavior ?? 'allow';
        // FACT: observed destinations are "localSettings" (project-level .claude/settings.local.json)
        const settingsPath =
          suggestion.destination === 'localSettings'
            ? ports.joinPath(projectCwd, '.claude', 'settings.local.json')
            : ports.joinPath(projectCwd, '.claude', 'settings.local.json'); // default to local

        try {
          await ports.addPermissionRulesToSettings(settingsPath, toolNames, behavior);
          ports.logger.info(
            `[${run.teamName}] Added permission rules for ${agentId}: ${toolNames.join(', ')} -> ${behavior} in ${settingsPath}`
          );
        } catch (error) {
          ports.logger.error(
            `[${run.teamName}] Failed to add permission rules: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }
  }

  sendSuccessResponse();

  // Also attempt control_response via stdin - the lead runtime MAY forward it
  // to the teammate subprocess. This was broken before (missing updatedInput: {})
  // but is now fixed. Belt-and-suspenders: settings handle future calls,
  // control_response may unblock the CURRENT waiting prompt.
  if (allow && run.child?.stdin?.writable) {
    const updatedInput = buildTeammatePermissionUpdatedInput(toolName, toolInput, message) ?? {};
    const controlResponse = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { behavior: 'allow', updatedInput },
      },
    };
    run.child.stdin.write(JSON.stringify(controlResponse) + '\n', (err) => {
      if (err) {
        ports.logger.warn(
          `[${run.teamName}] control_response via stdin for teammate ${agentId} failed (non-critical): ${err.message}`
        );
      }
    });
  }
}

function sendTeammatePermissionResponse(
  input: SendTeammatePermissionResponseInput,
  ports: TeamProvisioningTeammatePermissionResponsePorts
): void {
  const payload = input.allow
    ? {
        type: 'permission_response',
        request_id: input.requestId,
        subtype: 'success',
        response: {
          updated_input: buildTeammatePermissionUpdatedInput(
            input.toolName,
            input.toolInput,
            input.message
          ),
          permission_updates: input.permissionUpdates ?? [],
        },
      }
    : {
        type: 'permission_response',
        request_id: input.requestId,
        subtype: 'error',
        error: input.message ?? 'Permission denied',
      };

  ports.persistInboxMessage(input.run.teamName, input.agentId, {
    from:
      input.run.request?.members.find((member) => member.role?.toLowerCase().includes('lead'))
        ?.name ?? 'team-lead',
    to: input.agentId,
    text: JSON.stringify(payload),
    timestamp: ports.nowIso(),
    read: false,
    summary: input.allow
      ? `Approved ${input.toolName ?? 'tool'} request`
      : `Denied ${input.toolName ?? 'tool'} request`,
    messageId: `permission-response-${input.run.runId}-${input.requestId}-${ports.nowMs()}`,
    source: 'lead_process',
  });
  ports.emitTeamChange({
    type: 'inbox',
    teamName: input.run.teamName,
    detail: `inboxes/${input.agentId}.json`,
  });
}
