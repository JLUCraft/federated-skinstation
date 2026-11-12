import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import type { FromSchema } from 'json-schema-to-ts';
import { contractSchemas } from '../shared/contracts/generated.js';
import { bearer, record } from './validate.js';
import { now, Rejected, requireThat, type Store } from './store.js';
import type { LocalIdentity } from './permissions.js';

const PROTOCOL_VERSION = '2025-11-25';
const MCP_BODY_LIMIT = 4 * 1024 * 1024;
const MESSAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['jsonrpc', 'method'],
  properties: {
    jsonrpc: { const: '2.0' },
    id: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
    method: { type: 'string', minLength: 1 },
    params: { type: 'object', additionalProperties: true },
  },
} as const;
type Message = FromSchema<typeof MESSAGE_SCHEMA>;
type Schema = Record<string, unknown>;
type RpcId = string | number | null;
interface Tool {
  name: string;
  description: string;
  inputSchema: Schema;
  annotations: { readOnlyHint: boolean };
}
interface Endpoint {
  method: HTTPMethods;
  url: string;
  tool: Tool;
}
class RpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}

function expandSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => expandSchema(item));
  if (value === null || typeof value !== 'object') return value;
  const schema = record(value);
  if (typeof schema.$ref === 'string') {
    const [id, pointer = ''] = schema.$ref.split('#');
    let target: unknown = contractSchemas.find((contract) => contract.$id === id);
    requireThat(target, 'Contract reference required');
    for (const key of pointer.split('/').slice(1)) target = record(target)[key];
    return expandSchema(target);
  }
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !['$id', '$schema', 'definitions'].includes(key))
      .map(([key, item]) => [key, expandSchema(item)]),
  );
}

