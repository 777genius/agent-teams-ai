import { describe, expect, it } from 'vitest';

import {
  buildAllowControlResponsePayload,
  buildDenyControlResponsePayload,
  buildLeadToolApprovalDecisionPayload,
  buildLeadToolApprovalRequest,
  buildTeammatePermissionUpdatedInput,
  buildTeammateToolApprovalRequest,
  formatToolApprovalBody,
  parseAskUserQuestionAnswers,
  planToolApprovalNotification,
  resolveToolApprovalTimeoutAutoResolution,
  TOOL_APPROVAL_TIMEOUT_TEAMMATE_DENY_MESSAGE,
} from '../TeamProvisioningToolApprovalFlow';

describe('tool approval notification body formatting', () => {
  it('formats AskUserQuestion approvals with normalized question text', () => {
    expect(
      formatToolApprovalBody('AskUserQuestion', {
        questions: [
          { question: '  Which path should be used?\nPlease confirm.  ' },
          { question: 'Second question' },
        ],
      })
    ).toBe('Questions (2): Which path should be used? Please confirm.');
  });

  it('formats AskUserQuestion approvals without questions', () => {
    expect(formatToolApprovalBody('AskUserQuestion', { questions: [] })).toBe(
      'Question: User input is required'
    );
  });

  it('formats Bash approvals with the command preview', () => {
    expect(formatToolApprovalBody('Bash', { command: 'pnpm exec vitest run tool.test.ts' })).toBe(
      'Bash: pnpm exec vitest run tool.test.ts'
    );
  });

  it('formats file tool approvals with file_path', () => {
    expect(formatToolApprovalBody('Edit', { file_path: 'src/main/index.ts' })).toBe(
      'Edit: src/main/index.ts'
    );
  });

  it('formats unknown tools with the JSON input fallback', () => {
    expect(formatToolApprovalBody('CustomTool', { foo: 'bar', count: 2 })).toBe(
      'CustomTool: {"foo":"bar","count":2}'
    );
  });
});

describe('tool approval control response payloads', () => {
  it('builds allow payloads with the nested request_id', () => {
    expect(buildAllowControlResponsePayload('req-allow')).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-allow',
        response: { behavior: 'allow', updatedInput: {} },
      },
    });
  });

  it('builds deny payloads with the nested request_id and message', () => {
    expect(buildDenyControlResponsePayload('req-deny', 'Denied by user')).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-deny',
        response: { behavior: 'deny', message: 'Denied by user' },
      },
    });
  });

  it('builds lead AskUserQuestion allow payloads with answers in updatedInput', () => {
    expect(
      buildLeadToolApprovalDecisionPayload({
        requestId: 'req-question',
        allow: true,
        message: '{"Which path?":"src/main"}',
        approval: {
          toolName: 'AskUserQuestion',
          toolInput: { questions: [{ question: 'Which path?' }] },
        },
      })
    ).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-question',
        response: {
          behavior: 'allow',
          updatedInput: {
            questions: [{ question: 'Which path?' }],
            answers: { 'Which path?': 'src/main' },
          },
        },
      },
    });
  });

  it('treats a JSON scalar as a plain-text AskUserQuestion answer', () => {
    expect(
      buildLeadToolApprovalDecisionPayload({
        requestId: 'req-question-scalar',
        allow: true,
        message: 'true',
        approval: {
          toolName: 'AskUserQuestion',
          toolInput: { questions: [{ question: 'Enable the feature?' }] },
        },
      })
    ).toMatchObject({
      response: {
        response: {
          updatedInput: {
            answers: { 'Enable the feature?': 'true' },
          },
        },
      },
    });
  });

  it('builds lead deny payloads with the default user denial message', () => {
    expect(
      buildLeadToolApprovalDecisionPayload({
        requestId: 'req-deny-default',
        allow: false,
        approval: { toolName: 'Bash', toolInput: { command: 'rm -rf tmp' } },
      })
    ).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-deny-default',
        response: { behavior: 'deny', message: 'User denied' },
      },
    });
  });
});

describe('tool approval request shaping', () => {
  it('builds lead approval requests with optional provider metadata', () => {
    expect(
      buildLeadToolApprovalRequest({
        requestId: 'req-lead',
        runId: 'run-1',
        teamName: 'alpha',
        providerId: 'codex',
        toolName: 'Bash',
        toolInput: { command: 'pnpm test' },
        teamColor: '#123456',
        teamDisplayName: 'Alpha',
        receivedAt: '2026-01-01T00:00:00.000Z',
      })
    ).toEqual({
      requestId: 'req-lead',
      runId: 'run-1',
      teamName: 'alpha',
      providerId: 'codex',
      source: 'lead',
      toolName: 'Bash',
      toolInput: { command: 'pnpm test' },
      receivedAt: '2026-01-01T00:00:00.000Z',
      teamColor: '#123456',
      teamDisplayName: 'Alpha',
    });
  });

  it('omits empty teammate permission suggestions', () => {
    expect(
      buildTeammateToolApprovalRequest({
        requestId: 'req-member',
        runId: 'run-2',
        teamName: 'beta',
        source: 'worker',
        toolName: 'Edit',
        toolInput: { file_path: 'src/app.ts' },
        receivedAt: '2026-01-01T00:00:00.000Z',
        permissionSuggestions: [],
      })
    ).toEqual({
      requestId: 'req-member',
      runId: 'run-2',
      teamName: 'beta',
      source: 'worker',
      toolName: 'Edit',
      toolInput: { file_path: 'src/app.ts' },
      receivedAt: '2026-01-01T00:00:00.000Z',
      teamColor: undefined,
      teamDisplayName: undefined,
      permissionSuggestions: undefined,
    });
  });
});

