# Hosted v1 authentication

Status: implementation in progress
Decision owner: `src/features/hosted-access`
Supersedes: any earlier hosted-web note that deferred OIDC

## Decision

Hosted v1 has exactly one public authentication mode per deployment:

- `AUTH_MODE=personal` uses a ten-minute, one-time pairing challenge and one personal owner.
- `AUTH_MODE=oidc` uses generic OpenID Connect Authorization Code Flow with state, nonce and
  PKCE. It never falls back to pairing when discovery, JWKS, token exchange or the IdP is
  unavailable.

The first successful startup durably claims the configured mode in
`hosted_auth_configuration`. A later startup with the other mode fails closed with
`hosted_auth_mode_change_requires_host_reset`; it cannot turn an OIDC outage into a personal
pairing surface. A mode change is possible only through the local Unix-socket CLI, a strictly newer
reset generation and exact, current, target-bound AR drain evidence. It atomically changes the
durable claim, invalidates personal credentials, revokes OIDC sessions, deletes pending OIDC login
attempts and appends its audit event. The serving process then refuses every HTTP and local
administration operation until it is restarted with the target profile. Personal credential reset
is a separate operation and also requires exact, current AR drain evidence.

Keycloak is a supported OIDC deployment profile, not an application-core dependency. Both modes
resolve to immutable Agent Teams `UserId` values and the same server-side role/permission policy.
The desktop owner and hosted users use shared application use cases; Electron, Fastify, SQLite,
files and OIDC HTTP are outside `core`.

One deployment owns one runtime root, supports multiple human users and has exactly one backend
controller. Desktop and hosted processes must never mutate the same runtime root concurrently.
Agent Runtime (AR) remains the only process-supervision, provider-execution and runtime-recovery
owner. Local runner/relay and hosted terminal are not v1 capabilities.

Both Compose authentication profiles mount the same `agent-teams-data` authority volume and use
the same explicit controller container name. This makes a second profile, replica or Compose
project on the same Docker daemon fail admission before it can expose another controller, while
the durable mode claim independently refuses a mode change against that shared volume. The
deployment must never copy or mount this volume into a concurrently running desktop process.

Export `HOSTED_SECRETS_DIR` as an absolute path outside the repository before every Compose
invocation. Compose interpolates the shared file before applying profiles. Both profiles require
`$HOSTED_SECRETS_DIR/lifecycle_orchestrator_trust_anchor` and
`$HOSTED_SECRETS_DIR/lifecycle_owner_release_pin.json`; a personal-only deployment therefore
cannot use an empty secret directory. From the repository root, run
`node scripts/hosted-auth-cli.mjs preflight` before Compose so the canonical path is proven to be
outside the repository Docker build context.

## External lifecycle-owner handoff

Compose never starts a lifecycle owner. Before either authentication profile starts, the one
external AR/lifecycle launcher must exclusively own a dedicated run directory and create its
`orchestrator-lifecycle.sock` there. Set `HOSTED_LIFECYCLE_ORCHESTRATOR_RUN_DIR` to the canonical
absolute path of that narrow directory, not `/run`, `/tmp`, a home directory or another shared
root. The controller receives the directory read-only and is the only Compose service that can
connect to the socket. The bind uses `create_host_path: false`, so a missing or misspelled owner
directory fails instead of silently creating an empty root-owned directory. The external owner
must admit container UID/GID `1000:1000` to connect to that socket without making unrelated runtime
state visible. There is no supported fallback owner, in-process lifecycle executor or second
controller.

Release admission has two independent inputs. The external launcher writes
`lifecycle-owner-admission.json` beside the socket, as UID/GID `1000:1000` and mode `0400`, and
signs `agent-teams.hosted-lifecycle-owner-admission/v2\0` plus its exact canonical payload with an
Ed25519 launcher key. Separately, the reviewed
deployment/release process provisions
`$HOSTED_SECRETS_DIR/lifecycle_owner_release_pin.json`; the owner must not generate or rewrite this
pin. It is canonical one-line JSON (with an optional final newline) in this shape:

```json
{
  "format": "agent-teams.hosted-lifecycle-owner-release-pin/v2",
  "artifact": {
    "artifactDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "imageReference": "registry.example/agent-teams-owner@sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "artifactVersion": "1.0.0",
    "protocolVersion": 2
  },
  "launcher": {
    "algorithm": "ed25519",
    "publicKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "keyId": "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925"
  }
}
```

`publicKey` is the canonical unpadded base64url encoding of the raw 32-byte Ed25519 public key;
`keyId` is the lowercase SHA-256 digest of those raw bytes. The manifest carries a detached
Ed25519 signature and the same key ID. Its signed payload binds the exact artifact metadata and
digest, live socket identity, bootstrap digest, mount generation, and expected owner binding. The
manifest artifact must match the independent pin exactly. A compromised runtime owner therefore
cannot approve a different build, socket, or bootstrap using the readiness HMAC key.

Before signing, the launcher must resolve or measure the digest of the actual executable or image
bytes it is about to launch and compare that observation, plus image reference, artifact version,
and protocol version, with the release pin. It must derive the manifest artifact fields from that
measured launch observation and fail closed on any mismatch. Copying the pin's claimed metadata
into a payload without measuring the launched artifact is forbidden.

The runtime owner and controller share one 32-byte proof key encoded as exactly 64 lowercase
hexadecimal characters. It authenticates readiness and command frames only; it is not a launcher
signing key. Store the controller copy, with at most one trailing newline, at
`$HOSTED_SECRETS_DIR/lifecycle_orchestrator_trust_anchor`; keep the enclosing directory mode
`0700` and both source files mode `0444`. The broad-looking source mode is required because local
Compose file secrets do not portably remap ownership, while the non-traversable parent protects
the host files. A networkless UID-1000 one-shot initializer validates the inputs and copies both
into the `agent-teams-lifecycle-trust` volume as UID/GID `1000:1000`, mode `0400`. The controller
mounts only that derived volume read-only. Give the external owner the same proof key through its
launcher's independent protected input; never put the key in the Compose environment, command
line, logs or the owner socket directory. Keep the Ed25519 private launcher key in a separate
protected launcher input that is never mounted into the controller, copied into the two-file
lifecycle trust volume, exposed through environment variables, or made available to the runtime
owner after the launcher handoff is complete.

The bounded hosted-v1 E2E fixture deliberately co-locates fake launcher and fake owner code in one
test process so it can publish a live-socket manifest. Its private Ed25519 key is still delivered
through a fake-runtime-only `0400` mount that the controller cannot see. That co-location is
test-only and is not an acceptable production launcher/runtime topology. The fixture still feeds
its marker-owned trust anchor and release pin through Compose file secrets and the same networkless
`hosted-volume-init lifecycle-trust-anchor` handoff used by production; neither controller nor fake
owner bind-mounts the source trust directory.

The same launcher transaction must emit the exact serialized lifecycle-read bootstrap bound to
the current deployment, runtime roots and owner instance. Export that unmodified value as
`AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP`; do not hand-author, cache across an owner
restart or copy it from the bounded E2E fixture. Start Compose only after the socket, proof key and
bootstrap describe the same live owner, the authenticated admission manifest is durable beside the
socket, and its artifact matches the independent release pin. A missing, stale, foreign or
mismatched handoff fails controller startup/readiness closed.

