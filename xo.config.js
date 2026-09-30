import tsParser from "@typescript-eslint/parser";
import globals from "globals";
import sveltePlugin from "eslint-plugin-svelte";

/**
@type {import('xo').FlatXoConfig}
*/
const xoConfig = [
    {
        // Matches the repo's existing 4-space indentation
        space: 4,
        // Prettier owns formatting; XO only turns off the conflicting rules
        prettier: "compat",
    },
    {
        // Not linted: the app.html template uses SvelteKit placeholders and
        // app.css uses Tailwind-only at-rules (@plugin, @theme) that the
        // CSS linter does not know; static/ holds vendored third-party files
        // (opus-recorder) that are served as-is
        ignores: ["src/app.html", "src/app.css", "static/**"],
    },
    {
        rules: {
            // Conflicts with Prettier, which strips the clarifying parentheses
            // this rule asks for in mixed arithmetic (a * b + c)
            "@stylistic/no-mixed-operators": "off",
        },
    },
    ...sveltePlugin.configs.recommended,
    {
        // Parse <script lang="ts"> blocks in Svelte files with the TypeScript parser
        files: ["**/*.svelte"],
        languageOptions: {
            globals: { ...globals.browser, Recorder: "readonly" },
            parserOptions: {
                parser: tsParser,
                extraFileExtensions: [".svelte"],
            },
        },
    },
];

export default xoConfig;
