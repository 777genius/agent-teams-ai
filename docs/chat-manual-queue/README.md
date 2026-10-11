# Manual message queue handoff

The accepted implementation specification is [plan.md](plan.md), SHA-256
`788971fe19c90d58b0caa2107d299d122c9eed7fe05a1c2db1cb23583565d4b2`.
The design reference is [reference.png](reference.png).

Use Cmd+Enter on macOS or Ctrl+Enter elsewhere to save ordinary text in the
current chat's queue. Enter sends the working draft and Shift+Enter inserts a
newline. Each queued row has independent Send, Edit, and Delete controls; sending
one row never sends the next. Inline edits leave the working composer untouched.

Queues remain scoped to the effective local team root, context, authoritative SSH
host, team, and chat. Group items retain the selected group recipient; All means
the current group membership at send time. Direct items retain Do/Ask mode and
member identity. Attachments, file chips, cross-team messages, commands, revision
actions, and restored unknown sends are excluded visibly.

Adding a row atomically saves it and consumes only the captured durable working
draft revision. Concurrent typing remains a working draft. Each explicit send
gets a fresh attempt id distinct from the queue item id. Once a transport result
is uncertain, the row freezes; Copy and an exact-id history check remain
available. Removing that record does not cancel delivery, and resending its text
may create a duplicate. A deterministic rejection before canonical group save
returns the row to editable state for a later explicit attempt.

Verification covers keyboard/inline editing, real IndexedDB rollback and
recovery, captured direct/group routes, the shared ordinary-send latch, and
concurrent typing. Hosted renderer integration and visual checks are recorded
separately by the integration coordinator. No provider, runtime, MCP, event,
reaction, or main-process queue behavior is added.
