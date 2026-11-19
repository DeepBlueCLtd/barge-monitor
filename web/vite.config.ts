import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// base './': every URL in the built site is relative, so the same build works
// at the site root and under a pull request's preview folder (FR-04).
export default defineConfig({
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 1500 },
});
