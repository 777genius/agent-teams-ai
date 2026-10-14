import { CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION } from '@features/custom-team-templates/contracts';
import { normalizeTemplateNameKey } from '@features/custom-team-templates/core/domain/templateNamePolicy';
import { asc, eq } from 'drizzle-orm';

import {
  isStoredTemplateEquivalentToRequest,
  parseTemplateMembers,
  readStoredTemplate,
  toStoredTemplateRow,
} from './customTeamTemplateRecordMapper';
import { customTeamTemplates } from './internalStorageSchema';

import type { StoredCustomTeamTemplateRow } from './customTeamTemplateRecordMapper';
import type {
  CreateCustomTeamTemplateRecordRequest,
  CreateCustomTeamTemplateRecordResult,
  CustomTeamTemplateUnreadableRecord,
  CustomTeamTemplateV1,
  ListCustomTeamTemplateRecordsResult,
  ReadCustomTeamTemplateRecordResult,
} from '@features/custom-team-templates/contracts';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

/** SQLite reports write-lock contention with these codes after `busy_timeout`. */
const SQLITE_BUSY_ERROR_CODES = new Set([
  'SQLITE_BUSY',
  'SQLITE_BUSY_SNAPSHOT',
  'SQLITE_BUSY_TIMEOUT',
]);

function isSqliteBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && SQLITE_BUSY_ERROR_CODES.has(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCreatePayload(payload: unknown): CreateCustomTeamTemplateRecordRequest {
  if (!isPlainRecord(payload)) {
    throw new Error('Invalid customTemplate.create payload: expected an object');
  }
  const { template, contentHash } = payload;
  if (!isPlainRecord(template)) {
    throw new Error('Invalid customTemplate.create payload: template must be an object');
  }
  const { templateId, name, description, schemaVersion, teamPrompt, members } = template;
  if (typeof templateId !== 'string' || !templateId) {
    throw new Error('Invalid customTemplate.create payload: templateId must be a non-empty string');
  }
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('Invalid customTemplate.create payload: name must be a non-blank string');
  }
  if (description !== undefined && typeof description !== 'string') {
    throw new Error('Invalid customTemplate.create payload: description must be a string');
  }
  if (schemaVersion !== CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION) {
    // Fail closed instead of persisting a payload whose contract version this
    // build cannot vouch for.
    throw new Error(
      `Invalid customTemplate.create payload: unsupported schemaVersion ${String(schemaVersion)}`
    );
  }
  if (typeof teamPrompt !== 'string') {
    throw new Error('Invalid customTemplate.create payload: teamPrompt must be a string');
  }
  const parsedMembers = parseTemplateMembers(members);
  if (!parsedMembers) {
    throw new Error('Invalid customTemplate.create payload: members must be allowlisted entries');
  }
  if (typeof contentHash !== 'string' || !contentHash) {
    throw new Error(
      'Invalid customTemplate.create payload: contentHash must be a non-empty string'
    );
  }

  return {
    template: {
      templateId,
      name,
      ...(description !== undefined ? { description } : {}),
      schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
      teamPrompt,
      members: parsedMembers,
    },
    contentHash,
  };
}

function parseReadByIdPayload(payload: unknown): string {
  if (!isPlainRecord(payload) || typeof payload.templateId !== 'string' || !payload.templateId) {
    throw new Error(
      'Invalid customTemplate.getById payload: templateId must be a non-empty string'
    );
  }
  return payload.templateId;
}

/** Dispatches one `customTemplate.*` worker op; mirrors the other op families. */
export function handleCustomTeamTemplateOp(
  ops: CustomTeamTemplateWorkerOps,
  op: string,
  payload: unknown
): unknown {
  switch (op) {
    case 'customTemplate.create':
      return ops.create(payload);
    case 'customTemplate.list':
      return ops.list();
    case 'customTemplate.getById':
      return ops.getById(payload);
    default:
      throw new Error(`Unknown internal-storage op: ${op}`);
  }
}

/**
 * Synchronous SQLite operations for the custom team template library.
 *
 * Runs inside the worker thread on one connection; the client serializes calls.
 * Every mutation is a single transaction, and every invariant (name uniqueness,
 * id idempotency) is enforced inside it by the schema, never by a caller-side
 * read-then-write check.
 */
