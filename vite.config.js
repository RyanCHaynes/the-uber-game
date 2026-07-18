import { defineConfig } from 'vite';

import { tokenRushLevelEvolutionPlugin } from './scripts/token-rush-level-evolution-data.mjs';

export default defineConfig({
  plugins: [tokenRushLevelEvolutionPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
