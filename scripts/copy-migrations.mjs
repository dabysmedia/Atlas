import { cpSync } from 'node:fs';
cpSync('server/db/migrations', 'dist/server/db/migrations', { recursive: true });
