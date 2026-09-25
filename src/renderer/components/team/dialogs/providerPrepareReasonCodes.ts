import { getScopedModelReason } from './providerPrepareModelReasons';

import type { TranslationNamespace } from '@features/localization';
import type { TeamProvisioningPrepareResult } from '@shared/types';
import type { TFunction } from 'i18next';

type TeamTranslator = TFunction<TranslationNamespace, undefined>;

type KnownModelAccessReasonCode =
  | 'usage_limit'
  | 'needs_connection_go'
  | 'needs_connection_zen'
  | 'needs_connection'
  | 'key_rejected'
  | 'free_tier_restricted';

// The main process classifies a model refusal once and attaches a reasonCode to
// the model-scoped issue. These sentences are the English fallback for each
// code; the status list maps them back to the code by exact match to localize.
const MODEL_ACCESS_REASON_SENTENCES: Record<KnownModelAccessReasonCode, string> = {
  usage_limit: 'Usage limit reached. Check your plan limits, retry later, or pick another model',
  needs_connection_go:
    'This route needs an OpenCode Go key. Connect OpenCode Go in Providers & plans',
  needs_connection_zen:
    'This model needs an OpenCode Zen key. Connect OpenCode Zen in Providers & plans',
  needs_connection: 'This provider is not connected. Connect it in Providers & plans',
  key_rejected: 'The provider rejected the connected key. Check or replace it in Providers & plans',
  free_tier_restricted:
    'OpenCode currently limits free models for this kind of use. Pick a paid model or another provider',
};

function isKnownModelAccessReasonCode(code: string): code is KnownModelAccessReasonCode {
  return Object.hasOwn(MODEL_ACCESS_REASON_SENTENCES, code);
}

export function getModelAccessReasonSentence(
  modelId: string,
  result: TeamProvisioningPrepareResult
): string | null {
  for (const issue of result.issues ?? []) {
    const code = issue.reasonCode?.trim();
    if (issue.scope === 'model' && issue.modelId === modelId && code) {
      if (isKnownModelAccessReasonCode(code)) {
        return MODEL_ACCESS_REASON_SENTENCES[code];
      }
    }
  }
  return null;
}

// A structured reasonCode wins over parsing the runtime's free text, so a
// refusal is never re-labelled by keyword matching (e.g. any 403 as "auth").
export function resolveScopedModelReason(
  modelId: string,
  result: TeamProvisioningPrepareResult,
  modelScopedEntries: string[]
): string | null {
  return (
    getModelAccessReasonSentence(modelId, result) ??
    getScopedModelReason(modelId, modelScopedEntries)
  );
}

function getModelAccessReasonCodeForSentence(sentence: string): KnownModelAccessReasonCode | null {
  const trimmed = sentence.trim();
  for (const [code, candidate] of Object.entries(MODEL_ACCESS_REASON_SENTENCES)) {
    if (candidate === trimmed && isKnownModelAccessReasonCode(code)) {
      return code;
    }
  }
  return null;
}

export function localizeModelAccessReason(reason: string, t: TeamTranslator): string {
  switch (getModelAccessReasonCodeForSentence(reason)) {
    case 'usage_limit':
      return t('provisioning.providerStatus.modelAccessReasons.usageLimit');
    case 'needs_connection_go':
      return t('provisioning.providerStatus.modelAccessReasons.needsConnectionGo');
    case 'needs_connection_zen':
      return t('provisioning.providerStatus.modelAccessReasons.needsConnectionZen');
    case 'needs_connection':
      return t('provisioning.providerStatus.modelAccessReasons.needsConnection');
    case 'key_rejected':
      return t('provisioning.providerStatus.modelAccessReasons.keyRejected');
    case 'free_tier_restricted':
      return t('provisioning.providerStatus.modelAccessReasons.freeTierRestricted');
    default:
      return reason;
  }
}
