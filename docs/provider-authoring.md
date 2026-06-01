# Provider Authoring

New providers should implement the provider session and agent ports from
`@777genius/subscription-runtime/core`.

Rules:

- no provider-specific fields in `core`;
- no queue or HTTP framework dependencies in providers;
- no backend storage decisions in providers;
- expose a provider module through a subpath export, for example
  `@777genius/subscription-runtime/provider-claude`.
