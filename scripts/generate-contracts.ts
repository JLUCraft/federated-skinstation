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

function typeExpression(value: unknown, path: string): string {
  const fallback = `FromSchema<${path}, { references: [...typeof contractSchemas] }>`;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const schema = value as Record<string, unknown>;
  if (typeof schema.$ref === 'string') {
    const definition = /#\/definitions\/([A-Za-z_]\w*)$/.exec(schema.$ref)?.[1];
    if (definition) return definition;
  }
  if (
    schema.type === 'array' &&
    schema.items &&
    !Array.isArray(schema.items) &&
    !['minItems', 'maxItems', 'prefixItems', 'contains'].some((key) => key in schema)
  )
    return `(${typeExpression(schema.items, `(${path})["items"]`)})[]`;
  for (const union of ['anyOf', 'oneOf'] as const) {
    const members = schema[union];
    if (
      Array.isArray(members) &&
      Object.keys(schema).every((key) => [union, 'description', 'title'].includes(key))
    )
      return members
        .map((item: unknown, index: number) =>
          typeExpression(item, `(${path})[${JSON.stringify(union)}][${index}]`),
        )
        .join(' | ');
  }
  if (
    schema.type === 'object' &&
    schema.additionalProperties === false &&
    schema.properties &&
    typeof schema.properties === 'object' &&
    !Array.isArray(schema.properties) &&
    !['oneOf', 'anyOf', 'allOf', 'not', 'if', 'dependentSchemas', 'patternProperties'].some(
      (key) => key in schema,
    )
  ) {
    const required = new Set<unknown>(Array.isArray(schema.required) ? schema.required : []);
    const properties = Object.entries(schema.properties).map(
      ([key, item]: [string, unknown]) =>
        `${JSON.stringify(key)}${required.has(key) || (item !== null && typeof item === 'object' && 'default' in item) ? '' : '?'}: ${typeExpression(item, `(${path})["properties"][${JSON.stringify(key)}]`)};`,
    );
    return properties.length ? `{ ${properties.join(' ')} }` : 'Record<string, never>';
  }
  return fallback;
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
  types.push(`export type ${name} = ${typeExpression(schema, `typeof ${variable}`)};`);
  for (const definition of Object.keys(schema.definitions ?? {})) {
    const reference = definition[0].toLowerCase() + definition.slice(1) + 'Schema';
    output.push(
      `export const ${reference} = { ...${variable}.definitions.${definition}, definitions: ${variable}.definitions } as const;`,
    );
    types.push(
      `export type ${definition} = ${typeExpression(schema.definitions?.[definition], `typeof ${reference}`)};`,
    );
  }
}
output.push(`export const contractSchemas = [${references.join(', ')}] as const;`, ...types);
await writeFile(new URL('generated.ts', directory), output.join('\n') + '\n');
