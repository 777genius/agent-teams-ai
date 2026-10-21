import assert from 'node:assert/strict';
import path from 'node:path';
import {
  defaultArtifact,
  qualifyDefaultArtifact,
  type DefaultArtifact,
} from '../anthropic-compatible-status/packaged-default-artifact.ts';
// @ts-expect-error Existing shared JavaScript packaged harness has no declarations.
import { packagedArtifact } from './packaged.mjs';

export type AttachmentRuntimeInput =
  | { mode: 'candidate'; executable: string; candidateFile: string }
  | { mode: 'published'; executable: string; runtimeArchive: string };

export type AttachmentArtifact = DefaultArtifact & { candidate?: Record<string, unknown> };

function absoluteWindowsFile(value: string | undefined) {
  assert(
    value &&
      path.win32.isAbsolute(value) &&
      !/["<>|*?]/.test(value) &&
      ![...value].some((character) => character.charCodeAt(0) < 32),
    'Absolute Windows artifact path required'
  );
  return value;
}

export function attachmentRuntimeArguments(args: readonly string[]): AttachmentRuntimeInput {
  const executable = absoluteWindowsFile(args[0]);
  assert(/\.exe$/i.test(executable) && !/(setup|uninstall)/i.test(path.win32.basename(executable)));
  if (args.length === 3 && args[1] === '--runtime-archive') {
    const runtimeArchive = absoluteWindowsFile(args[2]);
    assert(/\.zip$/i.test(runtimeArchive), 'Published runtime ZIP required');
    return { mode: 'published', executable, runtimeArchive };
  }
  assert(
    args.length === 2 && !args[1]?.startsWith('--'),
    'Explicit candidate or published archive required'
  );
  const candidateFile = absoluteWindowsFile(args[1]);
  assert.equal(path.win32.basename(candidateFile), 'runtime-candidate-evidence.json');
  return { mode: 'candidate', executable, candidateFile };
}

// Authority stays with either the explicit CI candidate or the locked public
// archive. Fingerprints of the package itself never become expected public bytes.
export async function qualifyAttachmentRuntime(
  input: AttachmentRuntimeInput,
  artifact: AttachmentArtifact,
  root: string,
  repoRoot: string
) {
  if (input.mode === 'candidate') {
    assert(artifact.candidate?.testOnly === true, 'Explicit candidate identity required');
    assert.deepEqual(await packagedArtifact(input.executable, input.candidateFile), artifact);
    return { mode: input.mode, artifact };
  }
  assert(!artifact.candidate, 'Published runtime cannot use candidate evidence');
  assert.deepEqual(
    await defaultArtifact(input.executable),
    artifact,
    'Packaged app artifact changed'
  );
  const delivery = await qualifyDefaultArtifact(
    artifact,
    input.runtimeArchive,
    path.join(root, 'public-runtime-proof'),
    repoRoot
  );
  return { mode: input.mode, artifact, delivery };
}

// This is a separate real app API attempt, not the later admission resolver's
// internal read. Only selected model identity/capabilities and finite status
// metadata survive; auth, raw errors, provider options and diagnostics do not.
export function selectedModelCatalogObservation(
  selected: { providerId: string; model: string; projectPath: string },
  response: unknown
) {
  const value = response as {
    schemaVersion?: unknown;
    runtimeId?: unknown;
    error?: { code?: unknown };
    models?: {
      runtimeId?: unknown;
      providerId?: unknown;
      catalogState?: unknown;
      freshUntil?: unknown;
      diagnostics?: unknown;
      models?: {
        providerId?: unknown;
        modelId?: unknown;
        declaredInputModalities?: unknown;
      }[];
    };
  } | null;
  const catalog = value?.models;
  const rows = Array.isArray(catalog?.models) ? catalog.models : [];
  assert(rows.length <= 10000, 'Selected catalog observation bound exceeded');
  const matches = rows.filter(
    (row) =>
      row &&
      row.providerId === selected.providerId &&
      (row.modelId === selected.model || `${row.providerId}/${row.modelId}` === selected.model)
  );
  const declaration = matches.length === 1 ? matches[0]!.declaredInputModalities : null;
  const safeDeclaration =
    Array.isArray(declaration) &&
    declaration.length <= 16 &&
    declaration.every((item) => ['text', 'image', 'audio', 'video', 'pdf'].includes(item))
      ? declaration
      : null;
  return {
    observationOnly: true,
    separateAppApiAttempt: true,
    admissionAuthority: false,
    selected,
    schemaVersion: value?.schemaVersion === 1 ? 1 : null,
    runtimeId: value?.runtimeId === 'opencode' ? 'opencode' : null,
    outcome: value?.error ? 'catalog-error' : catalog ? 'catalog-returned' : 'catalog-missing',
    errorCode:
      typeof value?.error?.code === 'string' &&
      [
        'unsupported-runtime',
        'unsupported-action',
        'runtime-missing',
        'runtime-misconfigured',
        'runtime-unhealthy',
        'provider-missing',
        'auth-required',
        'auth-failed',
        'model-missing',
        'model-access-unavailable',
        'model-test-failed',
        'unsupported-auth-method',
      ].includes(value.error.code)
        ? value.error.code
        : null,
    catalogRuntimeMatches: catalog?.runtimeId === 'opencode',
    catalogProviderMatches: catalog?.providerId === selected.providerId,
    catalogState:
      catalog?.catalogState === 'fresh' || catalog?.catalogState === 'stale'
        ? catalog.catalogState
        : null,
    freshUntil:
      typeof catalog?.freshUntil === 'string' && Number.isFinite(Date.parse(catalog.freshUntil))
        ? new Date(Date.parse(catalog.freshUntil)).toISOString()
        : null,
    diagnosticsCount: Array.isArray(catalog?.diagnostics) ? catalog.diagnostics.length : null,
    matchingRows: matches.length,
    selectedRow:
      matches.length === 1
        ? {
            providerId: selected.providerId,
            model: selected.model,
            modelId: matches[0]!.modelId,
            declaredInputModalities: safeDeclaration,
            declarationPresent: declaration !== undefined && declaration !== null,
            declarationRedacted:
              declaration !== undefined && declaration !== null && safeDeclaration === null,
          }
        : null,
  };
}
