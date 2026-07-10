/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __BUILD_GIT_SHA__: string;
declare const __BUILD_ID__: string;
declare const __RELEASE_CHANNEL__: string;

interface ImportMetaEnv {
  readonly VITE_POSTHOG_HOST?: string;
  readonly VITE_POSTHOG_KEY?: string;
  readonly VITE_SENTRY_DSN?: string;
}

declare module '*.png' {
  const src: string;
  // eslint-disable-next-line import/no-default-export -- Vite asset modules require default exports
  export default src;
}

declare module '*.jpg' {
  const src: string;
  // eslint-disable-next-line import/no-default-export -- Vite asset modules require default exports
  export default src;
}

declare module '*.svg' {
  const src: string;
  // eslint-disable-next-line import/no-default-export -- Vite asset modules require default exports
  export default src;
}
