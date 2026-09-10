import prettier from 'eslint-config-prettier';
import path from 'node:path';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	prettier,
	...svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off',

			// Ambas vienen del preset `svelte.configs.recommended` y no fueron adoptadas de forma
			// consciente por el proyecto:
			//
			// - no-navigation-without-resolve: exige envolver cada `href` / `goto()` con
			//   `resolve()` de `$app/paths`. Mientras no haya `paths.base` configurado
			//   (hoy no lo hay en svelte.config.js), `resolve('/x')` devuelve `'/x'`, así que
			//   es boilerplate sin cambio de comportamiento sobre ~57 sitios.
			//
			// - prefer-svelte-reactivity: exige `SvelteURLSearchParams` / `SvelteSet` en lugar de
			//   los built-ins. A diferencia de la anterior, SÍ cambia comportamiento (vuelve
			//   reactivas esas instancias), por lo que requiere una decisión consciente y
			//   prueba por sitio, no un reemplazo masivo.
			'svelte/no-navigation-without-resolve': 'off',
			'svelte/prefer-svelte-reactivity': 'off'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser,
				svelteConfig
			}
		}
	}
);
