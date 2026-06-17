# Environment and Data Safety (PARAMOUNT)

Verify the target before every operation affecting external systems.

## Environment Verification

- State which environment will be affected and confirm before executing.
- Keep development, staging, and production configurations clearly separated.
- Copy production data to development only with explicit approval.

## Kubernetes Cluster Isolation

- Before ANY kubectl/helm/K8s MCP operation, verify context and server URL via `kubectl config view --minify` (context name alone is insufficient).
- If context does not match this project's cluster, STOP and alert the user.
- Specify namespace explicitly. Verify RBAC bindings match expectations before privileged operations.

## Data Safety

- Destructive operations (DROP, TRUNCATE, DELETE without WHERE, down-migrations) require explicit approval.
- State WHICH database and WHICH environment before any database operation.
- Back up data before migrations in non-development environments.

## Resource Cleanup

- Stop/delete temporary files, containers, port-forwards, and local services when done.
- Before ending a session, verify no orphaned processes remain.
