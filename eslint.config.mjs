import { defineConfig, globalIgnores } from 'eslint/config';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import vue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import sonarjs from 'eslint-plugin-sonarjs';
import prettier from 'eslint-plugin-prettier';
import globals from 'globals';

// Shared across the .ts/.vue blocks below — flat config (ESLint 9+) requires
// each config object to declare its own `files`/`languageOptions.parser`,
// so a single shared block can no longer cover both.
const plugins = {
	'@typescript-eslint': typescriptEslint,
	vue,
	sonarjs,
	prettier
};

const rules = {
	'prettier/prettier': 'off',
	'@typescript-eslint/ban-ts-comment': [
		'error',
		{
			'ts-ignore': 'allow-with-description'
		}
	],
	'vue/no-deprecated-slot-attribute': 'off',
	// The core rule doesn't understand TS-only constructs (interface/type
	// method signatures, ambient overload params) and flags them as unused;
	// the TS-aware rule fixes that. `_`-prefixed names are the repo's
	// established "intentionally unused" convention.
	'no-unused-vars': 'off',
	'@typescript-eslint/no-unused-vars': [
		'error',
		{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
	]
};

export default defineConfig([
	globalIgnores([
		'node_modules/',
		'package.json',
		'package-lock.json',
		'**/index.html',
		'src/vite-env.d.ts',
		'dist/',
		// Capacitor-synced native projects: generated copies of the web build,
		// not source (see ios/.gitignore, android/.gitignore).
		'ios/',
		'android/'
	]),
	{
		files: ['**/*.{js,mjs,cjs,ts,tsx}'],
		plugins,
		languageOptions: {
			globals: {
				...globals.browser
			},
			ecmaVersion: 'latest',
			sourceType: 'module',
			parser: tsParser
		},
		rules
	},
	{
		files: ['**/*.vue'],
		plugins,
		languageOptions: {
			globals: {
				...globals.browser
			},
			ecmaVersion: 'latest',
			sourceType: 'module',
			parser: vueParser,
			parserOptions: {
				parser: tsParser
			}
		},
		rules
	}
]);
