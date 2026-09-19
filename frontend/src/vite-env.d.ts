/// <reference types="vite/client" />

/** 由 vite.config.ts 的 define 注入，应用版本号（取自 build/config.yml 的 info.version）。 */
declare const __APP_VERSION__: string;
