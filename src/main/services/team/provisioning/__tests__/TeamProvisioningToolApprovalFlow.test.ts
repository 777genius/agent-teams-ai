import { describe, expect, it } from 'vitest';

import {
  buildAllowControlResponsePayload,
  buildDenyControlResponsePayload,
  formatToolApprovalBody,
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
