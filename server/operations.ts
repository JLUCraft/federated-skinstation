import { OperationAuthority } from './operation-authority.js';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { SSE_ENVELOPE_BYTES, sseFrames } from './streams.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  operationsJobSchema,
  operationsBackupPageSchema,
  type OperationsBackupPage,
  operationsClaimSchema,
  type OperationsClaim,
  operationsJobPageSchema,
  operationsLogPageSchema,
  operationsObservationSchema,
  operationsPageQuerySchema,
  type OperationsJobPage,
  type OperationsLogPage,
  type OperationsObservation,
  type OperationsPageQuery,
  operationsSnapshotSchema,
  operationsSubmissionSchema,
  operationsTargetSchema,
  operationsReservationSchema,
  type OperationsReservation,
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
  EXECUTOR_INSTANCES_PATH,
  OPERATIONS_SCOPE_HEADER,
  OPERATIONS_MAX_PAGE_ROWS,
  EXECUTOR_SNAPSHOT_PATH,
  OPERATIONS_LEASE_SECONDS,
  OPERATIONS_MAX_REQUEST_BYTES,
  OPERATIONS_PATH,
  operationPermission,
  operationNeedsApproval,
  operationRequiresGlobal,
  OPERATIONS_APPROVAL_SECONDS,
  OPERATIONS_CLAIM_PATH,
  OPERATIONS_CLAIM_HEADER,
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
  if (response.status === 409)
    throw new Rejected('Operation conflicts with the current job state', 409);
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
  settings: OperationsSettings | undefined,
  transport: typeof fetch,
  origin: string,
) {
  const authority = new OperationAuthority(store, identity, origin);
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
    headers: Record<string, string> = {},
  ): Promise<T> {
    const host = hosts.get(id);
    requireThat(host, 'Operations host is not configured', 503);
    try {
      const response = await transport(host.endpoint + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...headers,
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
    const approval = authority.proof(intent.id);
    const job = await remote<OperationsJob>(
      request,
      host,
      EXECUTOR_JOBS_PATH,
      operationsJobSchema,
      {
        intent,
        expiresAt: Math.min(
          now() + OPERATIONS_LEASE_SECONDS,
          (approval?.approvedAt ?? now()) + OPERATIONS_APPROVAL_SECONDS,
        ),
        ...(approval ? { approval } : {}),
      },
    );
    requireThat(
      isDeepStrictEqual(job.intent, intent) && isDeepStrictEqual(job.approval, approval),
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
  app.post<{ Params: { host: string }; Body: OperationsReservation }>(
    OPERATIONS_PATH + '/hosts/:host/instances',
    { schema: { body: operationsReservationSchema } },
    (request): OperationsTarget => {
      const account = owner(request);
      const host = request.params.host;
      requireThat(hosts.has(host), 'Operations host is not configured');
      return store.transaction(() => {
        requireThat(identity.decide(account.id, 'global', 'manage'), 'Local authority required');
        const scope = parseScope(request.body.scope);
        requireThat(
          scope?.kind === 'global' ||
            (scope?.kind === 'club' &&
              store.db.prepare('SELECT 1 FROM clubs WHERE id=?').get(scope.id!)),
          'Operations scope must be global or an existing club',
        );
        const key = request.body.key;
        const client = store.currentCaller()?.client ?? '';
        const prior = store.db
          .prepare(
            'SELECT instance,scope FROM operation_reservations WHERE account=? AND host=? AND request_key=? AND client=?',
          )
          .get(account.id, host, key, client) as { instance: string; scope: string } | undefined;
        if (prior) {
          const value: OperationsTarget = { host, ...prior };
          requireThat(value.scope === request.body.scope, 'Reservation key already used', 409);
          return value;
        }
        const value: OperationsTarget = { host, instance: randomUUID(), scope: request.body.scope };
        store.db
          .prepare('INSERT INTO operation_targets VALUES(?,?,?)')
          .run(host, value.instance, value.scope);
        store.db
          .prepare('INSERT INTO operation_reservations VALUES(?,?,?,?,?,?)')
          .run(account.id, host, client, key, value.instance, value.scope);
        appendAudit(store, account.id, value.scope, 'operations.instance.reserve', key, value);
        return value;
      });
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
        if (operationRequiresGlobal(request.body.operation))
          requireThat(
            identity.decide(account.id, 'global', 'manage'),
            'Global management required',
          );
        requireThat(
          identity.decide(account.id, binding.scope, operationPermission(request.body.operation)),
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
            isDeepStrictEqual(saved.command.operation, request.body.operation) &&
              saved.scope === binding.scope,
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
          command: { instance: binding.instance, operation: request.body.operation },
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
        authority.remember(value, bearer(request.headers.authorization));
        appendAudit(store, account.id, binding.scope, 'operations.job.submit', value.id, {
          action: value.command.operation.action,
          key: request.body.key,
        });
        return value;
      });
      authority.active(intent.id);
      if (operationNeedsApproval(intent.command.operation)) {
        const review = authority.review(intent.id, account.id);
        if (review.status !== 'approved') return review;
      }
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
    permitted(account.id, intent.scope, 'write');
    if (operationNeedsApproval(intent.command.operation)) {
      const review = authority.review(intent.id, account.id);
      if (review.status !== 'approved') return review;
    }
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
  function recorded(id: string) {
    const row = store.db
      .prepare('SELECT host,instance,intent FROM operation_requests WHERE id=?')
      .get(id) as SavedRequest | undefined;
    requireThat(row, 'Operation not found', 404);
    return { ...row, value: JSON.parse(row.intent) as OperationsIntent };
  }
  function pageSearch(query: OperationsPageQuery) {
    const search = new URLSearchParams();
    if (query.cursor !== undefined) search.set('cursor', query.cursor);
    if (query.limit !== undefined) search.set('limit', String(query.limit));
    return search.size ? '?' + search.toString() : '';
  }
  app.post<{ Params: { id: string } }>(OPERATIONS_PATH + '/jobs/:id/cancel', async (request) => {
    const account = owner(request);
    const row = recorded(request.params.id);
    const actor = store.currentCaller();
    const caller = {
      account: account.id,
      client: actor?.client ?? null,
      request: actor?.request ?? randomUUID(),
    };
    store.transaction(() => {
      requireThat(
        identity.decide(account.id, row.value.scope, 'write'),
        'Local authority required',
      );
      appendAudit(
        store,
        account.id,
        row.value.scope,
        'operations.job.cancel.submit',
        row.value.id,
        {},
      );
    });
    const job = await remote<OperationsJob>(
      request,
      row.host,
      EXECUTOR_JOBS_PATH + '/' + encodeURIComponent(row.value.id) + '/cancel',
      operationsJobSchema,
      { actor: caller, expiresAt: now() + OPERATIONS_LEASE_SECONDS },
    );
    requireThat(
      isDeepStrictEqual(job.intent, row.value),
      'Operations host returned a different job',
      502,
    );
    return job;
  });
  const instancePath = OPERATIONS_PATH + '/hosts/:host/instances/:instance';
  app.get<{ Params: { host: string; instance: string } }>(
    instancePath + '/backups',
    async (request) => {
      const account = owner(request);
      const binding = target(request.params.host, request.params.instance);
      permitted(account.id, binding.scope, 'write');
      const page = await remote<OperationsBackupPage>(
        request,
        binding.host,
        EXECUTOR_INSTANCES_PATH + '/' + encodeURIComponent(binding.instance) + '/backups',
        operationsBackupPageSchema,
        undefined,
        { [OPERATIONS_SCOPE_HEADER]: binding.scope },
      );
      requireThat(
        page.backups.every((backup) => backup.instance === binding.instance),
        'Operations host returned another instance backup',
        502,
      );
      return page;
    },
  );
  app.get<{ Params: { host: string; instance: string }; Querystring: OperationsPageQuery }>(
    instancePath + '/jobs',
    { schema: { querystring: operationsPageQuerySchema } },
    async (request) => {
      const account = owner(request);
      const binding = target(request.params.host, request.params.instance);
      permitted(account.id, binding.scope, 'write');
      const page = await remote<OperationsJobPage>(
        request,
        binding.host,
        EXECUTOR_INSTANCES_PATH +
          '/' +
          encodeURIComponent(binding.instance) +
          '/jobs' +
          pageSearch(request.query),
        operationsJobPageSchema,
        undefined,
        { [OPERATIONS_SCOPE_HEADER]: binding.scope },
      );
      requireThat(
        page.jobs.length <= OPERATIONS_MAX_PAGE_ROWS,
        'Operations history page too large',
        502,
      );
      if (page.jobs.length) {
        const rows = store.db
          .prepare(
            'SELECT id,host,instance,intent FROM operation_requests WHERE id IN (' +
              page.jobs.map(() => '?').join(',') +
              ')',
          )
          .all(...page.jobs.map((job) => job.intent.id));
        const saved = new Map(rows.map((row) => [row.id, row]));
        for (const job of page.jobs) {
          const row = saved.get(job.intent.id);
          requireThat(
            row &&
              row.host === binding.host &&
              row.instance === binding.instance &&
              typeof row.intent === 'string' &&
              job.intent.scope === binding.scope &&
              isDeepStrictEqual(job.intent, JSON.parse(row.intent)),
            'Operations host returned a different job',
            502,
          );
        }
      }
      return page;
    },
  );
  app.get<{ Params: { host: string; instance: string }; Querystring: OperationsPageQuery }>(
    instancePath + '/logs',
    { schema: { querystring: operationsPageQuerySchema } },
    async (request) => {
      const account = owner(request);
      const binding = target(request.params.host, request.params.instance);
      permitted(account.id, binding.scope, 'write');
      return remote<OperationsLogPage>(
        request,
        binding.host,
        EXECUTOR_INSTANCES_PATH +
          '/' +
          encodeURIComponent(binding.instance) +
          '/logs' +
          pageSearch(request.query),
        operationsLogPageSchema,
      );
    },
  );
  app.get<{ Params: { host: string; instance: string } }>(
    instancePath + '/observe',
    async (request) => {
      const account = owner(request);
      const binding = target(request.params.host, request.params.instance);
      permitted(account.id, binding.scope, 'read');
      return remote<OperationsObservation>(
        request,
        binding.host,
        EXECUTOR_INSTANCES_PATH + '/' + encodeURIComponent(binding.instance) + '/observe',
        operationsObservationSchema,
      );
    },
  );
  app.get<{ Params: { host: string; instance: string }; Querystring: OperationsPageQuery }>(
    instancePath + '/logs/watch',
    { config: { mcpStream: true }, schema: { querystring: operationsPageQuerySchema } },
    async (request, reply) => {
      const binding = target(request.params.host, request.params.instance);
      const guard = (audit = false) => {
        const account = owner(request);
        requireThat(
          target(binding.host, binding.instance).scope === binding.scope,
          'Operations binding changed',
        );
        if (audit) permitted(account.id, binding.scope, 'write');
        else
          requireThat(
            identity.check(account.id, binding.scope, 'write'),
            'Local authority required',
          );
      };
      guard(true);
      const host = hosts.get(binding.host);
      requireThat(host, 'Operations host is not configured', 503);
      const abort = new AbortController();
      reply.raw.once('close', () => abort.abort());
      const response = await transport(
        host.endpoint +
          EXECUTOR_INSTANCES_PATH +
          '/' +
          encodeURIComponent(binding.instance) +
          '/logs/watch' +
          pageSearch(request.query),
        {
          headers: { Authorization: 'Bearer ' + host.credential },
          redirect: 'error',
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        },
      );
      requireThat(response.ok && response.body, 'Operations stream unavailable', 502);
      const body = response.body;
      async function* output() {
        let complete = false;
        const limit = Math.max(
          1,
          Math.min(OPERATIONS_MAX_PAGE_ROWS, request.query.limit ?? OPERATIONS_MAX_PAGE_ROWS),
        );
        const tail: OperationsLogPage = {
          entries: [],
          cursor: request.query.cursor ?? '0',
          truncated: false,
        };
        try {
          for await (const frame of sseFrames(
            body,
            OPERATIONS_MAX_REQUEST_BYTES + SSE_ENVELOPE_BYTES,
            guard,
          )) {
            requireThat(
              ['logs', 'done'].includes(frame.event) &&
                request.compileValidationSchema(operationsLogPageSchema)(frame.data),
              'Invalid operations stream',
              502,
            );
            const page = frame.data as OperationsLogPage;
            tail.entries.push(...page.entries);
            tail.cursor = page.cursor;
            tail.truncated ||= page.truncated;
            while (
              tail.entries.length > limit ||
              Buffer.byteLength(JSON.stringify(tail)) > OPERATIONS_MAX_REQUEST_BYTES
            ) {
              requireThat(tail.entries.length > 0, 'Operations stream metadata too large', 502);
              tail.entries.shift();
              tail.truncated = true;
            }
            const value = frame.event === 'done' ? tail : page;
            yield 'event: ' + frame.event + '\ndata: ' + JSON.stringify(value) + '\n\n';
            if (frame.event === 'done') {
              complete = true;
              break;
            }
          }
          requireThat(complete, 'Operations stream interrupted', 502);
        } finally {
          abort.abort();
        }
      }
      return reply
        .type('text/event-stream')
        .header('Cache-Control', 'no-cache')
        .send(Readable.from(output(), { objectMode: false, highWaterMark: 1 }));
    },
  );
  return {
    authority,
    dispatch: (request: FastifyRequest, id: string) => {
      const saved = authority.active(id);
      return dispatch(request, saved.host, saved.intent);
    },
    registerClaims() {
      app.post<{ Params: { host: string }; Body: OperationsClaim }>(
        OPERATIONS_CLAIM_PATH + '/:host/claim',
        { schema: { body: operationsClaimSchema } },
        async (request) => {
          const host = hosts.get(request.params.host),
            credential = request.headers[OPERATIONS_CLAIM_HEADER];
          requireThat(
            host &&
              typeof credential === 'string' &&
              credential.length === host.credential.length &&
              timingSafeEqual(Buffer.from(credential), Buffer.from(host.credential)),
            'Executor authorization required',
            401,
          );
          const saved = authority.active(request.body.id);
          requireThat(saved.host === request.params.host, 'Operation belongs to another host');
          const approval = authority.proof(saved.intent.id);
          return {
            intent: saved.intent,
            expiresAt: Math.min(
              now() + OPERATIONS_LEASE_SECONDS,
              (approval?.approvedAt ?? now()) + OPERATIONS_APPROVAL_SECONDS,
            ),
            ...(approval ? { approval } : {}),
          };
        },
      );
    },
  };
}
