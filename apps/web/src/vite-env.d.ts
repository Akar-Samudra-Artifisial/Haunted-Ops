/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /** `true` enables the `?demo=` parameter in a production build. */
  readonly VITE_DEMO_MODE?: string;
}
