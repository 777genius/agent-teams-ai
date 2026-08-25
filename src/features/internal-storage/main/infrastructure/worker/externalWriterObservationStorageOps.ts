import { createHash } from 'node:crypto';

import { parseTeamId } from '@shared/contracts/hosted';

import { parseTeamIdentityChecksum } from '../../../contracts/teamIdentityStorageContracts';

import type { ExternalWriterObservationCheckpointRecord } from '../../../contracts/externalWriterObservationStorageContracts';
import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;
import {
  assertNonRegressing,
  checkpointFromRow,
  checkpointTeamIds,
  compareExternalWriterText,
  exactObject,
  parseExternalWriterObservationCheckpoint,
  parseExternalWriterObservationIdentity,
  parseSaveRequest,
} from './externalWriterObservationCheckpointSupport';
import {
  readConsumeReceipt,
  replaceConsumeReceipt,
} from './externalWriterObservationConsumeReceiptStore';
import {
  assertNoRetiredTeamReappears,
  hasHandoffEligibility,
  insertRetiredFloor,
  readCheckpoint,
  verifyTombstoneProof,
  writeCheckpoint,
} from './externalWriterObservationSqlSupport';

export { parseExternalWriterObservationCheckpoint } from './externalWriterObservationCheckpointSupport';

const MAX_HANDOFF_JSON_BYTES = 64 * 1024 * 1024;
const MAX_HANDOFF_REGISTRATIONS = 100_000;
const MAX_HANDOFF_RETIREMENTS = 1_024;
const MAX_HANDOFF_KEY_BYTES = 1_024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const HANDOFF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONSUME_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HANDOFF_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,1023}$/;
function exactDataObject(
  value: unknown,
  keys: readonly string[],
  code: string
): Record<string, unknown> {
  const record = exactObject(value, keys, code);
  const prototype = Object.getPrototypeOf(record) as unknown;
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Reflect.ownKeys(record).length !== keys.length
  ) {
    throw new TypeError(code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(record);
  if (
    keys.some((key) => {
      const descriptor = descriptors[key];
      return !descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set;
    })
  ) {
    throw new TypeError(code);
  }
  return record;
}

function exactDenseArray(value: unknown, maxLength: number, code: string): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > maxLength ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw new TypeError(code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
      throw new TypeError(code);
    }
  }
  return value;
}

function boundedHandoffKey(value: unknown, code: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > MAX_HANDOFF_KEY_BYTES ||
    !HANDOFF_KEY_PATTERN.test(value)
  ) {
    throw new TypeError(code);
  }
  return value;
}

function canonicalJson(value: unknown, code: string): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > MAX_HANDOFF_JSON_BYTES) throw new TypeError(code);
  return json;
}

