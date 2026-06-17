# Chaining bridge tools: use pipe / batch, not shell glue

When you would chain a bridge listing tool into a filter, or run several
bridge tools at once, use the bridge's own meta-tools instead of stitching
shell commands together.

## pipe — filter a listing tool on structured fields

`mcp__plugin_mcp-tool-bridge_tool-bridge__pipe` runs a source tool (find, ls,
lsof, kubectl_list, docker_list, docker_images) and filters its output on typed
fields (AND semantics, dot-notation, `contains`/`equals`/`starts_with`, limit).

| Instead of (Bash) | Do |
|-------------------|-----|
| `find . -name '*.rs' \| grep test` | `…__pipe` source=find, filter on name |
| `docker ps \| grep redis` | `…__pipe` source=docker_list, filter on name/image |
| `lsof -i \| grep LISTEN` | `…__pipe` source=lsof, filter on the relevant field |

## batch — run several bridge tools in one call

`mcp__plugin_mcp-tool-bridge_tool-bridge__batch` runs multiple bridge tools in
parallel and returns all results together, with per-operation error isolation.
Use it when you'd otherwise fire several independent read calls in sequence
(e.g. `ls` here + `git_status` there + `ps`), or several `&&`-joined reads.

## When Bash is still correct

- The pipeline crosses into a non-bridge filter you genuinely need
  (`awk` math, `sed` rewriting, `sort -u`, `xargs` into another program).
- The source isn't one of pipe's whitelisted listing tools.

## Why

`pipe`/`batch` keep the data structured end-to-end (you filter on real fields,
not regex over rendered text) and collapse multiple round-trips into one call.
