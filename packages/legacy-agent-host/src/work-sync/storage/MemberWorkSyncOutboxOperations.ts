import { withFileLock } from '../../adapters/cross-team/fileLock.js';
import { summarizeRecentDeliveredOutboxItems } from '../policy/core/domain/memberWorkSyncRecentDelivered.js';
import { normalizeMemberKey } from './memberWorkSyncStoreIdentity.js';
import {
  applyOptionalNextAttemptAt,
  canReviveOutboxItem,
  getDueOutboxRoutes,
  canClaimOutboxItem,
  isOutboxItemOwnedBy,
  toOutboxIndexItem,
  isOutboxTerminal,
  normalizeTeamKey,
  canClaimOutboxRoute,
} from './jsonStorePolicy.js';
import type {
  OutboxIndexFile,
  OutboxIndexRoute,
  OutboxDueRoute,
  MemberOutboxFile,
} from './jsonStorePolicy.js';
import type { MemberWorkSyncStorePaths } from './MemberWorkSyncStorePaths.js';
import type { MemberWorkSyncOutboxStorePort } from '../policy/core/application/ports.js';
import type {
  MemberWorkSyncOutboxEnsureInput,
  MemberWorkSyncOutboxEnsureResult,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncOutboxClaimInput,
  MemberWorkSyncOutboxMarkDeliveredInput,
  MemberWorkSyncOutboxMarkSupersededInput,
  MemberWorkSyncOutboxMarkFailedInput,
  MemberWorkSyncOutboxCountRecentDeliveredInput,
  MemberWorkSyncOutboxRecentDeliveredSummary,
  MemberWorkSyncOutboxCountDeliveredForAgendaInput,
} from '../policy/contracts/index.js';
export interface MemberWorkSyncOutboxStorage {
  paths: Pick<
    MemberWorkSyncStorePaths,
    'getMemberKey' | 'ensureMemberWorkSyncDir' | 'getOutboxIndexPath' | 'getMemberOutboxPath'
  >;
  enqueue(teamName: string, operation: () => Promise<void>): Promise<void>;
  readMemberOutboxFile(teamName: string, memberName: string): Promise<MemberOutboxFile>;
  writeMemberOutboxFile(
    teamName: string,
    memberName: string,
    file: MemberOutboxFile
  ): Promise<void>;
  readOutboxIndexFile(teamName: string): Promise<OutboxIndexFile>;
  writeOutboxIndexFile(teamName: string, file: OutboxIndexFile): Promise<void>;
  scanMemberNames(teamName: string): Promise<string[]>;
  readLegacyOutboxFile(
    teamName: string
  ): Promise<{ schemaVersion: 1; items: Record<string, MemberWorkSyncOutboxItem> }>;
  appendAudit(input: {
    teamName: string;
    memberName: string;
    event: 'index_repaired' | 'legacy_fallback_used';
    source: string;
    reason: string;
  }): Promise<void>;
}
/** Existing feature outbox transitions. Consumer owns current physical lifetime and guarded file commits. */
export class MemberWorkSyncOutboxOperations implements MemberWorkSyncOutboxStorePort {
  constructor(
    private readonly storage: MemberWorkSyncOutboxStorage,
    private readonly memberScope?: string,
    private readonly itemScope?: ReadonlySet<string>
  ) {}

  private assertMember(memberName: string): void {
    if (
      this.memberScope !== undefined &&
      normalizeMemberKey(memberName) !== normalizeMemberKey(this.memberScope)
    )
      throw new Error('Work sync outbox member scope changed');
  }

  private dueRoutes(index: OutboxIndexFile, nowIso: string, limit: number): OutboxDueRoute[] {
    const scoped =
      this.memberScope === undefined
        ? index
        : {
            schemaVersion: 2 as const,
            items: Object.fromEntries(
              Object.entries(index.items).filter(
                ([id, route]) =>
                  (this.itemScope === undefined || this.itemScope.has(id)) &&
                  normalizeMemberKey(route.memberName) === normalizeMemberKey(this.memberScope)
              )
            ),
          };
    return getDueOutboxRoutes(scoped, nowIso, limit);
  }

