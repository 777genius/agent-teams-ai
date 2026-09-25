import { getScopedModelReason } from './providerPrepareModelReasons';

import type { TranslationNamespace } from '@features/localization';
import type { OpenCodeModelAccessReasonCode, TeamProvisioningPrepareResult } from '@shared/types';
import type { TFunction } from 'i18next';

type TeamTranslator = TFunction<TranslationNamespace, undefined>;

type KnownModelAccessReasonCode = Exclude<OpenCodeModelAccessReasonCode, 'unknown'>;

// The main process classifies a model refusal once and attaches a reasonCode to
// the model-scoped issue. Preflight results reach the dialogs as text lines, so
// each code travels as this fixed English sentence (also the text used in logs
// and copied diagnostics) and is mapped back to its code for localization.
const MODEL_ACCESS_REASON_SENTENCES: Record<KnownModelAccessReasonCode, string> = {
  usage_limit: 'Usage limit reached. Check your plan limits, retry later, or pick another model',
  needs_connection_go:
    'This route needs an OpenCode Go key. Connect OpenCode Go in Providers & plans',
  needs_connection_zen:
    'This model needs an OpenCode Zen key. Connect OpenCode Zen in Providers & plans',
  needs_connection: 'This provider is not connected. Connect it in Providers & plans',
  free_tier_restricted:
    'OpenCode refused this free model request. Pick a paid model or another provider, or try again later',
};

function isKnownModelAccessReasonCode(code: string): code is KnownModelAccessReasonCode {
  return Object.hasOwn(MODEL_ACCESS_REASON_SENTENCES, code);
}

export function getModelAccessReasonSentence(
  modelId: string,
  result: TeamProvisioningPrepareResult
): string | null {
  for (const issue of result.issues ?? []) {
    const code = issue.reasonCode;
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
  const code = getModelAccessReasonCodeForSentence(reason);
  if (!code) {
    return reason;
  }
  const section = t('cliStatus.quickConnect.title', { ns: 'dashboard' });
  switch (code) {
    case 'usage_limit':
      return t('provisioning.providerStatus.modelAccessReasons.usageLimit');
    case 'needs_connection_go':
      return t('provisioning.providerStatus.modelAccessReasons.needsConnectionGo', { section });
    case 'needs_connection_zen':
      return t('provisioning.providerStatus.modelAccessReasons.needsConnectionZen', { section });
    case 'needs_connection':
      return t('provisioning.providerStatus.modelAccessReasons.needsConnection', { section });
    case 'free_tier_restricted':
      return t('provisioning.providerStatus.modelAccessReasons.freeTierRestricted');
  }
}

export function localizeOptionalModelAccessReason(
  reason: string | null | undefined,
  t: TeamTranslator
): string | null {
  return reason ? localizeModelAccessReason(reason, t) : null;
}

const MODEL_STATUS_WITH_REASON = /^(unavailable|check failed|verification deferred)\s+-\s+(.+)$/i;

/** Localizes "<status> - <reason>" model detail tails, or returns null if not one. */
export function localizeModelStatusWithReason(status: string, t: TeamTranslator): string | null {
  const match = MODEL_STATUS_WITH_REASON.exec(status.trim());
  if (!match) {
    return null;
  }
  const [, kind, reason] = match;
  const lowerKind = kind.toLowerCase();
  let label: string;
  if (lowerKind === 'unavailable') {
    label = t('provisioning.providerStatus.detailSummary.selectedModelUnavailable');
  } else if (lowerKind === 'check failed') {
    label = t('provisioning.providerStatus.detailSummary.selectedModelCheckFailed');
  } else {
    label = t('provisioning.providerStatus.detailSummary.selectedModelDeferred');
  }
  return `${label}: ${localizeModelAccessReason(reason, t)}`;
}
