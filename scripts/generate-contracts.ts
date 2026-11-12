import { readFile, readdir, writeFile } from 'node:fs/promises';

function absoluteReferences(value: unknown, id: string): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => absoluteReferences(item, id));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]: [string, unknown]) => [
        key,
        key === '$ref' && typeof item === 'string' && item.startsWith('#')
          ? `${id}${item}`
          : absoluteReferences(item, id),
      ]),
    );
  return value;
}

const directory = new URL('../shared/contracts/', import.meta.url);
const output = ["import type { FromSchema } from 'json-schema-to-ts';"];
const references: string[] = [];
const types: string[] = [];
for (const filename of (await readdir(directory))
  .filter((name) => name.endsWith('.schema.json'))
  .sort()) {
  const schema = JSON.parse(await readFile(new URL(filename, directory), 'utf8')) as {
    title: string;
    $id?: string;
    definitions?: Record<string, unknown>;
  };
  const name = schema.title;
  const variable = name[0].toLowerCase() + name.slice(1) + 'Schema';
  output.push(
    `export const ${variable} = ${JSON.stringify(schema.$id ? absoluteReferences(schema, schema.$id) : schema, null, 2)} as const;`,
  );
  if (schema.$id) references.push(variable);
  types.push(
    `export type ${name} = FromSchema<typeof ${variable}, { references: [...typeof contractSchemas] }>;`,
  );
  for (const definition of Object.keys(schema.definitions ?? {})) {
    const reference = definition[0].toLowerCase() + definition.slice(1) + 'Schema';
    output.push(
      `export const ${reference} = { ...${variable}.definitions.${definition}, definitions: ${variable}.definitions } as const;`,
    );
    types.push(
      `export type ${definition} = FromSchema<typeof ${reference}, { references: [...typeof contractSchemas] }>;`,
    );
  }
}
output.push(`export const contractSchemas = [${references.join(', ')}] as const;`, ...types);
await writeFile(new URL('generated.ts', directory), output.join('\n') + '\n');
