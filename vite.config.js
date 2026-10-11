import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { devApi } from './tools/vite-dev-api.js';

// Two entry points: the game (index.html) and the editor (editor.html). The dev API plugin lets
// the editor and the agent tools read / write the game data under public/data while `vite` runs.
export default defineConfig({
  server: { port: 5190, strictPort: false, watch: { ignored: ['**/shots/**', '**/.mc-backup/**', '**/dist/**', '**/tests/**'] } },
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        game: resolve(import.meta.dirname, 'index.html'),
        editor: resolve(import.meta.dirname, 'editor.html'),
      },
    },
  },
  plugins: [devApi()],
});
