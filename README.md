# Federated Skin Station

JLUCraft account, Yggdrasil, MUA, skin library, wardrobe, and community services, with a React web portal.

## Setup and structure

`server/` owns authentication and persistence, `shared/` owns shared contracts, and `web/` owns the portal. Install dependencies with `bun install --frozen-lockfile`. Set `SKIN_CONFIG` to an external JSON configuration matching `server/app.ts::Config`; use `bun run dev` for the service and `bun run dev:web` for the portal. `bun run start` runs the service; the frontend output is `dist/`.

## Validation

Select one validation channel for a batch and reuse successful results for unchanged inputs. Standard commands:

```sh
bun run format
bun run build
bun run test
```

`build` runs `bun run check` before bundling. See
[AGENTS.md](AGENTS.md#development-boundaries) for the development check policy.
Generated contracts are regenerated from JSON Schema and are not hand-formatted.

Read [AGENTS.md](AGENTS.md) before making changes.

`shared/contracts/*.schema.json` owns the central service's cross-language contracts.
`bun run contracts` derives the TypeScript schemas and types used by the routes;
installation and the service, build, and test commands run it automatically.
Generated TypeScript is ignored by Git. The sibling game host's build script reads
the same JSON Schema with `typify`; do not maintain handwritten copies of those types.
The session-profile contract drives `hasJoined` and profile lookup; the identity
snapshot contract drives the account's local membership and authority response.
Add business contracts here as their central services are implemented.

The `SKIN_CONFIG` JSON accepts an optional `organization` string of 1–64 lowercase letters, digits, or hyphens, defaulting to `jlucraft`. Changing it prevents decryption of existing AAD-bound MUA secrets and changes the passkey cookie name, launcher client ID used by stored authorization records, and Yggdrasil version string; plan for these effects before changing an existing deployment.

## Central identity and authorization

The store applies ordered SQLite migrations in a transaction and records the completed
version in `PRAGMA user_version`. Schema 2 preserves existing accounts, tokens,
profiles, and `identity_members`; its generated `legacy_member` column exposes
the original member identifier without maintaining a second copy.

`shared/permissions.ts` owns the permission catalog, scope parser, role mapping,
and authorization algorithm. `server/permissions.ts::LocalIdentity` binds it to
SQLite. Call `authorize(account, scope, permission)` on that server-owned instance;
each decision appends an audit entry, including denials. Disabled or missing accounts
cannot authorize. Global administrators bypass membership checks. Other scoped
permissions require active membership in the owning club, including service scopes.
Service permissions inherit from their club and then global; clubs inherit from global.
The built-in `service:mua` scope inherits directly from global.
League, event, workflow, and report scopes inherit from their owning club.

The catalog contains `admin`, `manage`, `president`, `read`, `write`,
`members.manage`, `chairs.manage`, `grants.manage`, `services.manage`, `accounts.recover`, and
the global-only `accounts.disable`. Scoped `manage` covers scoped permissions
except `admin` and the derived `president`; it cannot grant global-only authority.
Grant creation requires both grant-management authority and the permission being
delegated. Membership roles can name catalog permissions
or the `member` role, which grants `read`. President authority derives solely
from the current chair and grants scoped management. Global-only permissions require
an explicit global grant or global administrator authority.

Startup imports each configured site and MUA administrator list independently,
once that list is nonempty, including account IDs that have not registered yet. On a fresh
installation, register the initial administrator, copy the account ID from
`/api/me` into `siteAdmins` in the external configuration, and restart the service.
An empty configuration leaves that initial import pending. The `identity_seeds`
markers prevent subsequent restarts from restoring revoked grants. Schema 3 splits
the import markers and retains completed imports, including revoked grants. All route and
portal administrator decisions read the local authority, including MUA and texture
publication; editing the configuration after the import does not change authority.
The federation identity bridge and its attestation endpoints have been removed.

Configured schools create local clubs, using `school.club` when supplied
and the school key otherwise. Successful email confirmation creates an active
`email_domain` membership in the same transaction. Existing accounts gain membership
when they verify their email again; no historical membership is inferred from the
old trust-log mapping. A revoked membership cannot be reactivated or deleted.
Revoking membership removes the account's grants in that club and its services.
Losing the last active club also deletes access tokens, OAuth refresh tokens, and
approved device authorizations. Login, passkeys, OAuth exchanges, authenticated
requests, and `hasJoined` require an enabled account and an active local membership.
Existing accounts must verify their email again before logging in. The existing
registration flow accepts their current email and password for this purpose.
Previously issued ID tokens retain their original expiration; they are identity
assertions, not the database-backed access tokens removed by this operation.

A club authority proposes a chair appointment and the active nominee accepts it.
Acceptance advances that club's epoch and closes competing proposals; no other club
votes or quorum participate. The first chair can be appointed by a global administrator.
The current HTTP management surface uses Yggdrasil Bearer access tokens:

- `GET /api/identity` returns the caller's account, memberships, grants, and open nominations.
- `GET /api/clubs/:club/members` lists members for authorized club managers;
  `POST /api/clubs/:club/members/:account/revoke` permanently revokes membership.
- `GET` and `POST /api/clubs/:club/successions` list and propose appointments;
  `POST /api/identity/successions/:id/accept` lets the nominee accept.
- `GET /api/identity/grants?scope=...` lists active scoped grants;
  `POST /api/identity/grants` accepts `account`, `scope`, and `permission`;
  `DELETE /api/identity/grants/:id` revokes a grant.
- `POST /api/admin/accounts/:account/disable` disables an account and revokes its sessions.
- `GET /api/clubs` returns manageable clubs and server-computed action availability.
  Member and grant responses use the named definitions in the identity contract;
  grant metadata includes only permissions the caller can delegate.
- `POST /api/clubs/:club/recoveries` sends a recovery confirmation to a new mailbox;
  `POST /api/recovery/confirm` accepts that confirmation and a new password.

The portal's club management page provides membership, succession, grant,
disablement, and recovery actions using those server-reported permissions.
The login page links to the recovery confirmation form. Recovery belongs to the
account's configured home club, requires `accounts.recover`, and confirms the new
mailbox within 15 minutes. An account with global grants requires a global
administrator to initiate recovery. Confirmation rechecks the initiating
authority, the target's active membership, and expiry, then changes the email and
password under one transaction. It retains the account ID, profiles, memberships,
and grants, revokes previous session families and passkeys, and consumes the
confirmation. Migration 4 owns the pending recovery records and the account's
server-owned credential revision. Every token issuance rechecks the account
snapshot against that revision; session revocation advances it, fencing password,
OAuth, or passkey authentication that was still in progress before revocation.
Password constraints
originate in the identity contract and are shared by the service and portal.

Grant revocation requires the permission being removed as well as grant-management
authority. Once an enabled global administrator with active membership exists,
identity actions preserve at least one such administrator in the same transaction.
Publication uses the same administrator-availability rule. A manager can nominate
another member as chair; self-nomination requires current chair or site-admin
authority, which is checked again at acceptance.

Audit entries chain SHA-256 digests of the ordered entry fields and payload digests;
SQLite triggers reject updates and deletes. This is local append-only history, not
an external trust anchor.

## Competitions

`server/league.ts` owns game resources, leagues, teams, seasons, seating, scoring,
and result disputes in SQLite. `shared/contracts/league.schema.json` owns the
request and response contracts. JSON request validation rejects extra fields
without changing command payloads while evaluating action alternatives.
All participants, organizers, hosts, and scorers use account IDs and authenticate
with Yggdrasil Bearer sessions. Club `services.manage` registers resources; club
or league `manage` controls attendance, schedules, starts, pauses, and disputes.
Host and scorer accounts must belong to the resource's club. Members of other
clubs can enter through their own accounts. When `crossClub` is false, each team
keeps its own club affiliation; when true, a team can mix club memberships.

- `GET` and `POST /api/game-resources` list and register resource definitions.
  A resource's club is immutable; its definition remains fixed while a league
  using it is unfinished.
- `GET` and `POST /api/leagues` list and create competitions.
  `GET /api/leagues/:id` returns a snapshot.
- `GET /api/leagues/:id/scoring` returns the designated scorer's competition
  snapshot and an account-to-UUID-list map for eligible registered participants.
  The map includes current primary and extra profiles and follows admission,
  membership, account disablement, and profile changes.
- `POST /api/leagues/:id/actions` accepts the schema's team, attendance,
  presence, start, tick, infrastructure, pause, score, and finish commands.
  Only the designated host submits measured presence and health; only the
  designated scorer submits results and finishes a league.
- `GET /api/leagues/:id/route/:member` returns the member's current destination,
  team, and seat epoch for that member or the designated host. Registered,
  eligible participants wait during registration or a pause; finished games
  have no destination.
- `GET /api/hosted-leagues` lists the caller's assigned leagues while the caller
  remains an active member of each league's club.
- `GET /api/leagues/:id/admission/:profile` lets the designated host resolve a
  current primary or extra Minecraft UUID to its account and authorized route.
  It checks current membership, registration, event check-in and planning policy,
  and rejects finished games. It returns the same seat epoch and address as the
  member route. The native gateway must authenticate the Minecraft session
  through Yggdrasil `hasJoined` before using this routing decision and repeat
  the decision for existing connections as authority or game state changes.
- `GET` and `POST /api/seasons` list and create seasons;
  `POST /api/leagues/:id/schedule` assigns a season and registration/start window.
  `GET /api/seasons/:id/rankings` aggregates finished results.
- `POST /api/leagues/:id/disputes` opens a participant's result dispute.
  Managers list them through `GET` on that route and resolve them through
  `POST /api/league-disputes/:id/resolve`, applying recorded score deltas.

Server time drives registration, grace periods, pauses, and explicit host ticks.
Seating chooses online roster members at the service and advances a persistent
epoch for each assignment. Pauses preserve remaining reconnection time, including
overlapping infrastructure and manual pauses. Score event IDs are replayable only
with the same deltas; failed mutations roll back scores and receipts together.
Membership revocation removes league grants and blocks future participation.

## Activities and approvals

`server/office.ts` owns activities, tasks, enrollment, check-in, notices, artifacts,
and human approval workflows. Migration 6 stores these records centrally.
`shared/contracts/office.schema.json` references the league contract's scheduling
definition; the generator supplies the same schema references to TypeScript and
Fastify. Canonical schemas are registered once at service startup.

- `POST /api/artifacts` accepts a club, title, MIME type, and base64 content up to
  2 MiB. Uploads are immutable; an authorized revision supplies `parent`.
  `GET /api/artifacts/:id/content` downloads authorized content.
- `GET` and `POST /api/events` list visible events and create drafts.
  `GET` and `PUT /api/events/:id` read and revise an event.
  `POST /api/events/:id/actions` submits, publishes, finishes, or cancels it,
  or lets a member sign up, cancel signup, or check in.
  Managers read enrollment through `GET /api/events/:id/attendance`.
- `GET` and `POST /api/events/:id/tasks` list and create tasks.
  `POST /api/tasks/:id/actions` assigns, completes, or schedules a notice.
  `GET /api/notices` lists personal notices;
  `POST /api/notices/:id/acknowledge` acknowledges one after its due time.
- `POST /api/approval-templates` installs or retires a club's current template.
  `GET /api/clubs/:id/approval-templates` lists them.
  `POST /api/workflows` starts an event review with its current epoch and an
  optional template. `GET /api/events/:id/workflows` lists review history.
  `POST /api/workflows/:id/actions` approves, rejects, delegates,
  advances an elapsed deadline, cancels, or executes the approved review.

Templates select individual members, club roles, club quorums, or current chairs.
They can also include an AI review stage with its model, optional provider,
purpose, output-token limit, and point cap. AI stages require a reject timeout
policy and use the document workflow described below.
Instances snapshot their stages and input artifact. Every event review ends with
mandatory consent from each organizing club's current chair, with no automatic
timeout or delegation for that final stage. Other stages can delegate within a
club and use explicit timeout policies. Execution rechecks the proposer and all
approvals against current authority. Revising an event advances its epoch and
cancels pending reviews; earlier artifacts and completed review records remain
historical data.

Drafts and their briefs are visible to participating clubs and assigned reviewers;
published activities are readable by active members. Only the current brief is
shared through an event. Attendance uses the authenticated account and service
time. Assigned tasks require current participating-club membership. Authorization
preparation and mutations share one write lock; rejected preparation retains its
decision audit while failed mutations roll back business changes.

`server/planning.ts` owns event planning in migration 9. Club managers configure
their official or independent status through `GET` and
`PUT /api/clubs/:id/planning-profile`. Managers create or replace an unfinalized
draft through `PUT /api/events/:id/plan`, supplying the current event epoch,
participating clubs and rosters, and candidate resources. Participating managers
and named members read it through `GET` on the same route. Club lists match the
event organizers, and each participant has one club in the plan.
Meeting enrollment follows the named roster; online enrollment selects an active
membership among participating clubs using the identity service's affiliation
order. Enrollment and check-in recheck the current planning policy.

`POST /api/events/:id/plan/actions` records club opinions, meeting consents,
reward rules, the final game selection, and the polished document. Each action
includes the current plan ID. Official meetings require a club manager's consent;
independent meetings require every named participant's personal consent.
Multi-club plans require every club's opinion. Every club sets its own point and
material reward rule. Selecting a resource requires its owner's game-specific
opinion. Finalization rechecks membership and authority and freezes a private
snapshot of the plan and its source documents.

Finalization reserves each selected Minecraft endpoint from check-in opening to
event end. Endpoint identity includes its host and port, with port 25565 as the
default. Aliases with the same endpoint share the reservation. Overlapping events,
duplicate selections, and playing competitions are rejected atomically. Reserved
resources cannot be edited before their reservation ends. Standalone competitions can start after outstanding
event reservations expire or are released. Revision, cancellation, and completion
release reservations; revision also clears the plan and attendance.

Consent documents, transcripts, opinions, and frozen evidence stay private.
Current event managers can read planning evidence; club managers can read their
club's opinions and official consent. Individual consent remains available to its
author and event managers. These documents cannot become event briefs or polished
documents. Frozen input snapshots follow current event authority, including when
the finalizer loses management permission. The polished document is shared with the event and becomes the human
workflow's input. Plans must be finalized and polished before submission, review,
execution, and publication; each transition rechecks current consent and club
policy and event window. Events without a plan retain the direct approval workflow.

## Event games and rewards

`server/event-games.ts` connects planned activities to the league and point
authorities. Migration 10 stores each event/resource's league binding, one
settlement, and award delivery receipts.

- `POST /api/events/:id/games` prepares a selected game with its current plan ID
  and resource ID after check-in opens. Repeating the request returns the same
  league. `GET` on that route returns the bound competitions.
- Players use the league team routes during check-in for manual teams.
  Automatic resources form teams from current check-ins at game start.
  Enrollment owns each player's club for team eligibility and later rewards.
- Event managers start and pause bound leagues through their existing actions.
  The selected resource's host supplies presence and ticks; its scorer supplies
  scores and completion. The event's schedule, check-ins, consent, resource
  approval, and reservation govern play and routing. Direct attendance updates
  and league rescheduling are closed for event games.
- Preparing a game closes event revision. Completing an online activity requires
  every selected game to finish. Cancellation closes all bound leagues, clears
  seating, and releases reservations in the same transaction.
- `POST /api/events/:id/rewards` settles a completed plan once; repeats return
  the recorded awards. Online ranks use exact aggregate scores from players who
  played in the selected leagues. Meetings rank checked-in participants equally.
  Each club's reward rule applies to its enrolled members; place limits include
  ties. Open score disputes must be resolved first. Settlement closes further
  result disputes and changes.
- `GET /api/events/:id/rewards` shows personal awards, each club manager's own
  club awards, or all awards for an event manager.
  `POST /api/events/:id/awards/:account` records `deliver` by the award club's
  current manager and then `receive` by the recipient, using service time.

Point credits, the settlement marker, and award records commit together. A failed
credit rolls back the whole settlement. Historical enrollment determines the
award club; later membership changes keep the earned record, while current
identity and permissions continue to govern spending, management, and play.

## Points and player activity

`server/points.ts` owns the point ledger, activity sources and receipts, daily
limits, and spending authorizations. Migration 7 stores exact unsigned point
amounts as decimal text; calculations use `BigInt`. The points contract owns the
amount limit and activity constants. Membership eligibility and the default
active club selection are shared through `LocalIdentity`.

- `GET` and `POST /api/points/policy` read and configure the daily member cap.
  Configuration requires a global administrator.
- `GET` and `POST /api/activity-sources` list and configure activity sources.
  A global administrator binds each source to a game resource and its host
  account. Reconfiguration preserves the source's processed-window position.
- `POST /api/points/activity-deliveries` accepts the generated `ActivityDelivery`
  contract, atomically archives private telemetry and profile bindings, and
  credits measured activity. Initial delivery validates current UUID ownership.
  Retries require identical measurements and evidence bytes and return the
  original receipt, including after a profile is deleted. Every call rechecks
  current source and host authority.
- `POST /api/points/activity` submits measured, aligned activity slices with
  source-owned immutable telemetry. Current host authority, resource ownership,
  membership, window bounds, active/AFK totals, and bonus limits are checked
  before any credits. Daily member limits apply across sources; source limits
  apply to each source. The service's receipt time selects the credit day.
- `GET /api/points/me` returns the caller's club balances, today's measured
  activity, and the latest 100 ledger entries.
- `GET` and `POST /api/points/allowances` list and authorize the caller's spending
  budgets for a personal request, managed event, or managed report. Replacement advances the
  authorization epoch. An owner can revoke an existing budget after losing its
  club membership; a fresh authorization requires current membership and scope
  authority. Authorization alone does not debit a balance.

Exact receipt replays return their existing result without another credit.
Conflicting payloads and overlapping windows are rejected. Balances, daily
usage, receipt storage, the source position, and audit changes share one
transaction; an overflow rolls back the entire credit batch.

## AI execution and accounting

Set `SKIN_CONFIG.ai` to the generated `AiGatewaySettings` shape. Each provider has
an `id`, registered provider `account`, `protocol`, full endpoint `url`, model
list, document capabilities, and context-token limit. The protocols are
`chat_completions`, `responses`, and `messages`. Supply credentials through
`keyEnv` or a `keyFile` with mode `0600`; select `bearer` or `api_key`
authentication when needed. HTTPS is required outside loopback. `concurrency`
defaults to 4. Register the provider account before configuring it and restarting
the service. Provider addresses and credentials stay outside HTTP responses.

- `GET /api/ai/models` lists configured, priced models with active providers.
  A global administrator sets point prices through `POST /api/ai/pricing`.
- `POST /api/ai/jobs` selects readable input artifacts, a club balance, provider
  and model, generation/review mode, purpose, output-token cap, and point limit.
  A personal request authorizes its bounded spend directly. An optional
  personal/event/report `scope` consumes a matching point authorization; event and report requests
  require current management authority from both requester and payer.
- `GET /api/ai/jobs` lists readable jobs; `GET /api/ai/jobs/:id` returns one.
  `POST /api/ai/jobs/:id/actions` runs, cancels, retries, or advances an elapsed
  deadline. Execution uses the selected provider with uploaded material and
  server-owned task instructions.

The service snapshots pricing and the selected provider's context-token limit.
It quotes the highest cost permitted by that context and the output-token cap,
reserves the quoted amount, and stores the hold in `point_escrows`. Available
balances plus held points stay within the amount limit. Measured provider usage
determines the full final charge; the remainder returns to the payer.
Execution and retries require a provider within the reserved context limit.
Settlement either burns the charge or
credits the registered provider. Point prices use a base fee plus input/output
rates per 1,000 tokens, rounded up. Changing prices leaves existing jobs' pricing
intact. Refunds restore a spending authorization only while its epoch and owner
still match.

Queued cancellation refunds the hold. Running cancellation discards output and
retains the hold until provider completion or the job deadline; measured usage
is charged before refunding the remainder. Late completion after a settled
cancellation or timeout has no further effect. Retries require current authority
and a fresh hold under the job's recorded authorization.

Migration 8 stores AI prices, jobs, holds, and burned totals. Office uploads can
choose `private` visibility, which revisions inherit unless changed by the owner.
AI output is private to the payer and requester; a site administrator can
inspect it. Structured review output is schema-validated, and incomplete reviews
fail. Documents and provider output remain evidence for human decisions.

`server/office-ai.ts` binds AI jobs to finalized activity plans and review stages.
Migration 11 stores document tasks, their private artifact links, and activity
summaries. The document contract references the gateway's model and token limits.

- `POST /api/events/:id/documents` requests `polish` for a finalized draft or
  `summary` for a completed, reward-settled activity, using its current plan ID.
  `GET` lists the event's document tasks for its managers.
- `POST /api/workflows/:id/ai` requests the current AI stage using the template's
  settings. Human votes and delegation cannot supply an AI decision.
- Run or retry the returned job through the AI job actions. Then use
  `POST /api/document-tasks/:id/actions` with `apply` to attach completed output
  to its plan, review stage, or summary. Repeated requests reuse a pending task
  with the same target and settings. `GET /api/document-tasks/:id` returns the
  task and its current job.
- Applied polish becomes the event's shared review document. AI approval advances
  to the following stage, including the mandatory current-chair consent.
  Rejection or `changes_requested` closes that workflow; managers revise the
  event and start a new review. Execution rechecks the provider's membership.
  If the provider loses membership before application, a new stage request
  creates replacement evidence using the currently configured provider.
- Applied summaries remain private until a manager sends `publish` to the
  document task actions. Publication shares the output through the event.

All document jobs consume the event's existing point authorization. Source
snapshots include the plan, original consent documents and transcripts, and,
for reviews and summaries, recorded attendance, games, awards, and tasks.
Inputs and unapplied outputs require current event management; payer or uploader
ownership alone grants no access. Private review details stay outside shared
workflow records. Revision fences old jobs and their private artifacts by plan
and event epoch. Work already running still settles measured usage through the
gateway, while its stale output cannot be applied.

## Club reports

`server/reports.ts` owns annual MUA reports and official clubs' school annual
reviews. Migration 12 stores report policies, drafts, AI job bindings, private
document links, and published versions. Club kind comes from the existing
planning profile.

- `GET` and `PUT /api/clubs/:id/report-policy` read and set each destination's
  recipient and requirements artifact. Setting the policy copies requirements
  into private club-managed documents. Official clubs must provide the school
  annual-review destination.
- `POST /api/reports` creates a report with its ID, club, kind, and closed
  reporting period. School annual reviews require an official club. Creation
  freezes the destination and evidence: published activities starting within the
  period, their public brief and published summary, and the reporting club's
  attendance, awards, and assigned tasks. Private planning documents and other
  clubs' member records stay outside the report. Binary public documents become
  frozen attachments; text documents appear in the evidence itself.
  Task assignment records the assignee's club independently of enrollment, so
  organizers' work is included even when they do not sign up as participants.
- Authorize a point budget for `report:<id>`, then call
  `POST /api/reports/:id/generate` with the current version and AI settings.
  Run the returned job through the AI actions and send `apply` with the version
  to `POST /api/reports/:id/actions`. Matching pending generation requests reuse
  their job.
- Send `revise` with the current version and replacement `content` to create a
  private text revision. Revision advances the version and supersedes pending
  generation. Generating again from existing output also advances the version.
  Send `publish` with the current version to share its output with active members.
- `GET /api/reports` lists managed reports; `GET /api/reports/:id` returns the
  draft and current job. `GET /api/reports/public` lists immutable publications.
  Earlier publications remain readable while later revisions are private.

Evidence and unpublished output follow current report management before uploader,
payer, or requester ownership. Current club managers retain access to requirements
after chair succession. Superseded jobs cannot start or retry; running work still
settles measured usage and its output stays private. Cancel queued jobs through
the AI actions to refund their reserved points.

## Agent management through MCP

Connect an agent to `POST /mcp` with a Yggdrasil or MUA OAuth access token in
`Authorization: Bearer <token>`. The endpoint uses JSON responses over Streamable
HTTP with protocol `2025-11-25`, the protocol already used by the game host.
It is stateless: clients send their session token on every request. Browser
origins must match the configured site origin. Invalid or revoked sessions
return HTTP 401; GET and DELETE return HTTP 405. Notifications return HTTP 202.

Use `initialize`, `tools/list`, `tools/call`, and `ping`. The catalog covers
identity and club management, competitions, activities and approvals, points,
AI document jobs, and reports. Tool names derive from the HTTP method and
route, replacing path parameters with `by_<parameter>`; for example,
`post_reports_by_id_actions` maps to `POST /api/reports/:id/actions`.

Each tool accepts only the `path`, `query`, and `body` objects declared by its
input schema. Those schemas expand the existing route's canonical contracts.
For example, publishing report version 2 uses:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "post_reports_by_id_actions",
    "arguments": {
      "path": { "id": "annual-report" },
      "body": { "action": "publish", "version": 2 }
    }
  }
}
```

Calls invoke the existing local HTTP route with the caller's token and address.
That route owns authorization, audit, transactions, spending, and validation.
JSON responses provide structured content; document downloads provide text,
images, or an embedded PDF resource. Business denials return tool results with
`isError`; invalid RPC methods and arguments return JSON-RPC errors.
Membership and grant changes apply to the next call, including after restart.
