# Hosted Web Core v1: stopped-stack recovery

This procedure uses the production image's one-shot CLI at
`/app/scripts/hosted-web/phase-10/state-compatibility/stopped-stack-recovery.mjs`.
Run it for one stopped, single-controller deployment. The CLI archives the app-owned
`/data/.agent-teams` tree, including the separately mounted `/data/.agent-teams/data` volume.
It excludes the instance-lock directory. It does not back up mounted workspace repositories,
the external lifecycle owner, Keycloak/PostgreSQL, Caddy data, or provider installations.
Coordinate those systems with their own backup procedures; their recovery points are not atomic
with this archive. Keep the archive and its containing directory private.
The current archive inventories files under `data/hosted-auth-secrets`; restore replaces those
files with fresh material, but the archive itself can contain old credential bytes and must be
handled as a secret-bearing backup.

## Pre-header state on upgrade

The startup admission gate can stamp the v1 state header on an intact personal-mode
SQLite v30 or v31 database only when its persisted personal authority binding
matches `AUTH_DEPLOYMENT_ID` and `AUTH_RESTORE_GENERATION`. The storage worker then
performs its supported v30 to v31 migration. Unknown older and future SQLite
versions remain refused.

An OIDC-only pre-header database has no `hosted_access_authority` binding: that
row is created only in personal mode. The OIDC mode claim and the current process
environment cannot prove which deployment or restore generation owns those bytes.
Startup therefore refuses it until an operator, with the stack stopped, attests
the binding from an independent deployment record and pins the exact offline DB
bytes. From a source checkout with dependencies installed, verify that the
controller is stopped and that `app.db-wal`, `app.db-shm`, and `app.db-journal` are
absent; obtain the deployment ID and restore generation from the deployment or
restore record, and calculate the SHA-256 of `storage/app.db`. Then run:

```sh
node --import tsx scripts/hosted-web/phase-10/state-compatibility/attest-oidc-preheader.mjs \
  --state-directory /path/to/state \
  --deployment-id DEPLOYMENT_ID \
  --restore-generation GENERATION \
  --database-sha256 SHA256_OF_APP_DB \
  --confirm-stopped yes
```

The command checks SQLite integrity, application ID, supported v30/v31 version,
the persisted OIDC mode claim, absence of a personal authority row, and the
supplied DB digest before writing a private, exclusive attestation file. Startup
rechecks the digest and binding before writing the header. A mismatch or a
pending restore marker still refuses startup. Do not derive the attested binding
from the current environment or from the OIDC database; without the independent
deployment or restore record, this migration has no trustworthy binding proof.

## Prepare and stop

Use the same reviewed image, Compose configuration, secrets, and environment that run the
deployment. From the repository root, set `HOSTED_PROFILE=personal` and
`HOSTED_SERVICE=agent-teams-personal` for Core v1. For an existing Keycloak deployment, use
`keycloak` and `agent-teams-keycloak` respectively, and back up its PostgreSQL state separately.
`COMPOSE_PROJECT_NAME` must identify the source deployment. Choose an absolute recovery directory
outside the repository, all app volumes, and all workspace mounts; make it writable only by the
operator and container UID/GID `1000:1000`. Choose a new `ARCHIVE_NAME` for each attempt so a
known-good archive is never overwritten. Do not put plaintext secrets in these variables.

```sh
export HOSTED_PROFILE=personal
export HOSTED_SERVICE=agent-teams-personal
export COMPOSE_PROJECT_NAME=your_existing_project
export RECOVERY_DIR=/absolute/private/recovery-directory
export ARCHIVE_NAME=app-2026-09-23-001
test -d "$RECOVERY_DIR" && test ! -e "$RECOVERY_DIR/$ARCHIVE_NAME"
```

Drain and stop all hosted teams and provider processes using the external lifecycle owner's
normal stop procedure. Stop that owner and the complete Compose stack, including the controller,
proxy, and any Keycloak/PostgreSQL services in this project. Confirm no controller or provider
process remains and that `docker compose ps -a` shows no running service. Keep the stack stopped
through the archive operation; do not restart a second writer against the same volumes.

