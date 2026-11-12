# Federated Skin Station

JLUCraft account, Yggdrasil, MUA, skin library, wardrobe, and community services, with a React web portal.

## Setup and structure

`server/` owns authentication and persistence, `shared/` owns shared contracts, and `web/` owns the portal. Install dependencies with `bun install --frozen-lockfile`. Set `SKIN_CONFIG` to an external JSON configuration matching `server/app.ts::Config`; use `bun run dev` for the service and `bun run dev:web` for the portal. `bun run start` runs the service; the frontend output is `dist/`.

## Validation

Select one validation channel for a batch and reuse successful results for unchanged inputs. Standard commands:

```sh
bun run build
bun run test
```

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
League, event, and workflow scopes parse but have no local resource implementation yet
and deny scoped authorization until their ownership is implemented.

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
