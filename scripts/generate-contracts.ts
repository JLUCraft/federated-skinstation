import { readFile, readdir, writeFile } from 'node:fs/promises';

const directory = new URL('../shared/contracts/', import.meta.url);
const output = ["import type { FromSchema } from 'json-schema-to-ts';"];
for (const filename of (await readdir(directory)).filter(name => name.endsWith('.schema.json')).sort()) {
  const schema = JSON.parse(await readFile(new URL(filename, directory), 'utf8'));
  const name = schema.title as string;
  const variable = name[0].toLowerCase() + name.slice(1) + 'Schema';
  output.push(
    `export const ${variable} = ${JSON.stringify(schema, null, 2)} as const;`,
    `export type ${name} = FromSchema<typeof ${variable}>;`,
  );
}
await writeFile(new URL('generated.ts', directory), output.join('\n') + '\n');
