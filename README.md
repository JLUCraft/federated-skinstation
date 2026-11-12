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
The first contract is the Yggdrasil session profile returned by `hasJoined` and
profile lookup. Add business contracts here as their central services are implemented.

The `SKIN_CONFIG` JSON accepts an optional `organization` string of 1–64 lowercase letters, digits, or hyphens, defaulting to `jlucraft`. Changing it prevents decryption of existing AAD-bound MUA secrets and changes the passkey cookie name, launcher client ID used by stored authorization records, and Yggdrasil version string; plan for these effects before changing an existing deployment.

## Local identity foundation

The store applies ordered SQLite migrations in a transaction and records the completed
version in `PRAGMA user_version`. Schema 2 preserves existing accounts, tokens,
profiles, and `identity_members`; its generated `legacy_member` column exposes
the original member identifier without maintaining a second copy.

`shared/permissions.ts` owns the P0 permission catalog, scope parser, role mapping,
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
`members.manage`, `chairs.manage`, `grants.manage`, `services.manage`, and
the global-only `accounts.disable`. Scoped `manage` covers scoped permissions;
it cannot grant global-only authority. Membership roles can name catalog permissions
or the `member` role, which grants `read`. President authority derives solely
from the current chair and grants scoped management. Global-only permissions require
an explicit global grant or global administrator authority.

Startup imports the configured site and MUA administrator lists into grants once,
including account IDs that have not registered yet. The `identity_seeds` marker
prevents restarts from restoring revoked grants. Existing configuration-based route
checks and the federation bridge remain active during P0; switching those consumers
to local authorization is P1.

Configured schools create local clubs, using `school.identity.club` when supplied
and the school key otherwise. Successful email confirmation creates an active
`email_domain` membership in the same transaction. Existing accounts gain membership
when they verify their email again; no historical membership is inferred from the
old trust-log mapping. A revoked membership cannot be reactivated or deleted.
Revoking membership removes the account's grants in that club and its services.
Losing the last active club also deletes access tokens, OAuth refresh tokens, and
approved device authorizations. Previously issued ID tokens retain their original expiration; they are identity
assertions, not the database-backed access tokens removed by this operation.

A club authority proposes a chair appointment and the active nominee accepts it.
Acceptance advances that club's epoch and closes competing proposals; no other club
votes or quorum participate. The first chair can be appointed by a global administrator.
Audit entries chain SHA-256 digests of the ordered entry fields and payload digests;
SQLite triggers reject updates and deletes. This is local append-only history, not
an external trust anchor.
