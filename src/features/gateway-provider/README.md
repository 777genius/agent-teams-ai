# Gateway providers

Desktop-only feature for per-teammate API-key routing through an Anthropic/OpenAI-compatible gateway. The team lead keeps its existing connection.

- `contracts/index.ts`: profile/binding DTOs and IPC API; credentials are input-only.
- `core/domain/index.ts`: canonical endpoint and immutable owner/source identity policies.
- `main/index.ts`: composition, usage-source access and runtime mappings.
- `preload/index.ts`: gateway IPC bridge.
- `renderer/index.ts`: profile settings and the member gateway selector.

`GatewayProviderService` owns profile, key-owner and binding changes. `JsonGatewayProviderStore` serializes those changes; literals live in the existing `ApiKeyService`. Sources retain their endpoint, approval and owner after a profile or binding is removed.

The app shell composes runtime integrations in `src/main/services/gateway/createGatewayLaunchRuntime.ts`. Its app-owned run metadata records the source before spawn, associates native sessions immutably and retains terminal facts after team files disappear. Token usage imports daily UTC aggregates through the public usage port; marked runs do not also import CLI costs. OpenCode artifacts use the existing connector writer and are retired only after their bindings and live consumers are gone.

See [`gateway-provider-per-teammate-plan.md`](../../../docs/plans/gateway-provider-per-teammate-plan.md) for the gateway contract and acceptance criteria.

Focused verification:

```sh
pnpm exec vitest run src/features/gateway-provider src/features/token-usage/main/infrastructure/__tests__/GatewayUsageImporter.test.ts src/main/services/gateway
pnpm typecheck
pnpm guard:source-file-size
pnpm guard:team-provisioning-architecture
```

The desktop E2E driver owns an isolated app/home and a marked disposable project. It uses fresh test-only sub2api keys and an in-process mock upstream with real CLI runtimes. Start the verified local sub2api stand first, then supply its local-test admin env file and a compatible orchestrator launcher:

```sh
GATEWAY_E2E_STAND_ENV=/path/to/test-stand/.env \
CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH=/path/to/orchestrator/cli-source \
pnpm exec node scripts/e2e/gateway-provider-live-desktop.mts --scenario all
```

Use the built `cli` for the packaged compatibility pass. The driver reports its private evidence directory and cleans only the app, teams and stand entities it created. The UI driver can also attach to that driver's owned fixture via `--fixture`; it never attaches to an arbitrary running app.