function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class ExternalWriterObservationStorageOps {
  constructor(private readonly getDb: () => SqliteDatabase) {}

  load(payload: unknown): ExternalWriterObservationCheckpointRecord | null {
    const identity = parseExternalWriterObservationIdentity(payload);
    const row = readCheckpoint(this.getDb(), identity);
    return row ? { revision: row.revision, checkpoint: checkpointFromRow(row) } : null;
  }

  save(payload: unknown): ExternalWriterObservationCheckpointRecord {
    const request = parseSaveRequest(payload);
    return this.getDb().transaction(() => {
      const previous = readCheckpoint(this.getDb(), request);
      if ((previous?.revision ?? null) !== request.expectedRevision) {
        throw new Error('external-writer-observation-checkpoint-conflict');
      }
      assertNoRetiredTeamReappears(this.getDb(), request, request.checkpoint);
      if (previous) assertNonRegressing(checkpointFromRow(previous), request.checkpoint);
      if (hasHandoffEligibility(this.getDb(), request)) {
        throw new Error('external-writer-observation-handoff-eligibility-active');
      }
      return writeCheckpoint(this.getDb(), request, previous);
    })();
  }

  saveCleanHandoff(payload: unknown): ExternalWriterObservationCheckpointRecord {
    const record = exactObject(
      payload,
      ['deploymentId', 'observerId', 'expectedRevision', 'checkpoint', 'plan'],
      'external-writer-observation-handoff-save-invalid'
    );
    const request = parseSaveRequest({
      deploymentId: record.deploymentId,
      observerId: record.observerId,
      expectedRevision: record.expectedRevision,
      checkpoint: record.checkpoint,
    });
    const plan = exactDataObject(
      record.plan,
      [
        'handoffId',
        'oldCatalogToken',
        'nextCatalogToken',
        'retainedRegistrations',
        'retirementProofs',
        'createdAt',
      ],
      'external-writer-observation-handoff-plan-invalid'
    );
    const retirementInputs = exactDenseArray(
      plan.retirementProofs,
      MAX_HANDOFF_RETIREMENTS,
      'external-writer-observation-handoff-plan-invalid'
    );
    const retirementTeamIds = new Set<string>();
    const retirementProofs = retirementInputs.map((proof) => {
      const parsed = exactDataObject(
        proof,
        ['teamId', 'identityChecksum', 'tombstonedAt'],
        'external-writer-observation-handoff-plan-invalid'
      );
      if (
        typeof parsed.tombstonedAt !== 'string' ||
        !Number.isFinite(Date.parse(parsed.tombstonedAt)) ||
        new Date(parsed.tombstonedAt).toISOString() !== parsed.tombstonedAt
      ) {
        throw new TypeError('external-writer-observation-handoff-plan-invalid');
      }
      const teamId = parseTeamId(parsed.teamId);
      if (retirementTeamIds.has(teamId)) {
        throw new TypeError('external-writer-observation-handoff-plan-invalid');
      }
      retirementTeamIds.add(teamId);
      return {
        teamId,
        identityChecksum: parseTeamIdentityChecksum(parsed.identityChecksum),
        tombstonedAt: parsed.tombstonedAt,
      };
    });
    const hotTeamIds = checkpointTeamIds(request.checkpoint);
    if (retirementProofs.some((proof) => !hotTeamIds.has(proof.teamId))) {
      throw new Error('external-writer-observation-handoff-retirement-not-hot');
    }
    for (const token of [plan.oldCatalogToken, plan.nextCatalogToken]) {
      if (typeof token !== 'string' || !SHA256_PATTERN.test(token)) {
        throw new TypeError('external-writer-observation-handoff-plan-invalid');
      }
    }
    if (typeof plan.handoffId !== 'string' || !HANDOFF_ID_PATTERN.test(plan.handoffId)) {
      throw new TypeError('external-writer-observation-handoff-plan-invalid');
    }
    const retainedInputs = exactDenseArray(
      plan.retainedRegistrations,
      MAX_HANDOFF_REGISTRATIONS,
      'external-writer-observation-handoff-plan-invalid'
    );
    const retainedKeys = new Set<string>();
    const retained = retainedInputs
      .map((value) => {
        const entry = exactDataObject(
          value,
          ['teamId', 'featureKey', 'fileKey'],
          'external-writer-observation-handoff-plan-invalid'
        );
        const parsed = {
          teamId: parseTeamId(entry.teamId),
          featureKey: boundedHandoffKey(
            entry.featureKey,
            'external-writer-observation-handoff-plan-invalid'
          ),
          fileKey: boundedHandoffKey(
            entry.fileKey,
            'external-writer-observation-handoff-plan-invalid'
          ),
        };
        const key = `${parsed.teamId}\0${parsed.featureKey}\0${parsed.fileKey}`;
        if (retainedKeys.has(key)) {
          throw new TypeError('external-writer-observation-handoff-plan-invalid');
        }
        retainedKeys.add(key);
        return parsed;
      })
      .sort(
        (a, b) =>
          compareExternalWriterText(a.teamId, b.teamId) ||
          compareExternalWriterText(a.featureKey, b.featureKey) ||
          compareExternalWriterText(a.fileKey, b.fileKey)
      );
    const retainedJson = canonicalJson(
      retained,
      'external-writer-observation-handoff-plan-invalid'
    );
    if (retained.some((entry) => retirementTeamIds.has(entry.teamId))) {
      throw new Error('external-writer-observation-handoff-not-clean');
    }
    const removed = request.checkpoint.observedFiles
      .map((entry) => ({
        teamId: entry.scope.teamId,
        featureKey: entry.scope.featureKey,
        fileKey: entry.fileKey,
      }))
      .filter(
        (entry) => !retainedKeys.has(`${entry.teamId}\0${entry.featureKey}\0${entry.fileKey}`)
      )
      .sort(
        (a, b) =>
          compareExternalWriterText(a.teamId, b.teamId) ||
          compareExternalWriterText(a.featureKey, b.featureKey) ||
          compareExternalWriterText(a.fileKey, b.fileKey)
      );
    const removedJson = canonicalJson(removed, 'external-writer-observation-handoff-plan-invalid');
    const nextRegistrationDigest = canonicalSha256(retained);
    const requestedCandidateCoordinates = retirementProofs
      .map((proof) => ({
        teamId: proof.teamId,
        identityChecksum: proof.identityChecksum,
        tombstonedAt: proof.tombstonedAt,
        epoch:
          request.checkpoint.fileWriterEpochs.find((entry) => entry.teamId === proof.teamId)
            ?.epoch ?? null,
        lastObservationSequence:
          request.checkpoint.teamObservationWatermarks.find(
            (entry) => entry.teamId === proof.teamId
          )?.lastObservationSequence ?? null,
        observationWatermark:
          request.checkpoint.teamObservationWatermarks.find(
            (entry) => entry.teamId === proof.teamId
          )?.observationWatermark ?? null,
      }))
      .sort((a, b) => compareExternalWriterText(a.teamId, b.teamId));
    const requestedCandidatesJson = canonicalJson(
      requestedCandidateCoordinates,
      'external-writer-observation-handoff-plan-invalid'
    );
    const everySelfWriteRetained = request.checkpoint.selfWriteIntents.every(
      (intent) =>
        !retirementTeamIds.has(intent.scope.teamId) &&
        retainedKeys.has(`${intent.scope.teamId}\0${intent.scope.featureKey}\0${intent.fileKey}`)
    );
    if (
      typeof plan.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(plan.createdAt)) ||
      new Date(plan.createdAt).toISOString() !== plan.createdAt ||
      request.checkpoint.lastObservationSequence !== request.checkpoint.observationWatermark ||
      request.checkpoint.pendingObservations.length > 0 ||
      request.checkpoint.dirtyScopes.length > 0 ||
      !everySelfWriteRetained
    ) {
      throw new Error('external-writer-observation-handoff-not-clean');
    }
    return this.getDb().transaction(() => {
      const previous = readCheckpoint(this.getDb(), request);
      const revision =
        (previous?.revision ?? null) === request.expectedRevision
          ? (previous?.revision ?? 0) + 1
          : null;
      if (revision === null) {
        const existing = this.getDb()
          .prepare(
            `SELECT expected_checkpoint_revision, handoff_id, protocol_version, checkpoint_sha256,
                  old_catalog_token, target_catalog_token, next_registration_digest,
                  candidate_digest, candidates_json, retained_registrations_json,
                  removed_registrations_json, created_at
           FROM external_writer_observation_handoff_eligibility
           WHERE deployment_id = ? AND observer_id = ?`
          )
          .get(request.deploymentId, request.observerId) as Record<string, unknown> | undefined;
        const current = previous ? checkpointFromRow(previous) : null;
        if (
          existing &&
          request.expectedRevision !== null &&
          previous?.revision === request.expectedRevision + 1 &&
          existing.expected_checkpoint_revision === previous.revision &&
          existing.protocol_version === 1 &&
          existing.handoff_id === plan.handoffId &&
          current &&
          existing.checkpoint_sha256 === canonicalSha256(current) &&
          canonicalSha256(request.checkpoint) === existing.checkpoint_sha256 &&
          existing.old_catalog_token === plan.oldCatalogToken &&
          existing.target_catalog_token === plan.nextCatalogToken &&
          existing.next_registration_digest === nextRegistrationDigest &&
          existing.retained_registrations_json === retainedJson &&
          existing.removed_registrations_json === removedJson &&
          existing.candidates_json === requestedCandidatesJson &&
          existing.candidate_digest === canonicalSha256(requestedCandidateCoordinates) &&
          existing.created_at === plan.createdAt
        ) {
          return { revision: previous.revision, checkpoint: current };
        }
        throw new Error('external-writer-observation-checkpoint-conflict');
      }
      if (previous) assertNonRegressing(checkpointFromRow(previous), request.checkpoint);
      assertNoRetiredTeamReappears(this.getDb(), request, request.checkpoint);
      for (const proof of retirementProofs) verifyTombstoneProof(this.getDb(), proof);
      const candidateRecords = retirementProofs
        .map((proof) => {
          const epoch =
            request.checkpoint.fileWriterEpochs.find((entry) => entry.teamId === proof.teamId)
              ?.epoch ?? null;
          const watermark = request.checkpoint.teamObservationWatermarks.find(
            (entry) => entry.teamId === proof.teamId
          );
          return {
            teamId: proof.teamId,
            identityChecksum: proof.identityChecksum,
            tombstonedAt: proof.tombstonedAt,
            epoch,
            lastObservationSequence: watermark?.lastObservationSequence ?? null,
            observationWatermark: watermark?.observationWatermark ?? null,
          };
        })
        .sort((a, b) => compareExternalWriterText(a.teamId, b.teamId));
      const candidatesJson = canonicalJson(
        candidateRecords,
        'external-writer-observation-handoff-plan-invalid'
      );
      const checkpointSha256 = canonicalSha256(request.checkpoint);
      const candidateDigest = canonicalSha256(candidateRecords);
      const existing = this.getDb()
        .prepare(
          `SELECT checkpoint_sha256, old_catalog_token, target_catalog_token,
                handoff_id, next_registration_digest, candidate_digest, candidates_json, created_at
         FROM external_writer_observation_handoff_eligibility
         WHERE deployment_id = ? AND observer_id = ?`
        )
        .get(request.deploymentId, request.observerId) as Record<string, unknown> | undefined;
      if (existing) throw new Error('external-writer-observation-handoff-conflict');
      const result = writeCheckpoint(this.getDb(), request, previous);
      this.getDb()
        .prepare(
          `INSERT INTO external_writer_observation_handoff_eligibility (
           deployment_id, observer_id, expected_checkpoint_revision, handoff_id, protocol_version,
           checkpoint_sha256, captured_sequence, persisted_watermark,
           old_catalog_token, target_catalog_token, next_registration_digest,
           candidate_digest, candidates_json, retained_registrations_json,
           removed_registrations_json, created_at
         ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          request.deploymentId,
          request.observerId,
          result.revision,
          plan.handoffId,
          checkpointSha256,
          request.checkpoint.lastObservationSequence,
          request.checkpoint.observationWatermark,
          plan.oldCatalogToken,
          plan.nextCatalogToken,
          nextRegistrationDigest,
          candidateDigest,
          candidatesJson,
          retainedJson,
          removedJson,
          plan.createdAt
        );
      return result;
    })();
  }

  consumeCleanHandoff(payload: unknown): ExternalWriterObservationCheckpointRecord | null {
    const record = exactObject(
      payload,
      ['deploymentId', 'observerId', 'consumeAttemptId'],
      'external-writer-observation-handoff-consume-invalid'
    );
    const identity = parseExternalWriterObservationIdentity({
      deploymentId: record.deploymentId,
      observerId: record.observerId,
    });
    if (
      typeof record.consumeAttemptId !== 'string' ||
      !CONSUME_ATTEMPT_ID_PATTERN.test(record.consumeAttemptId)
    ) {
      throw new TypeError('external-writer-observation-consume-attempt-id-invalid');
    }
    const consumeAttemptId = record.consumeAttemptId;
    return this.getDb().transaction(() => {
      const receipt = readConsumeReceipt(this.getDb(), identity, consumeAttemptId);
      if (receipt) return receipt;
      const marker = this.getDb()
        .prepare(
          `SELECT expected_checkpoint_revision, protocol_version, checkpoint_sha256,
                captured_sequence, persisted_watermark, next_registration_digest,
                candidate_digest, candidates_json, retained_registrations_json,
                removed_registrations_json
         FROM external_writer_observation_handoff_eligibility
         WHERE deployment_id = ? AND observer_id = ?`
        )
        .get(identity.deploymentId, identity.observerId) as
        | {
            expected_checkpoint_revision: number;
            protocol_version: number;
            checkpoint_sha256: string;
            captured_sequence: number;
            persisted_watermark: number;
            next_registration_digest: string;
            candidate_digest: string;
            candidates_json: string;
            retained_registrations_json: string;
            removed_registrations_json: string;
          }
        | undefined;
      if (!marker) return null;
      const previousRow = readCheckpoint(this.getDb(), identity);
      if (!previousRow || previousRow.revision !== marker.expected_checkpoint_revision)
        throw new Error('external-writer-observation-checkpoint-conflict');
      const previous = checkpointFromRow(previousRow);
      if (
        marker.protocol_version !== 1 ||
        canonicalSha256(previous) !== marker.checkpoint_sha256 ||
        marker.captured_sequence !== previous.lastObservationSequence ||
        marker.persisted_watermark !== previous.observationWatermark ||
        marker.captured_sequence !== marker.persisted_watermark
      ) {
        throw new Error('external-writer-observation-handoff-checkpoint-mismatch');
      }
      const parseStoredRegistrations = (json: string) => {
        if (Buffer.byteLength(json, 'utf8') > MAX_HANDOFF_JSON_BYTES) {
          throw new Error('external-writer-observation-handoff-marker-invalid');
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(json) as unknown;
        } catch {
          throw new Error('external-writer-observation-handoff-marker-invalid');
        }
        const inputs = exactDenseArray(
          parsed,
          MAX_HANDOFF_REGISTRATIONS,
          'external-writer-observation-handoff-marker-invalid'
        );
        const seen = new Set<string>();
        const registrations = inputs.map((value) => {
          const entry = exactDataObject(
            value,
            ['teamId', 'featureKey', 'fileKey'],
            'external-writer-observation-handoff-marker-invalid'
          );
          const registration = {
            teamId: parseTeamId(entry.teamId),
            featureKey: boundedHandoffKey(
              entry.featureKey,
              'external-writer-observation-handoff-marker-invalid'
            ),
            fileKey: boundedHandoffKey(
              entry.fileKey,
              'external-writer-observation-handoff-marker-invalid'
            ),
          };
          const key = `${registration.teamId}\0${registration.featureKey}\0${registration.fileKey}`;
          if (seen.has(key)) throw new Error('external-writer-observation-handoff-marker-invalid');
          seen.add(key);
          return registration;
        });
        if (
          canonicalJson(registrations, 'external-writer-observation-handoff-marker-invalid') !==
          json
        ) {
          throw new Error('external-writer-observation-handoff-marker-invalid');
        }
        return registrations;
      };
      const retained = parseStoredRegistrations(marker.retained_registrations_json);
      const recordedRemoved = parseStoredRegistrations(marker.removed_registrations_json);
      if (canonicalSha256(retained) !== marker.next_registration_digest) {
        throw new Error('external-writer-observation-handoff-marker-invalid');
      }
      let candidateValue: unknown;
      try {
        candidateValue = JSON.parse(marker.candidates_json) as unknown;
      } catch {
        throw new Error('external-writer-observation-handoff-marker-invalid');
      }
      const candidateInputs = exactDenseArray(
        candidateValue,
        MAX_HANDOFF_RETIREMENTS,
        'external-writer-observation-handoff-marker-invalid'
      );
      const candidateTeams = new Set<string>();
      const candidates = candidateInputs.map((value) => {
        const entry = exactDataObject(
          value,
          [
            'teamId',
            'identityChecksum',
            'tombstonedAt',
            'epoch',
            'lastObservationSequence',
            'observationWatermark',
          ],
          'external-writer-observation-handoff-marker-invalid'
        );
        const teamId = parseTeamId(entry.teamId);
        const epoch = entry.epoch;
        const last = entry.lastObservationSequence;
        const watermark = entry.observationWatermark;
        const priorEpoch =
          previous.fileWriterEpochs.find((entry) => entry.teamId === teamId)?.epoch ?? null;
        const priorWatermark = previous.teamObservationWatermarks.find(
          (entry) => entry.teamId === teamId
        );
        if (
          candidateTeams.has(teamId) ||
          (epoch !== null && (!Number.isSafeInteger(epoch) || (epoch as number) < 1)) ||
          (last === null) !== (watermark === null) ||
          (last !== null &&
            (!Number.isSafeInteger(last) ||
              (last as number) < 0 ||
              !Number.isSafeInteger(watermark) ||
              (watermark as number) < 0 ||
              (watermark as number) > (last as number))) ||
          epoch !== priorEpoch ||
          last !== (priorWatermark?.lastObservationSequence ?? null) ||
          watermark !== (priorWatermark?.observationWatermark ?? null)
        ) {
          throw new Error('external-writer-observation-handoff-marker-invalid');
        }
        candidateTeams.add(teamId);
        return {
          teamId,
          identityChecksum: parseTeamIdentityChecksum(entry.identityChecksum),
          tombstonedAt:
            typeof entry.tombstonedAt === 'string' &&
            Number.isFinite(Date.parse(entry.tombstonedAt)) &&
            new Date(entry.tombstonedAt).toISOString() === entry.tombstonedAt
              ? entry.tombstonedAt
              : (() => {
                  throw new Error('external-writer-observation-handoff-marker-invalid');
                })(),
          epoch: epoch as number | null,
          lastObservationSequence: last as number | null,
          observationWatermark: watermark as number | null,
        };
      });
      if (
        canonicalJson(candidates, 'external-writer-observation-handoff-marker-invalid') !==
          marker.candidates_json ||
        canonicalSha256(candidates) !== marker.candidate_digest
      ) {
        throw new Error('external-writer-observation-handoff-marker-invalid');
      }
      for (const proof of candidates) verifyTombstoneProof(this.getDb(), proof);
      const removed = new Set(candidates.map((entry) => entry.teamId));
      const retainedKeys = new Set(
        retained.map((entry) => `${entry.teamId}\0${entry.featureKey}\0${entry.fileKey}`)
      );
      const removedKeys = new Set(
        recordedRemoved.map((entry) => `${entry.teamId}\0${entry.featureKey}\0${entry.fileKey}`)
      );
      const expectedRemoved = previous.observedFiles
        .map((entry) => ({
          teamId: entry.scope.teamId,
          featureKey: entry.scope.featureKey,
          fileKey: entry.fileKey,
        }))
        .filter(
          (entry) => !retainedKeys.has(`${entry.teamId}\0${entry.featureKey}\0${entry.fileKey}`)
        )
        .sort(
          (a, b) =>
            compareExternalWriterText(a.teamId, b.teamId) ||
            compareExternalWriterText(a.featureKey, b.featureKey) ||
            compareExternalWriterText(a.fileKey, b.fileKey)
        );
      if (
        canonicalJson(expectedRemoved, 'external-writer-observation-handoff-marker-invalid') !==
        marker.removed_registrations_json
      ) {
        throw new Error('external-writer-observation-handoff-marker-invalid');
      }
      const next = parseExternalWriterObservationCheckpoint({
        ...previous,
        fileWriterEpochs: previous.fileWriterEpochs.filter((entry) => !removed.has(entry.teamId)),
        teamObservationWatermarks: previous.teamObservationWatermarks.filter(
          (entry) => !removed.has(entry.teamId)
        ),
        observedFiles: previous.observedFiles.filter((entry) => {
          const key = `${entry.scope.teamId}\0${entry.scope.featureKey}\0${entry.fileKey}`;
          if (removedKeys.has(key)) return false;
          return retainedKeys.has(key);
        }),
      });
      for (const proof of candidates)
        insertRetiredFloor(this.getDb(), identity, proof as never, previous);
      const result = writeCheckpoint(
        this.getDb(),
        { ...identity, expectedRevision: previousRow.revision, checkpoint: next },
        previousRow
      );
      this.getDb()
        .prepare(
          `DELETE FROM external_writer_observation_handoff_eligibility WHERE deployment_id = ? AND observer_id = ?`
        )
        .run(identity.deploymentId, identity.observerId);
      replaceConsumeReceipt(this.getDb(), identity, consumeAttemptId, result);
      return result;
    })();
  }
}
