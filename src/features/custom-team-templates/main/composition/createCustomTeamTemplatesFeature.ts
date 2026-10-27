import { randomUUID } from 'node:crypto';

import { TEAM_TEMPLATES } from '@features/team-templates/core';

import { CopyBuiltinTemplateUseCase } from '../../core/application/CopyBuiltinTemplateUseCase';
import { DeleteCustomTeamTemplateUseCase } from '../../core/application/DeleteCustomTeamTemplateUseCase';
import { DuplicateCustomTeamTemplateUseCase } from '../../core/application/DuplicateCustomTeamTemplateUseCase';
import { InMemoryCustomTeamTemplatePreviewStore } from '../../core/application/InMemoryCustomTeamTemplatePreviewStore';
import { ListCustomTeamTemplatesUseCase } from '../../core/application/ListCustomTeamTemplatesUseCase';
import { PrepareCustomTemplatePreviewUseCase } from '../../core/application/PrepareCustomTemplatePreviewUseCase';
import { RecheckCustomTeamTemplateSaveUseCase } from '../../core/application/RecheckCustomTeamTemplateSaveUseCase';
import { SaveCustomTeamTemplateUseCase } from '../../core/application/SaveCustomTeamTemplateUseCase';
import { UpdateCustomTeamTemplateUseCase } from '../../core/application/UpdateCustomTeamTemplateUseCase';
import { InterruptionClassifyingCustomTeamTemplateStorageGateway } from '../adapters/output/InterruptionClassifyingCustomTeamTemplateStorageGateway';
import { NodeCustomTeamTemplateHasher } from '../adapters/output/NodeCustomTeamTemplateHasher';
import { SavedTeamConfigurationSnapshotAdapter } from '../adapters/output/SavedTeamConfigurationSnapshotAdapter';

import type {
  CustomTeamTemplateHasher,
  CustomTeamTemplateSnapshotReader,
} from '../../core/application/ports';
import type { InternalStorageCustomTeamTemplatesBackend } from '@features/internal-storage/main';

export interface CustomTeamTemplatesFeatureDeps {
  /**
   * Phase 2A SQLite backend for the template library, or null when the worker
   * bundle is unavailable. A null backend is reported as unavailable storage:
   * there is deliberately no fallback store to degrade to.
   */
  backend: InternalStorageCustomTeamTemplatesBackend | null;
  /** Overridable for tests and for a future composition boundary. */
  snapshotReader?: CustomTeamTemplateSnapshotReader;
  hasher?: CustomTeamTemplateHasher;
  now?: () => number;
  /** Must return unpredictable, unrepeated values. */
  createPreviewToken?: () => string;
  previewTokenTtlMs?: number;
  previewStoreCapacity?: number;
  /**
   * Resolves one built-in template's allowlisted content for the copy-built-in
   * flow, or null when the id is unknown. Defaults to the static catalogue.
   */
  resolveBuiltinTemplate?: (id: string) => {
    schemaVersion: 1;
    teamPrompt: string;
    members: readonly { name: string; role?: string; workflow?: string }[];
  } | null;
  /** Fresh stable id for duplicate/copy-built-in records. Defaults to randomUUID. */
  createTemplateId?: () => string;
}

/**
 * The application surface the IPC and HTTP adapters call.
 *
 * Both transports hand the raw request payload to these use cases, which accept
 * untrusted input and answer with typed outcomes instead of throwing. That is
 * what keeps IPC and HTTP domain-equivalent: validation and business rules live
 * in one place, and no transport re-implements them.
 */
