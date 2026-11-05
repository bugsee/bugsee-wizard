import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// e2e fixture: a plain rspack config with external source maps
export default {
  mode: 'production',
  entry: './src/main.js',
  devtool: 'source-map',
  output: {
    path: path.join(__dirname, 'dist'),
    filename: '[name].[contenthash:8].js',
    clean: true,
  },
};
