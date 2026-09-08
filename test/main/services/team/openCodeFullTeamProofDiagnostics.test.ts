import { describe, expect, it } from 'vitest';

import {
  classifyFailure,
  cleanupMetadata,
  transcriptMetadata,
} from './openCodeFullTeamProofDiagnostics';

describe('full-team bounded diagnostics', () => {
  it('classifies terminal abort without exporting provider text, arguments or output', () => {
    const secret = 'synthetic-test-secret-not-for-output';
    const metadata = transcriptMetadata({
      data: {
        messages: [
          { role: 'user', text: 'MessageAbortedError' },
          {
            id: 'msg_1',
            role: 'assistant',
            errorName: 'MessageAbortedError',
            errorMessage: secret,
            contentBlocks: [
              {
                type: 'tool_result',
                toolUseId: 'call_1',
                toolName: 'bash',
                status: 'errored',
                isError: true,
                contentText: `permission denied: ${secret}`,
                input: { auth: secret },
              },
            ],
          },
        ],
      },
    });
    expect(metadata.terminalAborted).toBe(true);
    expect(metadata.classification).toBe('message_aborted');
    expect(JSON.stringify(metadata)).not.toContain(secret);
    expect(metadata.messages[0].tools[0].error).toBe('permission_denied');
  });
  it('does not treat user mentions or tool output as terminal assistant abort', () => {
    expect(
      transcriptMetadata({
        data: {
          messages: [
            { role: 'user', errorName: 'MessageAbortedError' },
            {
              role: 'assistant',
              contentBlocks: [{ type: 'tool_result', contentText: 'MessageAbortedError' }],
            },
          ],
        },
      }).terminalAborted
    ).toBe(false);
  });
  it('retains cleanup outcome and classifications without raw reasons or unrelated hosts', () => {
    const result = cleanupMetadata(
      {
        remaining: 1,
        cleaned: 0,
        diagnostics: ['ECONNREFUSED secret'],
        hosts: [
          {
            projectPath: '/owned',
            pid: 42,
            action: 'failed',
            reason: 'timed out secret',
            leaseCount: 1,
          },
          { projectPath: '/other', pid: 99, action: 'disposed', reason: 'secret' },
        ],
      },
      '/owned'
    );
    expect(result).toMatchObject({
      remaining: 1,
      diagnostics: ['runtime_connection_lost'],
      hosts: [{ pid: 42, action: 'failed', reason: 'observation_timeout' }],
    });
    expect(result.hosts).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(classifyFailure(new Error('MessageAbortedError private payload'))).toBe(
      'message_aborted'
    );
  });
});