function rpcFailure(id: RpcId, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export class Mcp {
  private collecting = true;
  private readonly endpoints = new Map<string, Endpoint>();

  constructor(
    private readonly app: FastifyInstance,
    private readonly store: Store,
    private readonly identity: LocalIdentity,
    private readonly origin: string,
    private readonly version: string,
  ) {
    app.addHook('onRoute', (route) => {
      if (!this.collecting || route.url === '/api/recovery/confirm') return;
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        if (method === 'HEAD' || method === 'OPTIONS') continue;
        const name = `${method.toLowerCase()}_${route.url.slice('/api/'.length)}`
          .replaceAll(':', 'by_')
          .replaceAll(/[^a-zA-Z0-9_]/g, '_');
        requireThat(!this.endpoints.has(name), 'Unique MCP tool name required');
        const path = [...route.url.matchAll(/:([^/]+)/g)].map((match) => match[1]);
        const properties: Schema = {};
        const required: string[] = [];
        if (path.length) {
          properties.path = {
            type: 'object',
            additionalProperties: false,
            required: path,
            properties: Object.fromEntries(
              path.map((key) => [
                key,
                {
                  type: 'string',
                  minLength: 1,
                  maxLength: 256,
                  not: { enum: ['.', '..'] },
                },
              ]),
            ),
          };
          required.push('path');
        }
        if (route.schema?.body) {
          properties.body = expandSchema(route.schema.body);
          required.push('body');
        }
        if (route.schema?.querystring) {
          properties.query = expandSchema(route.schema.querystring);
          required.push('query');
        }
        this.endpoints.set(name, {
          method,
          url: route.url,
          tool: {
            name,
            description: `${method} ${route.url}`,
            inputSchema: { type: 'object', additionalProperties: false, properties, required },
            annotations: { readOnlyHint: method === 'GET' },
          },
        });
      }
    });
  }

  private async call(request: FastifyRequest, params: Record<string, unknown>) {
    if (typeof params.name !== 'string' || !this.endpoints.has(params.name))
      throw new RpcError(-32602, 'Unknown tool');
    const endpoint = this.endpoints.get(params.name)!;
    const args = params.arguments ?? {};
    if (!request.compileValidationSchema(endpoint.tool.inputSchema)(args))
      throw new RpcError(-32602, 'Invalid tool arguments');
    const input = record(args);
    const path = input.path ? record(input.path) : {};
    const query = input.query ? record(input.query) : {};
    const url = endpoint.url.replace(/:([^/]+)/g, (_match, key: string) =>
      encodeURIComponent(String(path[key])),
    );
    const search = new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    );
    const response = await this.app.inject({
      method: endpoint.method,
      url: search.size ? `${url}?${search}` : url,
      headers: { authorization: request.headers.authorization! },
      remoteAddress: request.ip,
      ...(input.body ? { payload: record(input.body) } : {}),
    });
    if (response.statusCode >= 400)
      return { isError: true, content: [{ type: 'text', text: response.body }] };
    const mime = String(response.headers['content-type'] ?? '').split(';')[0];
    if (mime.startsWith('image/'))
      return {
        content: [{ type: 'image', mimeType: mime, data: response.rawPayload.toString('base64') }],
      };
    if (mime === 'application/pdf')
      return {
        content: [
          {
            type: 'resource',
            resource: {
              uri: `jlucraft://artifact/${encodeURIComponent(String(path.id))}`,
              mimeType: mime,
              blob: response.rawPayload.toString('base64'),
            },
          },
        ],
      };
    if (mime && mime !== 'application/json')
      return { content: [{ type: 'text', text: response.body }] };
    const value: unknown = response.body
      ? response.json<unknown>()
      : { status: response.statusCode };
    const structuredContent =
      value !== null && typeof value === 'object' && !Array.isArray(value) ? value : { value };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  }

  register() {
    this.collecting = false;
    const handleError = this.app.errorHandler;
    const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
      requireThat(
        !request.headers.origin || request.headers.origin === this.origin,
        'MCP origin rejected',
      );
      try {
        this.identity.authenticate(
          this.store.token(bearer(request.headers.authorization), undefined, now()).id,
        );
      } catch {
        reply.header('WWW-Authenticate', 'Bearer realm="jlucraft"');
        throw new Rejected('MCP session required', 401, 'Unauthorized');
      }
    };
    this.app.post<{ Body: Message }>(
      '/mcp',
      {
        bodyLimit: MCP_BODY_LIMIT,
        onRequest: authenticate,
        schema: { body: MESSAGE_SCHEMA },
        errorHandler(error, request, reply) {
          const raw: unknown = request.body;
          const id =
            raw !== null &&
            typeof raw === 'object' &&
            'id' in raw &&
            (typeof raw.id === 'string' || typeof raw.id === 'number')
              ? raw.id
              : null;
          if (error instanceof RpcError)
            return reply.code(200).send(rpcFailure(id, error.rpcCode, error.message));
          if (error.validation || error.code === 'FST_ERR_CTP_INVALID_JSON_BODY')
            return reply
              .code(400)
              .send(rpcFailure(id, error.validation ? -32600 : -32700, 'Invalid JSON-RPC request'));
          if (error instanceof Rejected || (error.statusCode && error.statusCode < 500))
            return handleError(error, request, reply);
          return reply.code(500).send(rpcFailure(id, -32603, 'Internal error'));
        },
      },
      async (request, reply) => {
        const message = request.body;
        if (message.id === undefined) return reply.code(202).send();
        const params = message.params ?? {};
        let result: unknown;
        switch (message.method) {
          case 'initialize':
            result = {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'jlucraft', version: this.version },
              instructions:
                'Use path, query, and body from each tool schema. Club authority and point budgets are checked for every call.',
            };
            break;
          case 'ping':
            result = {};
            break;
          case 'tools/list':
            if (params.cursor !== undefined) throw new RpcError(-32602, 'Unknown cursor');
            result = { tools: [...this.endpoints.values()].map((endpoint) => endpoint.tool) };
            break;
          case 'tools/call':
            result = await this.call(request, params);
            break;
          default:
            throw new RpcError(-32601, 'Method not found');
        }
        return { jsonrpc: '2.0', id: message.id, result };
      },
    );
    this.app.route({
      method: ['GET', 'DELETE'],
      url: '/mcp',
      onRequest: authenticate,
      handler: async (_request, reply) => {
        return reply.header('Allow', 'POST').code(405).send();
      },
    });
  }
}
