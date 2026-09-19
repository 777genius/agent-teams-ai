// Must execute after path migration, before Sentry and eager ConfigManager.
import './bootstrapUserDataMigration';

import { app } from 'electron';

import { getClaudeBasePath } from './utils/pathDecoder';
import { probeAnnouncementsProfile } from './announcementsProfileProbe';

export const earlyAnnouncementsProfile = probeAnnouncementsProfile(
  app.getPath('userData'),
  getClaudeBasePath()
);