For Personal mode, after the external launcher has completed that handoff, replace the bootstrap
placeholder with its exact one-line value and start the controller:

```sh
HOSTED_DOMAIN=agent-teams.localhost \
HOSTED_PUBLIC_ORIGIN=https://agent-teams.localhost \
CLAUDE_DIR=/absolute/path/to/a/dedicated/hosted-sandbox/.claude \
HOSTED_SECRETS_DIR=/absolute/path/outside/the/repository/agent-teams-hosted-secrets \
HOSTED_LIFECYCLE_ORCHESTRATOR_RUN_DIR=/absolute/protected/path/to/the/owner-run-directory \
AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP='REPLACE_WITH_EXACT_LAUNCHER_ISSUED_JSON' \
HOSTED_WORKSPACE_IDS=-registered-hosted-workspace \
NODE_IMAGE_DIGEST=sha256:REPLACE_WITH_AUDITED_NODE_MANIFEST_DIGEST \
KEYCLOAK_IMAGE_DIGEST=sha256:REPLACE_WITH_AUDITED_KEYCLOAK_MANIFEST_DIGEST \
CADDY_IMAGE_DIGEST=sha256:REPLACE_WITH_AUDITED_CADDY_MANIFEST_DIGEST \
docker compose -f docker/docker-compose.yml --profile personal up --build -d
```

## Security boundary

The public browser receives only opaque Agent Teams cookies:

- `__Host-agent-teams-device`: personal mode, durable HttpOnly device-family grant.
- `__Host-agent-teams-session`: short HttpOnly Agent Teams session.
- two short `SameSite=Lax` HttpOnly cookies during an OIDC redirect: attempt id and state.

Production cookies are `Secure`, `Path=/`, have no `Domain`, and use `SameSite=Strict` except the
OIDC redirect cookies. CSRF is returned only from the authenticated status/pair response, held in
renderer module memory and sent as `x-agent-teams-csrf`. It is never written to localStorage,
sessionStorage, IndexedDB or a URL.

Pairing material is published once to `/run/agent-teams/pairing.json` with mode `0600`. Retrieve it
only on the Docker host:

```sh
docker compose -f docker/docker-compose.yml --profile personal \
  exec agent-teams-personal node scripts/hosted-auth-cli.mjs pairing-code
```

The pairing code is never an HTTP query parameter and application logging must never include it.
The delivery file is removed after use. Pairing attempts are bounded and the challenge expires
after ten minutes. Once the durable transition consumes a challenge, presenting that code again
never reconstructs or reissues its device/session credentials; concurrent presentations have
exactly one winner.

OIDC provider tokens are consumed only by the backend. The browser never receives an access,
refresh or ID token. The SQLite database stores no provider token and no password. The short-lived
PKCE verifier is AES-GCM encrypted with a key stored outside SQLite. SQLite stores keyed hashes of
Agent Teams session and pairing/device secrets.

`AUTH_PUBLIC_ORIGIN` is configuration authority for redirects and origin checks. Request `Host`,
`Forwarded` and `X-Forwarded-*` values never choose an OIDC redirect. Fastify ignores proxy headers
unless `TRUSTED_PROXY_CIDRS` explicitly admits the proxy address. Caddy is the production HTTPS
edge.

## Immutable identity and durable storage

Internal-storage SQLite schema version 16 owns:

- `hosted_auth_configuration`: the deployment's durable, mutually exclusive auth-mode claim,
  monotonic mode-reset generation and crash-recovery marker for external key rotation;
- `users`: immutable Agent Teams `UserId`, display projection and disabled state;
- `external_identities`: unique `(issuer, subject)` binding to `UserId`;
- `operator_sessions`: opaque OIDC sessions and bounded idle/absolute deadlines;
- `role_snapshots`: the exact role captured at successful reauthentication;
- `local_role_assignments`: explicit local role overrides that become effective only after a new
  OIDC authentication;
- `hosted_access_authority`: personal pairing/device/session projection plus a monotonic rollback
  fence;
- `personal_owners`: exactly one personal operator-to-`UserId` binding;
- `oidc_login_attempts`: one-time state, nonce and encrypted PKCE transaction state;
- `oidc_logout_replay`: durable Keycloak/OIDC back-channel `jti` replay protection;
- `hosted_workspaces`: server-registered runtime workspaces plus immutable opaque public IDs;
- `hosted_workspace_grants`: default-deny per-`UserId` workspace grants bound to the current
  restore generation;
- `auth_audit_events`: immutable authentication/authorization audit events.

Personal pairing and renewal prepare the SQLite owner before the authority CAS, so an unavailable
identity store cannot consume a challenge or rotate a valid device grant. Active sessions and
renewals also require the authority `OperatorId` to match the durable personal-owner binding. A
split or incorrectly restored pair of stores fails unavailable rather than authenticating one
authority identity as another immutable `UserId`.

Keycloak PostgreSQL is separate and owns passwords, MFA/passkeys, account recovery and lockout,
LDAP/AD/social federation, groups and base realm roles. Agent Teams owns application identities,
permissions, workspace/team access, sessions, role snapshots and audit.

The auth key/PKCE encryption file and personal keyring live under
`AUTH_DATA_DIR/hosted-auth-secrets`, outside SQLite. Do not put that directory in application
backups, diagnostics or support bundles. Losing those keys intentionally invalidates sessions and
requires explicit access recovery. An explicitly configured `AUTH_IDENTITY_KEY_FILE` must be an
absolute normalized path in an owner-controlled, non-symlink directory; startup locks that
directory to mode `0700` before creating or reading the key.

OIDC session and login-attempt hashes are also bound to the non-negative
`AUTH_RESTORE_GENERATION`. Increment that value for every Agent Teams SQLite restore, including a
database-only rollback that retains the live identity key. Cookies and pending authorization
transactions copied from the older database generation then become cryptographically unreachable.
Workspace grants are read only at the exact current generation, so a coordinated backup restored
under the required incremented generation also defaults to no browser workspace access until the
local administrator re-grants it.
Personal mode also detects the generation mismatch and remains fail closed until its documented
reset/recovery operation completes.

Auth-mode reset stages a new personal keyring durably before the SQLite transaction. The
transaction advances the personal authority rollback fence to a credential-empty state that
references that staged keyring. On target-profile startup, recovery idempotently activates the
staged keyring, removes any old pairing delivery, rotates the Agent Teams identity/PKCE key and
then marks the reset generation complete. A crash before that marker leaves startup fail closed
and repeatable; it never reopens the old public mode. Users, immutable external-identity bindings,
the personal-owner binding, local roles, workspaces, audit history and back-channel replay history
remain durable across the mode change.

## OIDC validation

The generic provider:

1. resolves the issuer discovery document without following redirects;
2. creates independent 256-bit state and nonce values and a high-entropy PKCE verifier;
3. sends `S256` PKCE and Authorization Code Flow parameters;
4. validates and snapshots a bounded role-claim mapping before durable auth-mode admission,
   rejecting empty claim-path segments, control characters and any provider value assigned to
   more than one local role;
5. bounds per-source login admission and the durable ten-minute attempt set;
6. compares the callback state to its HttpOnly cookie before atomically consuming the durable,
   provider-bound login attempt and exchanging a code;
