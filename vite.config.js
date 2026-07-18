import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

import { tokenRushLevelEvolutionPlugin } from './scripts/token-rush-level-evolution-data.mjs';

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [tokenRushLevelEvolutionPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        modes: path.join(repositoryRoot, 'index.html'),
        singleplayer: path.join(repositoryRoot, 'singleplayer.html'),
        multiplayer: path.join(repositoryRoot, 'multiplayer.html'),
      },
    },
  },
});