  async ensurePending(
    input: MemberWorkSyncOutboxEnsureInput
  ): Promise<MemberWorkSyncOutboxEnsureResult> {
    this.assertMember(input.memberName);
    let result: MemberWorkSyncOutboxEnsureResult | null = null;
    const memberKey = this.storage.paths.getMemberKey(input.memberName);
    await this.storage.paths.ensureMemberWorkSyncDir(input.teamName, input.memberName);
    await this.storage.enqueue(input.teamName, async () => {
      await withFileLock(this.storage.paths.getOutboxIndexPath(input.teamName), async () => {
        await withFileLock(
          this.storage.paths.getMemberOutboxPath(input.teamName, input.memberName),
          async () => {
            const outbox = await this.storage.readMemberOutboxFile(
              input.teamName,
              input.memberName
            );
            const current = outbox.items[input.id];
            if (current) {
              if (current.payloadHash !== input.payloadHash) {
                if (current.status !== 'delivered' && current.status !== 'failed_terminal') {
                  const next: MemberWorkSyncOutboxItem = {
                    ...current,
                    agendaFingerprint: input.agendaFingerprint,
                    payloadHash: input.payloadHash,
                    payload: input.payload,
                    status: 'pending',
                    attemptGeneration:
                      current.status === 'claimed'
                        ? current.attemptGeneration + 1
                        : current.attemptGeneration,
                    updatedAt: input.nowIso,
                  };
                  applyOptionalNextAttemptAt(next, input.nextAttemptAt);
                  delete next.claimedBy;
                  delete next.claimedAt;
                  delete next.lastError;
                  outbox.items[input.id] = next;
                  await this.storage.writeMemberOutboxFile(
                    input.teamName,
                    input.memberName,
                    outbox
                  );
                  await this.upsertOutboxIndexItem(input.teamName, next, memberKey);
                  result = { ok: true, outcome: 'existing', item: next };
                  return;
                }
                result = {
                  ok: false,
                  outcome: 'payload_conflict',
                  item: current,
                  existingPayloadHash: current.payloadHash,
                  requestedPayloadHash: input.payloadHash,
                };
                return;
              }

              if (canReviveOutboxItem(current.status)) {
                const next: MemberWorkSyncOutboxItem = {
                  ...current,
                  status: 'pending',
                  updatedAt: input.nowIso,
                };
                applyOptionalNextAttemptAt(next, input.nextAttemptAt);
                delete next.claimedBy;
                delete next.claimedAt;
                delete next.lastError;
                outbox.items[input.id] = next;
                await this.storage.writeMemberOutboxFile(input.teamName, input.memberName, outbox);
                await this.upsertOutboxIndexItem(input.teamName, next, memberKey);
                result = { ok: true, outcome: 'existing', item: next };
                return;
              }

              await this.upsertOutboxIndexItem(input.teamName, current, memberKey);
              result = { ok: true, outcome: 'existing', item: current };
              return;
            }

            const item: MemberWorkSyncOutboxItem = {
              id: input.id,
              teamName: input.teamName,
              memberName: input.memberName,
              agendaFingerprint: input.agendaFingerprint,
              payloadHash: input.payloadHash,
              payload: input.payload,
              status: 'pending',
              attemptGeneration: 0,
              ...(input.nextAttemptAt ? { nextAttemptAt: input.nextAttemptAt } : {}),
              createdAt: input.nowIso,
              updatedAt: input.nowIso,
            };
            outbox.items[input.id] = item;
            await this.storage.writeMemberOutboxFile(input.teamName, input.memberName, outbox);
            await this.upsertOutboxIndexItem(input.teamName, item, memberKey);
            result = { ok: true, outcome: 'created', item };
          }
        );
      });
    });

    if (!result) {
      throw new Error('Member work sync outbox write did not produce a result');
    }
    return result;
  }

