import { defineConfig } from 'vite';

// e2e fixture: the object-form config `npm create vite` writes, source maps on, no Bugsee anywhere
export default defineConfig({
  build: {
    sourcemap: true,
  },
});
