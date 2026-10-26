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
