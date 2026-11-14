import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

// Kept apart from vite.config.ts so tests do not load VitePWA or ViteFonts.
export default defineConfig({
	resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
	test: { include: ['src/**/*.spec.ts'], environment: 'node' }
});
