import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// base './': every URL in the build is relative (FR-04), so the same build
// works at the site root and under a pull request's preview folder.
export default defineConfig({
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 3000 },
});
