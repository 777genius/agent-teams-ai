import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TeamConfigReader } from '../../../../src/main/services/team/TeamConfigReader';
import { TeamMemberLogsFinder } from '../../../../src/main/services/team/TeamMemberLogsFinder';
import { TeamMemberRuntimeAdvisoryService } from '../../../../src/main/services/team/TeamMemberRuntimeAdvisoryService';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

const LIVE_TEAM = process.env.LIVE_RUNTIME_ADVISORY_TEAM?.trim();
const LIVE_CLAUDE_BASE = process.env.LIVE_RUNTIME_ADVISORY_CLAUDE_BASE?.trim();

const describeLive = LIVE_TEAM && LIVE_CLAUDE_BASE ? describe : describe.skip;

describeLive('TeamMemberRuntimeAdvisoryService live logs smoke', () => {
  beforeAll(() => {
    setClaudeBasePathOverride(LIVE_CLAUDE_BASE);
  });

  afterAll(() => {
    setClaudeBasePathOverride(null);
  });

  it('matches legacy member log attribution on real team logs', async () => {
    const config = await new TeamConfigReader().getConfig(LIVE_TEAM!);
    const memberNames = (config?.members ?? [])
      .filter((member) => member.name && member.name !== 'user' && !member.removedAt)
      .map((member) => member.name);

    expect(memberNames.length).toBeGreaterThan(0);

    const finder = new TeamMemberLogsFinder();
    const batchRefs = await finder.findRecentMemberLogFileRefsByMember(
      LIVE_TEAM!,
      memberNames,
      null
    );
    const batchFilesByMember = new Map<string, Set<string>>();
    for (const ref of batchRefs) {
      const files = batchFilesByMember.get(ref.memberName) ?? new Set<string>();
      files.add(ref.filePath);
      batchFilesByMember.set(ref.memberName, files);
    }

    for (const memberName of memberNames) {
      const legacyFiles = new Set(
        (await finder.findMemberLogs(LIVE_TEAM!, memberName, null))
          .map((summary) => summary.filePath)
          .filter(Boolean)
      );
      const batchFiles = batchFilesByMember.get(memberName) ?? new Set<string>();

      expect([...legacyFiles].sort()).toEqual([...batchFiles].sort());
    }
  }, 120_000);

  it('loads runtime advisories through the batch path without failing on real team logs', async () => {
    const config = await new TeamConfigReader().getConfig(LIVE_TEAM!);
    const members = (config?.members ?? [])
      .filter((member) => member.name && member.name !== 'user' && !member.removedAt)
      .map((member) => ({ name: member.name, removedAt: member.removedAt }));

    const advisories = await new TeamMemberRuntimeAdvisoryService(
      new TeamMemberLogsFinder()
    ).getMemberAdvisories(LIVE_TEAM!, members);

    expect(advisories).toBeInstanceOf(Map);
    if ('mockClear' in console.warn) {
      vi.mocked(console.warn).mockClear();
    }
  }, 60_000);
});
