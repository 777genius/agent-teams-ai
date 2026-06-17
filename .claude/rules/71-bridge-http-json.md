# HTTP + JSON: use the bridge curl, never hand-parse responses

When you make an HTTP request whose response you intend to inspect, call
`mcp__plugin_mcp-tool-bridge_tool-bridge__curl` instead of shelling out. It
returns a structured envelope — status, headers, timing breakdown, and the
body with JSON auto-detected and parsed — so you never pipe into `jq`,
`python3 -m json.tool`, or a throwaway parse script.

## Do this

| Instead of (Bash) | Do |
|-------------------|-----|
| `curl -s <url> \| jq '.field'` | `…__curl` then read the parsed `body` |
| `curl -s <url> \| python3 -c "import json,sys; …"` | `…__curl` then read `body` |
| `curl -sI <url>` (just headers) | `…__curl` and read `headers` |
| `curl -s -w '%{time_total}' <url>` | `…__curl` and read the `timing` breakdown |

(`…` = `mcp__plugin_mcp-tool-bridge_tool-bridge`.)

## When Bash curl is still correct

- **GitHub / Forgejo API**: use the dedicated CLIs per the forge-CLI rule
  (`gh` for GitHub, `fj` for Forgejo) or `…__gh_api` — not raw curl.
- **Downloads to disk**, file uploads, streaming, or auth flows that need
  cookie jars / client certs — features the bridge curl doesn't expose.
- **Non-HTTP** protocols.

## Why

`curl | jq` / `curl | python` shows up thousands of times in history — it's
the single most common "the agent reimplemented what the tool already does"
pattern. The bridge curl gives you the parsed body directly and reports
malformed-JSON / non-2xx status as typed fields instead of you scraping text.
