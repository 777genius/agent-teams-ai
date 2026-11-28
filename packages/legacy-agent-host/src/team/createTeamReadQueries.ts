import { digest, safeSegment } from "./identity.js";
import { TeamOwnerError } from "./contracts.js";
import { pageOwnerTaskComment } from "./pageOwnerTaskComment.js";
import { pageOwnerReadDetail } from "./pageOwnerTaskDetail.js";
import { json } from "./TeamReviewCommands.js";
import type { JsonValue } from "../contracts.js";
import type { OwnerBriefingScope } from "./pageOwnerTaskDetail.js";
import type { TeamGrant, TeamMember } from "./contracts.js";
import type { TeamBoardReadPolicy, TeamTaskInventoryFilters } from "./ports.js";

type BriefingPageOptions = { cursor?: string };
type MemberBriefingSettings = { includeActiveProcesses: boolean };

/** Read-only policy binding. No writer, native callback or path selector is exposed. */
export function createTeamReadQueries(options: {
  reads: TeamBoardReadPolicy;
  fenced<T>(action: () => T): T;
  authority(): { grant: TeamGrant; members: readonly TeamMember[] };
  commentPages: { principalId: string; key: string; teamName: string };
  getTeam(cursor?: string): unknown;
}) {
  const identity = () => {
    const { grant, members } = options.authority();
    return {
      grant,
      members,
      fingerprint: digest({ grant, members }),
    };
  };
  const read = <T>(action: () => T): T =>
    options.fenced(() => {
      identity();
      return action();
    });
  const finishBriefing = (
    value: string, page: BriefingPageOptions | undefined, scope: OwnerBriefingScope, grant: TeamGrant,
  ): JsonValue => {
    if (page === undefined) return value;
    if (typeof value !== "string") throw new TeamOwnerError("hold");
    return pageOwnerReadDetail({
      ...options.commentPages, grant, briefingScope: scope, value,
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    });
  };
  const briefing = async (memberName?: string, page?: BriefingPageOptions): Promise<JsonValue> => {
    const capturedPage = page === undefined ? undefined : { ...page };
    const pending = options.fenced(() => {
      const original = identity();
      if (memberName === undefined) {
        return {
          fingerprint: original.fingerprint,
          value: options.reads.leadBriefing(),
        };
      }
      safeSegment(memberName);
      if (!original.members.some((member) => member.name === memberName))
        throw new TeamOwnerError("invalid");
      return {
        fingerprint: original.fingerprint,
        value: options.reads.taskBriefing(memberName),
      };
    });
    const value = await pending.value;
    return options.fenced(() => {
      const current = identity();
      if (current.fingerprint !== pending.fingerprint)
        throw new TeamOwnerError("forbidden");
      return finishBriefing(value, capturedPage, {
        ...(memberName === undefined ? { kind: "lead" } : { kind: "task", memberName }),
        authorityFingerprint: current.fingerprint,
      }, current.grant);
    });
  };
  function taskBriefing(memberName?: string): Promise<string>;
  function taskBriefing(memberName: string | undefined, page: BriefingPageOptions): Promise<JsonValue>;
  function taskBriefing(memberName?: string, page?: BriefingPageOptions): Promise<JsonValue> {
    const selected = read(() => memberName ?? identity().grant.memberName);
    return briefing(selected, page);
  }
  function leadBriefing(): Promise<string>;
  function leadBriefing(page: BriefingPageOptions): Promise<JsonValue>;
  function leadBriefing(page?: BriefingPageOptions): Promise<JsonValue> {
    return briefing(undefined, page);
  }
  function memberBriefing(settings: MemberBriefingSettings): Promise<string>;
  function memberBriefing(settings: MemberBriefingSettings, page: BriefingPageOptions): Promise<JsonValue>;
  async function memberBriefing(settings: MemberBriefingSettings, page?: BriefingPageOptions): Promise<JsonValue> {
    const capturedPage = page === undefined ? undefined : { ...page };
    const includeActiveProcesses = settings.includeActiveProcesses;
    const pending = options.fenced(() => {
      const original = identity();
      const memberName = original.grant.memberName;
      if (!original.members.some((member) => member.name === memberName))
        throw new TeamOwnerError("forbidden");
      return {
        fingerprint: original.fingerprint, memberName,
        value: options.reads.memberBriefing!(memberName, { includeActiveProcesses }),
      };
    });
    const value = await pending.value;
    return options.fenced(() => {
      const current = identity();
      if (current.fingerprint !== pending.fingerprint)
        throw new TeamOwnerError("forbidden");
      return finishBriefing(value, capturedPage, {
        kind: "member", memberName: pending.memberName,
        includeActiveProcesses,
        authorityFingerprint: current.fingerprint,
      }, current.grant);
    });
  }
  return Object.freeze({
    getTeam: (cursor?: string) => read(() => options.getTeam(cursor)),
    getKanbanState: (settings?: { strict?: boolean }) => read(() => options.reads.getKanbanState(settings)),
    getReviewFlowSettings: () => read(() => options.reads.getReviewFlowSettings()),
    listReviewers: () => read(() => options.reads.listReviewers()),
    getTaskComment: (taskId: string, commentId: string, cursor?: string) =>
      read(() => {
        safeSegment(taskId);
        safeSegment(commentId);
        return pageOwnerTaskComment({
          ...options.commentPages, grant: identity().grant,
          value: options.reads.getTaskComment(taskId, commentId),
          ...(cursor === undefined ? {} : { cursor }),
        });
      }),
    listTaskInventory: (filters: TeamTaskInventoryFilters, cursor?: string) =>
      read(() => {
        const value = options.reads.listTaskInventory(filters);
        if (!Array.isArray(value)) throw new TeamOwnerError("hold");
        return pageOwnerReadDetail({
          ...options.commentPages, grant: identity().grant,
          inventoryFilters: filters, value: json(value),
          ...(cursor === undefined ? {} : { cursor }),
        });
      }),
    taskBriefing,
    leadBriefing,
    ...(options.reads.memberBriefing ? { memberBriefing } : {}),
  });
}