describe('AskUserQuestion teammate permission input shaping', () => {
  it('parses JSON object answers with string values', () => {
    expect(
      parseAskUserQuestionAnswers('{"Question A":"yes","Question B":2}', {
        questions: [{ question: 'Question A' }],
      })
    ).toEqual({ 'Question A': 'yes' });
  });

  it('falls back to the first question for plain-text answers', () => {
    expect(
      buildTeammatePermissionUpdatedInput(
        'AskUserQuestion',
        {
          questions: [{ question: 'Continue?' }],
        },
        'yes'
      )
    ).toEqual({
      questions: [{ question: 'Continue?' }],
      answers: { 'Continue?': 'yes' },
    });
  });

  it('merges parsed JSON answers into AskUserQuestion teammate tool input', () => {
    const toolInput = {
      questions: [
        {
          question: 'What type of calculator app would you like?',
          header: 'App type',
          options: [
            { label: 'Web UI (Recommended)', description: 'Browser app' },
            { label: 'CLI', description: 'Terminal app' },
          ],
          multiSelect: false,
        },
      ],
    };

    expect(
      buildTeammatePermissionUpdatedInput(
        'AskUserQuestion',
        toolInput,
        JSON.stringify({
          'What type of calculator app would you like?': 'Web UI (Recommended)',
        })
      )
    ).toEqual({
      ...toolInput,
      answers: {
        'What type of calculator app would you like?': 'Web UI (Recommended)',
      },
    });
  });

  it('preserves blank AskUserQuestion teammate answers', () => {
    const toolInput = {
      questions: [
        {
          question: 'Anything else?',
          options: [{ label: 'Skip', description: 'No extra details' }],
        },
      ],
    };

    expect(buildTeammatePermissionUpdatedInput('AskUserQuestion', toolInput, '')).toEqual({
      ...toolInput,
      answers: {
        'Anything else?': '',
      },
    });
  });

  it('keeps non-question teammate tool input unchanged', () => {
    const input = { file_path: 'src/app.ts' };
    expect(buildTeammatePermissionUpdatedInput('Edit', input, 'ignored')).toBe(input);
  });
});

describe('tool approval OS notification planning', () => {
  const approval = buildLeadToolApprovalRequest({
    requestId: 'req-notify',
    runId: 'run-notify',
    teamName: 'alpha',
    toolName: 'Bash',
    toolInput: { command: 'pnpm test' },
    receivedAt: '2026-01-01T00:00:00.000Z',
  });

  it('builds notification options and action support for desktop platforms', () => {
    expect(
      planToolApprovalNotification({
        approval,
        notifications: {
          enabled: true,
          notifyOnToolApproval: true,
          soundEnabled: true,
        },
        isWindowFocused: false,
        isNotificationSupported: true,
        platform: 'darwin',
        teamLabel: 'Alpha',
        nowMs: 100,
      })
    ).toEqual({
      title: 'Tool Approval — Alpha',
      body: 'Bash: pnpm test',
      sound: 'default',
      supportsActions: true,
    });
  });

  it('does not plan notifications when the window is focused or snoozed', () => {
    expect(
      planToolApprovalNotification({
        approval,
        notifications: {
          enabled: true,
          notifyOnToolApproval: true,
          soundEnabled: false,
          snoozedUntil: 200,
        },
        isWindowFocused: false,
        isNotificationSupported: true,
        platform: 'linux',
        nowMs: 100,
      })
    ).toBeNull();

    expect(
      planToolApprovalNotification({
        approval,
        notifications: {
          enabled: true,
          notifyOnToolApproval: true,
          soundEnabled: false,
        },
        isWindowFocused: true,
        isNotificationSupported: true,
        platform: 'win32',
        nowMs: 100,
      })
    ).toBeNull();
  });
});

describe('tool approval timeout auto-resolution metadata', () => {
  it('keeps timeout_allow for allow timeouts', () => {
    expect(
      resolveToolApprovalTimeoutAutoResolution({
        timeoutAction: 'allow',
        requestId: 'req-timeout-allow',
        runId: 'run-1',
        teamName: 'team-a',
      })
    ).toEqual({
      allow: true,
      event: {
        autoResolved: true,
        requestId: 'req-timeout-allow',
        runId: 'run-1',
        teamName: 'team-a',
        reason: 'timeout_allow',
      },
    });
  });

  it('keeps timeout_deny for deny timeouts', () => {
    expect(
      resolveToolApprovalTimeoutAutoResolution({
        timeoutAction: 'deny',
        requestId: 'req-timeout-deny',
        runId: 'run-2',
        teamName: 'team-b',
      })
    ).toEqual({
      allow: false,
      teammateDenyMessage: TOOL_APPROVAL_TIMEOUT_TEAMMATE_DENY_MESSAGE,
      event: {
        autoResolved: true,
        requestId: 'req-timeout-deny',
        runId: 'run-2',
        teamName: 'team-b',
        reason: 'timeout_deny',
      },
    });
  });

  it('does not resolve wait timeouts', () => {
    expect(
      resolveToolApprovalTimeoutAutoResolution({
        timeoutAction: 'wait',
        requestId: 'req-wait',
        runId: 'run-3',
        teamName: 'team-c',
      })
    ).toBeNull();
  });
});
