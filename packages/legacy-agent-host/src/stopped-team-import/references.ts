import { digest } from '../team/identity.js';
import { TeamOwnerError } from '../team/contracts.js';
import type { StoppedTeamSnapshot } from './contracts.js';

type Reference = StoppedTeamSnapshot['references'][number];
const alphabet = ['\u200b', '\u200c', '\u200d', '\u2060'];
/** Import context qualifies original references; body bytes are not rewritten or name-resolved. */
export function collectImportReferences(
  value: unknown,
  sourceTeam: string,
  tasks: ReadonlySet<string>
): Reference[] {
  const found = new Map<string, Reference>();
  const add = (taskId: unknown, displayId: unknown, teamName: unknown) => {
    if (
      typeof taskId !== 'string' ||
      !taskId ||
      taskId.length > 256 ||
      typeof displayId !== 'string' ||
      !displayId ||
      displayId.length > 256 ||
      typeof teamName !== 'string' ||
      !teamName ||
      teamName.length > 256
    )
      throw new TeamOwnerError('hold');
    const reference: Reference = {
      taskId,
      displayId,
      teamName,
      target:
        teamName === sourceTeam && tasks.has(taskId)
          ? 'internal'
          : teamName === sourceTeam
            ? 'unresolved'
            : 'source-archive',
    };
    found.set(JSON.stringify([taskId, displayId, teamName]), reference);
    if (found.size > 16384) throw new TeamOwnerError('hold');
  };
  const string = (text: string) => {
    for (const match of text.matchAll(/\u2063([^\u2064]*)\u2064/gu)) {
      const encoded = match[1]!;
      if (encoded.length % 4 || encoded.length > 16384) throw new TeamOwnerError('hold');
      const bytes = new Uint8Array(encoded.length / 4);
      for (let offset = 0; offset < encoded.length; offset += 4) {
        const parts = [...encoded.slice(offset, offset + 4)].map((char) => alphabet.indexOf(char));
        if (parts.some((part) => part < 0)) throw new TeamOwnerError('hold');
        bytes[offset / 4] = (parts[0]! << 6) | (parts[1]! << 4) | (parts[2]! << 2) | parts[3]!;
      }
      let ref: Record<string, unknown>;
      try {
        ref = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<
          string,
          unknown
        >;
      } catch {
        throw new TeamOwnerError('hold');
      }
      add(ref.taskId, ref.displayId, ref.teamName);
    }
    if (
      text.includes('\u2063') &&
      [...text.matchAll(/\u2063/gu)].length !==
        [...text.matchAll(/\u2063[^\u2064]*\u2064/gu)].length
    )
      throw new TeamOwnerError('hold');
    for (const match of text.matchAll(/task:\/\/([^\s)\]<>"']+)/gu)) {
      const raw = match[1]!,
        [path, query] = raw.split('?', 2),
        params = new URLSearchParams(query);
      let taskId: string;
      try {
        taskId = decodeURIComponent(path!);
      } catch {
        throw new TeamOwnerError('hold');
      }
      const teamName = params.get('team') ?? sourceTeam;
      add(taskId, params.get('display') ?? taskId, teamName);
    }
  };
  const visit = (item: unknown, depth = 0): void => {
    if (depth > 64) throw new TeamOwnerError('hold');
    if (typeof item === 'string') string(item);
    else if (Array.isArray(item)) item.forEach((child) => visit(child, depth + 1));
    else if (item && typeof item === 'object') {
      const row = item as Record<string, unknown>;
      if ('taskId' in row && 'teamName' in row && 'displayId' in row)
        add(row.taskId, row.displayId, row.teamName);
      Object.values(row).forEach((child) => visit(child, depth + 1));
    }
  };
  visit(value);
  return [...found.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** Opaque source identity cannot collide with the live Team-name vocabulary. */
export function importedReferenceTeam(
  snapshot: Pick<StoppedTeamSnapshot, 'header' | 'digest'>,
  ref: Reference,
  destination: string
): string {
  if (ref.target === 'internal') return destination;
  return `legacy-${ref.target === 'unresolved' ? 'gap' : 'archive'}:${digest({ sourceOwnerId: snapshot.header.sourceOwnerId, sourceId: snapshot.header.sourceId, snapshotDigest: snapshot.digest, teamName: ref.teamName, taskId: ref.taskId })}`;
}
function decodeReference(encoded: string): Record<string, unknown> {
  const bytes = Buffer.alloc(encoded.length / 4);
  for (let offset = 0; offset < encoded.length; offset += 4) {
    const bits = [...encoded.slice(offset, offset + 4)].map((part) => alphabet.indexOf(part));
    if (bits.some((part) => part < 0)) throw new TeamOwnerError('hold');
    bytes[offset / 4] = (bits[0]! << 6) | (bits[1]! << 4) | (bits[2]! << 2) | bits[3]!;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<
    string,
    unknown
  >;
}
function encodeReference(value: unknown): string {
  return [...Buffer.from(JSON.stringify(value))]
    .map((byte) => [6, 4, 2, 0].map((shift) => alphabet[(byte >> shift) & 3]).join(''))
    .join('');
}
/** Only the already-censused exact resource map may change an imported reference. */
export function qualifyImportReferences(
  value: unknown,
  snapshot: StoppedTeamSnapshot,
  destination: string
): unknown {
  const target = (taskId: unknown, displayId: unknown, teamName: unknown) => {
    const ref = snapshot.references.find(
      (entry) =>
        entry.taskId === taskId && entry.displayId === displayId && entry.teamName === teamName
    );
    if (!ref) throw new TeamOwnerError('hold');
    return importedReferenceTeam(snapshot, ref, destination);
  };
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') {
      let text = item.replace(/\u2063([^\u2064]*)\u2064/gu, (_all, encoded: string) => {
        const ref = decodeReference(encoded);
        return `\u2063${encodeReference({ ...ref, teamName: target(ref.taskId, ref.displayId, ref.teamName) })}\u2064`;
      });
      text = text.replace(/task:\/\/([^\s)\]<>"']+)/gu, (_all, raw: string) => {
        const [path, query] = raw.split('?', 2),
          params = new URLSearchParams(query),
          taskId = decodeURIComponent(path!);
        params.set(
          'team',
          target(
            taskId,
            params.get('display') ?? taskId,
            params.get('team') ?? snapshot.header.sourceTeamName
          )
        );
        return `task://${path}?${params.toString()}`;
      });
      return text;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== 'object') return item;
    const row = item as Record<string, unknown>;
    const result = Object.fromEntries(
      Object.entries(row).map(([key, child]) => [key, visit(child)])
    );
    if ('taskId' in row && 'displayId' in row && 'teamName' in row)
      result.teamName = target(row.taskId, row.displayId, row.teamName);
    return result;
  };
  return visit(value);
}
