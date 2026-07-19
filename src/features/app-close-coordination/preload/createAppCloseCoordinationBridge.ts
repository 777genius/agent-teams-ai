import {
  APP_CLOSE_READINESS_REQUEST,
  APP_CLOSE_READINESS_RESPONSE,
  type AppCloseCoordinationElectronApi,
  type AppCloseReadinessHandler,
  type AppCloseReadinessRequest,
} from '../contracts';

import type { IpcRenderer, IpcRendererEvent } from 'electron';

const normalizeBlockers = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 10);
};

export function createAppCloseCoordinationBridge(
  ipcRenderer: IpcRenderer
): AppCloseCoordinationElectronApi {
  let readinessHandler: AppCloseReadinessHandler | null = null;

  ipcRenderer.on(
    APP_CLOSE_READINESS_REQUEST,
    (_event: IpcRendererEvent, request: AppCloseReadinessRequest) => {
      void (async () => {
        let ok = true;
        let blockers: string[] = [];
        try {
          if (readinessHandler) {
            const result = await readinessHandler(request);
            ok = result.ok === true;
            blockers = normalizeBlockers(result.blockers);
          }
        } catch (error) {
          ok = false;
          blockers = [error instanceof Error ? error.message : String(error)];
        }
        ipcRenderer.send(APP_CLOSE_READINESS_RESPONSE, {
          requestId: request.requestId,
          ok,
          blockers,
        });
      })();
    }
  );

  return {
    onReadinessRequest: (handler) => {
      readinessHandler = handler;
      return (): void => {
        if (readinessHandler === handler) readinessHandler = null;
      };
    },
  };
}
