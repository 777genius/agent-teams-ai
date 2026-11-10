import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';

import {
  parseStrictQualifiedModelRef,
  qualifyModelId,
} from '../../core/domain/openCodeModelIdentity';

import { loadOpenCodeScopedCatalog } from './loadOpenCodeScopedCatalog';

export interface OpenCodeAttachmentTarget {
  projectPath: string | null;
  model: string | undefined;
}
export interface OpenCodeAttachmentDeclaration {
  declaredInputModalities: readonly string[] | null;
  unavailableReason?: string;
}
interface CatalogEntry {
  models: Awaited<ReturnType<typeof loadOpenCodeScopedCatalog>>['models'];
  freshUntil: string | null;
}
interface DeclarationState {
  requestKey: string;
  entries: Map<string, CatalogEntry>;
  failed: Set<string>;
}
let nextRequestGroup = 0;

function scopeFor(target: OpenCodeAttachmentTarget): string | null {
  const parsed = parseStrictQualifiedModelRef(target.model);
  return target.projectPath && parsed
    ? JSON.stringify([target.projectPath, parsed.sourceId])
    : null;
}

/** Reads exact scoped declarations. Only scope changes and refresh trigger I/O. */
export function useOpenCodeAttachmentDeclarations(
  targets: readonly OpenCodeAttachmentTarget[],
  contextKey = ''
) {
  const scopes = JSON.stringify(
    [...new Set(targets.map(scopeFor).filter((scope): scope is string => scope !== null))].sort()
  );
  const selectionKey = JSON.stringify(targets);
  const [revision, setRevision] = useState(0);
  const explicitRefreshKey = useRef<string | null>(null);
  const requestKey = JSON.stringify([contextKey, selectionKey, revision]);
  const [state, setState] = useState<DeclarationState | null>(null);
  useEffect(() => {
    let current = true;
    const refresh = explicitRefreshKey.current === requestKey;
    explicitRefreshKey.current = null;
    const groups: string[] = [];
    const scopeList = JSON.parse(scopes) as string[];
    const entries = new Map<string, CatalogEntry>();
    const failed = new Set<string>();
    void Promise.all(
      scopeList.map(async (scope) => {
        const [projectPath, providerId] = JSON.parse(scope) as [string, string];
        const group = `attachment-declarations:${++nextRequestGroup}`;
        groups.push(group);
        try {
          const result = await loadOpenCodeScopedCatalog(
            providerId,
            projectPath,
            group,
            () => current,
            refresh
          );
          entries.set(scope, { models: result.models, freshUntil: result.freshUntil });
        } catch {
          failed.add(scope);
        }
      })
    ).then(() => {
      if (current) setState({ requestKey, entries, failed });
    });
    return () => {
      current = false;
      for (const requestGroupId of groups) {
        void api.runtimeProviderManagement
          ?.cancelModelLoad?.({ requestGroupId })
          .catch(() => undefined);
      }
    };
  }, [requestKey, scopes]);
  const read = (target: OpenCodeAttachmentTarget): OpenCodeAttachmentDeclaration => {
    const scope = scopeFor(target);
    const unknown = (unavailableReason: string): OpenCodeAttachmentDeclaration => ({
      declaredInputModalities: null,
      unavailableReason,
    });
    if (!scope) return unknown('The running OpenCode model or project is unknown.');
    if (state?.requestKey !== requestKey)
      return unknown('Loading OpenCode image and video input declarations.');
    if (state.failed.has(scope))
      return unknown(
        'OpenCode image and video input declarations could not be loaded. Refresh to retry.'
      );
    const catalog = state.entries.get(scope);
    if (!catalog?.freshUntil || Date.parse(catalog.freshUntil) <= Date.now())
      return unknown('OpenCode image and video input declarations have expired. Refresh to retry.');
    const row = catalog.models.find(
      (model) =>
        qualifyModelId(model.providerId, model.modelId) ===
        parseStrictQualifiedModelRef(target.model)?.raw
    );
    return { declaredInputModalities: row?.declaredInputModalities ?? null };
  };
  return {
    read,
    refresh: useCallback(() => {
      const nextRevision = revision + 1;
      explicitRefreshKey.current = JSON.stringify([contextKey, selectionKey, nextRevision]);
      setRevision(nextRevision);
    }, [contextKey, selectionKey, revision]),
  };
}
