// e2e fixture: the plain object config (the only shape the wizard wires the plugin into itself)
export default {
  input: 'src/main.js',
  external: ['@bugsee/browser'],
  output: {
    dir: 'dist',
    format: 'es',
    sourcemap: true,
  },
};
