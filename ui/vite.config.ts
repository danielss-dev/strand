import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri expects a fixed port and disables HMR over the network.
// See https://v2.tauri.app/start/frontend/vite/
export default defineConfig(async () => ({
  plugins: [react()],
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
    sourcemap: true,
  },
}));
