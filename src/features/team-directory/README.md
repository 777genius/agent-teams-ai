# Team Directory

The renderer public entrypoint exposes a pure projection for browsing complete Desktop or
Hosted team snapshots. It owns search, status-filter union, source-specific order and
scope-fenced open-intent resolution. It does not load, cache or persist canonical teams.

- Desktop adapters supply existing resolved status as `running`/`offline`, or `unknown`
  when evidence is missing. They supply team name, description, project match and a
  finite activity timestamp. `partial_skipped` remains running under the existing
  Desktop status predicate.
- Hosted adapters supply canonical workspace/team IDs as opaque keys and only safe
  fields received from the server. A static `ready` or `degraded` lifecycle is not
  evidence of runtime state. Unknown remains visible in All and outside both filters.
- Callers project only complete source snapshots. Failed, partial or stale reads retain
  their source-owned freshness/error state; this projection cannot declare an empty
  result to mean that a paginated source is complete.
- A row click carries `scopeKey`, `targetKey` and `readEpoch`. The composition resolves
  it against the current rows before invoking its existing Desktop tab or Hosted panel
  navigation owner.

The renderer exposes props-only query, status and row presentation shared by both
consumers. Desktop adds its rich card details and commands in a Desktop-only adapter;
Hosted renders only server-provided facts. The shared row list never owns loading,
navigation or command admission.
