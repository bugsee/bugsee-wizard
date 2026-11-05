import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  plugins: [],
  define: { MODE: JSON.stringify(mode) },
}));
