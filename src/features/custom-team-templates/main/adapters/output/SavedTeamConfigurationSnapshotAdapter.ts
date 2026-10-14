import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

import {
  isReadableTeamConfigPayload,
  MAX_CONFIG_READ_BYTES,
} from '@main/services/team/TeamConfigReader';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import { MAX_TEAM_METADATA_BYTES } from '@main/services/team/TeamMetadataSerialization';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { getTeamsBasePath } from '@main/utils/pathDecoder';

import type {
  CustomTeamTemplateSnapshotReader,
  CustomTeamTemplateSnapshotReadOutcome,
} from '../../../core/application/ports';
import type {
  CustomTemplateSourceTeamSnapshot,
  RosterMetadataMember,
  RosterMetadataReadResult,
} from '../../../core/domain/templateSourceSnapshot';
import type { TeamMetaFile } from '@main/services/team/TeamMetaStore';
import type { TeamMember } from '@shared/types';

const CONFIG_FILENAME = 'config.json';
const TEAM_META_FILENAME = 'team.meta.json';
const MEMBERS_META_FILENAME = 'members.meta.json';

/**
 * Result of probing one authoritative file.
 *
 * `absent` and `unreadable` must stay distinct: "no roster metadata was ever
 * recorded" allows a prompt-only template, while "metadata exists but cannot be
 * read" blocks saving. A file that changes size while being read is reported as
 * unreadable so a torn read is never mistaken for a consistent one.
 */
type AuthoritativeFileProbe =
  | { status: 'absent' }
  | { status: 'file'; content: string }
  | { status: 'unreadable' };

interface TeamDirectoryProbe {
  config: AuthoritativeFileProbe;
  teamMeta: AuthoritativeFileProbe;
  members: AuthoritativeFileProbe;
  /** Digest of the directory identity and every authoritative file's presence and bytes. */
  revision: string;
}

/**
 * Reads the authoritative saved configuration of a source team.
 *
 * The adapter is intentionally narrow: it reads `config.json`,
 * `team.meta.json` and `members.meta.json` through the existing stores, and it
 * never touches tasks, messages, sessions, transcripts, agent processes or
 * runtime history. Team-level instructions come from `team.meta.json` only —
 * the saved launch request the configuration-management path also treats as
 * authoritative — so a team created outside the app reports a missing prompt
 * instead of an inferred one.
 *
 * The team name is validated with the project's existing identifier rules
 * before any path is built, and every failure mode is reported as a typed
 * outcome instead of an exception: the caller must never crash because a team
 * directory became unreadable, and must never receive fabricated content.
 *
 * Consistency is verified in the same narrow before/after pattern the
 * configuration-management path uses: the same three files are digested before
 * and after the store reads, and a change in between rejects the snapshot
 * rather than returning a mixed one. That mechanism is reimplemented here
 * because the existing one is private to that feature and throws its own
 * transport error types.
 *
 * A team whose `team.meta.json` carries `deletedAt` is reported as an
 * unavailable source: a trashed team's saved configuration is not a template
 * source under the conservative A1 default.
 */
export class SavedTeamConfigurationSnapshotAdapter implements CustomTeamTemplateSnapshotReader {
  private readonly metaStore = new TeamMetaStore();
  private readonly membersStore = new TeamMembersMetaStore();

  async readSnapshot(sourceTeamName: string): Promise<CustomTeamTemplateSnapshotReadOutcome> {
    const identity = validateTeamName(sourceTeamName);
    if (!identity.valid || !identity.value) {
      return { status: 'sourceUnavailable', sourceTeamName };
    }
    const teamName = identity.value;
    const directory = join(getTeamsBasePath(), teamName);

    const before = await this.probeTeamDirectory(teamName, directory);
    if (!before) {
      return { status: 'sourceUnavailable', sourceTeamName: teamName };
    }

    const snapshot = await this.buildSnapshot(teamName, before);
    const after = await this.probeTeamDirectory(teamName, directory);
    if (after?.revision !== before.revision) {
      return { status: 'configurationChanged', sourceTeamName: teamName };
    }
    if (!snapshot) {
      return { status: 'sourceUnavailable', sourceTeamName: teamName };
    }
    return { status: 'available', snapshot, revision: after.revision };
  }

  private async buildSnapshot(
    teamName: string,
    probe: TeamDirectoryProbe
  ): Promise<CustomTemplateSourceTeamSnapshot | null> {
    if (probe.config.status === 'unreadable') {
      return null;
    }
    if (probe.config.status === 'file' && !isReadableConfigPayload(probe.config.content)) {
      return null;
    }

    if (probe.teamMeta.status === 'unreadable') {
      return null;
    }
    const teamMeta = await this.readTeamMeta(teamName);
    if (probe.teamMeta.status === 'file' && !teamMeta) {
      return null;
    }

    // A trashed team keeps its saved configuration on disk, so it must be
    // refused explicitly instead of being projected like a live team. A1 has no
    // policy for templating a deleted team, so the conservative default is to
    // report the source as unavailable.
    if (teamMeta?.deletedAt) {
      return null;
    }

    // Neither file readable means there is no authoritative saved
    // configuration to project from.
    if (probe.config.status !== 'file' && !teamMeta) {
      return null;
    }

    const teamPrompt = teamMeta?.prompt;
    return {
      sourceTeamName: teamName,
      ...(teamPrompt ? { teamPrompt } : {}),
      roster: await this.readRoster(teamName, probe.members),
    };
  }

