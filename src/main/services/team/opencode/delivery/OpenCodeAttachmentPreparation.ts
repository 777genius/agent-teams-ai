import {
  resolveAgentAttachmentCapability,
  type ResolveOpenCodeInputDeclaration,
} from '@features/agent-attachments';
import {
  AgentAttachmentError,
  buildOpenCodeAttachmentDeliveryParts,
  type OpenCodeFilePart,
} from '@features/agent-attachments/main';
import { getErrorMessage } from '@shared/utils/errorHandling';

import type {
  DeliverableTrackedRun,
  OpenCodeMemberDirectory,
  OpenCodeMemberIdentityResolution,
  OpenCodeMemberInboxDelivery,
} from './OpenCodeMemberMessageDeliveryPorts';
import type { AttachmentPayload } from '@shared/types';

export function resolveOpenCodeDeliveryModel(input: {
  identity: Extract<OpenCodeMemberIdentityResolution, { ok: true }>;
  directory: OpenCodeMemberDirectory;
  run: DeliverableTrackedRun | null | undefined;
}): string {
  const { identity, directory, run } = input;
  const normalizedName = identity.canonicalMemberName.trim().toLowerCase();
  const launchMember = Object.values(directory.launchSnapshot?.members ?? {}).find(
    (member) => member.name.trim().toLowerCase() === normalizedName
  );
  if (identity.laneIdentity.laneKind === 'primary') {
    const launch =
      run?.launchIdentity ?? launchMember?.launchIdentity ?? directory.teamMeta?.launchIdentity;
    const model = launch?.resolvedLaunchModel ?? launch?.selectedModel;
    if (typeof model === 'string' && model.trim()) return model.trim();
  }
  const liveMember =
    run?.mixedSecondaryLanes.find((lane) => lane.laneId === identity.laneIdentity.laneId)?.member ??
    run?.allEffectiveMembers?.find((member) => member.name.trim().toLowerCase() === normalizedName);
  return (
    liveMember?.model ??
    launchMember?.launchIdentity?.resolvedLaunchModel ??
    launchMember?.model ??
    identity.configMember?.model ??
    identity.metaMember?.model ??
    ''
  );
}

export async function prepareOpenCodeDeliveryAttachments(input: {
  projectPath: string;
  model: string;
  text: string;
  attachments: AttachmentPayload[] | undefined;
  resolveOpenCodeInputDeclaration?: ResolveOpenCodeInputDeclaration;
  assertCurrentRun: () => void;
}): Promise<{ fileParts: OpenCodeFilePart[] } | { failure: OpenCodeMemberInboxDelivery }> {
  if (!input.attachments?.length) return { fileParts: [] };
  let declaration: readonly string[] | null;
  try {
    declaration =
      (await input.resolveOpenCodeInputDeclaration?.({
        projectPath: input.projectPath,
        model: input.model,
      })) ?? null;
  } catch {
    declaration = null;
  }
  // A replaced run must never dispatch bytes prepared using its declaration.
  input.assertCurrentRun();
  try {
    return {
      fileParts: buildOpenCodeAttachmentDeliveryParts({
        text: input.text,
        model: input.model,
        attachments: input.attachments,
        capability: resolveAgentAttachmentCapability({
          providerId: 'opencode',
          declaredInputModalities: declaration,
        }),
      }).fileParts,
    };
  } catch (error) {
    return {
      failure: {
        delivered: false,
        reason: error instanceof AgentAttachmentError ? error.code : 'attachment_model_unsupported',
        diagnostics: [`opencode_attachment_delivery_prepare_failed: ${getErrorMessage(error)}`],
        userVisibleImpact: {
          state: 'error',
          reasonCode: 'backend_error',
          message:
            error instanceof AgentAttachmentError
              ? error.message
              : 'OpenCode could not prepare the attachment for live delivery.',
        },
      },
    };
  }
}
