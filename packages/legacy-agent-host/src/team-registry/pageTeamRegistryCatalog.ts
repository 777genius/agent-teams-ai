import { createHash } from 'node:crypto';
import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import { teamRegistryCursorSchema } from './contracts.js';

import type { TeamRegistryList, TeamRegistryPage } from './contracts.js';

const MAX_PAGE_BYTES = 768 * 1024;
const DOMAIN = 'team-registry-catalog-v1';

/** Original ordered records only; no snapshot cache or extra whole-catalog serialization. */
export function pageTeamRegistryCatalog(options: {
  catalog: TeamRegistryList;
  key: string;
  contextId: string;
  cursor?: string;
}): TeamRegistryList | TeamRegistryPage {
  const { catalog, key, contextId } = options;
  const total = catalog.teams.length + catalog.held.length;
  if (total > 256) throw new TeamOwnerError('hold');
  const sizes: number[] = [];
  const hash = createHash('sha256').update(DOMAIN).update('\0');
  let bytes = 0;
  const part = (value: string) => {
    hash.update(value);
    bytes += Buffer.byteLength(value);
  };
  part('{"teams":[');
  for (const [index, row] of catalog.teams.entries()) {
    if (index) part(',');
    const encoded = JSON.stringify(row);
    sizes.push(Buffer.byteLength(encoded));
    part(encoded);
  }
  part('],"held":[');
  for (const [index, row] of catalog.held.entries()) {
    if (index) part(',');
    const encoded = JSON.stringify(row);
    sizes.push(Buffer.byteLength(encoded));
    part(encoded);
  }
  part(']}');
  if (options.cursor === undefined && bytes <= MAX_PAGE_BYTES) return catalog;
  const revision = hash.digest('hex');
  const signature = (offset: number) =>
    digest({ protocol: DOMAIN, key, contextId, revision, offset });
  let offset = 0;
  if (options.cursor !== undefined) {
    if (!teamRegistryCursorSchema.safeParse(options.cursor).success)
      throw new TeamOwnerError('invalid');
    const [position, proof] = options.cursor.split('.');
    offset = Number(position);
    if (offset >= total || proof !== signature(offset)) throw new TeamOwnerError('hold');
  }
  const page: TeamRegistryPage = {
    kind: 'team-registry-page',
    teams: [],
    held: [],
    totalTeams: catalog.teams.length,
    totalHeld: catalog.held.length,
    revision,
    nextCursor: null,
  };
  bytes = Buffer.byteLength(JSON.stringify(page)) + 256;
  let end = offset;
  for (; end < total; end++) {
    const size = sizes[end]! + 1;
    if (bytes + size > MAX_PAGE_BYTES) break;
    if (end < catalog.teams.length) page.teams.push(catalog.teams[end]!);
    else page.held.push(catalog.held[end - catalog.teams.length]!);
    bytes += size;
  }
  if (end === offset) throw new TeamOwnerError('hold');
  page.nextCursor = end < total ? end + '.' + signature(end) : null;
  if (Buffer.byteLength(JSON.stringify(page)) > MAX_PAGE_BYTES) throw new TeamOwnerError('hold');
  return page;
}
