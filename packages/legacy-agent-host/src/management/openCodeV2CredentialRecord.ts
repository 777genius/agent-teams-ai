import { z } from 'zod';
import { modelSelectionSchema } from '../modelSelection.js';
import { managementDigest, managementValuesEqual } from './identity.js';
import { secretFingerprintKdfSchema } from './secretFingerprint.js';

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const phases = ['key-intent', 'key-connected', 'key-published', 'probe-intent', 'probe-completed'] as const;

/** Original native key/probe references inside the existing credential command, never key bytes. */
export const openCodeV2CredentialProgressSchema = z.object({
  phase: z.enum(phases),
  integrationId: id,
  nativeNamespace: hash,
  beforeAuthDigest: hash,
  authWitnessKdf: secretFingerprintKdfSchema.optional(),
  credentialId: z.string().regex(/^cred_[A-Za-z0-9]{1,250}$/u).optional(),
  authDigest: hash.optional(),
  verification: z.object({
    commandId: id,
    modelId: modelSelectionSchema,
    ok: z.boolean().optional(),
  }).strict().optional(),
}).strict().refine(value => {
  const phase = phases.indexOf(value.phase);
  return (phase >= 1) === (value.credentialId !== undefined) &&
    (phase >= 2) === (value.authDigest !== undefined) &&
    (phase >= 3) === (value.verification !== undefined) &&
    (phase === 4) === (value.verification?.ok !== undefined);
});
export type OpenCodeV2CredentialProgress = z.infer<typeof openCodeV2CredentialProgressSchema>;

export function advanceOpenCodeV2Credential(
  previous: OpenCodeV2CredentialProgress | undefined,
  next: OpenCodeV2CredentialProgress,
): OpenCodeV2CredentialProgress | undefined {
  const captured = openCodeV2CredentialProgressSchema.parse(structuredClone(next));
  // Markerless originals remain readable, but no new/advanced publication can write one.
  if (!captured.authWitnessKdf || previous && !previous.authWitnessKdf) return undefined;
  if (previous && managementDigest(previous) === managementDigest(captured)) return captured;
  if (phases.indexOf(captured.phase) !== (previous ? phases.indexOf(previous.phase) + 1 : 0))
    return undefined;
  if (previous && (previous.integrationId !== captured.integrationId ||
      previous.nativeNamespace !== captured.nativeNamespace || previous.beforeAuthDigest !== captured.beforeAuthDigest ||
      !managementValuesEqual(previous.authWitnessKdf, captured.authWitnessKdf) ||
      previous.credentialId !== undefined && previous.credentialId !== captured.credentialId ||
      previous.authDigest !== undefined && previous.authDigest !== captured.authDigest ||
      previous.verification !== undefined && (previous.verification.commandId !== captured.verification?.commandId ||
        previous.verification.modelId !== captured.verification.modelId)))
    return undefined;
  return captured;
}
