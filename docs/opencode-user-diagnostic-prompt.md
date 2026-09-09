# OpenCode integration diagnostic prompt

Help diagnose an OpenCode integration failure in Agent Teams on my machine.

## Symptoms

- The installed app sometimes times out running OpenCode `--version`.
- Other times it reports:
  ```text
  opencode: OpenCode catalog request failed.
  cursor-acp: OpenCode catalog request failed.
  kiro: OpenCode catalog request failed.
  ollama: OpenCode catalog request failed.
  ```
- OpenCode works independently in my terminal and in its desktop app.
- Running Agent Teams as administrator did not resolve the issue.

Repository: 777genius/agent-teams-ai

## Investigation

Investigate first, without changing code or reinstalling anything:

1. Record my OS, installed Agent Teams version, OpenCode version and installation method. Locate all OpenCode executables resolved by my shell.

2. Locate Agent Teams diagnostics and `app-errors.ndjson`, if available. Inspect entries around a fresh reproduction. Ask me to reproduce the failure if necessary. Do not assume missing logs mean nothing failed.

3. Determine the exact OpenCode executable selected by Agent Teams, including whether it is app-managed or resolved from PATH. Compare it with the working terminal executable. Distinguish confirmed observations from information inferred from code.

4. Run that exact executable with `--version` from a new disposable test directory. Capture elapsed time, stdout, stderr and exit status. Compare relevant environment differences with the app where observable: PATH, working directory, home/config directories and elevation. Never dump the full environment or authentication files.

5. Trace catalog loading in the source matching the installed release. Identify whether the failure occurs during executable discovery, version probing, server startup or a catalog HTTP request. Preserve the underlying error, including connection cause or HTTP status. Do not treat the repeated provider errors as independent failures without evidence.

6. If installed-app evidence is insufficient, clone into a new test directory and follow the repository setup instructions. Use the desktop Electron app via `pnpm dev` and capture terminal output. If automating UI inspection, follow the repository's `pnpm dev:mcp` instructions. Compare the matching release first; label any tests against a newer version separately.

## Constraints

Do not launch teams or agents, open runtimes in real projects, modify credentials, disable security software or kill unrelated processes.

Redact tokens, passwords, authorization headers and private data from anything you ask me to share.

## Report

Return a concise report:

- Confirmed failing stage and evidence.
- Exact executable and version used.
- Relevant sanitized log excerpts.
- Whether the installed and development apps behave differently.
- Most likely cause, confidence and the smallest next diagnostic step.
