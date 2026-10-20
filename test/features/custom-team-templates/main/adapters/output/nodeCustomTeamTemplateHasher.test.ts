import { serializeCanonicalTemplateContent } from '@features/custom-team-templates/core/domain/canonicalTemplateSerialization';
import { NodeCustomTeamTemplateHasher } from '@features/custom-team-templates/main/adapters/output/NodeCustomTeamTemplateHasher';
import { describe, expect, it } from 'vitest';

const hasher = new NodeCustomTeamTemplateHasher();

const baseContent = {
  schemaVersion: 1 as const,
  teamPrompt: 'Ship it.',
  members: [{ name: 'alice', role: 'reviewer' }],
};

describe('NodeCustomTeamTemplateHasher', () => {
  it('hashes canonical content deterministically and separately from the identity', () => {
    const canonical = serializeCanonicalTemplateContent(baseContent);
    const digest = hasher.hashCanonicalContent(canonical);

    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hasher.hashCanonicalContent(canonical)).toBe(digest);
    expect(hasher.hashCanonicalContent(`${canonical} `)).not.toBe(digest);
  });

  it('covers the exact allowlisted fields and their order', () => {
    const reordered = serializeCanonicalTemplateContent({
      ...baseContent,
      members: [{ name: 'bob' }, ...baseContent.members],
    });
    expect(hasher.hashCanonicalContent(reordered)).not.toBe(
      hasher.hashCanonicalContent(serializeCanonicalTemplateContent(baseContent))
    );
    const changedMember = hasher.hashCanonicalContent(
      serializeCanonicalTemplateContent({
        ...baseContent,
        members: [{ name: 'alice', workflow: 'Review.' }, { name: 'bob' }],
      })
    );
    expect(changedMember).not.toBe(hasher.hashCanonicalContent(reordered));
  });

  it('derives a stable template id from the immutable identity', () => {
    const contentHash = hasher.hashCanonicalContent(serializeCanonicalTemplateContent(baseContent));
    const identity = { contentHash, nameKey: 'release pipeline', description: 'Weekly release' };

    const templateId = hasher.deriveTemplateId(identity);
    expect(templateId).toMatch(/^tmpl-[0-9a-f]{32}$/);
    expect(hasher.deriveTemplateId({ ...identity })).toBe(templateId);
  });

  it('separates identities that differ only by name, description or content', () => {
    const contentHash = hasher.hashCanonicalContent(serializeCanonicalTemplateContent(baseContent));
    const base = { contentHash, nameKey: 'release pipeline', description: null as string | null };

    const ids = new Set([
      hasher.deriveTemplateId(base),
      hasher.deriveTemplateId({ ...base, nameKey: 'release train' }),
      hasher.deriveTemplateId({ ...base, description: 'Weekly release' }),
      hasher.deriveTemplateId({ ...base, contentHash: `${contentHash}-other` }),
    ]);
    expect(ids.size).toBe(4);
    // No delimiter ambiguity: shifting a character between adjacent fields must
    // not produce the same identity digest.
    expect(hasher.deriveTemplateId({ ...base, nameKey: 'a', description: 'bc' })).not.toBe(
      hasher.deriveTemplateId({ ...base, nameKey: 'ab', description: 'c' })
    );
  });
});
