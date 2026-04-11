import { describe, expect, it } from 'vitest';

import {
  parseTaskNotifications,
  sanitizeDisplayContent,
} from '@shared/utils/contentSanitizer';

describe('contentSanitizer task notifications', () => {
  it('removes task-notification blocks and trailing output instructions from display text', () => {
    const content = [
      'Task finished.',
      '<task-notification>',
      '<task-id>task-123</task-id>',
      '<status>completed</status>',
      '<summary>Background command "Run foo" completed (exit code 0)</summary>',
      '<output-file>/tmp/task-123.log</output-file>',
      '</task-notification>',
      'Read the output file to retrieve the result: /tmp/task-123.log',
    ].join('');

    expect(sanitizeDisplayContent(content)).toBe('Task finished.');
  });

  it('extracts task notifications from raw xml blocks', () => {
    const content = [
      '<task-notification>',
      '<task-id>task-123</task-id>',
      '<status>completed</status>',
      '<summary>Background command "Run foo" completed (exit code 0)</summary>',
      '<output-file>/tmp/task-123.log</output-file>',
      '</task-notification>',
    ].join('');

    expect(parseTaskNotifications(content)).toEqual([
      {
        taskId: 'task-123',
        status: 'completed',
        summary: 'Background command "Run foo" completed (exit code 0)',
        outputFile: '/tmp/task-123.log',
      },
    ]);
  });

  it('returns an empty array when no task notifications are present', () => {
    expect(parseTaskNotifications('normal user content')).toEqual([]);
  });
});
