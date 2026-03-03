import { defineConfig, globalIgnores } from 'eslint/config';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import vue from 'eslint-plugin-vue';
import sonarjs from 'eslint-plugin-sonarjs';
import prettier from 'eslint-plugin-prettier';
import globals from 'globals';

export default defineConfig([
	globalIgnores([
		'node_modules/',
		'package.json',
		'package-lock.json',
		'**/index.html',
		'src/plugins/leaflet.restoreview.js',
		'src/vite-env.d.ts'
	]),
	{
		plugins: {
			'@typescript-eslint': typescriptEslint,
			vue,
			sonarjs,
			prettier
		},

		languageOptions: {
			globals: {
				...globals.browser
			},

			ecmaVersion: 'latest',
			sourceType: 'module',

			parserOptions: {
				parser: '@typescript-eslint/parser'
			}
		},

		rules: {
			'prettier/prettier': 'off',
			'@typescript-eslint/ban-ts-comment': [
				'error',
				{
					'ts-ignore': 'allow-with-description'
				}
			],
			'vue/no-deprecated-slot-attribute': 'off',
			'no-unused-vars': 'error'
		}
	}
]);
