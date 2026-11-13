import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  operationsJobSchema,
  operationsSnapshotSchema,
  operationsSubmissionSchema,
  operationsTargetSchema,
  type OperationsIntent,
  type OperationsJob,
  type OperationsSettings,
  type OperationsSnapshot,
  type OperationsSubmission,
  type OperationsTarget,
  type OperationsTargetList,
} from '../shared/contracts/generated.js';
import {
  EXECUTOR_JOBS_PATH,
  EXECUTOR_SNAPSHOT_PATH,
  OPERATIONS_LEASE_SECONDS,
  OPERATIONS_MAX_REQUEST_BYTES,
  OPERATIONS_PATH,
} from '../shared/operations.js';
import { parseScope } from '../shared/permissions.js';
import { appendAudit, type LocalIdentity } from './permissions.js';
import { now, Rejected, requireThat, type Store } from './store.js';
import { bearer } from './validate.js';

const REQUEST_TIMEOUT_MS = 15_000;
interface Host {
  endpoint: string;
  credential: string;
}
interface SavedRequest {
  host: string;
  instance: string;
  intent: string;
}

async function responseJson(response: Response): Promise<unknown> {
  requireThat(response.ok, 'Operations host rejected the request', 502);
  const reader = response.body?.getReader();
  requireThat(reader, 'Operations host response missing', 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > OPERATIONS_MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new Rejected('Operations host response too large', 502);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return value;
}

export function registerOperations(
  app: FastifyInstance,
  store: Store,
  identity: LocalIdentity,
  settings?: OperationsSettings,
  transport: typeof fetch = fetch,
) {
  const hosts = new Map<string, Host>();
  for (const [id, host] of Object.entries(settings?.hosts ?? {})) {
    const endpoint = new URL(host.endpoint);
    requireThat(
      !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
      'Invalid operations host address',
    );
    requireThat(
      endpoint.protocol === 'https:' ||
        (endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname)),
      'Operations host requires HTTPS',
    );
    const credential = process.env[host.credentialEnv];
    requireThat(
      credential && /^[a-fA-F0-9]{64}$/.test(credential),
      'Operations host credential requires 32 random bytes in hexadecimal',
    );
    hosts.set(id, { endpoint: endpoint.href.replace(/\/$/, ''), credential });
  }

  function owner(request: FastifyRequest) {
    const account = store.token(bearer(request.headers.authorization), undefined, now());
    identity.authenticate(account.id);
    return account;
  }
  function permitted(account: string, scope: string, permission: 'read' | 'write' | 'manage') {
    requireThat(identity.authorize(account, scope, permission), 'Local authority required');
  }
  function target(host: string, instance: string): OperationsTarget {
    const row = store.db
      .prepare('SELECT host,instance,scope FROM operation_targets WHERE host=? AND instance=?')
      .get(host, instance) as OperationsTarget | undefined;
    requireThat(row, 'Operations instance is not registered', 404);
    return row;
  }
  async function remote<T>(
    request: FastifyRequest,
    id: string,
    path: string,
    schema: Record<string, unknown>,
    body?: unknown,
  ): Promise<T> {
    const host = hosts.get(id);
    requireThat(host, 'Operations host is not configured', 503);
    try {
      const response = await transport(host.endpoint + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: 'Bearer ' + host.credential,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await responseJson(response);
      requireThat(
        request.compileValidationSchema(schema)(value),
        'Invalid operations host response',
        502,
      );
      return value as T;
    } catch (error) {
      if (error instanceof Rejected) throw error;
      throw new Rejected('Operations host unavailable', 502);
    }
  }
  async function status(request: FastifyRequest, host: string, instance: string) {
    const snapshot = await remote<OperationsSnapshot>(
      request,
      host,
      EXECUTOR_SNAPSHOT_PATH,
      operationsSnapshotSchema,
    );
    const found = snapshot.instances.find((value) => value.id === instance);
    requireThat(found, 'Operations host does not manage this instance', 404);
    return found;
  }
  async function dispatch(request: FastifyRequest, host: string, intent: OperationsIntent) {
    const job = await remote<OperationsJob>(
      request,
      host,
      EXECUTOR_JOBS_PATH,
      operationsJobSchema,
      { intent, expiresAt: now() + OPERATIONS_LEASE_SECONDS },
    );
    requireThat(
      isDeepStrictEqual(job.intent, intent),
      'Operations host returned a different job',
      502,
    );
    return job;
  }

  app.get(OPERATIONS_PATH + '/targets', async (request): Promise<OperationsTargetList> => {
    const account = owner(request);
    const targets = store.db
      .prepare('SELECT host,instance,scope FROM operation_targets ORDER BY host,instance')
      .all() as OperationsTarget[];
    return {
      targets: targets.filter((value) => identity.authorize(account.id, value.scope, 'read')),
    };
  });
  app.post<{ Body: OperationsTarget }>(
    OPERATIONS_PATH + '/targets',
    { schema: { body: operationsTargetSchema } },
    async (request, reply) => {
      const account = owner(request);
      permitted(account.id, 'global', 'manage');
      const value = request.body;
      requireThat(hosts.has(value.host), 'Operations host is not configured');
      const scope = parseScope(value.scope);
      requireThat(
        scope?.kind === 'global' ||
          (scope?.kind === 'club' &&
            store.db.prepare('SELECT 1 FROM clubs WHERE id=?').get(scope.id!)),
        'Operations scope must be global or an existing club',
      );
      await status(request, value.host, value.instance);
      store.transaction(() => {
        requireThat(identity.decide(account.id, 'global', 'manage'), 'Local authority required');
        store.db
          .prepare(
            'INSERT INTO operation_targets VALUES(?,?,?) ON CONFLICT(host,instance) DO UPDATE SET scope=excluded.scope',
          )
          .run(value.host, value.instance, value.scope);
        appendAudit(
          store,
          account.id,
          'global',
          'operations.target.set',
          value.host + '/' + value.instance,
          value,
        );
      });
      return reply.code(204).send();
    },
  );
  app.get<{ Params: { host: string; instance: string } }>(
    OPERATIONS_PATH + '/hosts/:host/instances/:instance',
    async (request) => {
      const account = owner(request);
      const value = target(request.params.host, request.params.instance);
      permitted(account.id, value.scope, 'read');
      return status(request, value.host, value.instance);
    },
  );
  app.post<{ Params: { host: string; instance: string }; Body: OperationsSubmission }>(
    OPERATIONS_PATH + '/hosts/:host/instances/:instance/jobs',
    { schema: { body: operationsSubmissionSchema } },
    async (request) => {
      const account = owner(request);
      const binding = target(request.params.host, request.params.instance);
      const intent = store.transaction((): OperationsIntent => {
        requireThat(
          identity.decide(account.id, binding.scope, 'write'),
          'Local authority required',
        );
        const caller = store.currentCaller();
        const client = caller?.client ?? '';
        const previous = store.db
          .prepare(
            'SELECT intent FROM operation_requests WHERE host=? AND instance=? AND account=? AND client=? AND request_key=?',
          )
          .get(binding.host, binding.instance, account.id, client, request.body.key) as
          | { intent: string }
          | undefined;
        if (previous) {
          const saved = JSON.parse(previous.intent) as OperationsIntent;
          requireThat(
            saved.command.action === request.body.action && saved.scope === binding.scope,
            'Operation key already used',
            409,
          );
          appendAudit(store, account.id, binding.scope, 'operations.job.retry', saved.id, {
            key: request.body.key,
          });
          return saved;
        }
        const value: OperationsIntent = {
          id: randomUUID(),
          actor: {
            account: account.id,
            client: caller?.client ?? null,
            request: caller?.request ?? randomUUID(),
          },
          scope: binding.scope,
          command: { instance: binding.instance, action: request.body.action },
        };
        store.db
          .prepare('INSERT INTO operation_requests VALUES(?,?,?,?,?,?,?)')
          .run(
            value.id,
            binding.host,
            binding.instance,
            account.id,
            client,
            request.body.key,
            JSON.stringify(value),
          );
        appendAudit(store, account.id, binding.scope, 'operations.job.submit', value.id, value);
        return value;
      });
      return dispatch(request, binding.host, intent);
    },
  );
  app.get<{ Params: { id: string } }>(OPERATIONS_PATH + '/jobs/:id', async (request) => {
    const account = owner(request);
    const row = store.db
      .prepare('SELECT host,instance,intent FROM operation_requests WHERE id=?')
      .get(request.params.id) as SavedRequest | undefined;
    requireThat(row, 'Operation not found', 404);
    const intent = JSON.parse(row.intent) as OperationsIntent;
    permitted(account.id, intent.scope, 'read');
    const job = await remote<OperationsJob>(
      request,
      row.host,
      EXECUTOR_JOBS_PATH + '/' + encodeURIComponent(intent.id),
      operationsJobSchema,
    );
    requireThat(
      isDeepStrictEqual(job.intent, intent),
      'Operations host returned a different job',
      502,
    );
    return job;
  });
}
