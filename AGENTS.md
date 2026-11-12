# AGENTS.md — federated-skinstation

Follow the workspace rules in `../AGENTS.md`. Read [README.md](README.md) for project scope, setup, and standard validation commands.

## Documentation ownership

Keep project documentation in the root `AGENTS.md` and `README.md` only. Product content and required license files retain their existing locations. Workspace progress and evidence belong in `../TODO.md`; unresolved issues belong in `../PROBLEMS.md`. These workspace records are machine-local and are not published.

## Development boundaries

`server/` owns authentication and persistence, `shared/` owns shared contracts, and `web/` owns the portal. Install dependencies with `bun install --frozen-lockfile`. Set `SKIN_CONFIG` to an external JSON configuration matching `server/app.ts::Config`; use `bun run dev` for the service and `bun run dev:web` for the portal. `bun run start` runs the service; the frontend output is `dist/`.

The skin station is the central account and authorization authority. Consolidate
identity, permissions, league, events, approvals, and points here, keyed by
`accounts.id`. Retire federation bridge consumers as each subsystem moves here.
Institutional email verification enrolls the matching club; membership revocation
is permanent. Chair succession and recovery belong to each club.
Cross-language contracts originate in `shared/contracts/*.schema.json`.
Generate TypeScript with `bun run contracts` and Rust with the host's `typify`
build script. Never edit generated types.

Change only the affected subsystem. Use existing dependencies and build directories. Finish each batch before validation; select one validation channel and reuse successful evidence for unchanged inputs. Report skipped checks and device execution limits explicitly.

Every batch must pass `bun run check` before review and commit. It runs Oxfmt
format checking, strict TypeScript checking, and type-aware Oxlint with zero
warnings. Run `bun run format` to apply formatting, then `bun run build` and
`bun run test`. Include all authored TypeScript in the project, including shared
types, scripts, and tests. Do not use `any` or suppress unsafe-value rules to make
checks pass. Keep external JSON as `unknown` until narrowed or parsed through a
declared contract. Generated contracts remain owned by their JSON Schemas.
