import { defineConfig } from 'vite';
export default defineConfig({ base: process.env.PORTAL_BASE_PATH || '/', server: { proxy: { '/api': 'http://127.0.0.1:8080' } }, build: { sourcemap: false } });
