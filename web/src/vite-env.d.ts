/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_SHARED_PATH?: string;
  /** Set by the pages workflow: the commit built, and when (D-364). */
  readonly VITE_BUILD_SHA?: string;
  readonly VITE_BUILD_TIME?: string;
}
