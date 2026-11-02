/**
 * The build of this client, embedded by Vite (`define: { __APP_BUILD__ }`, design D1/D6). Unit tests run without the
 * define: a `dev` build then. Kept in a module of its own so the e2e mock can serve another build after a «deploy».
 */
import { DEV_COMMIT, type BuildInfo } from './buildInfo';

declare const __APP_BUILD__: BuildInfo | undefined;

export const CLIENT_BUILD: BuildInfo = typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : { version: '0.0.0', commit: DEV_COMMIT, builtAt: '1970-01-01T00:00:00Z' };
