import { readFile, writeFile } from 'node:fs/promises';

const directory = new URL('../shared/contracts/', import.meta.url);
const schema = JSON.parse(await readFile(new URL('session-profile.schema.json', directory), 'utf8'));
const output = [
  "import type { FromSchema } from 'json-schema-to-ts';",
  `export const sessionProfileSchema = ${JSON.stringify(schema, null, 2)} as const;`,
  'export type SessionProfile = FromSchema<typeof sessionProfileSchema>;',
  '',
].join('\n');
await writeFile(new URL('generated.ts', directory), output);
