import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  // Disable Vite's modulepreload polyfill — not needed for a library
  // and breaks CDN usage by injecting relative path resolution
  appType: 'custom',
  build: {
    modulePreload: { polyfill: false },
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: 'esbuild',
    rollupOptions: {
      input: {
        'radar-runner': resolve(__dirname, 'src/main.ts'),
        react: resolve(__dirname, 'src/react.ts'),
        preact: resolve(__dirname, 'src/preact.ts'),
        vue: resolve(__dirname, 'src/vue.ts'),
      },
      external: ['react', 'preact', 'vue', 'preact/hooks'],
      output: {
        format: 'es',
        dir: 'dist',
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
      },
      preserveEntrySignatures: 'exports-only',
      // The shell registers a custom element as a top-level side effect.
      // Preserve module-level side effects so customElements.define() is not tree-shaken.
      treeshake: {
        moduleSideEffects: true,
      },
    },
  },
});
