Run only on the hosted coordinator, with an isolated source runtime and its pinned native OpenCode 2.0.21. This starts the actual Electron desktop through the `dev:mcp` entry script and attaches over its announced CDP port. It creates one new TEST team and five native recipients. The model and scoped catalog responses are explicitly scripted loopback fixtures; this does not test semantic image/video understanding.

```sh
xvfb-run -a dbus-run-session -- node --experimental-strip-types \
  scripts/e2e/opencode-input-modalities/run.mts \
  --run-root /srv/workers/JOB/TEST-input-modalities-RUN \
  --runtime-source /srv/workers/JOB/runtime/cli-source \
  --native /absolute/verified/native-opencode \
  --native-sha256 EXACT_SHA256 \
  --cdp-port 19222
```

The run root must not exist. Set `TMPDIR` to the job's scratch filesystem before starting, and put pinned Bun on `PATH` (the catalog-only wrapper has an `env bun` shebang). Never use a foreign CDP listener. Source `runtime providers models` is called once directly before the scripted catalog wrapper to record separate native declaration provenance without inference.

Typecheck separately on HOST:

```sh
node node_modules/@typescript/native/bin/tsc --noEmit \
  -p scripts/e2e/opencode-input-modalities/tsconfig.json
```

`evidence/receipt.json` remains false until all assertions and owned-app cleanup pass. The receipt, screenshots, native catalog result, catalog request journal, and native-to-model MIME/digest/original-message observations remain in the owned run directory even on failure. UI staging changes only the existing development store's synthetic selected team view, preserving the real main/runtime authority. It is used for pending project/target response and queued-text compatibility checks. No production test service or native picker is added.

The transport proof observes exact media bytes in the real native OpenCode model request after the actual UI/main/runtime send, including one original message ID and no duplicate provider turn. It does not claim an independently captured raw `/api/session/{id}/prompt` packet. Native 2.x uses that endpoint; the old `/session/{id}/message` endpoint belongs to legacy native versions.
