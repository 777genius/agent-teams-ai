import { addMainBreadcrumb } from '@main/sentry';

import type { TeamRuntimeEffectsPort } from '../../../core/application/ports/TeamRuntimeOperationPorts';

export class MainTeamRuntimeEffects implements TeamRuntimeEffectsPort {
  addStopBreadcrumb(teamName: string): void {
    addMainBreadcrumb('team', 'stop', { teamName });
  }
}