```sh
docker compose -f docker/docker-compose.yml --profile "$HOSTED_PROFILE" down
docker compose -f docker/docker-compose.yml --profile "$HOSTED_PROFILE" ps -a
```

The normal `hosted-entrypoint` invokes the native ADR-16 instance-lock launcher. The launcher
acquires the existing root-owned anchor, passes the lease as file descriptor 3, and only then
starts the CLI. The CLI refuses direct execution without that descriptor. Keep the entrypoint,
user, `agent-teams-data` lock volume, and nested `agent-teams-application-data` volume from the
Compose service; never use `--entrypoint`, delete/recreate the anchor, or point two stacks at the
same state. A busy lease is evidence that another process may still own the deployment.

## Backup and verify

The bind mount below is the only archive destination. It must have enough free space for the
whole app data volume and staging copy. `docker compose run --no-deps` starts only this one-shot
container while the rest of the stack stays down.

```sh
docker compose -f docker/docker-compose.yml --profile "$HOSTED_PROFILE" run --no-deps --rm \
  -v "$RECOVERY_DIR:/recovery:rw" \
  -e "HOSTED_RECOVERY_ARCHIVE_ROOT=/recovery/$ARCHIVE_NAME" \
  "$HOSTED_SERVICE" /usr/local/bin/node \
  /app/scripts/hosted-web/phase-10/state-compatibility/stopped-stack-recovery.mjs backup

docker compose -f docker/docker-compose.yml --profile "$HOSTED_PROFILE" run --no-deps --rm \
  -v "$RECOVERY_DIR:/recovery:ro" \
  -e "HOSTED_RECOVERY_ARCHIVE_ROOT=/recovery/$ARCHIVE_NAME" \
  "$HOSTED_SERVICE" /usr/local/bin/node \
  /app/scripts/hosted-web/phase-10/state-compatibility/stopped-stack-recovery.mjs verify

sha256sum "$RECOVERY_DIR/$ARCHIVE_NAME/manifest.json"
cat "$RECOVERY_DIR/$ARCHIVE_NAME/READY.json"
```

Record the `manifestHash` returned by both commands and compare it with the manifest SHA-256 and
`READY.json.manifestHash`. The CLI checks every payload file against `manifest.json`, validates
the state header and SQLite integrity, and accepts only a complete ready marker. Archive creation
writes the payload, durable manifest, and verification before `READY.json`; it then publishes the
staging directory as one archive. A `.partial` directory or an archive without a valid ready
marker is not a recovery point. Preserve the previous verified archive until the new one passes
verification and is copied to protected backup storage. Record the source
`AUTH_DEPLOYMENT_ID`, `AUTH_RESTORE_GENERATION`, image digest, Compose profile, and current
workspace registration manifest alongside the operator's protected recovery record.

Back up Keycloak/PostgreSQL with their native tools and preserve workspace repositories through
Git or infrastructure backup. After all backup work is complete, restart the external lifecycle
owner and the original Compose project using its normal startup procedure, then check health.

## Replace a deployment from an archive

Keep the source controller and its external lifecycle owner offline for the entire replacement.
`replace_deployment` preserves the deployment identity; it is not a supported way to fork a second
live deployment. Verify the archive again with the command above before writing the target. Read
its `manifest.json.deploymentId`. Choose a strictly newer positive `AUTH_RESTORE_GENERATION`
than the backed-up generation, and use the manifest deployment ID as `AUTH_DEPLOYMENT_ID`.
Supply the current operator-approved workspace registration manifest and mounts for the target;
do not treat archived mount fingerprints or old paths as current authority. For the existing
Compose wiring this includes reviewing `HOSTED_WORKSPACE_IDS`, the dedicated `CLAUDE_DIR`, and
the external lifecycle owner configuration before startup.

Use a **new Compose project name with no existing named volumes** for the target. The Compose file
creates separate `${COMPOSE_PROJECT_NAME}_agent-teams-instance-lock` and
`${COMPOSE_PROJECT_NAME}_agent-teams-data` volumes. Check that both names are absent before the
one-shot run; do not reuse the source data volume or an earlier partial target. Docker initializes
the new lock anchor from the image and the application-data volume is empty. The restore CLI
independently rejects any target content beyond the expected anchor and empty data directory.

