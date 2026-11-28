import { join } from 'node:path';

import {
  createPrMonitorFeature,
  isTrustedRenderer,
  registerPrMonitorIpc,
} from '@features/pr-monitor/main';
import { ApiKeyService } from '@main/services/extensions/apikeys/ApiKeyService';
import { ipcMain } from 'electron';

import type { ServiceContext } from '@main/services';

export function startPrMonitorFeature(
  getContext: () => ServiceContext,
  senderId: () => number | undefined,
  rendererUrl: () => string | undefined,
  dataPath: string
) {
  const feature = createPrMonitorFeature(getContext, {
    vault: new ApiKeyService(join(dataPath, 'pr-monitor-credentials'), {
      requireSecureBackend: true,
    }),
  });
  const remove = registerPrMonitorIpc(ipcMain, feature, senderId, (actual) =>
    isTrustedRenderer(actual, rendererUrl())
  );
  return {
    ...feature,
    dispose: () => {
      remove();
      feature.dispose();
    },
  };
}