7. validates a supported asymmetric JWS signature against JWKS;
8. validates exact issuer, audience, authorized party for multi-audience tokens, expiry, issued-at
   skew and nonce;
9. binds `(issuer, subject)` to an immutable `UserId`;
10. captures the configured role mapping and issues a new opaque Agent Teams session.

OIDC has an explicit `oidc_provider_unavailable` path. Back-channel logout validates signature,
issuer, audience, expiry, the logout event claim, absence of nonce, `sid`/`sub`, and consumes `jti`
once in the same SQLite transaction that revokes matching sessions. Issuer, subject and provider
session identifiers—not the configurable provider display label—select sessions and replay state,
so renaming `OIDC_PROVIDER_ID` cannot strand sessions or reopen a consumed `jti`. Local logout
revokes only Agent Teams state. Global logout additionally returns the provider end-session URL.
Reauthentication creates a fresh role snapshot; it does not mutate an active session's privileges
in place.

OIDC session configuration is bounded before any key or database mutation: idle lifetime must be
between one minute and one hour, absolute lifetime must be between five minutes and twenty-four
hours, and idle lifetime cannot exceed absolute lifetime. Defaults remain fifteen minutes idle and
eight hours absolute. Personal sessions retain the stricter fixed one-hour absolute policy.

The first OIDC user is never implicitly owner. `OIDC_DEFAULT_ROLE` cannot be `owner`. Owner access
requires an explicit `OIDC_OWNER_ROLE_VALUES` match or the local role-management CLI. A local
assignment never rewrites an active session; it is captured into a new role snapshot only after
successful reauthentication.

## Frozen roles and HTTP policy

| Role   | Query | SSE | Commands | Hosted management | Workspace management | Identity management |
| ------ | ----- | --- | -------- | ----------------- | -------------------- | ------------------- |
| owner  | yes   | yes | yes      | yes               | yes                  | yes                 |
| admin  | yes   | yes | yes      | yes               | yes                  | no                  |
| member | yes   | yes | yes      | no                | no                   | no                  |
| viewer | yes   | yes | no       | no                | no                   | no                  |

The server classifier is fail closed:

- `/api/auth/status`, personal pairing, OIDC begin/callback and signed back-channel logout are
  public transport endpoints;
- `/api/events` requires the SSE permission;
- an exact route inventory admits deployment/project/session reads with query permission;
- only the lifecycle read POST and registered-workspace session lookup POST are read-shaped, and
  both require CSRF;
- only registered-workspace pin/hide operations currently receive command permission;
- every unclassified API route is denied even when it uses a safe HTTP method;
- SSH, updater, notifications, arbitrary-path/file/config mutation APIs, terminal, provider relay
  and legacy team launch/stop/runtime routes are absent in hosted v1;
- project/worktree resource routes require both a `hosted_workspaces` registration and a durable
  current-generation grant for the authenticated immutable `UserId`;
- project lists, repository groups, recent projects and global search results are filtered against
  the same per-principal grants. Global search does not read an ungranted project.

Every unsafe request also requires an exact configured Origin and a same-origin/same-site browser
fetch context. CORS is restricted to `AUTH_PUBLIC_ORIGIN` when hosted auth is mounted.
Every authenticated response is marked `Cache-Control: no-store, private` and `Pragma: no-cache`;
a workspace-projection storage outage fails with an explicit `503` rather than returning an
apparently successful partial payload.
The hosted DTO projection replaces local scanner IDs with immutable opaque workspace IDs and
removes absolute paths, runtime roots, Git remotes (including embedded credentials), Git metadata
and repository identity internals from project, repository-group, recent-project, session and SSE
payloads. The hosted config projection removes Claude/SSH/custom-project paths, provider endpoint
URLs and ungranted session metadata. Hosted SSE suppresses legacy todo and notification payloads
that cannot yet be attributed to a granted workspace, and projects each event independently for
each connected principal. Each hosted event and keepalive revalidates the opaque session; grant
revoke immediately stops delivery without leaking the event to another principal. Personal host
reset first blocks every new public request, drains admitted HTTP work and closes every connected
stream; an early client disconnect releases the same idempotent drain fence, so an abandoned
socket cannot stall recovery.

## Keycloak production profile

Create a deployment-only secret directory outside the repository and every Docker build context,
then create four high-entropy files in it:

- `lifecycle_orchestrator_trust_anchor`
- `oidc_client_secret`
- `keycloak_admin_password`
- `keycloak_database_password`

Set `HOSTED_SECRETS_DIR` to that directory's absolute path before every Compose command. Compose
fails during interpolation when it is absent. Never place the directory beneath the repository,
including beneath `docker/`: Docker sends the repository root as the application image build
context, and ignored or untracked files can otherwise enter builder input or cache. The lifecycle
anchor has the exact lowercase-hex format specified above. Each of the other three files must
contain one non-empty base64url value (`A-Z`, `a-z`, `0-9`, `_` or `-`); a single trailing newline
is tolerated. Keep the external directory mode `0700` and all four files mode `0444`.
The apparently broad file mode is intentional for local Compose: file-backed secrets are
bind-mounted and its `uid`, `gid` and `mode` long-syntax fields are not portably applied. The
non-traversable parent protects the sources on the host, while Compose exposes each file only to
the services explicitly named in its `secrets` list. The non-root
`agent-teams-keycloak-secret-init` job copies the portable OIDC source into an image-seeded
placeholder on the persistent `agent-teams-keycloak-secret` volume, verifies UID/GID
`1000:1000`, and locks the result to mode `0400`. The application mounts that volume only
read-only at `/run/agent-teams-oidc`; its mutable local-control files remain on the separate
`/run/agent-teams` tmpfs. The handoff therefore survives an initializer or application restart
without granting the application write access to the secret. It never accepts the portable `0444`
source mount directly. The separate common lifecycle initializer applies the same portability
boundary to both authentication profiles and never exposes the source anchor to the application.
Do not make the source directory group/world traversable, and do not use these source files outside
this deployment.

The Keycloak startup wrapper reads the Docker secrets into shell-local variables, resolves the
realm template into a private tmpfs and writes database/bootstrap configuration into a second
private tmpfs. It unsets the variables and explicitly removes credential environment keys before
replacing itself with Keycloak; secret values never enter the Compose environment, container
command line or persistent container layer. The Compose service replaces the Keycloak image's
`kc.sh` entrypoint with that bootstrap shell, then explicitly executes `kc.sh` as the image's
non-root UID 1000/GID 0 identity. Compose builds that image from the pinned Keycloak source digest
with `kc.sh build --db=postgres --health-enabled=true`; the read-only runtime uses
`start --optimized` and the same PostgreSQL/health build options instead of augmenting at startup.

Resolve and review the multi-platform manifest digests for the exact image tags in the Compose
file, then provide them as `NODE_IMAGE_DIGEST`, `KEYCLOAK_IMAGE_DIGEST`,
`POSTGRES_IMAGE_DIGEST`, and `CADDY_IMAGE_DIGEST`. Each value must include the `sha256:` prefix.
Compose and the Dockerfile fail closed when a digest is absent; tags remain in the references only
as human-readable version labels. Record the four resolved digests with the deployment's upgrade
and backup evidence.

Add both the application and Keycloak host names to local DNS, or `/etc/hosts`, pointing at the
Docker host. They must be distinct origins so Keycloak pages, scripts and cookies never share the
Agent Teams application origin. Start:

