# Unified LLM API Libraries for TypeScript/Electron

> **Date:** 2026-03-24
> **Goal:** Find the best library that provides a single API for calling multiple LLM providers (OpenAI, Anthropic, Google, etc.) from our Electron app.
> **Requirements:** TypeScript-native, tool calling, streaming, can run in Electron (no server), open source, actively maintained, MCP integration

---

## TL;DR — Recommendation

**Vercel AI SDK (`ai` + `@ai-sdk/*` providers)** is the clear winner for our use case.

| Criteria | Winner |
|---|---|
| Best as a library (not framework) | Vercel AI SDK |
| Tool calling across providers | Vercel AI SDK |
| Streaming | Vercel AI SDK |
| TypeScript DX | Vercel AI SDK |
| MCP integration | Vercel AI SDK |
| Runs in Electron (no server) | Vercel AI SDK, multi-llm-ts |
| Community & maintenance | Vercel AI SDK |
| Lightweight / minimal footprint | multi-llm-ts |

If we need something **even simpler** with zero framework overhead and 12 provider support, `multi-llm-ts` is a solid lightweight alternative (already used by a production Electron app — Witsy).

---

## Candidates Compared

### 1. Vercel AI SDK (RECOMMENDED)

| | |
|---|---|
| **Package** | `ai` (core), `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, etc. |
| **GitHub** | [github.com/vercel/ai](https://github.com/vercel/ai) |
| **Stars** | ~23K |
| **npm downloads** | ~4.5M/week (across `ai` + `@ai-sdk/*` packages) |
| **License** | Apache 2.0 |
| **Latest version** | ai@6.0.138 (March 2026) |
| **TypeScript** | Native TypeScript, written from scratch. Excellent DX. |
| **Contributors** | 597+ |

**Provider coverage:**
100+ models supported. Official provider packages for: OpenAI, Anthropic, Google (Gemini), Mistral, Cohere, Amazon Bedrock, Azure OpenAI, xAI (Grok), Groq, Perplexity, Fireworks, Together AI, DeepSeek, Ollama (local), and 40+ community providers including OpenRouter, Portkey, etc.

**Tool calling:** Full support via `generateText` and `streamText`. Multi-step tool execution loops with `stopWhen`. AI SDK 6 introduces `ToolLoopAgent` for automatic tool execution. `needsApproval: true` for human-in-the-loop. Type-safe tool definitions with Zod schemas.

**Streaming:** First-class streaming via `streamText()` and `streamObject()`. Returns async iterable `textStream`. No custom parsing needed.

**MCP integration:** Full MCP support since AI SDK 6. Built-in MCP client with `tools()` method that adapts MCP tools to AI SDK tools. Supports HTTP/SSE/stdio transports. OAuth authentication for MCP servers. Elicitation support (MCP servers can request user input).

**Can run in Electron:** YES. `generateText()` and `streamText()` are pure Node.js functions — no web server required. Work directly in Electron's main process. Confirmed by Sentry's Electron + Vercel AI integration. Community project [electron-ai-chatbot](https://github.com/pashvc/electron-ai-chatbot) exists.

**Maturity:** Very high. Used by Thomson Reuters, Clay, and "teams ranging from startups to Fortune 500 companies". 20M+ monthly downloads. Active development with frequent releases (multiple per week).

**Strengths:**
- Most library-like: single function calls (`generateText`, `streamText`, `generateObject`), no framework lock-in
- Switch providers by changing one line of code
- Best TypeScript DX in the category
- Huge ecosystem of provider packages
- Excellent documentation at [ai-sdk.dev](https://ai-sdk.dev/)
- Built-in fallbacks in AI SDK 6
- DevTools for debugging LLM calls

**Weaknesses:**
- Provider packages add separate dependencies (though each is small)
- UI hooks (`useChat`, `useCompletion`) are React/web focused — not relevant for our Electron main process use
- Some newer features (AI SDK 6) are still stabilizing

**Reliability: 9/10 | Confidence: 9/10**

**Links:**
- [Official docs](https://ai-sdk.dev/docs/introduction)
- [Tool calling docs](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
- [MCP tools docs](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools)
- [Node.js getting started](https://ai-sdk.dev/docs/getting-started/nodejs)
- [AI SDK 6 announcement](https://vercel.com/blog/ai-sdk-6)
- [npm: ai](https://www.npmjs.com/package/ai)
- [GitHub](https://github.com/vercel/ai)

---

### 2. multi-llm-ts (Lightweight Alternative)

| | |
|---|---|
| **Package** | `multi-llm-ts` |
| **GitHub** | [github.com/nbonamy/multi-llm-ts](https://github.com/nbonamy/multi-llm-ts) |
| **Stars** | ~50 (small project) |
| **npm downloads** | ~211/week |
| **License** | MIT |
| **Latest version** | 4.6.2 (March 2026) |
| **TypeScript** | Native TypeScript |
| **Maintainers** | 1 |

**Provider coverage:**
12 providers: OpenAI, Anthropic, Google, Mistral, Groq, Ollama, xAI, DeepSeek, Cerebras, Meta/Llama, Azure AI, OpenRouter.

**Tool calling:** Built-in plugin/tool system. Define tools with parameter descriptions and execution logic. Tool calling handled automatically across all providers.

**Streaming:** `complete()` (non-streaming) and `generate()` (streaming) methods.

**MCP integration:** None built-in.

**Can run in Electron:** YES. Already powering [Witsy](https://github.com/nbonamy/witsy) — a production Electron desktop AI assistant using 20+ providers through this library. This is the most proven Electron integration of any library on this list.

**Maturity:** Active development, frequent releases. Small community but proven in production via Witsy.

**Strengths:**
- Smallest, most focused library — does exactly one thing well
- Already proven in a real Electron desktop app
- MIT license
- Clean abstraction: `igniteEngine()` / `igniteModel()` → `complete()` / `generate()`
- AbortSignal support for cancellation
- Token usage tracking
- Multi-attachment support

**Weaknesses:**
- Single maintainer — bus factor risk
- Very small community (~211 downloads/week)
- No MCP integration
- No structured output (generateObject equivalent)
- 12 providers vs 100+ in Vercel AI SDK
- Limited documentation

**Reliability: 6/10 | Confidence: 7/10**

**Links:**
- [npm: multi-llm-ts](https://www.npmjs.com/package/multi-llm-ts)
- [GitHub](https://github.com/nbonamy/multi-llm-ts)
- [Witsy (Electron app using it)](https://github.com/nbonamy/witsy)

---

### 3. Mastra

| | |
|---|---|
| **Package** | `@mastra/core` |
| **GitHub** | [github.com/mastra-ai/mastra](https://github.com/mastra-ai/mastra) |
| **Stars** | ~19.8K |
| **npm downloads** | ~300K/week |
| **License** | Apache 2.0 (core), Enterprise License (ee/ features) |
| **Latest version** | 1.x (January 2026 v1.0) |
| **TypeScript** | Native TypeScript, from Gatsby team |

**Provider coverage:**
3,388 models from 94 providers — because it uses Vercel AI SDK under the hood for model routing.

**Tool calling:** Full tool calling support. Define tools with schemas and descriptions. `ToolSearchProcessor` lets agents search for and load tools on demand.

**Streaming:** Yes, via Vercel AI SDK.

**MCP integration:** Yes, via `@mastra/mcp` package. Acts as both MCP client and server. Supports SSE, HTTP, and Hono-based MCP servers. MCP tool calls are traced with dedicated span types.

**Can run in Electron:** Partially. Mastra has an official [Electron guide](https://mastra.ai/guides/getting-started/electron). However, it's designed as a server-side framework with HTTP endpoints. Using it in Electron's main process would mean importing a framework designed for servers into a desktop app.

**Maturity:** High. v1.0 since January 2026. Y Combinator W25 batch ($13M funding). Used by Replit, PayPal, Sanity.

**Strengths:**
- Huge provider coverage (94 providers through Vercel AI SDK)
- Built-in agents, workflows, memory, evals
- Clean TypeScript DX
- Strong MCP integration including MCP server authoring
- Backed by VC funding and large team
- Official Electron guide exists

**Weaknesses:**
- It's a FRAMEWORK, not a library — brings entire agent/workflow/memory system
- Heavy dependency graph (`@mastra/core` pulls in many dependencies)
- Enterprise license for some features (RBAC, ACL)
- Designed primarily for server environments
- Overkill if you just need to call LLMs from Electron
- Uses Vercel AI SDK internally — so you'd be adding a framework layer on top of the library we actually need

**Reliability: 8/10 | Confidence: 6/10** (for our "library" use case — it's a great framework but overkill)

**Links:**
- [mastra.ai](https://mastra.ai/)
- [Docs](https://mastra.ai/docs)
- [Electron guide](https://mastra.ai/guides/getting-started/electron)
- [npm: @mastra/core](https://www.npmjs.com/package/@mastra/core)
- [GitHub](https://github.com/mastra-ai/mastra)
- [MCP integration docs](https://docs.mcp.run/integrating/tutorials/mcpx-mastra-ts/)

---

### 4. LangChain.js

| | |
|---|---|
| **Package** | `langchain`, `@langchain/core`, `@langchain/openai`, etc. |
| **GitHub** | [github.com/langchain-ai/langchainjs](https://github.com/langchain-ai/langchainjs) |
| **Stars** | ~17.3K |
| **npm downloads** | ~1M/week |
| **License** | MIT |
| **Latest version** | langchain@1.2.30 (March 2026) |
| **TypeScript** | TypeScript, ported from Python |

**Provider coverage:**
100+ LLM providers, 50+ vector stores, hundreds of tools.

**Tool calling:** Standardized `tool_calls` interface on AIMessage. `bind_tools()` and `create_tool_calling_agent()`. Dynamic tools and recovery from hallucinated tool calls (since v1.2.13). Custom Vitest matchers for tool call assertions.

**Streaming:** Yes, via `streamEvents` and async iterators. Real-time streaming with `StreamEvents`.

**MCP integration:** Community integrations exist but not first-party like Vercel AI SDK.

**Can run in Electron:** Yes, technically (it's Node.js), but:
- Heavy: 101.2 kB gzipped bundle
- Designed for server environments
- Many abstractions add overhead

**Maturity:** Very high. Largest ecosystem. LangSmith for observability. 8 maintainers.

**Strengths:**
- Largest ecosystem and community
- Most integrations (100+ providers, 50+ vector stores)
- LangSmith for production observability
- LangGraph for complex agent workflows
- Mature, well-documented

**Weaknesses:**
- Most framework-like — imposes architecture
- Heaviest bundle (101.2 kB gzipped)
- More boilerplate than Vercel AI SDK
- TypeScript feels like a port from Python (Python-first design)
- Frequent breaking changes historically
- "Powerful but sometimes overly complex for straightforward use cases"
- Edge runtime blocked

**Reliability: 8/10 | Confidence: 5/10** (for our use case — great framework, wrong fit for lightweight Electron integration)

**Links:**
- [langchain.com](https://www.langchain.com/)
- [JS docs](https://docs.langchain.com/oss/javascript/langchain/overview)
- [npm: langchain](https://www.npmjs.com/package/langchain)
- [GitHub](https://github.com/langchain-ai/langchainjs)
- [Tool calling with LangChain](https://blog.langchain.com/tool-calling-with-langchain/)

---

### 5. Portkey AI Gateway

| | |
|---|---|
| **Package** | `@portkey-ai/gateway` (self-hosted), `portkey-ai` (SDK), `@portkey-ai/vercel-provider` |
| **GitHub** | [github.com/Portkey-AI/gateway](https://github.com/Portkey-AI/gateway) |
| **Stars** | ~11K |
| **npm downloads** | Low (niche) |
| **License** | MIT |
| **Latest version** | gateway@1.15.2 |
| **TypeScript** | Written in TypeScript |

**Provider coverage:**
1,600+ models. 200+ LLM providers. 50+ AI guardrails.

**Tool calling:** Supported via OpenAI-compatible API. Also integrates as [Vercel AI SDK provider](https://ai-sdk.dev/providers/community-providers/portkey).

**Streaming:** Yes.

**MCP integration:** Has MCP Gateway feature for centralized MCP server management.

**Can run in Electron:** PARTIALLY. The gateway itself can run via `npx @portkey-ai/gateway` (starts a local server). The SDK (`portkey-ai`) is a client that needs a running gateway. This means you'd need to either: (a) run the gateway as a subprocess in Electron, or (b) use the hosted Portkey service. Neither is ideal vs just importing a library.

**Maturity:** High. 10B+ tokens processed daily. SOC2, HIPAA, GDPR compliant. Used by Postman, Haptik, Turing.

**Strengths:**
- Enterprise-grade: fallbacks, retries, load balancing, guardrails
- 1,600+ models
- <1ms gateway latency, 122kb footprint
- Excellent observability and logging
- MCP Gateway for centralized tool management
- Integrates with Vercel AI SDK as a provider

**Weaknesses:**
- Gateway architecture — needs a running server/proxy, doesn't work as a pure import
- For Electron, adds unnecessary complexity (subprocess management)
- Best as a production gateway, not as an embedded library
- Hosted service has latency (25-40ms added)
- Primarily designed for server/cloud deployments

**Reliability: 9/10 | Confidence: 4/10** (excellent product, wrong architecture for embedded Electron use)

**Links:**
- [portkey.ai](https://portkey.ai/)
- [Gateway docs](https://portkey.ai/docs/product/ai-gateway)
- [npm: @portkey-ai/gateway](https://www.npmjs.com/package/@portkey-ai/gateway)
- [GitHub](https://github.com/Portkey-AI/gateway)
- [Vercel AI SDK provider](https://ai-sdk.dev/providers/community-providers/portkey)

---

### 6. OpenRouter SDK

| | |
|---|---|
| **Package** | `@openrouter/sdk` |
| **GitHub** | [github.com/OpenRouterTeam/typescript-sdk](https://github.com/OpenRouterTeam/typescript-sdk) |
| **Stars** | ~148 |
| **npm downloads** | ~345K/week |
| **License** | Apache 2.0 |
| **Latest version** | 0.9.11 (beta) |
| **TypeScript** | Auto-generated from OpenAPI spec |

**Provider coverage:**
300+ models from 60+ providers through OpenRouter's unified endpoint.

**Tool calling:** Yes, built-in. Clean architecture for agentic workflows.

**Streaming:** Yes.

**MCP integration:** Not built-in. OpenRouter is a routing service, not an MCP-aware system.

**Can run in Electron:** YES, but requires internet connectivity to OpenRouter's API. All requests go through OpenRouter's servers (adds 25-40ms latency). Cannot use API keys directly with providers — must go through OpenRouter.

**Maturity:** SDK is in BETA. May have breaking changes between versions.

**Strengths:**
- Simple: one API key, one endpoint, 300+ models
- Auto-generated types always match the API
- High weekly downloads (345K)
- Pay-as-you-go pricing
- Also available as Vercel AI SDK provider (`@openrouter/ai-sdk-provider`, 611 stars)

**Weaknesses:**
- BETA status — not production-stable
- Requires routing through OpenRouter's servers (vendor dependency)
- Added latency per request
- Cannot use your own API keys directly with providers
- ESM-only (no CommonJS support)
- Not a library — it's a client for a service

**Reliability: 6/10 | Confidence: 5/10** (good service, but vendor dependency + beta status)

**Links:**
- [openrouter.ai](https://openrouter.ai/)
- [TypeScript SDK docs](https://openrouter.ai/docs/sdks/typescript)
- [npm: @openrouter/sdk](https://www.npmjs.com/package/@openrouter/sdk)
- [GitHub](https://github.com/OpenRouterTeam/typescript-sdk)
- [AI SDK provider](https://www.npmjs.com/package/@openrouter/ai-sdk-provider)

---

### 7. Google Genkit

| | |
|---|---|
| **Package** | `genkit` |
| **GitHub** | [github.com/firebase/genkit](https://github.com/firebase/genkit) |
| **Stars** | ~5.7K |
| **npm downloads** | ~moderate (41 dependents) |
| **License** | Apache 2.0 |
| **Latest version** | 1.30.1 |
| **TypeScript** | TypeScript + Go + Python |

**Provider coverage:**
Google (Gemini), OpenAI, Anthropic, Ollama, AWS Bedrock, Azure OpenAI, Mistral, Cloudflare Workers AI, Hugging Face, and more via plugins.

**Tool calling:** Full support via `defineTool` API. Interrupts for human-in-the-loop. Multi-agent architectures with sub-agents as tools.

**Streaming:** Yes.

**MCP integration:** Yes, supports connecting to external MCP servers for tool discovery and execution.

**Can run in Electron:** Technically yes (Node.js), but designed for Firebase/Cloud Run deployment. Brings CLI, local dev UI, and server deployment patterns.

**Maturity:** Built by Google, used in production by Firebase. Active development.

**Strengths:**
- Built by Google, used in production
- Clean tool calling API
- Multi-agent support
- MCP integration
- Dev UI for debugging

**Weaknesses:**
- Firebase/Google ecosystem bias
- Server-oriented design (CLI, cloud deployment focus)
- Smaller ecosystem than Vercel AI SDK or LangChain
- Not designed for desktop/Electron apps

**Reliability: 7/10 | Confidence: 4/10** (good framework, Google-centric, not ideal for Electron)

**Links:**
- [genkit.dev](https://genkit.dev/)
- [Firebase docs](https://firebase.google.com/docs/genkit)
- [npm: genkit](https://www.npmjs.com/package/genkit)
- [GitHub](https://github.com/firebase/genkit)
- [Tool calling docs](https://genkit.dev/docs/js/tool-calling/)

---

### 8. Bifrost (Maxim AI)

| | |
|---|---|
| **Package** | `@maximhq/bifrost` (via npx) |
| **GitHub** | [github.com/maximhq/bifrost](https://github.com/maximhq/bifrost) |
| **Stars** | ~2K+ |
| **License** | Source-available (check repo) |
| **Language** | Go (not TypeScript) |

**Provider coverage:**
15+ providers through OpenAI-compatible API.

**Tool calling:** Yes, via "Code Mode" — innovative approach reducing token usage by 50%.

**MCP integration:** Yes, acts as both MCP client and server. Centralized MCP tool management.

**Can run in Electron:** NO — it's a Go binary that runs as a server. Would need to be spawned as a subprocess and communicated with via HTTP.

**Strengths:**
- Blazing fast: 11us overhead (50x faster than LiteLLM)
- Code Mode innovation for tool calling
- Strong MCP gateway features

**Weaknesses:**
- Go binary, not a JS library
- Requires running a separate server process
- Wrong architecture for embedded Electron use

**Reliability: 7/10 | Confidence: 2/10** (great gateway, completely wrong for our use case)

**Links:**
- [docs.getbifrost.ai](https://docs.getbifrost.ai/overview)
- [GitHub](https://github.com/maximhq/bifrost)

---

## Comparison Matrix

| Library | Stars | npm/week | Tool Calling | Streaming | MCP | Electron | TypeScript | License | Library vs Framework |
|---|---|---|---|---|---|---|---|---|---|
| **Vercel AI SDK** | 23K | 4.5M | Excellent | Excellent | Full (v6) | YES | Native | Apache 2.0 | Library |
| **multi-llm-ts** | ~50 | 211 | Good | Good | No | YES (proven) | Native | MIT | Library |
| **Mastra** | 19.8K | 300K | Excellent | Excellent | Full | Partial | Native | Apache 2.0* | Framework |
| **LangChain.js** | 17.3K | 1M | Excellent | Good | Partial | Heavy | Ported | MIT | Framework |
| **Portkey** | 11K | Low | Good | Yes | MCP Gateway | Needs server | Native TS | MIT | Gateway |
| **OpenRouter SDK** | 148 | 345K | Good | Yes | No | Via service | Auto-gen | Apache 2.0 | Service client |
| **Google Genkit** | 5.7K | Moderate | Good | Yes | Yes | Server-focused | Native | Apache 2.0 | Framework |
| **Bifrost** | 2K+ | N/A | Innovative | Yes | Full | No (Go binary) | N/A | Source-avail | Gateway |

---

## Architecture for Our Electron App

### Recommended Approach: Vercel AI SDK in Electron Main Process

```
Renderer (React UI)
  │
  │ IPC (ipcMain / ipcRenderer)
  │
Main Process (Node.js)
  ├── AI SDK Core (generateText, streamText, generateObject)
  │   ├── @ai-sdk/openai    → OpenAI API
  │   ├── @ai-sdk/anthropic → Anthropic API
  │   ├── @ai-sdk/google    → Google Gemini API
  │   └── @ai-sdk/xai       → xAI/Grok API
  │
  ├── MCP Client (AI SDK built-in)
  │   └── Connect to MCP servers for tool discovery
  │
  └── API Key Storage (local, secure)
```

### Installation

```bash
pnpm add ai @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/google
```

### Example Usage (Electron Main Process)

```typescript
import { generateText, streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';

// Switch provider by changing one line
const model = anthropic('claude-sonnet-4-20250514');
// const model = openai('gpt-4o');
// const model = google('gemini-2.0-flash');

// Non-streaming
const { text } = await generateText({
  model,
  prompt: 'Explain quantum computing',
});

// Streaming
const result = streamText({
  model,
  prompt: 'Write a story',
});
for await (const chunk of result.textStream) {
  // Send to renderer via IPC
  mainWindow.webContents.send('ai:chunk', chunk);
}

// Tool calling
const { text, toolCalls } = await generateText({
  model,
  tools: {
    getWeather: {
      description: 'Get weather for a location',
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }) => fetchWeather(city),
    },
  },
  prompt: 'What is the weather in Tokyo?',
});
```

---

## Decision

**Primary choice: Vercel AI SDK (`ai` + provider packages)**
- Reliability: 9/10
- Confidence: 9/10
- Reason: Best TypeScript DX, most library-like, full MCP support, huge ecosystem, works in Electron main process, active development

**Fallback / lightweight alternative: `multi-llm-ts`**
- Reliability: 6/10
- Confidence: 7/10
- Reason: Already proven in production Electron app (Witsy), minimal footprint, but small community and no MCP

**NOT recommended for our use case:**
- LangChain.js — too heavy, framework-oriented, Python-first design
- Mastra — excellent framework but overkill (and uses Vercel AI SDK internally anyway)
- Portkey/Bifrost — gateway architecture, needs running server
- OpenRouter SDK — vendor dependency, beta status
- Google Genkit — server/Firebase oriented

---

## Sources

- [Vercel AI SDK — Official docs](https://ai-sdk.dev/docs/introduction)
- [Vercel AI SDK — GitHub](https://github.com/vercel/ai)
- [AI SDK 6 announcement](https://vercel.com/blog/ai-sdk-6)
- [AI SDK MCP tools](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools)
- [AI SDK Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
- [LangChain.js — GitHub](https://github.com/langchain-ai/langchainjs)
- [LangChain.js — npm](https://www.npmjs.com/package/langchain)
- [LangChain vs Vercel AI SDK vs OpenAI SDK: 2026 Guide](https://strapi.io/blog/langchain-vs-vercel-ai-sdk-vs-openai-sdk-comparison-guide)
- [Mastra — Official site](https://mastra.ai/)
- [Mastra — GitHub](https://github.com/mastra-ai/mastra)
- [Mastra Electron guide](https://mastra.ai/guides/getting-started/electron)
- [Mastra Licensing](https://mastra.ai/docs/community/licensing)
- [Portkey AI Gateway — GitHub](https://github.com/Portkey-AI/gateway)
- [Portkey AI docs](https://portkey.ai/docs/product/ai-gateway)
- [Portkey Vercel provider](https://ai-sdk.dev/providers/community-providers/portkey)
- [OpenRouter — TypeScript SDK docs](https://openrouter.ai/docs/sdks/typescript)
- [OpenRouter — npm](https://www.npmjs.com/package/@openrouter/sdk)
- [Google Genkit — GitHub](https://github.com/firebase/genkit)
- [Genkit Tool Calling](https://genkit.dev/docs/js/tool-calling/)
- [Bifrost — GitHub](https://github.com/maximhq/bifrost)
- [Bifrost docs](https://docs.getbifrost.ai/overview)
- [multi-llm-ts — GitHub](https://github.com/nbonamy/multi-llm-ts)
- [multi-llm-ts — npm](https://www.npmjs.com/package/multi-llm-ts)
- [Witsy (Electron app using multi-llm-ts)](https://github.com/nbonamy/witsy)
- [3 Best Open Source LiteLLM Alternatives in 2026](https://openalternative.co/alternatives/litellm)
- [Best LiteLLM Alternatives in 2026](https://www.getmaxim.ai/articles/best-litellm-alternatives-in-2026/)
- [AI Framework Comparison: Vercel AI SDK, Mastra, Langchain and Genkit](https://komelin.com/blog/ai-framework-comparison)
- [Top 5 TypeScript AI Agent Frameworks 2026](https://blog.agentailor.com/posts/top-typescript-ai-agent-frameworks-2026)
- [Sentry Electron + Vercel AI integration](https://docs.sentry.io/platforms/javascript/guides/electron/configuration/integrations/vercelai/)
- [Electron AI Chatbot](https://github.com/pashvc/electron-ai-chatbot)
