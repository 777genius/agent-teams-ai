import type {
  MemberLogPreviewRequestOptions,
  MemberLogPreviewResponse,
  MemberLogStreamRequestOptions,
  MemberLogStreamResponse,
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
  setMemberLogStreamTracking(teamName: string, enabled: boolean): Promise<void>;
}
