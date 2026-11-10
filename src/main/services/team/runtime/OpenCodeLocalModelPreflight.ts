import { getErrorMessage } from '@shared/utils/errorHandling';
import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';
import { isOpenCodeLocalProviderId } from '@shared/utils/opencodeModelRoute';

import { normalizeOpenCodeProjectIdentity } from '../opencode/readiness/OpenCodeProjectIdentity';

import type {
  TeamRuntimeLocalModelPreflightResult,
  TeamRuntimeLocalModelPreflightTarget,
} from './TeamRuntimeAdapter';

type LocalRuntimeReadiness = {
  severity: 'ready' | 'warning' | 'blocking';
  code: string;
  message: string;
} | null;

export interface OpenCodeTeamRuntimeAdapterOptions {
  inspectLocalModelRuntime?: (input: {
    projectPath: string;
    modelRoute: string;
    allowExperimentalLocalModels?: boolean;
  }) => Promise<LocalRuntimeReadiness>;
}

export interface LocalRuntimeInspectionState {
  readonly inspectedModels: Map<string, LocalRuntimeReadiness>;
  readonly nonLocalSources: Set<string>;
}

export function createLocalRuntimeInspectionState(): LocalRuntimeInspectionState {
  return { inspectedModels: new Map(), nonLocalSources: new Set() };
}

function isOpenCodeLocalModelRoute(modelRoute: string): boolean {
  const sourceId = parseOpenCodeQualifiedModelRef(modelRoute)?.sourceId ?? null;
  return isOpenCodeLocalProviderId(sourceId);
}

function mergeDiagnostics(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right].filter((value) => value.trim().length > 0))];
}

export async function preflightOpenCodeLocalModels(
  options: OpenCodeTeamRuntimeAdapterOptions,
  targets: readonly TeamRuntimeLocalModelPreflightTarget[],
  state: LocalRuntimeInspectionState = createLocalRuntimeInspectionState(),
  allowExperimentalLocalModels = false
): Promise<TeamRuntimeLocalModelPreflightResult> {
  if (!options.inspectLocalModelRuntime) {
    return { ok: true, warnings: [], diagnostics: [] };
  }

  let warnings: string[] = [];
  let diagnostics: string[] = [];
  for (const target of targets) {
    const modelRoute = target.modelRoute.trim();
    const parsed = parseOpenCodeQualifiedModelRef(modelRoute);
    if (!parsed) continue;

    const projectIdentity = normalizeOpenCodeProjectIdentity(target.projectPath);
    const sourceKey = `${projectIdentity}\0${parsed.sourceId}`;
    if (state.nonLocalSources.has(sourceKey)) continue;

    const inspectionKey = `${projectIdentity}\0${modelRoute}\0${allowExperimentalLocalModels}`;
    let readiness = state.inspectedModels.get(inspectionKey);
    if (!state.inspectedModels.has(inspectionKey)) {
      try {
        readiness = await options.inspectLocalModelRuntime({
          projectPath: target.projectPath,
          modelRoute,
          ...(allowExperimentalLocalModels ? { allowExperimentalLocalModels: true } : {}),
        });
        if (!readiness) {
          if (!isOpenCodeLocalModelRoute(modelRoute)) {
            state.nonLocalSources.add(sourceKey);
            state.inspectedModels.set(inspectionKey, null);
            continue;
          }
          readiness = {
            severity: 'blocking',
            code: 'local_provider_unavailable',
            message: `Local provider for ${modelRoute} could not be resolved. Reconnect it, then retry.`,
          };
        }
      } catch (error) {
        readiness = {
          severity: 'warning',
          code: 'local_runtime_inspection_failed',
          message:
            `Local model launch verification was unavailable: ${getErrorMessage(error)} ` +
            'The real OpenCode execution probe will make the launch decision.',
        };
      }
      state.inspectedModels.set(inspectionKey, readiness);
    }

    if (readiness?.severity === 'warning') {
      warnings = mergeDiagnostics(warnings, [readiness.message]);
    } else if (readiness?.severity === 'blocking') {
      diagnostics = mergeDiagnostics(diagnostics, [readiness.message]);
    }
  }

  return { ok: diagnostics.length === 0, warnings, diagnostics };
}
