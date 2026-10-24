import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src',
  base: './',
  publicDir: '../public',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: { port: 5174, strictPort: true },
});
