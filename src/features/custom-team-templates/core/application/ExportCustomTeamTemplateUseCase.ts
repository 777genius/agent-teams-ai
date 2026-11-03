import {
  CUSTOM_TEAM_TEMPLATE_PORTABLE_FORMAT,
  CUSTOM_TEAM_TEMPLATE_PORTABLE_SCHEMA_VERSION,
} from '@features/custom-team-templates/contracts';

import type { CustomTeamTemplateStorageGateway } from './ports';
import type {
  CustomTeamTemplateV1,
  ExportCustomTeamTemplateRequest,
  ExportCustomTeamTemplateResult,
  PortableCustomTeamTemplateV1,
} from '@features/custom-team-templates/contracts';

export interface ExportCustomTeamTemplateUseCaseDeps {
  gateway: CustomTeamTemplateStorageGateway | null;
}

/**
 * Projects one saved custom template onto the portable file contract.
 *
 * Read-only: it fails with `notFound`/`unreadableRecord`/`storageUnavailable`
 * instead of writing anything, and it never copies a template id, revision,
 * creation timestamp or content hash into the portable document, so the exported
 * file cannot smuggle local storage metadata across machines.
 */
export class ExportCustomTeamTemplateUseCase {
  constructor(private readonly deps: ExportCustomTeamTemplateUseCaseDeps) {}

  /**
   * Resolves the stored record and answers with the portable projection.
   *
   * `payload` is untrusted: only a non-empty `templateId` string is read and any
   * other property is ignored. Every failure is a typed outcome, never a throw.
   */
  async execute(payload: unknown): Promise<ExportCustomTeamTemplateResult> {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return { status: 'notFound', templateId: '' };
    }
    const candidate = payload as { templateId?: unknown };
    const templateId = typeof candidate.templateId === 'string' ? candidate.templateId : '';
    if (!templateId.trim()) {
      return { status: 'notFound', templateId };
    }

    const gateway = this.deps.gateway;
    if (!gateway) {
      return { status: 'storageUnavailable' };
    }

    let record: CustomTeamTemplateV1;
    try {
      const read = await gateway.customTeamTemplateGetById({ templateId });
      if (read.status === 'notFound') {
        return { status: 'notFound', templateId };
      }
      if (read.status === 'unreadable') {
        return { status: 'unreadableRecord', templateId };
      }
      record = read.template;
    } catch {
      return { status: 'storageUnavailable' };
    }

    const portable: PortableCustomTeamTemplateV1 = {
      format: CUSTOM_TEAM_TEMPLATE_PORTABLE_FORMAT,
      schemaVersion: CUSTOM_TEAM_TEMPLATE_PORTABLE_SCHEMA_VERSION,
      name: record.name,
      ...(record.description ? { description: record.description } : {}),
      teamPrompt: record.teamPrompt,
      members: record.members.map((m) => ({
        name: m.name,
        ...(m.role ? { role: m.role } : {}),
        ...(m.workflow ? { workflow: m.workflow } : {}),
      })),
    };
    return { status: 'exported', portable };
  }
}

export type { ExportCustomTeamTemplateRequest };
