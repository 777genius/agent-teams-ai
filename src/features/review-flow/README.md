# Review flow

## Public renderer surfaces

- `@features/review-flow/renderer` exports the ReviewFlow UI components.
- `@features/review-flow/renderer/http` exports only `createReviewFlowHttpApi`.

The HTTP entrypoint is store-free. The application HTTP adapter imports it so
loading transport code does not initialize ReviewFlow UI, the application store,
or renderer telemetry. The existing factory keeps its browser-mode unavailable
result; Desktop owner routing remains in the original app API composition.

Both surfaces are explicit public entrypoints. Their implementation modules and
descendants of their `index.ts` files remain private under
`eslint.review-flow-boundaries.mts`.

See the [feature architecture standard](../../../docs/FEATURE_ARCHITECTURE_STANDARD.md).
