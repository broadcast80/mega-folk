import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // WebGPU needs a secure context: `localhost` is one, a LAN IP is not.
    host: 'localhost',
    port: 5180,
  },
  preview: {
    host: 'localhost',
    port: 4180,
  },
  build: {
    // WebGPU-era browsers only; no point down-levelling top-level await or
    // modern syntax for engines that cannot run the renderer anyway.
    target: 'esnext',
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
  },
});
