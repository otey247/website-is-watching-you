import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build runs from any static host or subpath.
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
    rolldownOptions: {
      output: {
        // three.js changes far less often than the game, so it gets its own cacheable chunk.
        codeSplitting: { groups: [{ name: 'three', test: /node_modules[\\/]three[\\/]/ }] },
      },
    },
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
