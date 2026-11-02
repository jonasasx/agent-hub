import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { SW_NAVIGATE_DENYLIST } from './src/swDenylist';
import { SW_LIFECYCLE } from './src/swLifecycle';
import type { BuildInfo } from './src/features/update/buildInfo';

const HUB = process.env.HUB_DEV_URL ?? 'http://localhost:8080';

/** Short commit of the checkout, or null without git (the image build gets the commit as BUILD_COMMIT, design D6). */
function gitCommit(): string | null {
  try {
    return (
      execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim() || null
    );
  } catch {
    return null;
  }
}

/** change client-versions D1/D6: one build description for `__APP_BUILD__` and `dist/version.json`. */
const BUILD: BuildInfo = {
  version: (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version,
  commit: process.env.BUILD_COMMIT || gitCommit() || 'dev',
  builtAt: process.env.BUILD_TIME || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
};

/** Writes `version.json` next to `index.html`; the dev server answers `/version.json` with the same build. */
function versionJson(): Plugin {
  const body = JSON.stringify(BUILD);
  return {
    name: 'agent-hub-version-json',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: body });
    },
    configureServer(server) {
      server.middlewares.use('/version.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(body);
      });
    },
  };
}

// Requirement: PWA — installable shell, cached app shell, session data is never cached.
export default defineConfig({
  define: { __APP_BUILD__: JSON.stringify(BUILD) },
  plugins: [
    react(),
    versionJson(),
    VitePWA({
      // the page registers the SW itself (features/update/sw.ts) and reloads only when nothing is lost (design D2, D4);
      // autoUpdate alone does NOT make the SW skip waiting — see workbox SW_LIFECYCLE below
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['icons/icon.svg'],
      manifest: {
        name: 'Agent Hub',
        short_name: 'Agent Hub',
        description: 'Сессии Claude Code на X1, HP и ВМ',
        lang: 'ru',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#12151a',
        theme_color: '#12151a',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // skipWaiting + clientsClaim: the new SW takes control by itself (design D2); checked after build by scripts/check-sw.mjs
        ...SW_LIFECYCLE,
        // no json: /version.json always goes to the network (design D1)
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        // Server routes must reach the hub, never the cached shell.
        navigateFallbackDenylist: SW_NAVIGATE_DENYLIST,
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': HUB,
      '/auth': HUB,
      '/healthz': HUB,
      // only the hub's /mcp/… (the OAuth return); /mcp-like paths of the SPA stay with Vite
      '^/mcp/': HUB,
      '/ws': { target: HUB.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
