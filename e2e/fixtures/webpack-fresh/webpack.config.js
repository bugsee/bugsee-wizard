import path from 'node:path';
import { fileURLToPath } from 'node:url';
import HtmlWebpackPlugin from 'html-webpack-plugin';

const here = path.dirname(fileURLToPath(import.meta.url));

// e2e fixture: a browser app that has no .html file on disk (html-webpack-plugin writes the page),
// sets "type" and engines.node, and has no Bugsee in it. webpack 5 does not polyfill `process`.
export default {
  mode: 'production',
  entry: './src/index.js',
  devtool: 'source-map',
  output: { path: path.join(here, 'dist'), filename: 'main.[contenthash:8].js', clean: true },
  plugins: [new HtmlWebpackPlugin({ title: 'e2e' })],
};
