import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { offlineBuild } from './src/pwa/build.ts';

export default defineConfig({
  plugins: [react(), offlineBuild()],
  build: { target: 'safari18' },
});
