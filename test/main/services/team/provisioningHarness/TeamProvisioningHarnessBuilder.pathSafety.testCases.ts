/* eslint-disable security/detect-non-literal-fs-filename -- Test paths are owned by the harness temp workspace. */
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  charLabel,
  listTempWorkspaceNames,
  pathExists,
  RESERVED_FILENAME_CHARS_WITHOUT_SEPARATORS,
  track,
} from './builderTestContext';
import { memberFixture, teamConfigFixture, TeamProvisioningHarnessBuilder } from './index';

import type { TeamConfig } from '@shared/types';

describe('TeamProvisioningHarnessBuilder path safety', () => {
  it('rejects traversal team names before creating temp dirs or writing escaped files', async () => {
    const prefix = 'team-provisioning-harness-invalid-team-path-test-';
    const outsideDir = path.join(
      os.tmpdir(),
      `team-provisioning-harness-team-escape-${process.pid}`
    );
    await rm(outsideDir, { recursive: true, force: true });
    const beforeEntries = await listTempWorkspaceNames(prefix);
    const traversalTeamName = path.join('..', '..', '..', path.basename(outsideDir));

    await expect(
      TeamProvisioningHarnessBuilder.create()
        .withTempWorkspace({ prefix })
        .withTeam(traversalTeamName)
        .build()
    ).rejects.toThrow(/Invalid team name/);

    expect(await listTempWorkspaceNames(prefix)).toEqual(beforeEntries);
    expect(await pathExists(outsideDir)).toBe(false);
  });

  it('rejects team names that trim to traversal before creating temp dirs', async () => {
    const prefix = 'team-provisioning-harness-trimmed-team-path-test-';
    const beforeEntries = await listTempWorkspaceNames(prefix);

    await expect(
      TeamProvisioningHarnessBuilder.create().withTempWorkspace({ prefix }).withTeam(' .. ').build()
    ).rejects.toThrow(/Invalid team name/);

    expect(await listTempWorkspaceNames(prefix)).toEqual(beforeEntries);
  });

  it('rejects traversal sidecar team names before creating temp dirs or writing escaped files', async () => {
    const prefix = 'team-provisioning-harness-invalid-sidecar-team-path-test-';
    const outsideDir = path.join(
      os.tmpdir(),
      `team-provisioning-harness-sidecar-team-escape-${process.pid}`
    );
    await rm(outsideDir, { recursive: true, force: true });
    const beforeEntries = await listTempWorkspaceNames(prefix);
    const traversalTeamName = path.join('..', '..', '..', path.basename(outsideDir));

    await expect(
      TeamProvisioningHarnessBuilder.create()
        .withTempWorkspace({ prefix })
        .withLaunchState(traversalTeamName, { state: 'ready' })
        .build()
    ).rejects.toThrow(/Invalid team name/);

    expect(await listTempWorkspaceNames(prefix)).toEqual(beforeEntries);
    expect(await pathExists(outsideDir)).toBe(false);
  });

  it('rejects traversal inbox member names before creating temp dirs or writing escaped files', async () => {
    const prefix = 'team-provisioning-harness-invalid-member-path-test-';
    const teamName = 'invalid-member-path-team';
    const outsideDir = path.join(
      os.tmpdir(),
      `team-provisioning-harness-member-escape-${process.pid}`
    );
    await rm(outsideDir, { recursive: true, force: true });
    const beforeEntries = await listTempWorkspaceNames(prefix);
    const traversalMemberName = path.join('..', '..', '..', path.basename(outsideDir));

    await expect(
      TeamProvisioningHarnessBuilder.create()
        .withTempWorkspace({ prefix })
        .withTeam(
          teamName,
          teamConfigFixture.basic({
            teamName,
            members: [memberFixture.lead(), memberFixture.codex(traversalMemberName)],
          })
        )
        .build()
    ).rejects.toThrow(/Invalid member name/);

    expect(await listTempWorkspaceNames(prefix)).toEqual(beforeEntries);
    expect(await pathExists(outsideDir)).toBe(false);
  });

  it('rejects traversal inbox fixture member names before creating temp dirs', async () => {
    const prefix = 'team-provisioning-harness-invalid-inbox-fixture-path-test-';
    const teamName = 'invalid-inbox-fixture-team';
    const outsideDir = path.join(
      os.tmpdir(),
      `team-provisioning-harness-inbox-fixture-escape-${process.pid}`
    );
    await rm(outsideDir, { recursive: true, force: true });
    const beforeEntries = await listTempWorkspaceNames(prefix);
    const traversalMemberName = path.join('..', '..', '..', path.basename(outsideDir));

    await expect(
      TeamProvisioningHarnessBuilder.create()
        .withTempWorkspace({ prefix })
        .withInbox(teamName, traversalMemberName)
        .build()
    ).rejects.toThrow(/Invalid member name/);

    expect(await listTempWorkspaceNames(prefix)).toEqual(beforeEntries);
    expect(await pathExists(outsideDir)).toBe(false);
  });

  it('rejects member names that trim to traversal before temp dirs or fake stores are created', async () => {
    const prefix = 'team-provisioning-harness-trimmed-member-path-test-';
    const teamName = 'trimmed-member-path-team';
    const beforeEntries = await listTempWorkspaceNames(prefix);

    await expect(
      TeamProvisioningHarnessBuilder.create()
        .withTempWorkspace({ prefix })
        .withTeam(
          teamName,
          teamConfigFixture.basic({
            teamName,
            members: [memberFixture.lead(), memberFixture.codex(' .. ')],
          })
        )
        .build()
    ).rejects.toThrow(/Invalid member name/);

    expect(await listTempWorkspaceNames(prefix)).toEqual(beforeEntries);
  });

  it('rejects fake member store writes that normalize to traversal names', async () => {
    const harness = await track(TeamProvisioningHarnessBuilder.create().build());

    await expect(
      harness.stores.membersMetaStore.writeMembers('trimmed-store-team', [
        memberFixture.codex(' .. '),
      ])
    ).rejects.toThrow(/Invalid member name/);

    await expect(harness.stores.membersMetaStore.getMeta('trimmed-store-team')).resolves.toBeNull();
  });

  it('rejects traversal member names in inbox paths before writing escaped files', async () => {
    const harness = await track(TeamProvisioningHarnessBuilder.create().build());
    const outsideFileName = `team-provisioning-harness-inbox-escape-${process.pid}`;
    const outsideFile = path.join(os.tmpdir(), `${outsideFileName}.json`);
    await rm(outsideFile, { force: true });
    const traversalMemberName = path.join('..', '..', '..', '..', '..', outsideFileName);

    await expect(
      (async () => {
        const inboxPath = harness.paths.inboxPath(harness.teamName, traversalMemberName);
        await writeFile(inboxPath, '{}\n', 'utf8');
      })()
    ).rejects.toThrow(/Invalid member name/);

    expect(await pathExists(outsideFile)).toBe(false);
  });

  it('rejects traversal team names passed through the config facade before deleting files', async () => {
    const harness = await track(TeamProvisioningHarnessBuilder.create().build());
    const outsideDir = path.join(
      os.tmpdir(),
      `team-provisioning-harness-facade-escape-${process.pid}`
    );
    const outsideBackup = path.join(outsideDir, 'config.json.prelaunch.bak');
    const sentinel = 'outside the harness workspace';
    await rm(outsideDir, { recursive: true, force: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(outsideBackup, sentinel, 'utf8');

    try {
      const traversalTeamName = path.relative(harness.paths.teamsBase, outsideDir);

      await expect(
        harness.facades.configFacade.cleanupPrelaunchBackup(traversalTeamName)
      ).rejects.toThrow(/Invalid team name/);
      await expect(readFile(outsideBackup, 'utf8')).resolves.toBe(sentinel);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('validates caller fixtures before creating temp dirs or applying path overrides', async () => {
    const prefix = 'team-provisioning-harness-invalid-fixture-test-';
    const teamName = 'invalid-fixture-team';
    const beforeEntries = await listTempWorkspaceNames(prefix);
    const invalidConfig = {
      ...teamConfigFixture.basic({ teamName }),
      apiKey: 'fixture',
    } as unknown as TeamConfig;

    await expect(
      TeamProvisioningHarnessBuilder.create()
        .withTempWorkspace({ prefix })
        .withTeam(teamName, invalidConfig)
        .build()
    ).rejects.toThrow(/Secret-like fixture values/);

    expect(await listTempWorkspaceNames(prefix)).toEqual(beforeEntries);
  });

  it.each(RESERVED_FILENAME_CHARS_WITHOUT_SEPARATORS)(
    'rejects team names containing reserved filename char %s before side effects',
    async (reservedChar) => {
      const prefix = `team-provisioning-harness-reserved-team-${charLabel(reservedChar)}-`;
      const beforeEntries = await listTempWorkspaceNames(prefix);
      const teamName = `bad${reservedChar}team`;

      await expect(
        TeamProvisioningHarnessBuilder.create()
          .withTempWorkspace({ prefix })
          .withTeam(teamName)
          .build()
      ).rejects.toThrow(/Invalid team name/);

      expect(await listTempWorkspaceNames(prefix)).toEqual(beforeEntries);
    }
  );

  it.each(RESERVED_FILENAME_CHARS_WITHOUT_SEPARATORS)(
    'rejects member names containing reserved filename char %s before side effects',
    async (reservedChar) => {
      const prefix = `team-provisioning-harness-reserved-member-${charLabel(reservedChar)}-`;
      const teamName = `reserved-member-team-${charLabel(reservedChar)}`;
      const beforeEntries = await listTempWorkspaceNames(prefix);

      await expect(
        TeamProvisioningHarnessBuilder.create()
          .withTempWorkspace({ prefix })
          .withTeam(
            teamName,
            teamConfigFixture.basic({
              teamName,
              members: [memberFixture.lead(), memberFixture.codex(`bad${reservedChar}member`)],
            })
          )
          .build()
      ).rejects.toThrow(/Invalid member name/);

      expect(await listTempWorkspaceNames(prefix)).toEqual(beforeEntries);
    }
  );

  it.each(RESERVED_FILENAME_CHARS_WITHOUT_SEPARATORS)(
    'rejects reserved filename char %s in member inbox paths before writing files',
    async (reservedChar) => {
      const harness = await track(TeamProvisioningHarnessBuilder.create().build());
      const memberName = `bad${reservedChar}member`;
      const literalInboxPath = path.join(
        harness.paths.teamDir(harness.teamName),
        'inboxes',
        `${memberName}.json`
      );

      await expect(
        (async () => {
          const inboxPath = harness.paths.inboxPath(harness.teamName, memberName);
          await writeFile(inboxPath, '{}\n', 'utf8');
        })()
      ).rejects.toThrow(/Invalid member name/);

      expect(await pathExists(literalInboxPath)).toBe(false);
    }
  );
});
