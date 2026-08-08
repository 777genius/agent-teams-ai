# Team Roster Mutations

Owns durable and live member roster changes for existing teams.

## Boundaries

- `contracts/` owns the five stable IPC channel names.
- `core/domain/` contains provider ownership, diff, and rollback projection rules.
- `core/application/` coordinates persistence, live runtime reconciliation, notification, and rollback through narrow ports.
- `main/adapters/` validates untrusted IPC input and adapts main-process storage/cache services.
- `main/composition/` is the only place where concrete main services are bound to core ports.

Durable roster metadata is always updated before live attach/detach work. A failed lifecycle action restores metadata before trying to restore runtime state, while preserving the original lifecycle error. Lead notifications are best effort and happen only after successful reconciliation.

These mutations remain desktop-only for compatibility: the browser HTTP client already reports them as unsupported, and this extraction does not add a new hosted-web authority.
