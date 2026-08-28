import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ProviderAuthorityGeneration from '@main/services/team/TeamLaunchProviderAuthorityGeneration';

type AuthorityModule = typeof ProviderAuthorityGeneration;

describe('TeamLaunchProviderAuthorityGeneration', () => {
  let authority: AuthorityModule;

  beforeEach(async () => {
    vi.resetModules();
    authority = await import('@main/services/team/TeamLaunchProviderAuthorityGeneration');
  });

  it('bounds retained catalog state and capture work after more than 10,000 scopes', () => {
    const scopeCount = 10_001;
    for (let index = 0; index < scopeCount; index += 1) {
      authority.invalidateProviderCatalog('codex', `/project/${index}`);
    }

    const diagnostics = authority.getProviderAuthorityGenerationDiagnostics();
    const expectedProfileGeneration = Math.floor(
      (scopeCount - 1) / authority.MAX_CATALOG_AUTHORITY_SCOPES_PER_PROVIDER
    );
    const expectedRetainedScopes =
      scopeCount - expectedProfileGeneration * authority.MAX_CATALOG_AUTHORITY_SCOPES_PER_PROVIDER;

    expect(diagnostics).toEqual({
      retainedCatalogScopeCount: expectedRetainedScopes,
      catalogProviderCount: 1,
      captureProviderLookupCount: 1,
    });
    expect(authority.captureGenerations('/unrelated').catalogGenerationByProviderId.size).toBe(1);
    expect(authority.getAuthorityScope('codex', '/project/10000')).toMatchObject({
      profileGeneration: expectedProfileGeneration,
      catalogGeneration: 1,
    });
  });

  it('fails closed for a late response after scope retirement and a profile bump', () => {
    const evictedProject = '/project/evicted';
    authority.invalidateProviderCatalog('codex', evictedProject);
    const lateResponseGenerations = authority.captureGenerations(evictedProject);

    for (let index = 1; index <= authority.MAX_CATALOG_AUTHORITY_SCOPES_PER_PROVIDER; index += 1) {
      authority.invalidateProviderCatalog('codex', `/project/replacement-${index}`);
    }

    expect(authority.generationsAreCurrent(lateResponseGenerations, new Set(['codex']))).toBe(
      false
    );
    expect(authority.getAuthorityScope('codex', evictedProject)).toMatchObject({
      profileGeneration: 1,
      catalogGeneration: 0,
    });

    authority.invalidateProviderCatalog('codex', evictedProject);
    expect(authority.generationsAreCurrent(lateResponseGenerations, new Set(['codex']))).toBe(
      false
    );
  });

  it('isolates unrelated providers while one provider repeatedly retires scopes', () => {
    authority.invalidateProviderCatalog('gemini', '/gemini-project');
    const geminiCapture = authority.captureGenerations('/gemini-project');
    const geminiScope = authority.getAuthorityScope('gemini', '/gemini-project');

    for (let index = 0; index < 10_001; index += 1) {
      authority.invalidateProviderCatalog('codex', `/codex-project/${index}`);
    }

    expect(authority.generationsAreCurrent(geminiCapture, new Set(['gemini']))).toBe(true);
    expect(authority.getAuthorityScope('gemini', '/gemini-project')).toEqual(geminiScope);
    expect(authority.getProviderAuthorityGenerationDiagnostics()).toMatchObject({
      catalogProviderCount: 2,
      captureProviderLookupCount: 2,
    });
  });

  it('keeps catalog invalidation scoped to one provider and project', () => {
    const codexProjectA = authority.captureGenerations('/project/a');
    const codexProjectB = authority.captureGenerations('/project/b');
    const geminiProjectA = authority.captureGenerations('/project/a');

    authority.invalidateProviderCatalog('codex', '/project/a');

    expect(authority.generationsAreCurrent(codexProjectA, new Set(['codex']))).toBe(false);
    expect(authority.generationsAreCurrent(codexProjectB, new Set(['codex']))).toBe(true);
    expect(authority.generationsAreCurrent(geminiProjectA, new Set(['gemini']))).toBe(true);
  });

  it('keeps nested epochs and the aggregate generation monotonic across invalidation', () => {
    const initialAggregate = authority.getProviderAuthorityGeneration();
    const initial = authority.captureGenerations('/project');

    authority.invalidateProviderCatalog('codex', '/project');
    const afterCatalog = authority.getAuthorityScope('codex', '/project');
    const catalogAggregate = authority.getProviderAuthorityGeneration();
    authority.invalidateProviderCatalog('codex', '/project');
    const afterSecondCatalog = authority.getAuthorityScope('codex', '/project');
    const secondCatalogAggregate = authority.getProviderAuthorityGeneration();
    authority.invalidateProviderProfile('codex');
    const afterProfile = authority.getAuthorityScope('codex', '/project');
    const profileAggregate = authority.getProviderAuthorityGeneration();
    const beforeGlobal = authority.captureGenerations('/project');
    authority.invalidateAll();

    expect(afterCatalog.catalogGeneration).toBe(1);
    expect(afterSecondCatalog.catalogGeneration).toBe(2);
    expect(afterProfile).toMatchObject({ profileGeneration: 1, catalogGeneration: 0 });
    expect([
      initialAggregate,
      catalogAggregate,
      secondCatalogAggregate,
      profileAggregate,
      authority.getProviderAuthorityGeneration(),
    ]).toEqual([0, 1, 2, 3, 4]);
    expect(authority.generationsAreCurrent(initial, new Set(['codex']))).toBe(false);
    expect(authority.generationsAreCurrent(beforeGlobal, new Set(['codex']))).toBe(false);
  });

  it('starts a fresh process-local epoch after module restart', async () => {
    authority.invalidateAll();
    authority.invalidateProviderProfile('codex');
    authority.invalidateProviderCatalog('codex', '/project');

    vi.resetModules();
    const restarted: AuthorityModule =
      await import('@main/services/team/TeamLaunchProviderAuthorityGeneration');

    expect(restarted.getAuthorityScope('codex', '/project')).toMatchObject({
      globalGeneration: 0,
      profileGeneration: 0,
      catalogGeneration: 0,
    });
    expect(restarted.getProviderAuthorityGeneration()).toBe(0);
    expect(restarted.getProviderAuthorityGenerationDiagnostics().retainedCatalogScopeCount).toBe(0);
  });
});
