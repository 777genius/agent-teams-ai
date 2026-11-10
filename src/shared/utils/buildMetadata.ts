// eslint-disable-next-line @typescript-eslint/naming-convention -- Vite `define` injects this global
declare const __APP_VERSION__: string;
// eslint-disable-next-line @typescript-eslint/naming-convention -- Vite `define` injects this global
declare const __BUILD_GIT_SHA__: string;
// eslint-disable-next-line @typescript-eslint/naming-convention -- Vite `define` injects this global
declare const __BUILD_ID__: string;
// eslint-disable-next-line @typescript-eslint/naming-convention -- Vite `define` injects this global
declare const __RELEASE_CHANNEL__: string;

export const APP_NAME = 'agent-teams-ai';
export const APP_NAMESPACE = 'com.agent-teams.app';
export const APP_REPOSITORY = '777genius/agent-teams-ai';
export const APP_VERSION =
  typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : '0.0.0';
export const APP_RELEASE = `${APP_NAME}@${APP_VERSION}`;
export const BUILD_GIT_SHA = typeof __BUILD_GIT_SHA__ === 'string' ? __BUILD_GIT_SHA__.trim() : '';
export const BUILD_GIT_SHA_SHORT = BUILD_GIT_SHA.slice(0, 12);
export const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__.trim() : '';
export const RELEASE_CHANNEL =
  typeof __RELEASE_CHANNEL__ === 'string' && __RELEASE_CHANNEL__.trim()
    ? __RELEASE_CHANNEL__.trim()
    : 'development';

export function getSharedTelemetryBuildProperties(): Record<string, string> {
  const properties: Record<string, string> = {
    app_name: APP_NAME,
    app_namespace: APP_NAMESPACE,
    app_version: APP_VERSION,
    git_repository: APP_REPOSITORY,
    release: APP_RELEASE,
    release_channel: RELEASE_CHANNEL,
  };

  if (BUILD_ID) {
    properties.build_id = BUILD_ID;
  }
  if (BUILD_GIT_SHA) {
    properties.git_sha = BUILD_GIT_SHA;
  }
  if (BUILD_GIT_SHA_SHORT) {
    properties.git_sha_short = BUILD_GIT_SHA_SHORT;
  }

  return properties;
}