```sh
HOSTED_DOMAIN=agent-teams.localhost \
HOSTED_PUBLIC_ORIGIN=https://agent-teams.localhost \
KEYCLOAK_DOMAIN=auth.agent-teams.localhost \
KEYCLOAK_PUBLIC_ORIGIN=https://auth.agent-teams.localhost \
CLAUDE_DIR=/absolute/path/to/a/dedicated/hosted-sandbox/.claude \
HOSTED_SECRETS_DIR=/absolute/path/outside/the/repository/agent-teams-hosted-secrets \
HOSTED_LIFECYCLE_ORCHESTRATOR_RUN_DIR=/absolute/protected/path/to/the/owner-run-directory \
AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP='REPLACE_WITH_EXACT_LAUNCHER_ISSUED_JSON' \
HOSTED_WORKSPACE_IDS=-synthetic-hosted-e2e \
NODE_IMAGE_DIGEST=sha256:REPLACE_WITH_AUDITED_NODE_MANIFEST_DIGEST \
KEYCLOAK_IMAGE_DIGEST=sha256:REPLACE_WITH_AUDITED_KEYCLOAK_MANIFEST_DIGEST \
POSTGRES_IMAGE_DIGEST=sha256:REPLACE_WITH_AUDITED_POSTGRES_MANIFEST_DIGEST \
CADDY_IMAGE_DIGEST=sha256:REPLACE_WITH_AUDITED_CADDY_MANIFEST_DIGEST \
docker compose -f docker/docker-compose.yml --profile keycloak up --build -d
```

The profile starts Agent Teams, Keycloak, a separate PostgreSQL database and Caddy HTTPS. Caddy's
local root certificate is in the `caddy-data` volume; development clients must trust that
certificate explicitly. After Caddy health succeeds, the non-root `keycloak-volume-init` job
mounts Caddy data read-only and copies only `root.crt` into the persistent
`agent-teams-keycloak-trust` volume. It verifies a non-linked, UID/GID-`1000:1000`, mode-`0600`
placeholder or prior mode-`0444` handoff, rejects unexpected volume entries, and leaves the copied
certificate mode `0444`.
Agent Teams and Keycloak wait for that job, mount only this dedicated volume read-only at
`/caddy-trust`, and use it through `NODE_EXTRA_CA_CERTS` and `KC_TRUSTSTORE_PATHS`; neither
container mounts `caddy-data`, so the private root key and every other PKI artifact are absent
from their filesystems. Caddy itself does not wait for Keycloak: its health proves configuration
and CA readiness, while upstream dialing begins only after Keycloak starts. Replace internal TLS
with a public Caddy certificate in production. Caddy is explicitly UID/GID `1000:1000`, drops
every capability except `NET_BIND_SERVICE`, and owns its own data/config volumes. The dedicated
trust volume survives application restarts without reopening Caddy's private PKI tree.
The Agent Teams image runs as the unprivileged `node` user (UID/GID 1000); the dedicated
`CLAUDE_DIR` bind mount must therefore be readable and traversable by that container identity.
Writable auth data and the local-control runtime directory are explicitly owned by that identity.
The service-scoped OIDC secret remains readable through the dedicated read-only handoff volume
above, including on local Compose implementations that ignore secret UID remapping.
If `HOSTED_HTTPS_PORT` is not `443`, include that exact port in both `HOSTED_PUBLIC_ORIGIN` and
`KEYCLOAK_PUBLIC_ORIGIN`. Caddy serves both host names on that port, while Agent Teams redirects
remain on the application origin and OIDC discovery remains on the isolated Keycloak origin.

The public-facing internal Compose network is the dedicated `172.30.255.0/28` subnet. Both public
profiles assign Caddy `172.30.255.2` and admit only that exact `/32` as a trusted proxy; the former
broad Docker private-address trust is intentionally forbidden because another container could
otherwise spoof the client address. Keycloak and PostgreSQL also share a separate internal
`172.30.254.0/28` backend network; PostgreSQL is attached only there, so neither Caddy nor Agent
Teams can reach it directly. If the public subnet conflicts with the host, change
`HOSTED_NETWORK_SUBNET` together with the Agent Teams, Caddy, and Keycloak public IP values. Change
`HOSTED_KEYCLOAK_BACKEND_SUBNET` together with `HOSTED_POSTGRES_IPV4` independently.

The imported realm creates the confidential `agent-teams-hosted` client and four realm roles:
`agent-teams-owner`, `agent-teams-admin`, `agent-teams-member`, and `agent-teams-viewer`. The
container validates `HOSTED_DOMAIN` as an ASCII DNS name, requires `HOSTED_PUBLIC_ORIGIN` to match
that exact host and `HOSTED_HTTPS_PORT`, validates `KEYCLOAK_DOMAIN` and
`KEYCLOAK_PUBLIC_ORIGIN` independently, and rejects equal host names. It renders only the
application origin into redirect, web-origin and logout fields together with the client secret;
startup rejects any unresolved template placeholder. Caddy enables `strict_sni_host on` globally
and defines separate, exact application and Keycloak host blocks on the same internal/external
HTTPS listener; TLS SNI and the HTTP host therefore cannot select different upstreams. Personal
mode has only the exact application host block. A non-default public port does not break
container-to-Caddy issuer discovery. Keeping the hosts distinct prevents the application's
host-only `Path=/` session and
device cookies from being sent to Keycloak and prevents an IdP page from acquiring the
application's in-memory CSRF token through same-origin access. The realm disables public
registration, enables recovery and bounded brute-force lockout, and applies a
minimum-length/non-username password policy while leaving MFA/passkey enrollment and federation in
Keycloak. Redirect, post-logout and back-channel logout URLs are restricted to the application
origin. No application code calls the Keycloak Admin API.

For an external Keycloak or another OIDC provider, configure `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET_FILE`, claim path and role-value mappings. Custom scope lists are validated as
OAuth scope tokens and always include `openid`. Issuer URLs cannot contain a query or fragment,
and provider endpoint/redirect URLs cannot contain fragments. Do not enable the Compose Keycloak
services. Confidential client secrets are accepted only through the protected file setting; the
process-environment form `OIDC_CLIENT_SECRET` is rejected. Discovery-driven token exchange prefers
`client_secret_basic`, supports `client_secret_post` when that is the provider's only advertised
shared-secret method, and permits `none` only when no client secret is configured. Malformed or
unsupported authentication-method metadata fails before sending an authorization code or secret.

### Backup and upgrade

Back up Keycloak PostgreSQL with `pg_dump` while retaining database and Keycloak image versions in
the backup record. Back up the Agent Teams internal SQLite through the existing coordinated online
backup path. Do not copy SQLite WAL files ad hoc and do not include `hosted-auth-secrets`, Docker
secret files, provider tokens, pairing delivery files or Caddy private keys in an application
support backup.