  private async readTeamMeta(teamName: string): Promise<TeamMetaFile | null> {
    try {
      return await this.metaStore.getMeta(teamName, undefined, { requireCompleteFields: true });
    } catch {
      // Presence was already established by the probe, so an unreadable file is
      // reported as an unavailable source rather than as a missing one.
      return null;
    }
  }

  /**
   * Reads roster metadata with the strict replacement reader.
   *
   * The strict read rejects anything it cannot fully validate, including
   * malformed entries that a lenient read would silently drop, which is what
   * keeps a partially damaged roster from becoming a prompt-only template.
   */
  private async readRoster(
    teamName: string,
    membersProbe: AuthoritativeFileProbe
  ): Promise<RosterMetadataReadResult> {
    if (membersProbe.status === 'absent') {
      return { status: 'absent' };
    }
    if (membersProbe.status === 'unreadable') {
      return { status: 'unreadable' };
    }

    let meta: Awaited<ReturnType<TeamMembersMetaStore['getMeta']>>;
    try {
      meta = await this.membersStore.getMeta(teamName, {
        requireCompleteMembers: true,
        // A generated CLI auto-suffix duplicate (alice-2 above an active
        // alice) is a known artifact the template projection removes, so it
        // must not make the whole roster unreadable. Real corruption and
        // missing required fields still fail the strict read.
        allowCliAutoSuffixArtifacts: true,
      });
    } catch {
      return { status: 'unreadable' };
    }
    if (!meta) {
      return { status: 'unreadable' };
    }
    return { status: 'readable', members: meta.members.map(toRosterMetadataMember) };
  }

  /**
   * Digests the directory identity plus each authoritative file, and returns
   * the bounded file contents for the same read.
   *
   * A missing or non-local team directory is reported as `null`; any other
   * filesystem failure is reported as an unreadable file inside the probe, so
   * the caller fails closed instead of throwing.
   */
  private async probeTeamDirectory(
    teamName: string,
    directory: string
  ): Promise<TeamDirectoryProbe | null> {
    let identity;
    try {
      identity = await lstat(directory);
    } catch {
      return null;
    }
    if (!identity.isDirectory() || identity.isSymbolicLink()) {
      return null;
    }

    const [config, teamMeta, members] = await Promise.all([
      probeAuthoritativeFile(directory, CONFIG_FILENAME, MAX_CONFIG_READ_BYTES),
      probeAuthoritativeFile(directory, TEAM_META_FILENAME, MAX_TEAM_METADATA_BYTES),
      probeAuthoritativeFile(directory, MEMBERS_META_FILENAME, MAX_TEAM_METADATA_BYTES),
    ]);

    const hash = createHash('sha256').update(
      JSON.stringify({ teamName, directory: [identity.dev, identity.ino, identity.birthtimeMs] })
    );
    for (const probe of [config, teamMeta, members]) {
      hash.update(
        probe.status === 'file'
          ? `+${Buffer.byteLength(probe.content, 'utf8')}:`
          : `${probe.status}:`
      );
      if (probe.status === 'file') {
        hash.update(probe.content);
      }
    }

    return { config, teamMeta, members, revision: hash.digest('hex') };
  }
}

/** Only the contract version and safety rules defined by the app count as readable. */
function isReadableConfigPayload(content: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  return isReadableTeamConfigPayload(parsed);
}

/**
 * Reads one authoritative file through a single handle, so the initial size
 * check and the bytes actually read describe the same file.
 */
async function probeAuthoritativeFile(
  directory: string,
  name: string,
  limit: number
): Promise<AuthoritativeFileProbe> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const filePath = join(directory, name);
    const preflight = await lstat(filePath);
    if (!preflight.isFile() || preflight.size > limit) {
      return { status: 'unreadable' };
    }

    handle = await open(filePath, 'r');
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) {
      return { status: 'unreadable' };
    }
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      length > limit ||
      after.size > limit ||
      length !== before.size ||
      after.size !== before.size
    ) {
      return { status: 'unreadable' };
    }
    return { status: 'file', content: bytes.subarray(0, length).toString('utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'absent' };
    }
    return { status: 'unreadable' };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Projects one authoritative roster member onto the narrow template input.
 *
 * Only fields the projection may consume are forwarded. `removedAt` becomes the
 * explicit `removed` tombstone marker the projection counts, and `agentType`
 * and `role` travel through because the canonical lead exclusion rule needs
 * them.
 */
function toRosterMetadataMember(member: TeamMember): RosterMetadataMember {
  return {
    name: member.name,
    ...(member.role ? { role: member.role } : {}),
    ...(member.workflow ? { workflow: member.workflow } : {}),
    ...(member.agentType ? { agentType: member.agentType } : {}),
    ...(typeof member.removedAt === 'number' ? { removed: true } : {}),
  };
}
