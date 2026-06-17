# Read-only inspection: use mcp-tool-bridge, not Bash

When you need to **read** filesystem, process, git, container, cluster, or
database state, call the matching `mcp__plugin_mcp-tool-bridge_tool-bridge__*`
tool instead of spawning Bash. The bridge returns typed JSON — no parsing, no
shell-quoting bugs, no truncation guesswork.

This is a hard preference for the exact command shapes below. It is NOT a
blanket ban on Bash (see "When Bash is still correct").

## Command → tool

| If you would run (Bash) | Call instead |
|-------------------------|--------------|
| `ls`, `ls -l`, `ls -la`, `ls <dir>` | `…__ls` (`path`, `all`, `long`) |
| `find <dir> -name/-type/-maxdepth/-size` | `…__find` |
| `ps`, `ps aux`, `ps -ef` | `…__ps` (filter by name/user/pid) |
| `lsof -i`, `lsof -iTCP:<port>`, `lsof -p <pid>` | `…__lsof` |
| `wc`, `wc -l/-w/-c <file…>` | `…__wc` |
| `diff -u <a> <b>` output you need to parse | `…__diff` (feed it the unified-diff text) |
| `git status` / `git status --porcelain` | `…__git_status` |
| `git log` (default form) | `…__git_log` |
| `git show <ref>` | `…__git_show` |
| `kubectl get <kind>` (list) | `…__kubectl_list` |
| `kubectl get <kind> <name>` | `…__kubectl_get` |
| `docker ps` / list containers | `…__docker_list` |
| `docker inspect <container>` | `…__docker_inspect` |
| `docker images` | `…__docker_images` |
| `sqlite3 <db> "SELECT …"` (read-only) | `…__sqlite_query` |
| `sqlite3 <db> .schema` / `.tables` | `…__sqlite_tables` |
| GitHub API reads (`gh api …`) | `…__gh_api` |

(`…` = `mcp__plugin_mcp-tool-bridge_tool-bridge`. The prefix can differ per
install; confirm the actual tool name in your session's tool list.)

## When Bash is still correct

- **Compound shells**: pipelines (`|`), `&&`/`;` chains, redirections (`>`),
  command substitution (`$(…)`), subshells. The bridge tools are single
  operations; to chain bridge tools use `…__pipe` / `…__batch`, but a pipeline
  that crosses into `grep`/`awk`/`sed` stays in Bash.
- **Flags outside the bridge's coverage**: e.g. `ls -lt` (sort by mtime),
  `git log --oneline`/`--pretty` (different output shape), `find -exec`. If the
  bridge can't express it, use Bash.
- **Mutations**: `rm`, `mkdir`, `git commit`, `docker run`, `kubectl apply`,
  etc. The read tools above never mutate.

## Why

The bridge is a persistent process (no per-call shell spawn), returns typed
fields (no regex-parsing `lsof -F` or `--porcelain=v2`), and reports
truncation explicitly. For the shapes above it is strictly better than Bash.