```sh
export COMPOSE_PROJECT_NAME=your_new_replacement_project
export AUTH_DEPLOYMENT_ID=deployment_id_from_verified_manifest
export AUTH_RESTORE_GENERATION=1  # replace with the next generation for this deployment
if docker volume inspect "${COMPOSE_PROJECT_NAME}_agent-teams-instance-lock" >/dev/null 2>&1 \
  || docker volume inspect "${COMPOSE_PROJECT_NAME}_agent-teams-data" >/dev/null 2>&1; then
  echo 'Refusing an existing replacement volume' >&2
  exit 1
fi

docker compose -f docker/docker-compose.yml --profile "$HOSTED_PROFILE" run --no-deps --rm \
  -v "$RECOVERY_DIR:/recovery:ro" \
  -e "HOSTED_RECOVERY_ARCHIVE_ROOT=/recovery/$ARCHIVE_NAME" \
  "$HOSTED_SERVICE" /usr/local/bin/node \
  /app/scripts/hosted-web/phase-10/state-compatibility/stopped-stack-recovery.mjs restore
```

Require a `status: restored` result with the expected `manifestHash`, deployment ID, and restore
generation. The CLI verifies the ready marker, manifest, file hashes, and SQLite integrity before
writing. It then copies the whole app-owned payload, rotates the SQLite access authority and event
epoch, revokes copied sessions and OIDC login state, generates fresh keyring/identity material,
and leaves a durable restore journal and pending rotation marker. Old browser cookies and pairing
tickets must never work on the replacement. These files are a request for startup completion, not
proof that runtime credentials and workspace mounts have already rotated.

Start the target external lifecycle owner with fresh admission evidence and the reviewed current
workspace registration/mount configuration. Then start only the replacement Compose project:

```sh
docker compose -f docker/docker-compose.yml --profile "$HOSTED_PROFILE" up -d
docker compose -f docker/docker-compose.yml --profile "$HOSTED_PROFILE" ps
docker compose -f docker/docker-compose.yml --profile "$HOSTED_PROFILE" logs --tail=100 "$HOSTED_SERVICE"
```

Wait for the controller's readiness check before admitting browser traffic. Startup must consume
the pending rotation marker, rotate runtime authority, establish fresh mount bindings, and finish
command/lifecycle recovery before mutation admission. Verify that the pending marker is gone and
`data/hosted-restore-rotation.completed.v1.json` exists in the replacement volume; confirm
controller health, workspace registration, a fresh personal pairing exchange (or fresh OIDC
login and workspace grant), and rejection of a pre-restore browser session. Never adopt an old
PID or provider process from the archive. If an external owner or a workspace mount is missing,
leave the deployment unavailable until it is reconciled.

## Drill and failure handling

Before relying on a new image, run a full rehearsal using **new sandbox/test projects and new
Compose volumes only**: populate synthetic hosted state, stop the entire sandbox stack, run the
packaged `backup` and `verify` commands, restore into a fresh sandbox project name, start it with
the incremented generation, and confirm readiness, rotation completion, fresh pairing/login,
workspace rebinding, and old-session refusal. The focused fixture drill is
`node scripts/hosted-web/phase-10/state-compatibility/recovery-drill.mjs`; it checks archive and
restore mechanics but does not replace the Compose startup drill. For a built image, set
`HOSTED_RECOVERY_TEST_IMAGE` to its exact image reference and run
`node --test scripts/hosted-web/phase-10/state-compatibility/recovery-package.test.mjs` to check
that the image contains the CLI, relative I/O module, and working native SQLite driver.

If the launcher reports `instance_lock:lease_busy`, leave the stack stopped and identify the owner.
If backup/verify reports an invalid ready marker, checksum, state header, or SQLite database, keep
the archive unadvertised and use the last verified recovery point. Never edit a manifest or ready
marker to make it pass. If restore fails after it writes target files, keep the target offline;
retain it for diagnosis and retry from the immutable archive into **another fresh empty target**
with a newer target project name. If startup cannot prove rotation, mounts, or lifecycle recovery,
keep the controller unavailable and inspect its private diagnostics and restore markers. Do not
disable lease checks, reuse old credentials, merge files into a live volume, or restart the source
while the replacement is active.