  async claimDue(input: MemberWorkSyncOutboxClaimInput): Promise<MemberWorkSyncOutboxItem[]> {
    const claimed: MemberWorkSyncOutboxItem[] = [];
    await this.storage.enqueue(input.teamName, async () => {
      await withFileLock(this.storage.paths.getOutboxIndexPath(input.teamName), async () => {
        let index = await this.storage.readOutboxIndexFile(input.teamName);
        if (Object.keys(index.items).length === 0) {
          index = await this.repairOutboxIndex(input.teamName);
        }
        let dueRoutes = this.dueRoutes(index, input.nowIso, input.limit);
        if (
          dueRoutes.length < Math.max(0, input.limit) &&
          (await this.hasUnindexedOrStaleIndexedDueOutboxItem(input.teamName, index, input.nowIso))
        ) {
          index = await this.repairOutboxIndex(input.teamName);
          dueRoutes = this.dueRoutes(index, input.nowIso, input.limit);
        }

        const claimRoutes = async (routes: OutboxDueRoute[]): Promise<boolean> => {
          let staleIndex = false;
          for (const [id, route] of routes) {
            if (claimed.length >= Math.max(0, input.limit)) {
              break;
            }
            await withFileLock(
              this.storage.paths.getMemberOutboxPath(input.teamName, route.memberName),
              async () => {
                const outbox = await this.storage.readMemberOutboxFile(
                  input.teamName,
                  route.memberName
                );
                const item = outbox.items[id];
                if (!item || !canClaimOutboxItem(item, input.nowIso)) {
                  delete index.items[id];
                  staleIndex = true;
                  return;
                }
                const memberKey = this.storage.paths.getMemberKey(item.memberName);
                if (!isOutboxItemOwnedBy(input.teamName, route.memberName, item)) {
                  delete index.items[id];
                  staleIndex = true;
                  return;
                }
                const next: MemberWorkSyncOutboxItem = {
                  ...item,
                  status: 'claimed',
                  attemptGeneration: item.attemptGeneration + 1,
                  claimedBy: input.claimedBy,
                  claimedAt: input.nowIso,
                  updatedAt: input.nowIso,
                };
                delete next.nextAttemptAt;
                delete next.lastError;
                outbox.items[id] = next;
                await this.storage.writeMemberOutboxFile(input.teamName, route.memberName, outbox);
                index.items[id] = toOutboxIndexItem(next, memberKey);
                claimed.push(next);
              }
            );
          }
          return staleIndex;
        };

        let staleIndex = await claimRoutes(dueRoutes);
        if (staleIndex) {
          index = await this.repairOutboxIndex(input.teamName);
          const remainingLimit = Math.max(0, input.limit) - claimed.length;
          dueRoutes = remainingLimit > 0 ? this.dueRoutes(index, input.nowIso, remainingLimit) : [];
          staleIndex = dueRoutes.length > 0 ? await claimRoutes(dueRoutes) : false;
          if (staleIndex) {
            await this.repairOutboxIndex(input.teamName);
          } else if (dueRoutes.length > 0) {
            await this.storage.writeOutboxIndexFile(input.teamName, index);
          }
        } else if (dueRoutes.length > 0) {
          await this.storage.writeOutboxIndexFile(input.teamName, index);
        }
      });
    });
    return claimed;
  }

  async markDelivered(input: MemberWorkSyncOutboxMarkDeliveredInput): Promise<void> {
    await this.updateOutboxItem(input.teamName, input.id, (current) => {
      if (current?.attemptGeneration !== input.attemptGeneration || current.status !== 'claimed') {
        return current;
      }
      const next: MemberWorkSyncOutboxItem = {
        ...current,
        status: 'delivered',
        deliveredMessageId: input.deliveredMessageId,
        ...(input.deliveryState ? { deliveryState: input.deliveryState } : {}),
        ...(input.deliveryDiagnostics?.length
          ? { deliveryDiagnostics: input.deliveryDiagnostics }
          : {}),
        updatedAt: input.nowIso,
      };
      delete next.lastError;
      delete next.nextAttemptAt;
      return next;
    });
  }

  async markSuperseded(input: MemberWorkSyncOutboxMarkSupersededInput): Promise<void> {
    await this.updateOutboxItem(input.teamName, input.id, (current) => {
      if (!current || isOutboxTerminal(current.status)) {
        return current;
      }
      return {
        ...current,
        status: 'superseded',
        lastError: input.reason,
        updatedAt: input.nowIso,
      };
    });
  }

