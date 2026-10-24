import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const toolRoot = process.env.SECURITY_LINT_ROOT;
if (!toolRoot) {
  throw new Error('SECURITY_LINT_ROOT must identify the isolated security dependencies.');
}

const requireSecurityTool = createRequire(resolve(toolRoot, 'package.json'));
const sdl = requireSecurityTool('@microsoft/eslint-plugin-sdl');
const typescriptParser = requireSecurityTool('@typescript-eslint/parser');

export default [
  // Retain every rule from the configuration OSSAR previously selected.
  ...sdl.configs.required,
  {
    // ESLint 9 needs both an explicit TypeScript matcher and a TypeScript parser.
    files: ['**/*.ts'],
    languageOptions: {
      parser: typescriptParser,
    },
  },
];