export class CustomTeamTemplateWorkerOps {
  constructor(
    private readonly getOrm: () => BetterSQLite3Database,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * Idempotent, atomic creation.
   *
   * The insert runs first so the transaction takes the write lock before any
   * read, and the bare `ON CONFLICT DO NOTHING` clause is deliberate: an
   * ignored insert reports `changes === 0` for any uniqueness conflict without
   * saying which one, so the outcome always comes from the read-back that
   * follows. NOT NULL and CHECK violations still raise.
   */
  create(payload: unknown): CreateCustomTeamTemplateRecordResult {
    const request = parseCreatePayload(payload);
    const nameNormalized = normalizeTemplateNameKey(request.template.name);
    if (!nameNormalized) {
      // A blank normalized key would collapse every such template onto one
      // unique-index entry, so it is rejected before it reaches SQLite.
      throw new Error('Invalid customTemplate.create payload: name must not normalize to empty');
    }
    const row = toStoredTemplateRow({
      request,
      nameNormalized,
      createdAt: this.now().toISOString(),
    });

    try {
      return this.runCreateTransaction(row);
    } catch (error) {
      // A write-lock timeout is loud and retryable, never a silent lost write.
      // Retrying with the same template id is idempotent by construction, so
      // the decision is left to the application layer that owns the retry.
      if (isSqliteBusyError(error)) {
        return { status: 'retryable', reason: 'databaseBusy' };
      }
      throw error;
    }
  }

  /** Stable creation order; presentation ordering belongs to the UI layer. */
  list(): ListCustomTeamTemplateRecordsResult {
    const rows = this.getOrm()
      .select()
      .from(customTeamTemplates)
      .orderBy(asc(customTeamTemplates.createdAt), asc(customTeamTemplates.id))
      .all() as StoredCustomTeamTemplateRow[];

    const templates: CustomTeamTemplateV1[] = [];
    const unreadableRecords: CustomTeamTemplateUnreadableRecord[] = [];
    for (const row of rows) {
      const stored = readStoredTemplate(row);
      if (stored.status === 'readable') {
        templates.push(stored.template);
      } else {
        unreadableRecords.push({ templateId: stored.templateId, reason: 'unreadableRecord' });
      }
    }
    return { templates, unreadableRecords };
  }

  getById(payload: unknown): ReadCustomTeamTemplateRecordResult {
    const templateId = parseReadByIdPayload(payload);
    const row = this.selectById(this.getOrm(), templateId);
    if (!row) {
      return { status: 'notFound' };
    }
    const stored = readStoredTemplate(row);
    return stored.status === 'readable'
      ? { status: 'found', template: stored.template }
      : { status: 'unreadable', templateId };
  }

  private runCreateTransaction(
    row: StoredCustomTeamTemplateRow
  ): CreateCustomTeamTemplateRecordResult {
    const orm = this.getOrm();
    return orm.transaction((): CreateCustomTeamTemplateRecordResult => {
      const inserted = orm
        .insert(customTeamTemplates)
        .values(row)
        .onConflictDoNothing()
        .run().changes;
      if (inserted === 1) {
        const stored = readStoredTemplate(row);
        if (stored.status !== 'readable') {
          throw new Error(`customTemplate.create stored an unreadable row: ${row.id}`);
        }
        return { status: 'created', template: stored.template };
      }

      const existingById = this.selectById(orm, row.id);
      if (existingById) {
        if (!isStoredTemplateEquivalentToRequest(existingById, row)) {
          return {
            status: 'conflict',
            reason: 'idReusedWithDifferentContent',
            existingTemplateId: row.id,
          };
        }
        const stored = readStoredTemplate(existingById);
        if (stored.status !== 'readable') {
          // The columns match, but the stored record cannot be reconstructed,
          // so the outcome is genuinely unresolvable and must not be claimed
          // as a successful idempotent retry.
          return { status: 'existingRecordUnreadable', templateId: row.id };
        }
        return { status: 'alreadySaved', template: stored.template };
      }

      const existingByName = this.selectByName(orm, row.nameNormalized);
      if (existingByName) {
        return {
          status: 'conflict',
          reason: 'nameTaken',
          existingTemplateId: existingByName.id,
        };
      }

      // No visible conflict explains the ignored insert: report an internal
      // error instead of inventing a domain outcome or silently doing nothing.
      throw new Error(
        `customTemplate.create ignored the insert without a visible conflict: ${row.id}`
      );
    });
  }

  private selectById(
    orm: BetterSQLite3Database,
    templateId: string
  ): StoredCustomTeamTemplateRow | null {
    const rows = orm
      .select()
      .from(customTeamTemplates)
      .where(eq(customTeamTemplates.id, templateId))
      .all() as StoredCustomTeamTemplateRow[];
    return rows[0] ?? null;
  }

  private selectByName(
    orm: BetterSQLite3Database,
    nameNormalized: string
  ): StoredCustomTeamTemplateRow | null {
    const rows = orm
      .select()
      .from(customTeamTemplates)
      .where(eq(customTeamTemplates.nameNormalized, nameNormalized))
      .all() as StoredCustomTeamTemplateRow[];
    return rows[0] ?? null;
  }
}