  async markFailed(input: MemberWorkSyncOutboxMarkFailedInput): Promise<void> {
    await this.updateOutboxItem(input.teamName, input.id, (current) => {
      // Only the in-flight claim may record a failure. If the item was revived to
      // 'pending' (same attemptGeneration) while delivery was in flight, a late
      // failure must NOT clobber the revived work. Mirrors markDelivered and the
      // SQLite worker guard (memberWorkSyncWorkerOps.markFailed).
      if (current?.attemptGeneration !== input.attemptGeneration || current.status !== 'claimed') {
        return current;
      }
      const next: MemberWorkSyncOutboxItem = {
        ...current,
        status: input.retryable ? 'failed_retryable' : 'failed_terminal',
        lastError: input.error,
        ...(input.retryable && input.nextAttemptAt ? { nextAttemptAt: input.nextAttemptAt } : {}),
        updatedAt: input.nowIso,
      };
      if (!input.retryable) {
        delete next.nextAttemptAt;
      }
      return next;
    });
  }

  async countRecentDelivered(
    input: MemberWorkSyncOutboxCountRecentDeliveredInput
  ): Promise<MemberWorkSyncOutboxRecentDeliveredSummary> {
    this.assertMember(input.memberName);
    const workSyncIntentKeyPrefix = input.workSyncIntentKeyPrefix?.trim();
    if (workSyncIntentKeyPrefix) {
      const memberOutbox = await this.storage.readMemberOutboxFile(
        input.teamName,
        input.memberName
      );
      return summarizeRecentDeliveredOutboxItems(Object.values(memberOutbox.items), {
        sinceIso: input.sinceIso,
        workSyncIntentKeyPrefix,
      });
    }

    let index = await this.storage.readOutboxIndexFile(input.teamName);
    if (Object.keys(index.items).length === 0) {
      await this.storage.enqueue(input.teamName, async () => {
        await withFileLock(this.storage.paths.getOutboxIndexPath(input.teamName), async () => {
          index = await this.storage.readOutboxIndexFile(input.teamName);
          if (Object.keys(index.items).length === 0) {
            index = await this.repairOutboxIndex(input.teamName);
          }
        });
      });
    }
    const indexed = summarizeRecentDeliveredOutboxItems(
      Object.values(index.items).filter(
        (item) => normalizeMemberKey(item.memberName) === normalizeMemberKey(input.memberName)
      ),
      { sinceIso: input.sinceIso }
    );
    const memberOutbox = await this.storage.readMemberOutboxFile(input.teamName, input.memberName);
    const memberFile = summarizeRecentDeliveredOutboxItems(Object.values(memberOutbox.items), {
      sinceIso: input.sinceIso,
    });
    if (memberFile.count > indexed.count) {
      await this.storage.enqueue(input.teamName, async () => {
        await withFileLock(this.storage.paths.getOutboxIndexPath(input.teamName), async () => {
          await this.repairOutboxIndex(input.teamName);
        });
      });
    }
    return memberFile.count >= indexed.count ? memberFile : indexed;
  }

  async countDeliveredForAgenda(
    input: MemberWorkSyncOutboxCountDeliveredForAgendaInput
  ): Promise<number> {
    this.assertMember(input.memberName);
    const agendaFingerprint = input.agendaFingerprint.trim();
    if (!agendaFingerprint) {
      return 0;
    }

    const sinceIso = input.sinceIso?.trim();
    const memberKey = normalizeMemberKey(input.memberName);
    const memberOutbox = await this.storage.readMemberOutboxFile(input.teamName, input.memberName);
    return Object.values(memberOutbox.items).filter(
      (item) =>
        normalizeMemberKey(item.memberName) === memberKey &&
        item.status === 'delivered' &&
        item.agendaFingerprint === agendaFingerprint &&
        (!sinceIso || item.updatedAt > sinceIso)
    ).length;
  }

  async findDeliveredReviewPickupRequestEventIds(input: {
    teamName: string;
    memberName: string;
    reviewRequestEventIds: string[];
  }): Promise<string[]> {
    this.assertMember(input.memberName);
    const requested = new Set(input.reviewRequestEventIds.map((id) => id.trim()).filter(Boolean));
    if (requested.size === 0) {
      return [];
    }

    const memberOutbox = await this.storage.readMemberOutboxFile(input.teamName, input.memberName);
    const delivered = new Set<string>();
    for (const item of Object.values(memberOutbox.items)) {
      if (item.status !== 'delivered' || item.payload.workSyncIntent !== 'review_pickup') {
        continue;
      }
      for (const eventId of item.payload.workSyncReviewRequestEventIds ?? []) {
        const normalized = eventId.trim();
        if (requested.has(normalized)) {
          delivered.add(normalized);
        }
      }
    }
    return [...delivered].sort();
  }

