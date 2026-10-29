import { register } from 'tsx/esm/api';
import { fileURLToPath } from 'node:url';

register();

// The source entrypoint checks argv[1] to decide whether to start.
process.argv[1] = fileURLToPath(new URL('../src/index.ts', import.meta.url));
await import('../src/index.ts');
