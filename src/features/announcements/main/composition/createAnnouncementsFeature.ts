import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

import { createLogger } from '@shared/utils/logger';

import {
  ANNOUNCEMENTS_FEED_PATH,
  ANNOUNCEMENTS_ORIGIN,
  type AnnouncementState,
} from '../../contracts';
import { AnnouncementsService } from '../application/AnnouncementsService';
import { AnnouncementWriterOwner } from '../infrastructure/AnnouncementWriterOwner';
import { HttpAnnouncementSource } from '../infrastructure/HttpAnnouncementSource';
import { JsonAnnouncementRepository } from '../infrastructure/JsonAnnouncementRepository';

import type { AnnouncementClock, AnnouncementSource } from '../../core/application/ports';

export interface CreateAnnouncementsOptions {
  userDataPath: string;
  origin: AnnouncementState['origin'];
  production: boolean;
  isolatedProfile: boolean;
  sourceUrl?: string;
  firstOpenedAt?: string;
  clock?: AnnouncementClock;
}
export type AnnouncementsFeature = AnnouncementsService;
export type { AnnouncementWindowContext } from '../../core/application/ports';

export function createAnnouncementsFeature(
  options: CreateAnnouncementsOptions
): AnnouncementsFeature {
  const directory = path.join(options.userDataPath, 'data', 'announcements');
  let url = `${ANNOUNCEMENTS_ORIGIN}${ANNOUNCEMENTS_FEED_PATH}`;
  if (options.sourceUrl) {
    const parsed = new URL(options.sourceUrl);
    if (
      options.production ||
      !options.isolatedProfile ||
      parsed.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]'].includes(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== ANNOUNCEMENTS_FEED_PATH
    )
      throw new Error('Invalid announcements development source');
    url = parsed.href;
  }
  const networkEnabled = options.production || Boolean(options.sourceUrl);
  const source: AnnouncementSource = networkEnabled
    ? new HttpAnnouncementSource(url, path.join(directory, 'cache'))
    : {
        loadCached: async () => undefined,
        drain: async () => undefined,
        current: () => ({
          schemaVersion: 1,
          revision: '0'.repeat(64),
          autoShowEnabled: false,
          items: [],
        }),
        refresh: async () => ({
          schemaVersion: 1,
          revision: '0'.repeat(64),
          autoShowEnabled: false,
          items: [],
        }),
        body: async () => {
          throw new Error('unavailable');
        },
      };
  return new AnnouncementsService({
    repository: new JsonAnnouncementRepository(directory),
    owner: new AnnouncementWriterOwner(directory),
    source,
    clock: options.clock ?? { now: Date.now, monotonic: () => performance.now() },
    origin: options.origin,
    firstOpenedAt: options.firstOpenedAt,
    networkEnabled,
    diagnostic: (reason) =>
      createLogger('Feature:Announcements').warn('State transition', { reason }),
  });
}
