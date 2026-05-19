# Messenger Connectors Uncertainty Pass 90

Date: 2026-05-16
Scope: fresh-code alignment against `dev` commit `2beb4dae`

## What Was Rechecked

This pass looked for drift between the messenger architecture docs and the current code on the active `dev` worktree.

Checked fresh local files:

- `docs/FEATURE_ARCHITECTURE_STANDARD.md`
- `src/features/CLAUDE.md`
- `src/main/services/infrastructure/HttpServer.ts`
- `src/main/http/index.ts`
- `src/main/http/events.ts`
- `src/features/recent-projects/main/adapters/input/http/registerRecentProjectsHttp.ts`
- `src/features/member-work-sync/main/composition/createMemberWorkSyncFeature.ts`
- `src/features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore.ts`
- root `package.json`
- `pnpm-lock.yaml`

## Fresh Findings

Feature shape is now even more explicit:

```text
src/features/<feature-name>/
  contracts/
  core/domain/
  core/application/
  main/composition/
  main/adapters/input/
  main/adapters/output/
  main/infrastructure/
  preload/
  renderer/
```

This confirms `src/features/messenger-connectors/` as the correct home. The messenger feature is full-slice because it owns domain policy, providers, storage, HTTP routes, shell bridge, renderer UI, local runtime delivery and future provider adapters.

HTTP-first local API still fits:

```text
renderer or browser UI
-> existing Fastify HttpServer
-> registerMessengerConnectorsHttp()
-> feature facade
-> core use cases through ports
```

`HttpServer` still binds to `127.0.0.1` by default and registers route modules in `src/main/http/index.ts`. However, global CORS is not enough because standalone mode can allow all origins. Messenger mutating routes still need feature-local Host, Origin, local session and CSRF checks before the facade is called.

Storage wording needed a correction:

```text
wrong emphasis:
  sharded VersionedJsonStore is the named MVP implementation

better current emphasis:
  MessengerStateStorePort + MessengerUnitOfWork are the contract
  feature-owned file-locked versioned JSON physical tables are the MVP adapter
  VersionedJsonStore and JsonMemberWorkSyncStore are reference patterns
```

The fresh `member-work-sync` feature is important because it is a current example of a large feature-owned store:

- feature-local composition root;
- sharded member/index JSON files;
- schema version guards;
- `withFileLock`;
- `atomicWriteAsync`;
- index repair;
- invalid-file quarantine;
- audit journal;
- no core dependency on the concrete storage class.

Messenger should copy the pattern and adapt it to message/update/outbox ledgers, not import or couple to `member-work-sync`.

## Dependency Reality

Root desktop app dependencies currently include Fastify directly, but do not include:

- Telegram SDKs;
- `@grammyjs/types`;
- `zod`;
- SQLite drivers;
- Redis clients;
- BullMQ;
- Bottleneck;
- `fast-check`.

`mcp-server` uses `zod` `4.3.6`, but that is not the same as a direct desktop feature dependency.

Therefore the current library recommendation remains:

```text
MVP Telegram adapter:
  raw fetch
  planned @grammyjs/types dependency for Bot API typing
  strict local guards now
  zod schemas if added to the desktop bundle
  custom durable outbox and keyed executor
```

## Updated Current Rule

Messenger storage rule:

```text
core/application:
  MessengerStateStorePort
  MessengerUnitOfWork
  logical repositories

main/infrastructure/stores:
  feature-owned file-locked versioned JSON adapter
  physical shards by connection, route and time window where useful
  durable indexes for due work
  invalid-file quarantine
  repair/rebuild paths

future:
  SQLite adapter if volume or transaction pressure proves JSON is not enough
  NDJSON/WAL adapter only if write amplification becomes the bottleneck
```

The domain and application layers should never import `VersionedJsonStore`, `JsonMemberWorkSyncStore`, Fastify, Electron, Telegram clients, filesystem helpers or existing team services.

## Remaining Risks

1. Store schema design - 🎯 8.8   🛡️ 9.2   🧠 7
   The storage boundary is now clear, but the exact shard/index split still needs implementation design. Approx `1800-3600` LOC for the first robust adapter and tests.

2. Local HTTP auth integration - 🎯 9.0   🛡️ 8.8   🧠 6
   The needed protections are straightforward, but the app does not yet have a reusable local session system for protected `/api/*` routes. Approx `900-1800` LOC for session issue/burn, cookie, CSRF and route tests.

3. Fresh-code merge drift - 🎯 8.5   🛡️ 8.7   🧠 5
   The messenger docs branch is older than `dev`, so implementation should rebase or cherry-pick docs carefully before coding. Approx `300-900` LOC of doc/code adjustment risk depending on how much `dev` moves.

## Confidence After This Pass

Overall architecture coherence:

🎯 9.6   🛡️ 9.5   🧠 6

The docs now align with fresh code without overfitting to one storage class. The main remaining uncertainty is implementation detail, not product or architecture direction.
