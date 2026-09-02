import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri expects a fixed port and disables HMR over the network.
// See https://v2.tauri.app/start/frontend/vite/
export default defineConfig(async ({ mode }) => {
  // `vite build --mode demo` produces the browser demo strandgit.com embeds
  // (see src/demo/boot.ts): served from /demo/, written straight into the
  // website tree, no source maps for the public bundle.
  const demo = mode === 'demo';
  return {
    plugins: [
      react(),
      ...(demo
        ? [{
            name: 'strand-demo-html',
            transformIndexHtml: (html: string) => html
              .replace('<title>Strand</title>', '<meta name="robots" content="noindex" />\n    <title>Strand — live demo</title>')
              // First visit defaults to dark so the embed matches the charcoal
              // landing page; a theme picked inside the demo persists as usual.
              .replace('<head>', `<head>\n    <script>try{if(!localStorage.getItem('strand.settings'))localStorage.setItem('strand.settings',JSON.stringify({state:{theme:'dark'},version:0}))}catch(e){}</script>`),
            // public/fonts/fonts.css is copied verbatim, so its absolute
            // `/fonts/…` urls miss the /demo/ base. Vite's `base` rewrites the
            // <link> in index.html but not the file it points at.
            closeBundle: () => {
              const css = resolve(__dirname, '../website/demo/fonts/fonts.css');
              writeFileSync(css, readFileSync(css, 'utf8').replaceAll('url(/fonts/', 'url(/demo/fonts/'));
            },
          }]
        : []),
    ],
    base: demo ? '/demo/' : '/',
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
      host: false,
      // The HMR socket rides Tauri's fixed port. When the dev server runs
      // standalone (browser-mode smoke tests, no `tauri dev`), that socket can
      // never connect and the vite client reload-polls the page forever —
      // STRAND_NO_HMR=1 turns HMR off for those runs.
      hmr: process.env.STRAND_NO_HMR
        ? false
        : { protocol: 'ws', host: 'localhost', port: 1421 },
      watch: {
        // Don't watch the Rust side from Vite — Cargo handles that.
        ignored: ['**/src-tauri/**', '**/crates/**', '**/target/**'],
      },
    },
    envPrefix: ['VITE_', 'TAURI_ENV_*'],
    // Pierre's highlight worker (`@pierre/diffs/worker/worker.js?worker`) code-
    // splits internally (lazy wasm chunk), which rules out Vite's default iife
    // worker output.
    worker: { format: 'es' as const },
    build: {
      target: 'esnext',
      minify: 'esbuild',
      sourcemap: !demo,
      outDir: demo ? '../website/demo' : 'dist',
      emptyOutDir: true,
    },
  };
});
