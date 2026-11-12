import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node, chrome: 'readonly', zip: 'readonly' } },
    rules: {
      ...js.configs.recommended.rules,
      // XML chapter text must exclude control characters.
      'no-control-regex': 'off',
    },
  },
  { files: ['**/prepare.js'], languageOptions: { globals: { buildStoryEpub: 'readonly' } } },
  { files: ['**/story.js'], languageOptions: { globals: { buildStoryEpub: 'readonly' } } },
  {
    files: ['**/desktop.js'],
    languageOptions: { globals: { prepareStoryUpdate: 'readonly' } },
    rules: { 'no-unused-vars': ['error', { varsIgnorePattern: '^(zip|exports)$' }] },
  },
  { files: ['**/*.js'], languageOptions: { sourceType: 'script' } },
];
