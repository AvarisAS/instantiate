import type { Backend } from './treesitter.js';
import { python } from './python.js';
import { go } from './go.js';
import { swift } from './swift.js';

/** Every language indexed through tree-sitter. TypeScript and JavaScript go through the compiler instead. */
export const BACKENDS: Backend[] = [python, go, swift];
