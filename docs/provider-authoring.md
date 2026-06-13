# Provider Authoring

New providers should implement the provider session and agent ports from
`@vioxen/subscription-runtime/core`.

Rules:

- no provider-specific fields in `core`;
- no queue or HTTP framework dependencies in providers;
- no backend storage decisions in providers;
- expose a provider module through a subpath export, for example
  `@vioxen/subscription-runtime/provider-claude`.

Provider task adapters should follow `docs/pluggable-agent-runtime.md`:

- keep task execution as the default public contract;
- keep provider-specific run lifecycles private unless at least two providers or
  one product workflow need a public managed-run port;
- report provider-neutral telemetry instead of encoding provider details in
  `metadata`.
- expose streaming through provider-neutral `ProviderTaskEvent` only when the
  host needs live progress.

Concrete SDK or process runtimes belong at the provider adapter boundary, not
in `core`. For example, `provider-claude` exposes `ClaudeTaskAgentDriver` for
injected engines and `ClaudeRuntimeTaskExecutionEngine` for composition roots
that install `claude-runtime`. The bridge uses dynamic imports, so consumers
that do not opt into Claude execution do not need the Claude runtime package.
Keep SDK/module loading, process runner creation, filesystem shims and provider
state construction outside the task engine when those details can change for
different operational reasons. `provider-claude` does this through a dedicated
Claude BG runtime-context factory.

If a provider offers streaming, expose only provider-neutral
`ProviderTaskEvent` values and apply the same `RedactorPort` policy as the
non-streaming `runTask` path. This includes text deltas, completed task output,
structured output, warnings, diagnostic details, telemetry tool calls and
structured tool input before they cross the adapter boundary. Diagnostic
details should be bounded previews, not raw provider logs.
