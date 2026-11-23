import { describe, expect, it } from 'vitest';

import { parseTemplateEditorJson } from './templateEditorJson';

describe('template JSON editor', () => {
  it('preserves complete editable content and multiline workflows', () => {
    const content = {
      name: 'Review',
      description: 'Example',
      teamPrompt: 'Check\nreport',
      members: [{ name: 'reviewer', role: 'reviewer', workflow: 'Review\nreport' }],
    };
    expect(parseTemplateEditorJson(JSON.stringify(content))).toEqual(content);
  });
  it.each([
    '{',
    '[]',
    '{"name":"a","teamPrompt":"b","members":[],"secret":1}',
    '{"name":"a","teamPrompt":"b","members":[{"name":"b","model":"x"}]}',
    '{"name":"a","teamPrompt":"b","members":[{"name":"b","role":3}]}',
  ])('rejects invalid or unsupported data: %s', (text) => {
    expect(() => parseTemplateEditorJson(text)).toThrow();
  });
});
