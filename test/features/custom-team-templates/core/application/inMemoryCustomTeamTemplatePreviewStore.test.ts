import {
  DEFAULT_CUSTOM_TEMPLATE_PREVIEW_CAPACITY,
  DEFAULT_CUSTOM_TEMPLATE_PREVIEW_TTL_MS,
  InMemoryCustomTeamTemplatePreviewStore,
} from '@features/custom-team-templates/core/application/InMemoryCustomTeamTemplatePreviewStore';
import { describe, expect, it } from 'vitest';

function counterTokens(): () => string {
  let issued = 0;
  return () => {
    issued += 1;
    return `token-${issued}`;
  };
}

const baseInput = {
  sourceTeamName: 'alpha',
  templateId: 'tmpl-1',
  name: 'Template',
  nameKey: 'template',
  canonicalContent: '{"schemaVersion":1,"teamPrompt":"","members":[]}',
  contentHash: 'sha256:abc',
};

describe('InMemoryCustomTeamTemplatePreviewStore', () => {
  it('retains the reviewed state behind an opaque token', () => {
    const store = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => 1_000,
      createToken: counterTokens(),
    });

    const state = store.issue({ ...baseInput, description: 'Notes' });
    expect(state.token).toBe('token-1');
    expect(state.createdAtMs).toBe(1_000);
    expect(state.expiresAtMs).toBe(1_000 + DEFAULT_CUSTOM_TEMPLATE_PREVIEW_TTL_MS);

    const resolved = store.resolve('token-1');
    expect(resolved.status).toBe('found');
    if (resolved.status !== 'found') return;
    expect(resolved.state).toEqual(state);
    expect(resolved.state.canonicalContent).toBe(baseInput.canonicalContent);
  });

  it('reports an unknown token without reinterpreting it', () => {
    const store = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => 0,
      createToken: counterTokens(),
    });
    store.issue(baseInput);

    expect(store.resolve('token-2')).toEqual({ status: 'unknown' });
    expect(store.resolve('')).toEqual({ status: 'unknown' });
  });

  it('expires a token at its boundary and never returns it as found afterwards', () => {
    let now = 5_000;
    const store = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => now,
      createToken: counterTokens(),
      ttlMs: 100,
    });
    store.issue(baseInput);

    now = 5_099;
    expect(store.resolve('token-1').status).toBe('found');
    now = 5_100;
    expect(store.resolve('token-1')).toEqual({ status: 'expired' });
    expect(store.resolve('token-1')).toEqual({ status: 'unknown' });
    expect(store.size).toBe(0);
  });

  it('is bounded and evicts the oldest preview first, dropping expired entries on issue', () => {
    let now = 0;
    const store = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => now,
      createToken: counterTokens(),
      ttlMs: 1_000,
      capacity: 2,
    });

    store.issue({ ...baseInput, templateId: 'tmpl-1' });
    now = 10;
    store.issue({ ...baseInput, templateId: 'tmpl-2' });
    now = 20;
    store.issue({ ...baseInput, templateId: 'tmpl-3' });

    expect(store.size).toBe(2);
    expect(store.resolve('token-1')).toEqual({ status: 'unknown' });
    expect(store.resolve('token-3').status).toBe('found');

    // Expired entries are dropped before the capacity has to evict anything.
    now = 10_000;
    store.issue({ ...baseInput, templateId: 'tmpl-4' });
    expect(store.size).toBe(1);
    expect(DEFAULT_CUSTOM_TEMPLATE_PREVIEW_CAPACITY).toBeGreaterThan(1);
  });

  it('invalidates a token so it can never save refreshed data', () => {
    const store = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => 0,
      createToken: counterTokens(),
    });
    const state = store.issue(baseInput);

    store.invalidate(state.token);
    expect(store.resolve(state.token)).toEqual({ status: 'unknown' });
    expect(store.size).toBe(0);
  });

  it('records the identity a confirm-save resolved for the same token', () => {
    const store = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => 0,
      createToken: counterTokens(),
    });
    const state = store.issue({ ...baseInput, description: 'Original' });

    expect(
      store.confirmSave(state.token, {
        templateId: 'tmpl-confirmed',
        name: 'Renamed Template',
        nameKey: 'renamed template',
        description: 'Edited',
      })
    ).toBe(true);

    const resolved = store.resolve(state.token);
    expect(resolved.status).toBe('found');
    if (resolved.status !== 'found') return;
    expect(resolved.state.templateId).toBe('tmpl-confirmed');
    expect(resolved.state.name).toBe('Renamed Template');
    expect(resolved.state.nameKey).toBe('renamed template');
    expect(resolved.state.description).toBe('Edited');
    // The reviewed content and its digest are fixed by the preview itself.
    expect(resolved.state.canonicalContent).toBe(baseInput.canonicalContent);
    expect(resolved.state.contentHash).toBe(baseInput.contentHash);
    expect(resolved.state.sourceTeamName).toBe('alpha');

    // A missing, expired or invalidated token is never written against.
    expect(store.confirmSave('token-unknown', { templateId: 'x', name: 'x', nameKey: 'x' })).toBe(
      false
    );
  });

  it('clears every retained preview and confirmed operation on disposal', () => {
    const store = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => 0,
      createToken: counterTokens(),
    });
    store.issue(baseInput);
    store.issue({ ...baseInput, templateId: 'tmpl-2' });
    expect(store.size).toBe(2);

    store.clear();
    expect(store.size).toBe(0);
    expect(store.resolve('token-1')).toEqual({ status: 'unknown' });
  });

  it('refuses to reuse a live token rather than reinterpreting it', () => {
    const store = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => 0,
      createToken: () => 'fixed',
    });
    store.issue(baseInput);

    expect(() => store.issue({ ...baseInput, sourceTeamName: 'beta' })).toThrow(
      /preview token generation is not unique/
    );
    // The original preview is untouched by the failed issue.
    const resolved = store.resolve('fixed');
    expect(resolved.status).toBe('found');
    if (resolved.status !== 'found') return;
    expect(resolved.state.sourceTeamName).toBe('alpha');
  });
});