  async findRecentRecoveryByIntent(input: {
    teamName: string;
    memberName: string;
    intentKey: string;
    sinceIso: string;
  }): Promise<{
    id: string;
    status: MemberWorkSyncOutboxItem['status'];
    deliveredMessageId?: string;
    payloadHash: string;
    updatedAt: string;
  } | null> {
    this.assertMember(input.memberName);
    const intentKey = input.intentKey.trim();
    if (!intentKey) {
      return null;
    }

    const memberOutbox = await this.storage.readMemberOutboxFile(input.teamName, input.memberName);
    const matches = Object.values(memberOutbox.items)
      .filter(
        (item) =>
          item.payload.workSyncIntentKey === intentKey &&
          item.updatedAt >= input.sinceIso &&
          item.status !== 'failed_terminal' &&
          item.status !== 'superseded'
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const latest = matches[0];
    if (!latest) {
      return null;
    }

    return {
      id: latest.id,
      status: latest.status,
      ...(latest.deliveredMessageId ? { deliveredMessageId: latest.deliveredMessageId } : {}),
      payloadHash: latest.payloadHash,
      updatedAt: latest.updatedAt,
    };
  }

  async readItem(input: {
    teamName: string;
    memberName: string;
    id: string;
  }): Promise<MemberWorkSyncOutboxItem | null> {
    this.assertMember(input.memberName);
    const outbox = await this.storage.readMemberOutboxFile(input.teamName, input.memberName);
    return outbox.items[input.id] ?? null;
  }

  async updateOutboxItem(
    teamName: string,
    id: string,
    updater: (current: MemberWorkSyncOutboxItem | undefined) => MemberWorkSyncOutboxItem | undefined
  ): Promise<void> {
    await this.storage.enqueue(teamName, async () => {
      await withFileLock(this.storage.paths.getOutboxIndexPath(teamName), async () => {
        let index = await this.storage.readOutboxIndexFile(teamName);
        if (!index.items[id]) {
          index = await this.repairOutboxIndex(teamName);
        }
        const route = index.items[id];
        if (!route) {
          return;
        }
        const updateRoute = async (targetRoute: OutboxIndexRoute): Promise<boolean> => {
          this.assertMember(targetRoute.memberName);
          let staleRoute = false;
          await withFileLock(
            this.storage.paths.getMemberOutboxPath(teamName, targetRoute.memberName),
            async () => {
              const outbox = await this.storage.readMemberOutboxFile(
                teamName,
                targetRoute.memberName
              );
              const current = outbox.items[id];
              if (!current) {
                delete index.items[id];
                staleRoute = true;
                return;
              }
              if (!isOutboxItemOwnedBy(teamName, targetRoute.memberName, current)) {
                delete index.items[id];
                staleRoute = true;
                return;
              }
              const next = updater(current);
              if (!next) {
                return;
              }
              outbox.items[id] = next;
              await this.storage.writeMemberOutboxFile(teamName, targetRoute.memberName, outbox);
              index.items[id] = toOutboxIndexItem(
                next,
                this.storage.paths.getMemberKey(next.memberName)
              );
              await this.storage.writeOutboxIndexFile(teamName, index);
            }
          );
          return staleRoute;
        };

        let staleRoute = await updateRoute(route);
        if (staleRoute) {
          index = await this.repairOutboxIndex(teamName);
          const repairedRoute = index.items[id];
          if (!repairedRoute) {
            return;
          }
          staleRoute = await updateRoute(repairedRoute);
          if (staleRoute) {
            await this.repairOutboxIndex(teamName);
          }
        }
      });
    });
  }

  async repairOutboxIndex(teamName: string): Promise<OutboxIndexFile> {
    const index: OutboxIndexFile = { schemaVersion: 2, items: {} };
    const repairedMembers = new Set<string>();
    const legacyMembers = new Set<string>();
    for (const { memberName, outbox } of await this.scanMemberOutboxes(teamName)) {
      const memberKey = this.storage.paths.getMemberKey(memberName);
      for (const item of Object.values(outbox.items)) {
        if (!isOutboxItemOwnedBy(teamName, memberName, item)) {
          continue;
        }
        index.items[item.id] = toOutboxIndexItem(item, memberKey);
        repairedMembers.add(item.memberName);
      }
    }
    for (const item of Object.values((await this.storage.readLegacyOutboxFile(teamName)).items)) {
      if (!isOutboxItemOwnedBy(teamName, item.memberName, item)) {
        continue;
      }
      const memberKey = this.storage.paths.getMemberKey(item.memberName);
      if (!index.items[item.id]) {
        await withFileLock(
          this.storage.paths.getMemberOutboxPath(teamName, item.memberName),
          async () => {
            const outbox = await this.storage.readMemberOutboxFile(teamName, item.memberName);
            outbox.items[item.id] = item;
            await this.storage.writeMemberOutboxFile(teamName, item.memberName, outbox);
          }
        );
        index.items[item.id] = toOutboxIndexItem(item, memberKey);
        repairedMembers.add(item.memberName);
        legacyMembers.add(item.memberName);
      }
    }
    await this.storage.writeOutboxIndexFile(teamName, index);
    for (const memberName of repairedMembers) {
      await this.storage.appendAudit({
        teamName,
        memberName,
        event: 'index_repaired',
        source: 'json_store',
        reason: 'outbox',
      });
    }
    for (const memberName of legacyMembers) {
      await this.storage.appendAudit({
        teamName,
        memberName,
        event: 'legacy_fallback_used',
        source: 'json_store',
        reason: 'outbox_v1',
      });
    }
    return index;
  }

  async scanMemberOutboxes(
    teamName: string
  ): Promise<{ memberName: string; outbox: MemberOutboxFile }[]> {
    const outboxes: { memberName: string; outbox: MemberOutboxFile }[] = [];
    for (const memberName of await this.storage.scanMemberNames(teamName)) {
      outboxes.push({
        memberName,
        outbox: await this.storage.readMemberOutboxFile(teamName, memberName),
      });
    }
    return outboxes;
  }

  async hasUnindexedOrStaleIndexedDueOutboxItem(
    teamName: string,
    index: OutboxIndexFile,
    nowIso: string
  ): Promise<boolean> {
    const routes = index.items;
    for (const { memberName, outbox } of await this.scanMemberOutboxes(teamName)) {
      for (const item of Object.values(outbox.items)) {
        if (!isOutboxItemOwnedBy(teamName, memberName, item)) {
          continue;
        }
        const route = routes[item.id];
        if (
          canClaimOutboxItem(item, nowIso) &&
          !this.isCurrentDueOutboxRoute(teamName, route, item, nowIso)
        ) {
          return true;
        }
      }
    }
    for (const item of Object.values((await this.storage.readLegacyOutboxFile(teamName)).items)) {
      if (!isOutboxItemOwnedBy(teamName, item.memberName, item)) {
        continue;
      }
      const route = routes[item.id];
      if (
        canClaimOutboxItem(item, nowIso) &&
        !this.isCurrentDueOutboxRoute(teamName, route, item, nowIso)
      ) {
        return true;
      }
    }
    return false;
  }

  isCurrentDueOutboxRoute(
    teamName: string,
    route: OutboxIndexRoute | undefined,
    item: MemberWorkSyncOutboxItem,
    nowIso: string
  ): boolean {
    return (
      !!route &&
      normalizeTeamKey(item.teamName) === normalizeTeamKey(teamName) &&
      normalizeMemberKey(route.memberName) === normalizeMemberKey(item.memberName) &&
      route.memberKey === this.storage.paths.getMemberKey(item.memberName) &&
      canClaimOutboxRoute(route, nowIso)
    );
  }

  async upsertOutboxIndexItem(
    teamName: string,
    item: MemberWorkSyncOutboxItem,
    memberKey: string
  ): Promise<void> {
    const index = await this.storage.readOutboxIndexFile(teamName);
    index.items[item.id] = toOutboxIndexItem(item, memberKey);
    await this.storage.writeOutboxIndexFile(teamName, index);
  }
}