The `agent-teams-lifecycle-owner-high-water` volume is live monotonic anti-ABA authority, not an
application rollback artifact. Preserve it across image upgrades and Agent Teams SQLite restores;
never replace it with an older backup, delete it while reusing the same owner authority/key, or
clone it into a concurrent controller. For a host migration, stop the controller and external
owner, copy the latest volume as a separate exact filesystem artifact, verify that copy, and start
only one owner with a new session and a generation strictly above the recorded high water before
issuing a fresh bootstrap. Loss or corruption requires an operator-controlled owner-authority and
proof-key rotation plus a fresh bootstrap; restoring an older high-water directory is not a
recovery path. The `agent-teams-lifecycle-trust` volume is only a derived handoff and is excluded
from backups: recreate it from the protected source while the controller is stopped, and only when
that source still matches the external owner.

Before upgrading:

1. take and verify separate Keycloak PostgreSQL and Agent Teams SQLite backups;
2. record current Agent Teams, Keycloak, PostgreSQL and Caddy image versions;
3. test realm/client import and database migration on copies;
4. drain the one backend controller;
5. when upgrading an `agent-teams-data` volume created by an older root-running image, stop the
   controller and migrate that volume exactly once before starting the unprivileged image:

   ```sh
   docker compose -f docker/docker-compose.yml --profile personal \
     run --rm --no-deps --user root --entrypoint chown \
     agent-teams-personal -R 1000:1000 /data/.agent-teams
   ```

   Use the corresponding `agent-teams-keycloak` service and `keycloak` profile if only that service
   image is present. Keep the controller stopped throughout, verify the resulting ownership, and do
   not apply this command to the read-only `CLAUDE_DIR` bind mount;

6. upgrade PostgreSQL only through its supported major-version procedure;
7. start Keycloak and wait for readiness before Agent Teams;
8. prove OIDC login, role mapping, local/global/back-channel logout and restart recovery on a
   synthetic workspace.

Keycloak's `--import-realm` path creates the bundled realm on first boot; it does not reconcile an
already-existing realm in the persistent PostgreSQL database. Treat later realm/client template
changes as an explicit Keycloak configuration migration, review them against the deployed client,
and test them on a restored copy before production. Never delete the Keycloak database merely to
force the import to run again.

Changing `$HOSTED_SECRETS_DIR/oidc_client_secret` alone does not rotate the credential in an existing
Keycloak realm and will stop new logins. For a planned rotation, drain and stop the Agent Teams
controller while leaving Keycloak, PostgreSQL and Caddy available; regenerate the
`agent-teams-hosted` client credential through the protected Keycloak administration console;
write that exact value to the protected secret source without placing it in shell arguments,
environment variables or logs; then force-recreate the one-shot
`agent-teams-keycloak-secret-init` job while the controller remains stopped, followed by the Agent
Teams controller. This refreshes the persistent read-only handoff rather than relying on a source
mount to remount during application restart. Keep the controller stopped until both sides contain
the same credential and prove a synthetic login immediately afterward. The application still never
uses the Keycloak Admin API during normal operation.

Rollback restores each database only to its matching application version. Never restore the
internal SQLite authority projection without its monotonic rollback-fence domain. Increment
`AUTH_RESTORE_GENERATION` before starting against restored Agent Teams SQLite. A detected
projection/fence mismatch fails closed, and the new generation invalidates OIDC sessions and login
attempts from the restored snapshot even when the live identity key was retained.

## Personal reset and access recovery

The core personal authority already models the reset sequence: drain runtime, revoke device
families and sessions, stage and activate a new keyring, remove old pairing delivery, and publish
one new challenge under a strictly newer reset generation. The HTTP profile does not expose reset.
The operator-only CLI uses a mode-`0600` Unix socket under `/run/agent-teams`; it is never mounted
into Fastify or bound to TCP. Reset invokes the core use case only after a current, exact AR drain
evidence document is present. The local use case also closes the public request gate around the
complete transition; it reopens only after the authority reaches a durable completed state and its
audit append succeeds. A rejected or indeterminate reset stays closed for a local retry rather
than racing old browser work against credential revocation. If the controller exits after writing
the reset intent, personal-mode startup resumes that exact generation before mounting public
authentication; a still-requested stage must revalidate current AR evidence, while later durable
stages continue idempotently.

The evidence file defaults to `/run/agent-teams/drain-proof.json`, must be a regular mode-`0600`
file, expires within fifteen minutes of observation, and has an exact non-secret shape. Personal
credential reset uses:

```json
{
  "format": "agent-teams-runtime-drain/v1",
  "deploymentId": "deployment_hosted-v1",
  "restoreGeneration": 0,
  "purpose": "host_reset",
  "resetGeneration": 1,
  "outcome": "drained",
  "evidenceRef": "ar:drain:example-1",
  "observedAt": 1750000000000,
  "expiresAt": 1750000600000
}
```

Auth-mode reset uses a distinct purpose and binds the proof to the requested target:

```json
{
  "format": "agent-teams-runtime-drain/v1",
  "deploymentId": "deployment_hosted-v1",
  "restoreGeneration": 0,
  "purpose": "auth_mode_reset",
  "targetAuthMode": "personal",
  "resetGeneration": 2,
  "outcome": "drained",
  "evidenceRef": "ar:drain:auth-mode-personal-2",
  "observedAt": 1750000000000,
  "expiresAt": 1750000600000
}
```

The standalone composition has no runtime-mutation admission, which is sufficient only for
initial pairing. Personal reset refuses missing, stale, mismatched or unclassified evidence.
AR still needs to produce this public evidence document in the production controller integration.

Local administration examples:

```sh
docker compose -f docker/docker-compose.yml --profile keycloak \
  exec agent-teams-keycloak node scripts/hosted-auth-cli.mjs users list
docker compose -f docker/docker-compose.yml --profile keycloak \
  exec agent-teams-keycloak node scripts/hosted-auth-cli.mjs users disable usr_example123
docker compose -f docker/docker-compose.yml --profile keycloak \
  exec agent-teams-keycloak node scripts/hosted-auth-cli.mjs roles set usr_example123 owner
docker compose -f docker/docker-compose.yml --profile personal \
  exec agent-teams-personal node scripts/hosted-auth-cli.mjs workspaces register -synthetic-id
docker compose -f docker/docker-compose.yml --profile personal \
  exec agent-teams-personal node scripts/hosted-auth-cli.mjs \
  workspaces grant usr_example123 -synthetic-id
docker compose -f docker/docker-compose.yml --profile personal \
  exec agent-teams-personal node scripts/hosted-auth-cli.mjs \
  workspaces revoke usr_example123 -synthetic-id
docker compose -f docker/docker-compose.yml --profile personal \
  exec agent-teams-personal node scripts/hosted-auth-cli.mjs personal-reset 1
docker compose -f docker/docker-compose.yml --profile keycloak \
  exec agent-teams-keycloak node scripts/hosted-auth-cli.mjs auth-mode reset personal 2
```

Role changes become effective after OIDC reauthentication. User disable atomically revokes that
user's active sessions; re-enable never restores them. Workspace registration alone grants no
browser access. Grant and revoke are per immutable `UserId`; workspace disable also deletes its
grants and is immediate for HTTP/SSE authorization checks. The personal reset command emits no
pairing secret; retrieve the new challenge with the separate `pairing-code` command.

After `auth-mode reset` succeeds, stop the current profile and start only the requested target
profile against the same `agent-teams-data` volume. Do not start both profiles together. Directly
editing `AUTH_MODE`, SQLite, the keyring or the recovery generation is not a reset and remains
unsupported.

