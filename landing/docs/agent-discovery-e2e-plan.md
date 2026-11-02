# Agent discovery and docs SEO: implementation plan

Date: 2026-11-02. Scope: `landing/` only, including the docs build check.

## User value

AI agents should find the product, distinguish the free local desktop app from model-provider billing, install it and discover the actual **local** MCP connection. Search engines should index each docs page rather than assigning every page the docs home canonical.

## Changes

1. Remove the global VitePress canonical and `og:url`; emit unique per-page links using the configured docs origin and clean-route semantics, including index pages and non-root deploy bases.
2. Link concise externally usable instructions for Claude Code and Codex to the **running desktop** MCP endpoint. Do not advertise a public SaaS API, remote cloud access, universal agent support or capabilities outside the actual MCP management tool scope.
3. Improve landing `llms.txt`, with direct installation/docs/MCP/privacy/pricing links, and an honest `/auth.md` describing no Agent Teams sign-in and optional third-party provider auth.
4. Retain the existing JSON-LD `SoftwareApplication` and zero-dollar `Offer`, but remove unverified `softwareVersion: latest`.
5. Add a post-SSG check for canonical/OG URLs on distinct docs pages, `llms.txt`, `auth.md` and basic home structured-data integrity. Run it in the existing GitHub Pages PR workflow.

## Non-goals

No new public REST API, SDK, OAuth endpoints, public MCP manifest, WebMCP, MCP Apps, artificial signup flow, process manager, feature flags, or desktop modifications.

## Acceptance

- VitePress homepage, nested English guide, localized guide, and nested `index.md` each have **one correct canonical** and a matching `og:url`.
- `/docs/` and `/docs/guide/... ` remain valid with GitHub Pages base `/agent-teams-ai/`, as well as the separate production docs origin.
- The generated landing contains non-empty `llms.txt` and `auth.md`, and a software `Offer` with price `0` in JSON-LD.
- The new guide never directs cloud agents to `localhost` without a local executor; requires live per-app endpoint discovery; avoids unrestricted launches/mutations.
- Pass landing CI (SSG + guard), inspect code review and required checks before merge; post-merge verify deploy evidence.

## Review checkpoints

- Discovery accuracy: never represent an installed desktop/local MCP endpoint as an internet-hosted API.
- Static output accuracy: test generated HTML rather than only TypeScript helper outputs; avoid duplicate canonical metadata.
- Security: no public auth metadata for nonexistent server; no exposed local port, secrets, permissive origin, or generic remote MCP proxy.
