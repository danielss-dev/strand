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
    hmr: { protocol: 'ws', host: 'localhost', port: 1421 },
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