For OIDC outage, keep serving an explicit unavailable result; never enable personal pairing on the
same deployment as a workaround. Recovery is IdP restoration or an explicitly configured local
owner-management CLI operation. A local OIDC identity/session-store or authentication-crypto
failure is also an explicit `503 identity_storage_unavailable`; it is never downgraded to an
invalid or anonymous session, never clears a valid cookie, and never enables pairing fallback. Do
not edit SQLite identities or roles by hand. Unclassified callback, logout and signed
back-channel persistence failures likewise return an operation-specific `503`; logout preserves
the session cookie unless durable local revocation or a known post-revocation provider failure is
confirmed. Personal session, renewal and CSRF verification also return an explicit unavailable
response when the authority projection, rollback fence or keyring cannot make a trustworthy
decision; those failures never become an anonymous pairing screen or rotate credentials. Personal
logout and forget-device likewise clear browser credentials only after the authority store
confirms session or device-family revocation.

## Proof and current continuation ledger

Implemented product surfaces:

- provider-neutral roles, principals, exact permission matrix and fail-closed HTTP classifier;
- durable SQLite migrations and serialized internal-storage worker operations;
- complete personal authority adapter composition, delivery file and Docker-host retrieval CLI;
- cross-store personal-owner preparation before pairing consumption or device/session renewal,
  plus exact SQLite authority revision/fence compare-and-swap validation;
- local Unix-socket administration for user listing/disable/enable, OIDC role assignment, workspace
  register/disable/list/grant/revoke, drain-gated personal reset and target-bound durable
  auth-mode reset;
- generic OIDC discovery/code/PKCE/JWS/claim validation and immutable identity binding;
- opaque OIDC sessions, role snapshots, audit, local/global/back-channel logout and durable replay
  prevention with replay consumption and matching session revocation in one SQLite transaction;
- explicit OIDC session-authentication outage propagation, so local identity-store or crypto
  failures produce a stable fail-closed `503` instead of masquerading as invalid credentials;
- explicit OIDC callback/logout/back-channel outage responses, including cookie preservation when
  durable local logout cannot be confirmed;
- revocation-confirmed personal logout and forget-device responses, with credential cookies
  preserved whenever the authority transition fails or is unavailable;
- Fastify cookie/origin/CSRF/role/workspace enforcement with the Compose edge restricted to
  Caddy's exact static `/32`, rather than a spoofable Docker-private supernet;
- exact fail-closed legacy route inventory (including the reserved `/api` root), hosted-safe opaque
  workspace projection, default-deny per-principal HTTP/global-search admission and path/Git-free
  per-principal SSE;
- descriptor-bound OIDC client-secret reads with validated parent-chain ownership/modes,
  no-follow/close-on-exec open flags where supported, opened-descriptor `fstat`, bounded reads and
  pre/open/post device+inode identity checks;
- bounded no-follow descriptor reads for the deployment-owned identity key, personal keyrings,
  pairing delivery and AR drain evidence, including stable private-parent and file-identity
  checks; the Docker-host pairing CLI applies the same checks before emitting the one allowed
  pairing-code response;
- browser auth gate and in-memory CSRF composition;
- browser local logout, OIDC provider/global logout and personal forget-device controls;
- personal and Keycloak Compose profiles, separate PostgreSQL, Caddy HTTPS, Docker secrets, realm
  template and health checks;
- Keycloak secret materialization through private tmpfs-backed realm/config files, with no database,
  bootstrap-admin or client credential in the Compose environment, provider environment or
  container command line;
- immutable, operator-supplied image digest enforcement for Node, Keycloak, PostgreSQL and Caddy;
- frozen Docker installs copy `pnpm-workspace.yaml` with `package.json`, the lockfile and patches in
  both builder dependency stages, so the lockfile's workspace-owned overrides and patched
  dependencies are reproducible without weakening `--frozen-lockfile`; the builder also copies
  both repository lifecycle-script dependencies before install, preserving the enforced
  preinstall/postinstall boundary instead of disabling scripts;
