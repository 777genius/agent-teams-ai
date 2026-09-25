import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getModelAccessReasonSentence,
  localizeModelAccessReason,
  localizeModelStatusWithReason,
  localizeOptionalModelAccessReason,
  resolveScopedModelReason,
} from './providerPrepareReasonCodes';

import type { OpenCodeModelAccessReasonCode, TeamProvisioningPrepareResult } from '@shared/types';

const MODEL = 'opencode/big-pickle';
const RAW_403 =
  "HTTP 403: Error from provider (Console): OpenCode's free tier can only be used from within OpenCode";

const CODE_TO_KEY = {
  usage_limit: 'usageLimit',
  needs_connection_go: 'needsConnectionGo',
  needs_connection_zen: 'needsConnectionZen',
  needs_connection: 'needsConnection',
  free_tier_restricted: 'freeTierRestricted',
} as const satisfies Record<Exclude<OpenCodeModelAccessReasonCode, 'unknown'>, string>;

type CodeKeyEntry = [keyof typeof CODE_TO_KEY, (typeof CODE_TO_KEY)[keyof typeof CODE_TO_KEY]];
const CODE_KEY_ENTRIES = Object.entries(CODE_TO_KEY) as CodeKeyEntry[];

function resultWithIssue(
  reasonCode: OpenCodeModelAccessReasonCode | undefined,
  modelId = MODEL
): TeamProvisioningPrepareResult {
  return {
    ready: false,
    message: `Selected model ${modelId} is unavailable. ${RAW_403}`,
    issues: [
      {
        providerId: 'opencode',
        modelId,
        scope: 'model',
        severity: 'blocking',
        code: 'not_authenticated',
        message: RAW_403,
        ...(reasonCode ? { reasonCode } : {}),
      },
    ],
  };
}

const fakeT = ((key: string, options?: { ns?: string; section?: string }) => {
  if (options?.ns === 'dashboard') return 'Providers & plans';
  const section = options?.section ? '|' + options.section : '';
  return `T:${key}${section}`;
}) as unknown as Parameters<typeof localizeModelAccessReason>[1];

function readModelAccessReasons(locale: 'en' | 'ru'): Record<string, string> {
  const file = path.join(
    process.cwd(),
    'src/features/localization/renderer/locales',
    locale,
    'team.json'
  );
  const json = JSON.parse(readFileSync(file, 'utf8')) as {
    provisioning: { providerStatus: { modelAccessReasons: Record<string, string> } };
  };
  return json.provisioning.providerStatus.modelAccessReasons;
}

describe('providerPrepareReasonCodes', () => {
  it('maps every known reason code on a model-scoped issue to its own sentence', () => {
    const sentences = CODE_KEY_ENTRIES.map(([code]) =>
      getModelAccessReasonSentence(MODEL, resultWithIssue(code))
    );
    expect(sentences.every(Boolean)).toBe(true);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it('never tells a free-tier refusal to connect a key', () => {
    const sentence = getModelAccessReasonSentence(MODEL, resultWithIssue('free_tier_restricted'));
    expect(sentence).toMatch(/free model/i);
    expect(sentence).not.toMatch(/\bkey\b|connect/i);
  });

  it('ignores issues for other models, unknown codes and provider-scoped issues', () => {
    expect(getModelAccessReasonSentence(MODEL, resultWithIssue('unknown'))).toBeNull();
    expect(getModelAccessReasonSentence(MODEL, resultWithIssue(undefined))).toBeNull();
    expect(
      getModelAccessReasonSentence(MODEL, resultWithIssue('usage_limit', 'opencode/other'))
    ).toBeNull();
    expect(
      getModelAccessReasonSentence(MODEL, {
        ready: false,
        message: 'x',
        issues: [
          {
            providerId: 'opencode',
            scope: 'provider',
            severity: 'blocking',
            code: 'x',
            message: 'x',
            reasonCode: 'usage_limit',
          },
        ],
      })
    ).toBeNull();
  });

  it('prefers the structured code over keyword parsing of the runtime text', () => {
    const entries = [`Selected model ${MODEL} is unavailable. ${RAW_403}`];
    expect(resolveScopedModelReason(MODEL, resultWithIssue('free_tier_restricted'), entries)).toBe(
      getModelAccessReasonSentence(MODEL, resultWithIssue('free_tier_restricted'))
    );
    // Without a code the old text normalization still applies (any 403 reads as auth).
    expect(resolveScopedModelReason(MODEL, resultWithIssue(undefined), entries)).toBe(
      'OpenCode provider authentication failed'
    );
  });

  it('localizes each code sentence through its own key and passes other text through', () => {
    for (const [code, key] of CODE_KEY_ENTRIES) {
      const sentence = getModelAccessReasonSentence(MODEL, resultWithIssue(code))!;
      const section = code.startsWith('needs_connection') ? '|Providers & plans' : '';
      expect(localizeModelAccessReason(sentence, fakeT)).toBe(
        `T:provisioning.providerStatus.modelAccessReasons.${key}${section}`
      );
    }
    expect(localizeModelAccessReason('Model verification timed out', fakeT)).toBe(
      'Model verification timed out'
    );
  });

  it('keeps the English locale identical to the fallback sentences and has Russian translations', () => {
    const en = readModelAccessReasons('en');
    const ru = readModelAccessReasons('ru');
    for (const [code, key] of CODE_KEY_ENTRIES) {
      expect(en[key]?.replace('{{section}}', 'Providers & plans')).toBe(
        getModelAccessReasonSentence(MODEL, resultWithIssue(code))
      );
      expect(en[key]).not.toContain('Providers & plans');
      expect(ru[key]?.trim()).toBeTruthy();
      expect(ru[key]).not.toBe(en[key]);
    }
  });

  it('localizes every model status that carries a reason, including deferred checks', () => {
    const sentence = getModelAccessReasonSentence(MODEL, resultWithIssue('usage_limit'))!;
    const reasonKey = 'T:provisioning.providerStatus.modelAccessReasons.usageLimit';
    const summary = 'T:provisioning.providerStatus.detailSummary';
    expect(localizeModelStatusWithReason(`unavailable - ${sentence}`, fakeT)).toBe(
      `${summary}.selectedModelUnavailable: ${reasonKey}`
    );
    expect(localizeModelStatusWithReason(`check failed - ${sentence}`, fakeT)).toBe(
      `${summary}.selectedModelCheckFailed: ${reasonKey}`
    );
    expect(localizeModelStatusWithReason(`verification deferred - ${sentence}`, fakeT)).toBe(
      `${summary}.selectedModelDeferred: ${reasonKey}`
    );
    expect(localizeModelStatusWithReason('verified', fakeT)).toBeNull();
  });

  it('localizes optional picker hint reasons and leaves unknown text alone', () => {
    const sentence = getModelAccessReasonSentence(MODEL, resultWithIssue('free_tier_restricted'))!;
    expect(localizeOptionalModelAccessReason(sentence, fakeT)).toBe(
      'T:provisioning.providerStatus.modelAccessReasons.freeTierRestricted'
    );
    expect(localizeOptionalModelAccessReason('Runtime said no', fakeT)).toBe('Runtime said no');
    expect(localizeOptionalModelAccessReason(null, fakeT)).toBeNull();
  });
});
