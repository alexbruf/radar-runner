import { defineConfig } from 'vite';

export default defineConfig({
  base: '/radar-runner/',
  build: {
    outDir: 'demo-dist',
    emptyOutDir: true,
  },
});
