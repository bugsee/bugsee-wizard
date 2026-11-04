import { defineConfig, mergeConfig } from 'vite';
import base from './vite.base.config';

export default mergeConfig(base, defineConfig({ plugins: [] }));
