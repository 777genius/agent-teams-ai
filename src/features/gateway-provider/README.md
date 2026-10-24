# Gateway providers

Desktop-only feature for per-teammate API-key routing through an Anthropic/OpenAI-compatible gateway. The team lead keeps its existing connection.

- `contracts/index.ts`: profile/binding DTOs and IPC API; credentials are input-only.
- `core/domain/index.ts`: canonical endpoint and immutable owner/source identity policies.
- `main/index.ts`: composition, usage-source access and runtime mappings.
- `preload/index.ts`: gateway IPC bridge.
- `renderer/index.ts`: profile settings, member selector and dialog-local binding lookup.

`GatewayProviderService` owns profile, key-owner and binding changes. `JsonGatewayProviderStore` serializes those changes; literals live in the existing `ApiKeyService`. Sources retain their endpoint, approval and owner after a profile or binding is removed.

Local-network approval follows the existing local-provider policy and classifies literal IPs and `.local` hostnames. DNS resolution remains with the HTTP client and native CLIs: an ordinary HTTPS hostname can resolve to a private address. DNS pinning and rebinding protection require separate network-layer work and are outside this feature's agreed scope.

The app shell composes runtime integrations in `src/main/services/gateway/createGatewayLaunchRuntime.ts`. Its app-owned run metadata records the source before spawn, associates native sessions immutably and retains terminal facts after team files disappear. Token usage imports daily UTC aggregates through the public usage port; marked runs do not also import CLI costs. OpenCode artifacts use the existing connector writer and are retired only after their bindings and live consumers are gone.

Dialogs preserve gateway models and skip global account/catalog checks only for bound teammates. Binding lookup settles before model normalization; main revalidates the exact credential on every launch and restart.

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

Binding changes for connections saved before a team form opens are explicit saved
credential actions and survive roster cancellation. The selector explains this.
Bindings first allocated for an unsaved member are persisted with the issuing renderer
document's ownership and removed on cancellation. Renderer termination/reload and app
startup recover those provisional receipts under the existing roster configuration
fence. Initial recovery starts in the background after that fence is wired and does
not gate app startup or ordinary gateway APIs. Service-local live owners protect
current renderer drafts; startup reclaims only previous-process receipts, while
explicit renderer-loss recovery releases its owner's receipts. Saved members in `members.meta.json` or `config.json`, launch-history sources,
and runtime artifacts retain their bindings and immutable key ownership. Recovery
never infers abandonment from age or an offline team. Unreadable roster/history
evidence preserves that team's ownership, logs a safe warning, and lets healthy
teams continue; legacy unmarked
bindings retain their existing behavior. Unused draft sources release their key
fingerprint; shared API-key editor records are retained.
