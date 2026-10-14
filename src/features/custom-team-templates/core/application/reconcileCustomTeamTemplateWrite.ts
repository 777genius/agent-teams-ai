import { serializeCanonicalTemplateContent } from '../domain/canonicalTemplateSerialization';
import { normalizeTemplateNameKey } from '../domain/templateNamePolicy';

import { CustomTeamTemplateStorageInterruptedError } from './CustomTeamTemplateStorageInterruptedError';

import type { CustomTeamTemplateHasher, CustomTeamTemplateStorageGateway } from './ports';
import type { CustomTeamTemplateV1 } from '@features/custom-team-templates/contracts';

/**
 * Immutable identity of one attempted template write.
 *
 * This is deliberately the same shape the persistence layer compares for
 * idempotency: the stable template id, the normalized name key, the optional
 * description and the digest of the immutable allowlisted content. It is built
 * only from trusted main-process state, never from a renderer payload.
 */
export interface CustomTeamTemplateWriteIdentity {
  templateId: string;
  name: string;
  description?: string;
  contentHash: string;
}

/**
 * What one stored-record read proved about an attempted write.
 *
 * The four outcomes are deliberately distinct so neither a confirmed save nor a
 * re-check can invent an answer: a record that exists but cannot be
 * reconstructed is `unresolved`, never `absent`.
 */
export type CustomTeamTemplateStoredCheck =
  | { status: 'saved'; template: CustomTeamTemplateV1 }
  | { status: 'conflict'; templateId: string }
  | { status: 'absent'; templateId: string }
  | { status: 'unresolved'; templateId: string };

/**
 * Compares a stored record with an attempted write using the same semantics the
 * persistence layer uses for idempotency: normalized name, description and the
 * digest of the immutable allowlisted content. Display capitalization is
 * presentation and never affects equivalence.
 */
export function isStoredTemplateEquivalentToWrite(
  stored: CustomTeamTemplateV1,
  identity: CustomTeamTemplateWriteIdentity,
  hasher: CustomTeamTemplateHasher
): boolean {
  if (stored.templateId !== identity.templateId) {
    return false;
  }
  if (normalizeTemplateNameKey(stored.name) !== normalizeTemplateNameKey(identity.name)) {
    return false;
  }
  if ((stored.description ?? null) !== (identity.description ?? null)) {
    return false;
  }
  const storedHash = hasher.hashCanonicalContent(
    serializeCanonicalTemplateContent({
      schemaVersion: stored.schemaVersion,
      teamPrompt: stored.teamPrompt,
      members: stored.members,
    })
  );
  return storedHash === identity.contentHash;
}

/**
 * Reads the stored record for one attempted write and classifies it.
 *
 * Reconciliation happens by the stable template id, so a retry and a re-check
 * can never reach a different record. An interruption that may have reached the
 * database is waited out before the read, and any read failure or unreadable
 * record stays `unresolved` rather than being reported as absence.
 */
export async function checkStoredTemplate(
  gateway: CustomTeamTemplateStorageGateway,
  identity: CustomTeamTemplateWriteIdentity,
  hasher: CustomTeamTemplateHasher
): Promise<CustomTeamTemplateStoredCheck> {
  let read;
  try {
    read = await gateway.customTeamTemplateGetById({ templateId: identity.templateId });
  } catch (error) {
    if (
      error instanceof CustomTeamTemplateStorageInterruptedError &&
      error.execution === 'unknown'
    ) {
      await error.settled;
    }
    return { status: 'unresolved', templateId: identity.templateId };
  }

  if (read.status === 'unreadable') {
    // A record exists under this id but cannot be reconstructed, so neither
    // success nor overwriting it can be justified. The identifier reported to
    // the caller is the operation's own stable id, because that is what a retry
    // or a re-check has to reconcile against.
    return { status: 'unresolved', templateId: identity.templateId };
  }
  if (read.status === 'notFound') {
    return { status: 'absent', templateId: identity.templateId };
  }
  return isStoredTemplateEquivalentToWrite(read.template, identity, hasher)
    ? { status: 'saved', template: read.template }
    : { status: 'conflict', templateId: identity.templateId };
}
