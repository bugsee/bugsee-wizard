import { defineConfig } from 'rollup';

export default defineConfig({
  input: 'src/main.ts',
  output: { file: 'bundle.js', format: 'es' },
});
