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
    ).toEqual({ status: 'recorded' });

    const resolved = store.resolve(state.token);
    expect(resolved.status).toBe('found');
    if (resolved.status !== 'found') return;
    expect(resolved.state.templateId).toBe('tmpl-confirmed');
    expect(resolved.state.name).toBe('Renamed Template');
    expect(resolved.state.nameKey).toBe('renamed template');
    expect(resolved.state.description).toBe('Edited');
    expect(resolved.state.confirmedSave).toEqual({
      templateId: 'tmpl-confirmed',
      name: 'Renamed Template',
      nameKey: 'renamed template',
      description: 'Edited',
    });
    // The reviewed content and its digest are fixed by the preview itself.
    expect(resolved.state.canonicalContent).toBe(baseInput.canonicalContent);
    expect(resolved.state.contentHash).toBe(baseInput.contentHash);
    expect(resolved.state.sourceTeamName).toBe('alpha');

    // A missing, expired or invalidated token is never written against.
    expect(
      store.confirmSave('token-unknown', { templateId: 'x', name: 'x', nameKey: 'x' })
    ).toEqual({ status: 'unavailable' });
  });

  it('freezes the confirmed operation identity instead of rebinding the token', () => {
    const store = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => 0,
      createToken: counterTokens(),
    });
    const state = store.issue({ ...baseInput, description: 'Original' });
    const recorded = {
      templateId: 'tmpl-confirmed',
      name: 'Renamed Template',
      nameKey: 'renamed template',
      description: 'Edited',
    };
    expect(store.confirmSave(state.token, recorded)).toEqual({ status: 'recorded' });

    // The exact identity may be confirmed again: the create is idempotent.
    expect(store.confirmSave(state.token, { ...recorded })).toEqual({ status: 'alreadyRecorded' });
    // A different name, name key, stable id or description is rejected, and
    // the recorded identity survives untouched.
    expect(store.confirmSave(state.token, { ...recorded, name: 'Other Name' }).status).toBe(
      'identityMismatch'
    );
    expect(store.confirmSave(state.token, { ...recorded, nameKey: 'other name' }).status).toBe(
      'identityMismatch'
    );
    expect(store.confirmSave(state.token, { ...recorded, templateId: 'tmpl-other' }).status).toBe(
      'identityMismatch'
    );
    expect(store.confirmSave(state.token, { ...recorded, description: 'Different' }).status).toBe(
      'identityMismatch'
    );
    expect(
      store.confirmSave(state.token, {
        templateId: 'tmpl-confirmed',
        name: 'Renamed Template',
        nameKey: 'renamed template',
      }).status
    ).toBe('identityMismatch');

    const resolved = store.resolve(state.token);
    expect(resolved.status).toBe('found');
    if (resolved.status !== 'found') return;
    expect(resolved.state.confirmedSave).toEqual(recorded);
    expect(resolved.state.templateId).toBe('tmpl-confirmed');
    expect(resolved.state.name).toBe('Renamed Template');
    expect(resolved.state.description).toBe('Edited');
  });

  it('reports an expired or invalidated token as unavailable for confirmation', () => {
    let now = 0;
    const store = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => now,
      createToken: counterTokens(),
      ttlMs: 100,
    });
    const state = store.issue(baseInput);

    now = 100;
    expect(store.confirmSave(state.token, { templateId: 'x', name: 'x', nameKey: 'x' })).toEqual({
      status: 'unavailable',
    });

    now = 0;
    const second = store.issue({ ...baseInput, templateId: 'tmpl-2' });
    store.invalidate(second.token);
    expect(store.confirmSave(second.token, { templateId: 'x', name: 'x', nameKey: 'x' })).toEqual({
      status: 'unavailable',
    });
    expect(store.resolve(second.token)).toEqual({ status: 'unknown' });
  });

  it('preserves a submitted operation for re-check when its preview expires', () => {
    let now = 0;
    const store = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => now,
      createToken: counterTokens(),
      ttlMs: 100,
    });
    const state = store.issue(baseInput);
    const identity = {
      templateId: 'tmpl-confirmed',
      name: 'Confirmed',
      nameKey: 'confirmed',
    };
    expect(store.confirmSave(state.token, identity)).toEqual({ status: 'recorded' });

    now = 100;
    const resolved = store.resolve(state.token);
    expect(resolved.status).toBe('expired');
    if (resolved.status !== 'expired' || !resolved.state) return;
    // The full reconciliation state survives expiry: template id, display
    // identity, canonical content and digest are all intact for re-check.
    expect(resolved.state.confirmedSave).toEqual(identity);
    expect(resolved.state.templateId).toBe('tmpl-confirmed');
    expect(resolved.state.contentHash).toBe(baseInput.contentHash);
    expect(resolved.state.canonicalContent).toBe(baseInput.canonicalContent);
    // A new save can no longer be confirmed against the expired preview.
    expect(store.confirmSave(state.token, identity)).toEqual({ status: 'unavailable' });
  });

  it('drops an expired settled entry on the next issue instead of retaining it', () => {
    let now = 0;
    const store = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => now,
      createToken: counterTokens(),
      ttlMs: 100,
    });
    const state = store.issue(baseInput);
    const identity = {
      templateId: 'tmpl-confirmed',
      name: 'Confirmed',
      nameKey: 'confirmed',
    };
    expect(store.confirmSave(state.token, identity)).toEqual({ status: 'recorded' });
    // The save outcome settled (no unresolved write), so the expired entry is
    // dropped on the next issue and stops occupying capacity.
    now = 100;
    store.issue({ ...baseInput, templateId: 'tmpl-2' });
    expect(store.resolve(state.token)).toEqual({ status: 'unknown' });
  });

  it('frees an expired settled entry under capacity pressure instead of evicting a live preview', () => {
    let now = 0;
    const store = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => now,
      createToken: counterTokens(),
      ttlMs: 100,
      capacity: 2,
    });
    const settled = store.issue(baseInput);
    expect(
      store.confirmSave(settled.token, {
        templateId: 'tmpl-confirmed',
        name: 'Confirmed',
        nameKey: 'confirmed',
      })
    ).toEqual({ status: 'recorded' });
    now = 10;
    const live = store.issue({ ...baseInput, templateId: 'tmpl-2' });

    // The settled entry expired while the unsubmitted preview is still live.
    // The next issue must reclaim the settled slot; evicting the live preview
    // instead would fail the save the user is about to confirm.
    now = 100;
    const next = store.issue({ ...baseInput, templateId: 'tmpl-3' });
    expect(store.resolve(settled.token)).toEqual({ status: 'unknown' });
    expect(store.resolve(live.token).status).toBe('found');
    expect(store.resolve(next.token).status).toBe('found');
    expect(store.size).toBe(2);
  });

  it('retains an expired entry while its write outcome is unresolved', () => {
    let now = 0;
    const store = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => now,
      createToken: counterTokens(),
      ttlMs: 100,
    });
    const state = store.issue(baseInput);
    const identity = {
      templateId: 'tmpl-confirmed',
      name: 'Confirmed',
      nameKey: 'confirmed',
    };
    expect(store.confirmSave(state.token, identity)).toEqual({ status: 'recorded' });
    store.markUnresolvedWrite(state.token);

    // The unresolved operation survives both expiry reporting and the next
    // issue, so re-check can still reconcile it.
    now = 100;
    store.issue({ ...baseInput, templateId: 'tmpl-2' });
    const resolved = store.resolve(state.token);
    expect(resolved.status).toBe('expired');
    if (resolved.status !== 'expired' || !resolved.state) return;
    expect(resolved.state.confirmedSave).toEqual(identity);
    expect(resolved.state.contentHash).toBe(baseInput.contentHash);
  });

  it('preserves a submitted operation for re-check when its preview is invalidated', () => {
    const store = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => 0,
      createToken: counterTokens(),
    });
    const state = store.issue(baseInput);
    const identity = {
      templateId: 'tmpl-confirmed',
      name: 'Confirmed',
      nameKey: 'confirmed',
    };
    expect(store.confirmSave(state.token, identity)).toEqual({ status: 'recorded' });

    store.invalidate(state.token);

    // The entry is preserved with its full reconciliation state, so re-check
    // can still reconcile the submitted write by its stable id and digest.
    const resolved = store.resolve(state.token);
    expect(resolved.status).toBe('found');
    if (resolved.status !== 'found') return;
    expect(resolved.state.templateId).toBe('tmpl-confirmed');
    expect(resolved.state.contentHash).toBe(baseInput.contentHash);
    expect(resolved.state.canonicalContent).toBe(baseInput.canonicalContent);
    expect(resolved.state.confirmedSave).toEqual(identity);
  });

  it('prefers evicting unsubmitted previews over submitted operations', () => {
    const store = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => 0,
      createToken: counterTokens(),
      ttlMs: 10_000,
      capacity: 2,
    });
    const first = store.issue({ ...baseInput, templateId: 'tmpl-1' });
    store.confirmSave(first.token, { templateId: 'tmpl-1', name: 'Template', nameKey: 'template' });
    store.issue({ ...baseInput, templateId: 'tmpl-2' });

    // The store is full (1 submitted + 1 unsubmitted). Issuing a third must
    // evict the unsubmitted preview, preserving the submitted operation.
    store.issue({ ...baseInput, templateId: 'tmpl-3' });

    expect(store.resolve(first.token).status).toBe('found');
    expect(store.resolve('token-2')).toEqual({ status: 'unknown' });
    expect(store.resolve('token-3').status).toBe('found');
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