- unprivileged Agent Teams runtime ownership, private UID/GID-bound tmpfs and service-scoped OIDC
  secret delivery (including local Compose's read-only file-bind fallback), with an explicit
  existing-volume ownership migration step;
- HTTPS routing for the Keycloak realm, account resources and administration console without
  applying the Agent Teams browser CSP to Keycloak HTML;
- explicit `AUTH_MODE` standalone admission into the hosted cache-only/read-root path, so Compose
  deployments cannot fall back to the legacy ambient filesystem watcher while the canonical
  team-lifecycle envelope remains unavailable;

Current focused proof:

- [x] generic OIDC tests cover asymmetric signature, issuer, audience, nonce, expiry, durable state
      replay, PKCE, back-channel authenticity, rejection of unsupported critical JOSE semantics
      and explicit IdP outage/timeout/overload results; provider configuration proof also prevents
      custom scopes from removing `openid`, rejects implicit default-owner escalation, validates
      URL shape and proves discovery-selected `client_secret_basic`, `client_secret_post` and
      public `none` token-endpoint authentication without silently downgrading a confidential
      client;
- [x] synthetic generic OIDC Fastify E2E covers authorization code/state/nonce/S256 PKCE,
      session-fixation resistance, opaque cookies, durable restart, local role refresh only after
      reauthentication, local and signed back-channel logout, logout replay, explicit IdP outage
      and the absence of personal-pairing fallback;
- [x] Fastify injection tests cover authentication, CSRF/origin denial, role escalation,
      registered-workspace denial, SSE, unknown-route fail closure, canonical request-target
      routing and untrusted proxy spoofing;
- [x] the existing personal authority suite covers pairing replay, bounded attempts, device/session
      rotation, predecessor grace, forget-device and reset transitions;
- [x] synthetic personal Fastify E2E covers one-time pairing, opaque cookie flags, session-fixation
      resistance, CSRF, local logout with device preservation, process restart/device renewal,
      drain-gated reset/key rotation, old-credential revocation and forget-device; it also proves a
      disabled personal owner cannot authenticate or rotate a device grant;
- [x] personal identity-storage outage proof preserves valid credentials, performs no renewal and
      returns an explicit unavailable response instead of silently converting the outage to a
      logged-out state; separate cross-store proof rejects an authority/SQLite owner mismatch for
      both an active session and device renewal;
- [x] personal authority-storage outage proof preserves both short-session and durable-device
      cookies, performs no renewal and returns `503 identity_storage_unavailable`; CSRF crypto or
      storage failure likewise returns unavailable rather than misclassifying the request as a
      forged token;
- [x] OIDC session-authentication outage proof normalizes local identity-store/crypto exceptions,
      returns `503 identity_storage_unavailable` for status and protected routes, preserves the
      credential cookie and never converts the outage into an anonymous session or pairing mode;
- [x] OIDC callback and signed back-channel persistence outages return operation-specific `503`
      responses rather than invalid-credential/token errors, while an unconfirmed durable logout
      returns `503 oidc_logout_unavailable` without clearing the session cookie;
- [x] personal logout/forget-device failure injection proves an unavailable authority transition
      is not reported as success and cannot clear the browser's session or device credential;
- [x] production random-ID generation is regression-tested against every hosted identity parser;
      this closes the base64url `-`/`_` first-character failure that the repeated personal E2E
      exposed.
- [x] the OIDC secret-file boundary accepts only an exact, read-only file beneath a non-linked
      `/run/secrets` directory that the application identity cannot modify; arbitrary external
      secret paths retain strict process ownership and mode-`0600` enforcement;
- [x] identity-key, personal-keyring, pairing-delivery and drain-evidence reads are bounded and
      descriptor-bound; focused replacement, weakened-mode, oversized-input and CLI symlink tests
      prove path races cannot redirect a sensitive read or echo pairing material on failure;
- [x] OIDC session and login-state keyed hashes are bound to `AUTH_RESTORE_GENERATION`; synthetic
      rollback proof advances the generation while retaining the repository and identity key and
      confirms restored cookies and pending authorization transactions cannot authenticate;
- [x] native SQLite and composition tests cover atomic audited OIDC/personal mode transitions,
      rollback on audit failure, monotonically fenced generations, revocation of both credential
      stores, HTTP fail closure, restart-only staged-keyring recovery and identity-key rotation in
      both directions;
- [x] an opt-in sandbox Chromium session E2E consumes the production `Secure`, `HttpOnly`,
      host-only, `Path=/`, `SameSite=Strict` cookies, proves session fixation and pairing replay
      resistance, enforces CSRF, persists the durable device grant across a real browser-process
      restart, rotates both cookies on renewal, rejects both old cookies after host reset, pairs
      again and clears both cookies on forget-device. The pairing codes cross into the browser
      process over a private stdin pipe, never argv, environment, URL, storage or output;
- [x] the same opt-in Electron Chromium harness builds and loads the real `HostedAuthGate` React
      component in a headless `WebContents`, types the one-time code into its password input,
      renders protected owner content, invokes local logout and proves device-backed
      reauthentication, invokes forget-device, returns to the anonymous pairing form and verifies
      the code never entered URL, local storage, session storage or child output. Before browser
      traffic starts, the harness physically copies the required native package graph to a
      disposable tree, removes copied bindings, rebuilds only that tree for Electron 40.10.0 ABI
      143, and loads `better-sqlite3`, `node-pty` and `ssh2` there. It fingerprints the producer
      workspace bindings before and after and reopens them under Node ABI 137, so the proof cannot
      mutate the normal Node dependency tree in place;
- [x] production-profile static proof requires Caddy health, including durable local-root
      materialization, before Agent Teams starts and loads the OIDC trust root;
- [x] production-profile static proof admits exactly one controller as the read-only consumer of an
      external lifecycle-owner socket, requires a launcher-issued bootstrap and a mode-`0400`
      trust-anchor handoff, and rejects every in-Compose owner candidate or second consumer;
- [x] the hosted-v1 Compose E2E uses one marker-owned fake-runtime owner and synthetic OIDC server
      inside a bounded, network-isolated fixture. It proves the production wire/client behavior and
      lifecycle-trust initializer path and cleanup harness only; it is not evidence that a
      production external AR owner was deployed, and its generated bootstrap or key must never be
      reused outside that fixture;
- [x] an opt-in Node-environment real-Keycloak/PostgreSQL harness now provisions an isolated Docker
      network from exact Keycloak 26.3.2 and PostgreSQL 17.5-alpine immutable image references on
      controller-owned ports 18080/18443, imports disposable member and owner accounts, preserves
      provider cookies by domain/path/expiry, follows provider redirects until the Agent Teams
      callback while checking state and S256 PKCE, proves two-workspace principal isolation, drives
      local/global/back-channel logout and narrowly removes only its randomized containers and
      network. Random database, admin, client and user credentials live only in mode-`0600` files
      under the disposable test directory; their values never enter Docker arguments, the host
      process environment, URLs or test output;

Run the dedicated verifier on a Linux x64 host with the already-installed Node 24 producer
dependency tree and the exact project Electron binary. Do not run an in-place Electron rebuild:
the test creates, rebuilds and removes its own isolated dependency tree while leaving the producer
workspace on Node ABI 137:

```sh
HOSTED_BROWSER_E2E_ELECTRON=/absolute/path/to/node_modules/electron/dist/electron \
  node node_modules/vitest/vitest.mjs run \
  test/features/hosted-access/HostedPersonalAuth.integration.test.ts \
  -t 'Chromium'
```

Run the real Keycloak proof only with reviewed immutable multi-platform image references and a
Docker daemon dedicated to synthetic tests:

```sh
HOSTED_KEYCLOAK_E2E_KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:26.3.2@sha256:REPLACE_WITH_AUDITED_DIGEST \
HOSTED_KEYCLOAK_E2E_POSTGRES_IMAGE=postgres:17.5-alpine@sha256:REPLACE_WITH_AUDITED_DIGEST \
  node node_modules/vitest/vitest.mjs run \
  test/features/hosted-access/HostedOidcAuth.integration.test.ts \
  -t 'Keycloak hosted authentication'
```

The final production image build contains a mandatory Node-ABI probe that opens
`better-sqlite3` and loads `node-pty` and `ssh2`. With four reviewed multi-platform manifest
digests and a disposable hosted `CLAUDE_DIR`, run:

```sh
CLAUDE_DIR=/absolute/path/to/a/disposable/hosted-sandbox/.claude \
NODE_IMAGE_DIGEST=sha256:REPLACE_WITH_AUDITED_NODE_DIGEST \
KEYCLOAK_IMAGE_DIGEST=sha256:REPLACE_WITH_AUDITED_KEYCLOAK_DIGEST \
POSTGRES_IMAGE_DIGEST=sha256:REPLACE_WITH_AUDITED_POSTGRES_DIGEST \
CADDY_IMAGE_DIGEST=sha256:REPLACE_WITH_AUDITED_CADDY_DIGEST \
  docker compose -f docker/docker-compose.yml --profile keycloak \
  build --no-cache agent-teams-keycloak
```

An image build that cannot load any of those three production modules fails in the `prod-deps`
stage. Keep the full build log and immutable digest inputs as the ABI/artifact evidence.

Required proof or remaining implementation before this contract is complete:

- [x] run the personal injection E2E against native SQLite on Node 24, including durable restart,
      device renewal, reset, key rotation, replay resistance and forget-device;
- [x] add explicit SSE authentication injection coverage;
- [x] add browser-level cookie behavior proof with the opt-in headless Electron Chromium session
      harness in `HostedPersonalAuth.integration.test.ts`;
- [x] pass native internal-storage migration, restart, rollback-fence, audit and durable
      back-channel replay tests; these tests now fail instead of silently falling back or skipping
      when the native SQLite binding is unavailable. Recovery also distinguishes the legacy
      workspace table from an already-current v16 table restored with a historical
      `user_version`, preserving the current table rather than selecting its removed
      `workspace_id` column;
- [x] add sandbox-only Chromium network/session E2E for personal mode, including browser-process
      restart, forget-device and host reset recovery;
- [x] add rendered hosted-browser UI E2E for the `HostedAuthGate` pairing, logout and forget-device
      controls, using the real component bundle, Chromium DOM/events, production HTTP facade and
      native SQLite sandbox;
- [ ] record an authorized sandbox deployment with the production external AR owner as the sole
      lifecycle owner, one controller consumer, launcher-issued bootstrap, restart generation/session
      advance and persisted high-water fence. The bounded fake-runtime Compose fixture is explicitly
      insufficient for this deployment proof;
- [ ] run the implemented sandbox-only real-Keycloak E2E for member/owner mapping,
      local/global/back-channel logout and replay, application restart, IdP outage and recovery.
      The continuation worker could render both Compose profiles but its Docker API socket denied
      container access, so the opt-in test remains intentionally unclaimed until an authorized
      synthetic Docker runner records a passing result;
- [x] add the local owner/workspace/reset CLI, with new role snapshots taking effect only after
      reauthentication and reset remaining absent from the public HTTP surface;
- [ ] wire the desktop local-owner principal to the common immutable `UserId` and shared
      authorization/application-use-case context. The desktop HTTP server currently remains
      correctly unmounted from hosted auth, but desktop identity convergence is not implemented.
      The current desktop entrypoint only propagates the installation `clientId` store path into
      child environments; no desktop IPC or shared application-use-case boundary accepts a
      `HostedPrincipal`, `UserId` or authenticated `QueryContext`. Completion therefore requires
      controller-owned changes to those shared use-case/IPC contracts and their desktop adapters,
      not a synthetic principal created solely inside `hosted-access`;
- [x] implement drained, audited durable auth-mode reset; direct `AUTH_MODE` changes remain refused,
      while the local operation requires target-bound AR evidence, atomically invalidates both
      credential stores, blocks serving and completes crash-safe key rotation on target restart;
- [x] replace the standalone `runtimeDrained: () => true` placeholder with the AR public
      drain-evidence file port and make personal reset fail closed without exact current evidence;
- [ ] integrate the production AR controller as the sole producer of the drain-evidence document;
      no local CLI or browser operation may fabricate or bypass the proof;
- [x] enforce Docker deployment-level single-controller admission and shared auth runtime-root
      exclusion: both profiles use one explicit container name and the same authority volume, so
      a second profile, replica or Compose project on the same daemon conflicts before serving,
      while the SQLite mode claim independently rejects cross-mode startup;
- [x] treat any explicit `AUTH_MODE` standalone process as hosted before constructing ambient
      services, validate the exact administrator-mounted `CLAUDE_ROOT`, retain unavailable
      canonical team-lifecycle reads without an AR envelope, and start cache-only rather than the
      legacy filesystem watcher;
- [ ] integrate the desktop lifecycle with the same runtime-root admission protocol; no desktop
      process may mount a hosted deployment's authority/runtime root concurrently;
- [x] keep the exact hosted-standalone legacy HTTP inventory synchronized as routes are added. The
      executable inventory registers the production route composition, freezes all 79 current
      legacy method/path pairs, and proves the exact server-side permission, CSRF and workspace
      decision for every route; additions fail until the inventory explicitly classifies them;
- [x] implement registered-workspace attribution before re-enabling notification/todo SSE. The
      bounded hosted event bridge admits file changes and error notifications only with a current
      active workspace registration, correlates path-free todo events only after the session has
      resolved to exactly one registered workspace, expires and bounds that correlation state,
      suppresses ambiguous/team/aggregate events, and still rechecks the current principal session
      and grant during every SSE delivery. Other denied browser APIs remain fail-closed;
- [x] enforce canonical team-to-workspace attribution for both hosted task-board routes at the
      hosted authorization boundary. Resolution uses one bounded, revision-pinned canonical
      lifecycle snapshot, rejects ambiguous/unresolved teams, and then requires the authenticated
      user's current workspace grant. The outer HTTP host accepts only a complete
      route-registration contribution and refuses malformed or non-hosted task-board mounting;
- [ ] provide the production AR-owned task-board page source, mutation-admission port and
      authenticated human `QueryContext` factory, then mount the task-board browser client/page
      through that seam. Standalone intentionally supplies none of those capabilities, so both
      routes remain unmounted there rather than fabricating runtime mutation authority;
- [x] build the desktop renderer/main/preload bundles and the standalone server bundle, including
      emitted `dist-standalone/assets/internal-storage-worker.cjs`;
- [ ] build the final production image and record the mandatory Node-ABI `better-sqlite3`,
      `node-pty` and `ssh2` probe from the `prod-deps` stage;
- [x] retain the current provider-neutral Node crypto and explicit cookie boundary after reviewing
      `openid-client@6.8.4` and `@fastify/cookie@11.1.2`: the implemented surface is smaller than
      either package integration, is covered for the required algorithms/claims/cookie attributes,
      and avoids introducing a second session owner. Neither package is imported and no
      manifest/lockfile mutation is required;
- [x] pass the pinned TypeScript compiler, changed-source type-aware lint, changed-file fast lint,
      Prettier check, focused tests, team-provisioning architecture guard, both Compose profile
      renders and `git diff --check`;
- [x] pass the full feature architecture guard. Hosted standalone now requests a hosted-only scope
      through the existing grandfathered internal-storage public composition factory; the concrete
      narrow worker backend remains private to that feature, while the process-specific alias is
      composed only after hosted root/identity admission in the outer HTTP host;
- [ ] pass full-tree type-aware lint and full tests. The first full changed-file lint invocation
      exhausted its 4 GiB heap; an 8 GiB retry proved changed production source but surfaced
      project-service exclusions for the Docker Vite config and CLI script. Exact type-aware lint
      now passes all 13 owned hosted-auth test files with warnings only: synchronous promise-port
      doubles carry documented test-only `require-await` exceptions, redundant assertions were
      removed, and the browser cookie/Compose proof no longer relies on a complex parser or unsafe
      regular expression. The latest full Vitest run reached 16 failed and 1,567 passing files,
      with 45 failed, 16,731 passing and 72 skipped tests. This branch subsequently fixed and
      focusedly re-proved all three historical hosted-workspace schema upgrade failures from that
      run.
      Remaining branch-attributable evidence assertions outside this ownership receipt still need
      to update the phase-0 environment census for `AUTH_PUBLIC_ORIGIN`, `AUTH_DATA_DIR`,
      `AUTH_CONTROL_SOCKET` and `TRUSTED_PROXY_CIDRS`; accept the hosted-access `main`/`renderer`
      architecture added by the final contract; expect internal-storage schema version 16 rather
      than 11 in the process-ownership migration test; and regenerate the standalone worker-entry
      artifact evidence. Other failures were unrelated baseline/runtime issues, including
      unavailable `/bin/zsh` and MCP dependencies, post-teardown renderer activity, test timeouts
      and an overlong temporary IPC socket path. The source-size guard currently reports only two
      unrelated legacy baseline caps that must move downward;
- [x] perform a P0-P2 security self-review covering replay, state/nonce/PKCE, cookie scope and
      rotation, fixation, back-channel authenticity, trusted proxy handling, role escalation,
      SQLite migration/rollback, exact route fail-closure and secret leakage;
- [ ] prove the repaired desktop Electron preload contract in the controller-owned runtime, with
      hosted auth unmounted, and confirm no desktop/runtime provider environment receives hosted
      auth secrets. The build now emits the CommonJS preload as
      `dist-electron/preload/index.cjs` beneath the root `"type": "module"` package and the main
      window loads that exact artifact, preserving `window.electronAPI` and the desktop `App`
      composition instead of mounting `HostedAuthGate`. Producer execution of Electron is
      intentionally forbidden for this remediation, so an authorized controller must record the
      runtime assertion before this proof can be checked off.

No claim of full personal or OIDC E2E completion is valid until every unchecked item has
authoritative evidence.
