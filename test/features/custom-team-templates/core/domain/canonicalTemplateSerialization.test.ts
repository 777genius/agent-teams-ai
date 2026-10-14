import { serializeCanonicalTemplateContent } from '@features/custom-team-templates/core/domain/canonicalTemplateSerialization';
import { describe, expect, it } from 'vitest';

describe('serializeCanonicalTemplateContent', () => {
  it('pins the canonical field order', () => {
    expect(
      serializeCanonicalTemplateContent({
        schemaVersion: 1,
        teamPrompt: 'p',
        members: [{ name: 'a' }],
      })
    ).toBe('{"schemaVersion":1,"teamPrompt":"p","members":[{"name":"a"}]}');
  });

  it('is deterministic regardless of object construction order', () => {
    const ordered = serializeCanonicalTemplateContent({
      schemaVersion: 1,
      teamPrompt: 'p',
      members: [{ name: 'engineer', role: 'Engineer', workflow: 'Build.' }],
    });
    const reordered = serializeCanonicalTemplateContent({
      members: [{ workflow: 'Build.', role: 'Engineer', name: 'engineer' }],
      teamPrompt: 'p',
      schemaVersion: 1,
    });
    expect(reordered).toBe(ordered);
  });

  it('omits absent optional member fields', () => {
    expect(
      serializeCanonicalTemplateContent({
        schemaVersion: 1,
        teamPrompt: 'p',
        members: [{ name: 'a', role: undefined }],
      })
    ).toBe('{"schemaVersion":1,"teamPrompt":"p","members":[{"name":"a"}]}');
  });

  it('treats member order as significant', () => {
    const forward = serializeCanonicalTemplateContent({
      schemaVersion: 1,
      teamPrompt: 'p',
      members: [{ name: 'a' }, { name: 'b' }],
    });
    const reversed = serializeCanonicalTemplateContent({
      schemaVersion: 1,
      teamPrompt: 'p',
      members: [{ name: 'b' }, { name: 'a' }],
    });
    expect(reversed).not.toBe(forward);
  });

  it('changes when the prompt changes', () => {
    const base = { schemaVersion: 1, members: [{ name: 'a' }] } as const;
    expect(serializeCanonicalTemplateContent({ ...base, teamPrompt: 'p1' })).not.toBe(
      serializeCanonicalTemplateContent({ ...base, teamPrompt: 'p2' })
    );
  });
});