export interface CustomTeamTemplatesFeature {
  preparePreview: PrepareCustomTemplatePreviewUseCase;
  saveTemplate: SaveCustomTeamTemplateUseCase;
  recheckSave: RecheckCustomTeamTemplateSaveUseCase;
  listTemplates: ListCustomTeamTemplatesUseCase;
  updateTemplate: UpdateCustomTeamTemplateUseCase;
  deleteTemplate: DeleteCustomTeamTemplateUseCase;
  duplicateTemplate: DuplicateCustomTeamTemplateUseCase;
  copyBuiltinTemplate: CopyBuiltinTemplateUseCase;
  /**
   * Drops every retained preview and confirmed operation.
   *
   * Preview state is in-memory only, so disposal just forgets it: no store is
   * written and the SQLite backend stays owned by internal-storage, which closes
   * its own worker on shutdown.
   */
  dispose(): void;
}

/**
 * Wires the custom-team-templates use cases for the main process.
 *
 * Dependencies are explicit constructor parameters: there is no container, no
 * service locator and no second store. The saved-configuration reader, the
 * trusted hasher and the bounded preview-token state are created here so that
 * callers cannot substitute a renderer-supplied reader, digest or template id,
 * and a missing worker backend stays explicitly unavailable.
 *
 * Composition itself registers nothing: the IPC and HTTP adapters are wired at
 * the main-process startup boundary, which is what keeps this function usable
 * from tests and from any future embedding.
 */
export function createCustomTeamTemplatesFeature(
  deps: CustomTeamTemplatesFeatureDeps
): CustomTeamTemplatesFeature {
  const gateway = deps.backend
    ? new InterruptionClassifyingCustomTeamTemplateStorageGateway(deps.backend.gateway)
    : null;
  const reader = deps.snapshotReader ?? new SavedTeamConfigurationSnapshotAdapter();
  const hasher = deps.hasher ?? new NodeCustomTeamTemplateHasher();
  const previewStore = new InMemoryCustomTeamTemplatePreviewStore({
    now: deps.now ?? (() => Date.now()),
    createToken: deps.createPreviewToken ?? (() => randomUUID()),
    ...(deps.previewTokenTtlMs === undefined ? {} : { ttlMs: deps.previewTokenTtlMs }),
    ...(deps.previewStoreCapacity === undefined ? {} : { capacity: deps.previewStoreCapacity }),
  });

  return {
    preparePreview: new PrepareCustomTemplatePreviewUseCase({
      gateway,
      reader,
      hasher,
      previewStore,
    }),
    saveTemplate: new SaveCustomTeamTemplateUseCase({ gateway, reader, hasher, previewStore }),
    recheckSave: new RecheckCustomTeamTemplateSaveUseCase({ gateway, hasher, previewStore }),
    listTemplates: new ListCustomTeamTemplatesUseCase({ gateway }),
    updateTemplate: new UpdateCustomTeamTemplateUseCase({ gateway, hasher }),
    deleteTemplate: new DeleteCustomTeamTemplateUseCase({ gateway }),
    duplicateTemplate: new DuplicateCustomTeamTemplateUseCase({
      gateway,
      hasher,
      createTemplateId: deps.createTemplateId ?? (() => `tmpl-${randomUUID()}`),
    }),
    copyBuiltinTemplate: new CopyBuiltinTemplateUseCase({
      gateway,
      hasher,
      resolveBuiltin: deps.resolveBuiltinTemplate ?? resolveBuiltinTemplateContent,
      createTemplateId: deps.createTemplateId ?? (() => `tmpl-${randomUUID()}`),
    }),
    dispose: () => previewStore.clear(),
  };
}

/**
 * Default built-in resolver over the static catalogue.
 */
function resolveBuiltinTemplateContent(id: string): {
  schemaVersion: 1;
  teamPrompt: string;
  members: readonly { name: string; role?: string; workflow?: string }[];
} | null {
  const found = TEAM_TEMPLATES.find((entry: any) => entry.id === id);
  if (!found) {
    return null;
  }
  return {
    schemaVersion: 1,
    teamPrompt: found.teamPrompt,
    members: found.members.map((member: any) => ({
      name: member.name,
      role: member.role,
      workflow: member.workflow,
    })),
  };
}
