import type {
  MemberLogPreviewRequestOptions,
  MemberLogPreviewResponse,
  MemberLogStreamRequestOptions,
  MemberLogStreamResponse,
  MemberRuntimeLogTailOptions,
  MemberRuntimeLogTailResponse,
} from './dto';

export interface MemberLogStreamApi {
  getMemberLogStream(
    teamName: string,
    memberName: string,
    options?: MemberLogStreamRequestOptions
  ): Promise<MemberLogStreamResponse>;
  getMemberLogPreviews(
    teamName: string,
    memberNames: string[],
    options?: MemberLogPreviewRequestOptions
  ): Promise<MemberLogPreviewResponse>;
  getMemberRuntimeLogTail(
    teamName: string,
    memberName: string,
    options: MemberRuntimeLogTailOptions
  ): Promise<MemberRuntimeLogTailResponse>;
  setMemberLogStreamTracking(teamName: string, enabled: boolean): Promise<void>;
}
