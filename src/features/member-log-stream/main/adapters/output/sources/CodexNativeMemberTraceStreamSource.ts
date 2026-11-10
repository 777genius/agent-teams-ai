import type {
  MemberLogStreamSource,
  MemberLogStreamSourceInput,
  MemberLogStreamSourceResult,
} from '../../../../core/application/ports/MemberLogStreamSource';
import type { TeamConfigReader } from '@main/services/team/TeamConfigReader';

export class CodexNativeMemberTraceStreamSource implements MemberLogStreamSource {
  readonly provider = 'codex_native_trace' as const;

  constructor(private readonly configReader: TeamConfigReader) {}

  async load(input: MemberLogStreamSourceInput): Promise<MemberLogStreamSourceResult> {
    const config = await this.configReader.getConfig(input.teamName).catch(() => null);
    const member = config?.members?.find(
      (item) => item.name.trim().toLowerCase() === input.memberName.trim().toLowerCase()
    );
    const isCodexMember =
      member?.providerId === 'codex' || member?.providerBackendId === 'codex-native';

    return {
      provider: this.provider,
      status: 'skipped',
      reason: 'codex_member_wide_not_supported',
      participants: [],
      segments: [],
      warnings: isCodexMember
        ? [
            {
              code: 'codex_member_wide_not_supported',
              message: 'Codex member-wide native trace is not available in this variant yet.',
            },
          ]
        : [],
    };
  }
}
