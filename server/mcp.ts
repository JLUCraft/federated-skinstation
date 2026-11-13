import { sseFrames, streamText, writeEvent } from './streams.js';
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { FromSchema } from 'json-schema-to-ts';
import { contractSchemas } from '../shared/contracts/generated.js';
import { bearer, record, requestToken } from './validate.js';
import { now, Rejected, requireThat, type Store } from './store.js';
import type { LocalIdentity } from './permissions.js';
import {
  MCP_PATH,
  MCP_METADATA_PATH,
  MCP_READ_SCOPE,
  MCP_WRITE_SCOPE,
  mcpScopeAllows,
} from '../shared/oauth.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    mcpStream?: boolean;
  }
}

const PROTOCOL_VERSION = '2025-11-25';
const MAX_CONCURRENT_STREAMS = 64;
const MCP_BODY_LIMIT = 4 * 1024 * 1024;
const MESSAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['jsonrpc', 'method'],
  properties: {
    jsonrpc: { const: '2.0' },
    id: {},
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
  stream: boolean;
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

function isRequestId(value: unknown): value is Exclude<RpcId, null> {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
}

function rpcFailure(id: RpcId, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export class Mcp {
  private collecting = true;
  private readonly streams = new Map<string, AbortController>();
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
          stream: route.config?.mcpStream === true && method === 'GET',
          tool: {
            name,
            description: `${method} ${route.url}`,
            inputSchema: { type: 'object', additionalProperties: false, properties, required },
            annotations: { readOnlyHint: method === 'GET' },
          },
        });
      }
    });
    app.addHook('preHandler', async (request, reply) => {
      const token = requestToken(request);
      const session = token ? this.store.oauthSession(token) : undefined;
      if (!session || request.routeOptions.url === MCP_PATH) return;
      const caller = this.store.currentCaller();
      const method = request.method === 'HEAD' ? 'GET' : request.method;
      const endpoint = [...this.endpoints.values()].find(
        (entry) => entry.url === request.routeOptions.url && entry.method === method,
      );
      requireThat(
        caller?.client === session.client && endpoint,
        'MCP access token requires the MCP endpoint',
      );
      this.scope(session, method !== 'GET', reply);
    });
  }

  private scope(
    session: NonNullable<ReturnType<Store['oauthSession']>>,
    write: boolean,
    reply: FastifyReply,
  ) {
    if (session.resource !== this.origin + MCP_PATH)
      throw new Rejected('MCP resource rejected', 401, 'Unauthorized');
    if (!mcpScopeAllows(session.scope.split(' '), write)) {
      reply.header(
        'WWW-Authenticate',
        'Bearer error="insufficient_scope", resource_metadata="' +
          this.origin +
          MCP_METADATA_PATH +
          '", scope="' +
          (write ? MCP_WRITE_SCOPE : MCP_READ_SCOPE) +
          '"',
      );
      throw new Rejected('MCP scope required', 403, 'InsufficientScope');
    }
  }

  private async stream(
    request: FastifyRequest,
    reply: FastifyReply,
    endpoint: Endpoint,
    url: string,
    session: NonNullable<ReturnType<Store['oauthSession']>>,
    id: string | number,
    metadata: unknown,
  ) {
    const key = JSON.stringify([session.id, id]);
    if (this.streams.has(key)) throw new RpcError(-32600, 'Request ID already active');
    if (this.streams.size >= MAX_CONCURRENT_STREAMS)
      throw new Rejected('Too many active streams', 429);
    const meta = metadata === undefined ? {} : record(metadata);
    const progress = meta.progressToken;
    if (
      progress !== undefined &&
      typeof progress !== 'string' &&
      (typeof progress !== 'number' || !Number.isFinite(progress))
    )
      throw new RpcError(-32602, 'Invalid progress token');
    const abort = new AbortController();
    const disconnected = () => abort.abort();
    reply.raw.once('close', disconnected);
    this.streams.set(key, abort);
    const token = bearer(request.headers.authorization);
    const guard = () => {
      const current = this.store.oauthSession(token);
      requireThat(current?.id === session.id, 'OAuth session revoked');
      this.identity.authenticate(this.store.token(token, undefined, now()).id);
      this.scope(current, false, reply);
    };
    try {
      return await this.store.withCaller(session.client, randomUUID(), async () => {
        const response = await this.app.inject({
          method: endpoint.method,
          url,
          headers: { authorization: request.headers.authorization! },
          remoteAddress: request.ip,
          payloadAsStream: true,
          signal: abort.signal,
        });
        const closeSource = () => response.raw.res.destroy();
        if (abort.signal.aborted) closeSource();
        else abort.signal.addEventListener('abort', closeSource, { once: true });
        if (response.statusCode >= 400)
          return {
            isError: true,
            content: [{ type: 'text', text: await streamText(response.stream(), MCP_BODY_LIMIT) }],
          };
        requireThat(
          String(response.headers['content-type']).startsWith('text/event-stream'),
          'Event stream required',
          502,
        );
        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        let result: unknown;
        try {
          let complete = false;
          let count = 0;
          let last: unknown = {};
          for await (const frame of sseFrames(response.stream(), MCP_BODY_LIMIT, guard)) {
            if (abort.signal.aborted) break;
            last = frame.data;
            if (frame.event === 'done') {
              complete = true;
              break;
            }
            if (progress !== undefined)
              await writeEvent(
                reply.raw,
                {
                  jsonrpc: '2.0',
                  method: 'notifications/progress',
                  params: {
                    progressToken: progress,
                    progress: ++count,
                    message: JSON.stringify(frame.data),
                  },
                },
                abort.signal,
              );
          }
          requireThat(complete && !abort.signal.aborted, 'Event stream interrupted', 502);
          const structuredContent =
            last !== null && typeof last === 'object' && !Array.isArray(last)
              ? last
              : { value: last };
          result = {
            content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
            structuredContent,
          };
        } catch (error) {
          if (reply.raw.writableNeedDrain) reply.raw.destroy();
          result = {
            isError: true,
            content: [
              {
                type: 'text',
                text: abort.signal.aborted
                  ? 'Request cancelled'
                  : error instanceof Rejected && error.statusCode === 403
                    ? 'Authorization revoked'
                    : 'Event stream interrupted',
              },
            ],
          };
        }
        if (!reply.raw.destroyed) {
          try {
            await writeEvent(
              reply.raw,
              { jsonrpc: '2.0', id, result },
              new AbortController().signal,
            );
            reply.raw.end();
          } catch {
            reply.raw.destroy();
          }
        }
        return reply;
      });
    } catch (error) {
      if (abort.signal.aborted)
        return { isError: true, content: [{ type: 'text', text: 'Request cancelled' }] };
      throw error;
    } finally {
      this.streams.delete(key);
      reply.raw.off('close', disconnected);
      abort.abort();
    }
  }

  private async call(
    request: FastifyRequest,
    params: Record<string, unknown>,
    reply: FastifyReply,
    id: string | number,
  ) {
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
    const session = this.store.oauthSession(bearer(request.headers.authorization));
    requireThat(session);
    this.scope(session, endpoint.method !== 'GET', reply);
    if (endpoint.stream)
      return this.stream(
        request,
        reply,
        endpoint,
        search.size ? `${url}?${search}` : url,
        session,
        id,
        params._meta,
      );

    const response = await this.store.withCaller(session.client, randomUUID(), async () => {
      const result = await this.app.inject({
        method: endpoint.method,
        url: search.size ? `${url}?${search}` : url,
        headers: { authorization: request.headers.authorization! },
        remoteAddress: request.ip,
        ...(input.body ? { payload: record(input.body) } : {}),
      });
      return result;
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
        const session = this.store.oauthSession(bearer(request.headers.authorization));
        requireThat(session, 'OAuth authorization required');
        this.identity.authenticate(
          this.store.token(bearer(request.headers.authorization), undefined, now()).id,
        );
        this.scope(session, false, reply);
      } catch {
        reply.header(
          'WWW-Authenticate',
          'Bearer resource_metadata="' +
            this.origin +
            MCP_METADATA_PATH +
            '", scope="' +
            MCP_READ_SCOPE +
            '"',
        );
        throw new Rejected('MCP session required', 401, 'Unauthorized');
      }
    };
    this.app.get(MCP_METADATA_PATH, async () => ({
      resource: this.origin + MCP_PATH,
      authorization_servers: [this.origin],
      scopes_supported: [MCP_READ_SCOPE, MCP_WRITE_SCOPE],
      bearer_methods_supported: ['header'],
    }));
    this.app.post<{ Body: Message }>(
      MCP_PATH,
      {
        bodyLimit: MCP_BODY_LIMIT,
        onRequest: authenticate,
        schema: { body: MESSAGE_SCHEMA },
        errorHandler(error, request, reply) {
          const raw: unknown = request.body;
          const id =
            raw !== null && typeof raw === 'object' && 'id' in raw && isRequestId(raw.id)
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
        if (message.id !== undefined && !isRequestId(message.id))
          throw new RpcError(-32600, 'Invalid request ID');
        if (message.id === undefined) {
          if (message.method === 'notifications/cancelled') {
            const requestId = message.params?.requestId;
            if (isRequestId(requestId)) {
              const session = this.store.oauthSession(bearer(request.headers.authorization));
              requireThat(session);
              this.streams.get(JSON.stringify([session.id, requestId]))?.abort();
            }
          }
          return reply.code(202).send();
        }
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
            result = await this.call(request, params, reply, message.id);
            if (reply.sent) return reply;
            break;
          default:
            throw new RpcError(-32601, 'Method not found');
        }
        return { jsonrpc: '2.0', id: message.id, result };
      },
    );
    this.app.route({
      method: ['GET', 'DELETE'],
      url: MCP_PATH,
      onRequest: authenticate,
      handler: async (_request, reply) => {
        return reply.header('Allow', 'POST').code(405).send();
      },
    });
  }
}
