/**
 * change client-versions D2: the generated SW activates itself and claims the open pages. vite-plugin-pwa 2 with
 * `registerType: 'autoUpdate'` does not put these into the workbox config — it relies on its own `registerSW` sending
 * SKIP_WAITING, and the page registers the SW itself (`injectRegister: false`). Without them a new SW waits forever.
 */
export const SW_LIFECYCLE = { skipWaiting: true, clientsClaim: true } as const;
