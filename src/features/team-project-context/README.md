# Team project context

The feature separates a team **definition** from its project-specific **work history**.

- `contracts/` owns the browser-safe history-mode type.
- `core/` owns the two distinct defaults: existing persisted teams without a field remain shared; newly created teams default to `per_project`.
- The intended application boundary maps a verified logical team and selected project to a native-compatible physical execution team. Do not use a UI filter as isolation.
- Do not create physical contexts merely to read, or infer ownership from an alias prefix.
- Runtime/storage/renderer integration must not expose `per_project` as working until real inbox/task/session isolation is proven.

See [the reviewed implementation plan in Draft PR #1215](https://github.com/777genius/agent-teams-ai/pull/1215/files) in the plan PR #1215.
