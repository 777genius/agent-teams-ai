import type {
  MemberLogPreviewSource,
  MemberLogPreviewSourceInput,
  MemberLogPreviewSourceResult,
} from '../../../../core/application/ports/MemberLogPreviewSource';
import type { TeamConfigReader } from '@main/services/team/TeamConfigReader';

export class CodexNativeMemberTracePreviewSource implements MemberLogPreviewSource {
  readonly provider = 'codex_native_trace' as const;

  constructor(private readonly configReader: TeamConfigReader) {}

  async loadPreview(input: MemberLogPreviewSourceInput): Promise<MemberLogPreviewSourceResult> {
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
      items: [],
      warnings: isCodexMember
        ? [
            {
              code: 'codex_member_wide_not_supported',
              message: 'Codex member-wide native trace is not available in this variant yet.',
            },
          ]
        : [],
      truncated: false,
      overflowCount: 0,
    };
  }
}
