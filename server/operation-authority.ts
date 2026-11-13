import type {
  OperationsApproval,
  OperationsHumanApproval,
  OperationsIntent,
} from '../shared/contracts/generated.js';
import {
  operationNeedsApproval,
  operationPermission,
  operationRequiresGlobal,
  OPERATIONS_APPROVAL_SECONDS,
} from '../shared/operations.js';
import { MCP_PATH, MCP_WRITE_SCOPE } from '../shared/oauth.js';
import { appendAudit, type LocalIdentity } from './permissions.js';
import { digest, now, requireThat, type Store } from './store.js';

export class OperationAuthority {
  constructor(
    private readonly store: Store,
    private readonly identity: LocalIdentity,
    private readonly origin: string,
  ) {}
  recorded(id: string) {
    const row = this.store.db
      .prepare('SELECT host,instance,intent FROM operation_requests WHERE id=?')
      .get(id) as { host: string; instance: string; intent: string } | undefined;
    requireThat(row, 'Operation not found', 404);
    return {
      host: row.host,
      instance: row.instance,
      intent: JSON.parse(row.intent) as OperationsIntent,
    };
  }
  remember(intent: OperationsIntent, token: string) {
    const session = this.store.oauthSession(token);
    requireThat((session?.client ?? null) === intent.actor.client, 'Operation client mismatch');
    this.store.db
      .prepare('INSERT INTO operation_origins VALUES(?,?,?)')
      .run(intent.id, session?.id ?? null, session ? null : digest(token));
    if (operationNeedsApproval(intent.command.operation))
      this.store.db
        .prepare("INSERT INTO operation_approvals VALUES(?,'pending',?,NULL)")
        .run(intent.id, now() + OPERATIONS_APPROVAL_SECONDS);
  }
  private inspect(id: string) {
    const saved = this.recorded(id),
      intent = saved.intent;
    const bound = this.store.db
      .prepare('SELECT scope FROM operation_targets WHERE host=? AND instance=?')
      .get(saved.host, saved.instance) as { scope: string } | undefined;
    requireThat(bound?.scope === intent.scope, 'Operation scope changed', 409);
    const origin = this.store.db
      .prepare('SELECT session,token FROM operation_origins WHERE request=?')
      .get(id) as { session: string | null; token: string | null } | undefined;
    requireThat(origin, 'Operation authorization revoked');
    if (origin.session) {
      const session = this.store.db
        .prepare(
          'SELECT account,client,scope,resource FROM oauth_sessions WHERE id=? AND EXISTS(SELECT 1 FROM tokens WHERE session=oauth_sessions.id AND expires>?)',
        )
        .get(origin.session, now()) as
        | { account: string; client: string; scope: string; resource: string }
        | undefined;
      requireThat(
        session?.account === intent.actor.account &&
          session.client === intent.actor.client &&
          session.scope.split(' ').includes(MCP_WRITE_SCOPE) &&
          session.resource === new URL(MCP_PATH, this.origin).href,
        'Operation authorization revoked',
      );
    } else {
      requireThat(
        this.store.db
          .prepare(
            'SELECT 1 FROM tokens WHERE hash=? AND account=? AND expires>? AND session IS NULL',
          )
          .get(origin.token, intent.actor.account, now()),
        'Operation authorization revoked',
      );
    }
    this.identity.authenticate(intent.actor.account);
    this.store.withCaller(intent.actor.client, intent.actor.request, () => {
      if (operationRequiresGlobal(intent.command.operation))
        requireThat(
          this.identity.decide(intent.actor.account, 'global', 'manage'),
          'Global management required',
        );
      requireThat(
        this.identity.decide(
          intent.actor.account,
          intent.scope,
          operationPermission(intent.command.operation),
        ),
        'Local authority required',
      );
    });
    this.preparation(intent, saved.host);
    return saved;
  }
  private preparation(intent: OperationsIntent, host: string) {
    const operation = intent.command.operation;
    if (operation.action !== 'deploy') return undefined;
    const saved = this.recorded(operation.preparation);
    requireThat(
      saved.host === host &&
        saved.instance === intent.command.instance &&
        saved.intent.scope === intent.scope &&
        saved.intent.command.operation.action === 'deploy_prepare',
      'Deployment preparation differs from this target',
      409,
    );
    return saved.intent;
  }
  active(id: string) {
    return this.store.transaction(() => this.inspect(id));
  }
  proof(id: string): OperationsHumanApproval | undefined {
    const { intent } = this.recorded(id);
    if (!operationNeedsApproval(intent.command.operation)) return undefined;
    const row = this.store.db
      .prepare('SELECT state,approved_at FROM operation_approvals WHERE request=?')
      .get(id) as { state: string; approved_at: number | null } | undefined;
    requireThat(
      row?.state === 'approved' &&
        row.approved_at !== null &&
        row.approved_at + OPERATIONS_APPROVAL_SECONDS > now(),
      'Fresh human approval required',
    );
    return { account: intent.actor.account, request: id, approvedAt: row.approved_at };
  }
  review(id: string, account: string): OperationsApproval {
    const saved = this.recorded(id);
    requireThat(
      saved.intent.actor.account === account,
      'Operation belongs to another administrator',
    );
    this.active(id);
    const row = this.store.db
      .prepare('SELECT state,expires FROM operation_approvals WHERE request=?')
      .get(id) as { state: OperationsApproval['status']; expires: number } | undefined;
    requireThat(row, 'Operation approval not found', 404);
    const client = saved.intent.actor.client
      ? (this.store.db
          .prepare('SELECT name FROM oauth_clients WHERE id=?')
          .get(saved.intent.actor.client) as { name: string } | undefined)
      : undefined;
    const preparation = this.preparation(saved.intent, saved.host);
    return {
      id,
      host: saved.host,
      intent: saved.intent,
      status: row.state === 'pending' && row.expires <= now() ? 'expired' : row.state,
      expiresAt: row.expires,
      reviewUrl: new URL('/portal/?operation_request=' + encodeURIComponent(id), this.origin).href,
      clientName: client?.name ?? null,
      ...(preparation ? { preparation } : {}),
    };
  }
  decide(id: string, browserToken: string, approve: boolean) {
    return this.store.transaction(() => {
      const account = this.store.token(browserToken, undefined, now()).id;
      requireThat(!this.store.oauthSession(browserToken), 'Browser sign-in required');
      const saved = this.inspect(id);
      requireThat(
        saved.intent.actor.account === account,
        'Operation belongs to another administrator',
      );
      const changed = this.store.db
        .prepare(
          "UPDATE operation_approvals SET state=?,approved_at=?,expires=? WHERE request=? AND state='pending' AND expires>?",
        )
        .run(
          approve ? 'approved' : 'denied',
          approve ? now() : null,
          now() + OPERATIONS_APPROVAL_SECONDS,
          id,
          now(),
        );
      requireThat(changed.changes === 1, 'Operation approval expired or already decided', 409);
      appendAudit(
        this.store,
        account,
        saved.intent.scope,
        approve ? 'operations.job.approve' : 'operations.job.deny',
        id,
        { client: saved.intent.actor.client },
      );
      return saved;
    });
  }
}
