/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

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
