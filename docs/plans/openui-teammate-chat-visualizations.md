# OpenUI visualizations in teammate chats

Status: revised implementation specification incorporating independent GPT-6.1 high review findings: plain-text TextContent, real adapter guards, stable Markdown pre identity, actual chat-search projection, and compatible source limits. Implementation starts after the reviewer verifies this revision. Base: `777genius/agent-teams-ai`, `398c34e3da6c189c96788d334d4a91787798ae76`.

## Goal and acceptance boundary

Agents can send useful charts, read-only tables, and summary cards in ordinary Markdown messages. Existing main team, group, and direct conversations display these through their existing shared renderer. Mermaid remains supported. A wide message container displays the visualization inline; a narrow message container displays a compact card with **Open visualization**, opening the existing shared Radix Dialog. Progressive OpenUI parsing works when the existing surface receives growing message text. A real sandbox agent must generate a valid final fenced visualization that the desktop app displays.

This is one bounded presentation feature plus its agent instruction contract. Do not replace chat, add a second message model, invent streaming transport, or change inbox persistence and routing.

## Verified current understanding

- Main/team, group, and direct surfaces compose `MessagesPanel -> MessagesTimelineSection -> ActivityTimeline -> ActivityItem/ReplyQuoteBlock -> MarkdownViewer`. Their filtering/routing differs; rich message rendering already converges. `MessageExpandDialog` also reuses the existing activity rendering path.
- `MarkdownViewer.tsx` recognizes `language-mermaid` in its `pre` renderer. HAST text extraction avoids depending on highlighted React children. Compact preview currently prints fenced code; this would expose OpenUI DSL.
- `ReplyQuoteBlock` uses a full MarkdownViewer for a clipped one-line original-message preview and for collapsed originals. Rendering a complete chart in that clipped area would be wasteful and misleading.
- `ActivityItem` computes text summaries using `extractMarkdownPlainTextCached`. Actual team-chat search in `src/renderer/utils/teamMessageFiltering.ts` checks sanitized message text/summary with `includes(q)` plus participant names; changing `collectTextSegments` alone does not fix that path. Invisible DSL must not match chat search or appear in summaries. Some summary paths flatten line breaks before extraction, which destroys fence structure; apply visualization summarization before that flattening.
- Canonical `leadBriefing` and `memberBriefing` live in `agent-teams-controller/src/internal/tasks.js`, not the sibling orchestrator. Shared protocol functions live in `briefingProtocols.js`, are exposed by `controller.js`, and are declared in `src/types/agent-teams-controller.d.ts`. The controller build copies its `src` tree into `dist` without bundling.
- The initial lead prompt is composed by `TeamProvisioningPromptBuilders.ts`. Native app-managed member startup has canonical, local-fallback, and compact paths in `NativeAppManagedBootstrapContextBuilder.ts`. The latter can truncate context and cannot be assumed to carry a full appended schema.
- Frozen caps at this base include MarkdownViewer 1219 lines, ActivityItem 1713, controller tasks.js 1233, and TeamProvisioningPromptBuilders 1160. Extract a narrow existing seam before adding lines; never raise the baseline.
- OpenUI source was inspected through `gh` at `544d22dd468b11fd9c27e7774e686f0c418a9df0`. Its Renderer accepts accumulated `response`, stable `library`, `isStreaming`, `onParseResult`, and `onError`; its parser caches completed statements. `lang-core` exports React-free parsers, schema/prompt generation, and ParseResult.
- Upstream TextContent internally renders Markdown through TextContentWrapper, so reusing that renderer would enable links/images despite a restricted registry. Override it with escaped plain React text. Upstream JSON-schema validation does not enforce every Zod bound or mixed composite/ref slot; schemas describe the agent contract, while actual adapter guards enforce this feature's caps/slot rules.
- MarkdownViewer creates a fresh components map, including an anonymous `pre` function, on normal renders and intentionally rebuilds search closures. A visualization below that changing component type would remount during streaming. Preserve a stable imported pre component identity rather than memoizing the whole search map.
- The existing whole-message Markdown guard switches to raw preview above 60,000 JavaScript characters. The per-fence visualization limit must be smaller and must not bypass this existing guard.
- Registry inspection on 2026-10-12 found current npm releases: `@openuidev/react-lang` 1.0.0, `@openuidev/lang-core` 1.0.0, `@openuidev/react-ui` 0.18.0, `@openuidev/react-headless` 0.18.0, and Zod 4.6.7. Published React UI peers accept React 19 and Zustand ^4.5.5. React-headless has an `ai` peer; resolve peers explicitly with pnpm and inspect the lockfile rather than introducing an application AI SDK integration.

Primary upstream references, pinned to the inspected source:

- [Library APIs and prompt options](https://github.com/thesysdev/openui/blob/544d22dd468b11fd9c27e7774e686f0c418a9df0/packages/lang-core/src/library.ts)
- [Renderer and streaming implementation](https://github.com/thesysdev/openui/blob/544d22dd468b11fd9c27e7774e686f0c418a9df0/packages/react-lang/src/Renderer.tsx)
- [Built-in component registry](https://github.com/thesysdev/openui/blob/544d22dd468b11fd9c27e7774e686f0c418a9df0/packages/react-ui/src/genui-lib/openuiLibrary.tsx)
- [Theme scoping](https://github.com/thesysdev/openui/blob/544d22dd468b11fd9c27e7774e686f0c418a9df0/packages/react-ui/src/components/ThemeProvider/README.md)

## Scope and non-goals

In scope: one display-only OpenUI catalog; fence dispatch; a common adaptive presentation shell where semantics match; localized loading/error/open labels; generated authoritative instructions for lead and members; compact previews, quotes, and visible-text search handling; incremental rendering; focused contract/interaction checks; hosted desktop visual proof and one real agent generation.

Out of scope: forms, generated buttons/actions, Query/Mutation, MCP tools supplied to OpenUI, toolProvider, state persistence, OpenUI Cloud scripts/protocol bundles, remote image loading, arbitrary HTML/JS execution, new backend/IPC/preload APIs, generic artifact infrastructure, Markdown editor redesign, a second chat application, Mermaid engine/theme redesign, and unrelated provisioning/runtime refactors. Existing external Markdown links/citations keep their current behavior; generated visualizations have no new link/action capability.

## Architecture decision

Use `src/features/chat-visualizations/` as a thin feature. It owns renderer integration and pure fence/projection semantics only. Add `renderer/index.ts` and a browser-safe `contracts/index.ts` only for public shared constants/types consumed outside the feature. Do not create empty core/application, main, or preload layers. Keep small pure fence recognition/summary helpers in contracts or a shared pure helper if the existing shared search utility would otherwise violate dependency rules. A helper's layer name must describe its real ownership, not manufacture domain abstractions.

External production callers import the feature's public entrypoints. Vendor React packages are imported only by the renderer adapter. The controller and Electron main consume generated JSON/text through the existing controller protocol surface, so they never import React UI or create a feature transport.

Options considered:

1. **Recommended: reuse a small built-in registry subset, narrow unsafe schemas, and generate the agent protocol from that exact display library.** Confidence 9/10, reliability 9/10, complexity 4/10. Approximately 500-800 handwritten production LOC, including integration/extraction work. Registry and prompt stay coupled by an executable contract check.
2. Handwrite all chart/table/card React components and pure schemas. Confidence 8/10, reliability 8/10, complexity 6/10. Approximately 850-1300 production LOC. More styling and schema code than this scope warrants.
3. Embed OpenUI chat/headless UI as a separate application. Confidence 5/10, reliability 5/10, complexity 8/10. Approximately 1200-2000 production LOC. Adds redundant message/interaction ownership and does not match the requested existing-chat integration.

## Public presentation contracts

Use these small contracts, adjusted only to fit real local types:

```ts
type VisualizationKind = 'openui' | 'mermaid';
type FenceState = 'open' | 'closed';
type VisualizationBlockProps = {
  kind: VisualizationKind;
  source: string;
  fenceState: FenceState;
};
```

The Markdown `pre` dispatch helper receives the original Markdown source, HAST node/children, compact mode, and the existing normal-code-copy setting. It identifies supported languages and delegates. It contains no OpenUI schemas, parser state, Dialog logic, resize logic, store subscription, or vendor imports.

Canonical fence language is `openui-lang`, matching upstream prompt generation. Accept `openui` as a compatibility alias. Keep `mermaid` unchanged. Other code languages retain their present formatting/copy behavior.

Parallel lane contract: each full visualization shell exposes `data-chat-visualization-kind="openui|mermaid"` and `data-chat-visualization-presentation="inline|card"`. The Dialog has accessible title `Visualization` (or `Diagram`), the narrow Button is `Open visualization`, and local status text is `Visualization incomplete`, `Visualization unavailable`, or `Visualization exceeds display limits` as appropriate. Use the existing localization public API with English team-namespace strings/fallback; lane A owns only that minimal English addition, not a translation rollout. These attributes describe real UI state; no test-only state API is added. Lane B dispatches the agreed props and lane D tests these contracts through the normal DOM.

## Implementation steps and difficult details

### 1. Resolve the vendor contract before connecting chat

Perform this small vertical check on the hosted integration checkout after the plan review, before parallel lanes depend on it:

- Install/pin the verified OpenUI packages and Zod with pnpm. Recheck current published versions at execution time; do not silently substitute a major/new API. Inspect actual package exports/peer resolutions and record the versions used.
- Import only the public `@openuidev/react-ui/genui-lib` registry and `@openuidev/react-lang` APIs. Do not deep-import vendor source files.
- Build the library at module scope; stable identity preserves upstream incremental-parser caches. Validate one Card, one Table, and one BarChart render under React 19 and the actual application theme/CSS.
- Prove protocol generation can run in Node using the project's TypeScript runner without needing DOM or CSS loaders. If loading registry renderers in Node requires a browser, generate in the existing Vite/Vitest environment and keep the generated output/verification deterministic; do not expose a production generation endpoint.
- Capture any package install scripts/telemetry defaults and disable vendor devtools/observability where supported for this adapter. There is no new remote service or telemetry dependency in the user workflow.

### 2. Define the exact display-only library

Initial catalog: `Stack`, `Card`, `CardHeader`, `TextContent`, `Table`, `Col`, `BarChart`, `LineChart`, `PieChart`, `Series`. This is sufficient for structured card summaries, metrics represented by large TextContent, column-oriented tables, categorical bar charts, trend charts, and pie/donut breakdowns. Do not expand to forms/images/carousels/tabs merely because upstream ships them.

Use `openuiLibrary.components[name]` for existing safe renderer implementations, with the explicit TextContent override below. Use `defineComponent` to narrow the few schemas that leak broad capabilities. Do not assume JSON-schema generation or upstream materialization enforces all Zod constraints:

- Choose a fixed nonrecursive layout: root Stack children are Card; Card children may be CardHeader, TextContent, Table, BarChart, LineChart, or PieChart. No Stack-inside-Card, nested Card, or recursive layouts. Exclude forms, actions, generated Modal, Markdown/HTML/image components. Card's upstream union and Stack's `z.any()` cannot simply be copied unchanged. At the corresponding renderer adapter, check actual materialized child `typeName` against this slot list before rendering; a schema union alone is insufficient. Partial unresolved null children are allowed while the fence is open.
- Preserve CardHeader/TextContent positional prop order. Replace TextContent's implementation with React text children and the known small/default/large/small-heavy/large-heavy presentation classes. Strings containing Markdown image/link/script syntax render literally as text; do not call MarkdownViewer, TextContentWrapper, dangerouslySetInnerHTML, or an image/link renderer. Its feature description/prompt must say plain text.
- Table takes `columns: Col[]`. Its adapter checks actual Col element nodes and their props: string label, data array containing only strings/finite numbers/booleans/null, optional `type: 'string'|'number'`. Reject object/action/component cells before invoking the vendor Table renderer. Empty and unequal-length columns show empty cells rather than throwing.
- Series remains category + finite numeric values. Bar/Line adapters require string labels and actual Series element nodes with string category and finite numeric value arrays; no alternate 2D/query-results format. Closed chart series must align with label count. Pie takes string labels + aligned finite numeric values. Limit rows/points to 500 and optional chart height to 160-600 px with actual per-adapter checks before vendor rendering, not just Zod max/min. Check source length before mounting/parsing: **32,000 JavaScript characters per fence**. The existing >60,000-character whole-message raw-preview behavior remains authoritative; do not raise or bypass it. Reject excessive input with a local error and never silently truncate plotted data.
- Do not independently handwrite a second catalog for agents. `library.toSpec()`, `toJSONSchema()`, and `library.prompt({inlineMode: true, toolCalls: false, bindings: false, builtinFunctions: false, tools: []})` define the protocol. Supply feature-specific display-only rules/examples; do not reuse upstream groups/examples that advertise omitted forms or tool workflows.
- `builtinFunctions: false` affects the prompt, not the evaluator. Before mounting Renderer, use the official lang-core parser against this library's JSON schema and a small guard over its ParseResult: reject rootExpression, nonempty queryStatements/mutationStatements/stateDeclarations, and a root marked hasDynamicProps (which upstream computes from nested AST values). These prevent built-in/dynamic expressions from entering the runtime. Verify a real built-in-expression fixture is rejected before Renderer, not merely omitted from the prompt. Do not implement a lexer, expression parser, AST interpreter, or general validator. Renderer accepts only response text, so it will internally parse again; this bounded vendor preflight is deliberate and must keep stable parser/library identity across chunks rather than adding another DSL implementation.
- Do not pass toolProvider, onAction, initialState, onStateUpdate, or registered functions/actions to Renderer. Do not support Cloud-framed responses/scripts; reject their framing markers in fence input. Per-adapter guards allow only the known display props/children and static data. Verify unsupported Query/Mutation/Action attempts produce a local error with zero tool/network/action calls. Missing props in a genuinely partial node stay pending; closed malformed data produces a clear error. Small static-program and adapter guards are the enforcement boundary; the protocol remains the single schema authority.

### 3. Generate and distribute ONE agent protocol

The feature's display library is the source of truth. A short TypeScript generator writes a deterministic generated JSON payload under `agent-teams-controller/src/internal/generated/chatVisualizationProtocol.json`, containing protocol version, `toSpec()` output and the exact compact instructions. toSpec already carries signatures/schema knowledge; do not add a second toJSONSchema copy to this artifact. The existing controller copy build includes this artifact; no runtime file lookup outside its package is allowed. Mark it generated; callers never maintain it manually. A check mode compares the produced artifact to the checked-in file and fails on drift. No timestamps/random library ids enter the payload.

Expose `buildChatVisualizationProtocolText()` from the existing controller `protocols` surface and its `.d.ts`. Its input is context-free; lead and member must consume identical text. Instructions explain:

- Prefer a visualization when it makes the requested answer clearer; do not replace all prose with UI.
- Output ordinary readable prose plus fenced `openui-lang`, not JSX/JSON/HTML and not an OpenUI Cloud bundle. Put the visualization outside hidden agent blocks. Keep ordinary citations outside the fence.
- Use exactly the available signatures; static values only. No Query/Mutation/state/actions/remote assets. Do not invent data.
- Declare `root = Stack([...])` first and use subsequent referenced statements so completed children can appear while later children stream. Use semicolon/newline-delimited real DSL; define every reference by completion and close the fence.
- Include one small independently validated card/table/chart example rather than a large UI catalog demo.

Connect it to canonical memberBriefing, leadBriefing, the initial lead instruction builder, and local/compact native member startup paths. Do not inject it into each user message or duplicate it into every sendMessage instruction. Canonical reconnect briefing can repeat a durable protocol once; tests must detect accidental duplication within a single briefing.

Native startup budgets are a real constraint: **first measure** the compact generated protocol against the smallest existing context budget. If it fits, reserve it as an atomic block before variable task/context material; no alternate fallback path is needed. Never cut it midway with boundText. Only if the measured full block cannot fit, keep a short instruction requiring a canonical briefing refresh before generating a visualization; fetch it during actual work, without breaking the private bootstrap silence/readiness rules. If needed, this fallback must be exercised and does not claim the compact bootstrap received a full schema. Do not increase aggregate bootstrap budgets blindly.

The frozen controller tasks.js and lead prompt builder must not grow. Extract only the necessary existing briefing composition or short protocol-list seam; avoid relocating task operations. Put the reusable new text builder in a small module. Keep JS edits in existing CommonJS modules, but write new operator generators/harnesses in TypeScript.

### 4. Extract the Markdown pre seam and connect one dispatcher

Move the current pre renderer's ordinary-code copying/compact behavior into a small adjacent helper/component, keeping the existing output and CopyButton contract. Assign one imported, module-stable `MarkdownPre` component as `components.pre` in every Markdown components map. Supply original Markdown/copy/compact settings through a narrow React context around ReactMarkdown rather than creating a new pre closure. Keep search highlight closures fresh as the existing code requires. This pays for the new dispatch without growing a frozen file and preserves the visualization subtree during text growth.

- Identify the original code language from HAST className; extract DSL from HAST text, not highlighted React children.
- Use the original Markdown and node position offsets to determine fence closure. A closing fence must use the opener's delimiter character and at least its length; support backticks, tildes, CRLF, indentation accepted by Markdown, and fences inside list/blockquote contexts. Do not guess closure by `source.endsWith('```')`. If HAST positions lose the opener context, use a small remark code-node annotation instead of reimplementing Markdown parsing.
- Dispatch OpenUI through the feature renderer entrypoint; keep Mermaid's sanitized SVG adapter intact and delegate its presentation shell through composition. Unsupported language remains ordinary code.
- There are no new visualization branches in MessagesPanel, group-chat adapters, direct-chat hooks, or transport/store selectors. If a surface bypasses MarkdownViewer, add a single use of the common dispatcher at that existing renderer boundary, not a duplicate OpenUI renderer.
- Do not key pre/VisualizationBlock/Renderer/Dialog by source text or recreate their component type during updates. With the same message and fence position, appending content must preserve the first rendered child DOM node, open Dialog state, and focus. A genuinely different message/fence may reset its own state normally.

### 5. Adaptive presentation and progressive states

The feature shell observes its own available message-body width with ResizeObserver. Use 640 px as the initial inline threshold, measured on the actual block/container after layout, not window width or named chat mode. At unknown/zero width, start with the compact card to avoid an incorrectly large first paint. ResizeObserver cleanup is mandatory; narrow -> wide -> narrow must work while sidebar/panel layouts resize.

- Width >= 640 px: inline visualization, `min-width: 0`, `max-width: 100%`, local overflow for a wide table; do not widen the conversation or force horizontal page scrolling.
- Width < 640 px: a descriptive compact card, local status, and shared Button **Open visualization**. It opens shared Dialog/DialogContent/DialogTitle/Description, bounded by viewport with its own scroll. Keyboard activation, Escape, focus trap, focus return, and click propagation inside ActivityItem are verified.
- A user may expand a wide visualization too if a small shared expand control is helpful; this is optional only if it adds no extra state branch. The narrow card action is mandatory.
- Keep one mounted active OpenUI Renderer per displayed block where practicable. In narrow mode render content only when Dialog opens; do not invisibly mount all charts behind cards. Opening/closing may reset display-only table pagination; that is acceptable and no persistence is added.
- Use the actual app light/dark theme. Load the vendor component stylesheet once through renderer composition. ThemeProvider targets a dedicated visualization selector/class, including Dialog content, rather than applying defaults globally to body. Verify tables, chart axes, and cards are legible in both modes and do not alter unrelated Markdown styles.
- Preserve independent state for multiple fences and message items. Do not key Renderer by the growing source string; reset error state on a changed response and recover in-place from an invalid prefix to a valid later program. Cancel/ignore stale async Mermaid results using its existing cancellation behavior.

State policy:

| Input/state | Observable result |
| --- | --- |
| Empty/open fence or root not yet available | Stable card/status `Visualization incomplete`; no raw DSL and no permanent animated spinner for an old incomplete message |
| Open fence with completed referenced children | Render available children progressively, show an unobtrusive incomplete indicator, preserve useful partial content |
| Closed valid fence | Show final content and remove incomplete status |
| Open fence with temporary syntax/schema errors | Keep useful partial content when upstream can render it; do not flash a final red error on every chunk |
| Closed malformed/unknown/disallowed program | Clear localized visualization error; adjacent prose still renders. Optional copy-source action remains explicit, never a default source dump |
| Closed program with some renderable content and errors | Show useful content plus an explicit warning; do not silently declare it valid |
| Per-fence source/point/row limit exceeded, within the existing whole-message limit | Local limit error; no partial silently truncated chart |
| Whole message exceeds 60,000 characters | Existing bounded raw-preview fallback remains; no expensive rich rendering |
| Response changes after error | Retry parsing the new response, clear stale error when resolved |
| Dialog open during text growth | Update the same content; no focus theft or modal recreation |

Fence closure is enough to support incremental Markdown input without a new transport flag. An unclosed historical message is honestly labeled incomplete. If an existing caller already owns a reliable active-stream flag, it may inform the status, but it is not a prerequisite or excuse to add a second streaming service.

Mermaid shares only width measurement/card/Dialog presentation where equivalent. Its parse/render/sanitize/error fallback behavior remains its own responsibility. No generated SVG is trusted without the current DOMPurify sanitization.

### 6. Previews, quotes, and search

Implement one pure fence-summary rule: supported OpenUI fences become `Visualization`, Mermaid becomes `Diagram`, and ordinary prose remains. Apply it before compact/cross-team preview flattening. Do not remove arbitrary other code blocks or inline text that happens to contain `openui`.

- CompactMarkdownPreview's pre dispatch returns a short label for rich fences and never mounts Renderer/Dialog/ResizeObserver.
- Wide one-line quote originals use compact preview, not full MarkdownViewer. Collapsed compact originals use the same rich-fence summary; expanded originals may use full visualization rendering. Reply bodies keep the normal full renderer.
- Plain-text summaries derived from fenced content must see the same summary semantics. Make only the needed targeted edits/extraction in frozen ActivityItem.
- Apply the same fence omission/summary projection at the **actual** `filterTeamMessages` text/summary search boundary before `includes(q)`, retaining participant `from`/`to` matching. Preserve ordinary code, adjacent prose, and existing sanitization. A focused `test/renderer/utils/teamMessageFiltering.test.ts` regression must exclude a message for a query occurring only in rich-fence DSL and include it for adjacent prose/participant queries. Do not redesign global/session search. Where the existing visible-text collector is used for these messages' summaries/highlight counts, skip the same rich-fence DSL so it does not report invisible highlighted matches; this is a targeted consistency edit, not a new search index. Generated chart labels are not added to chat search in this slice.
- Full-message copy keeps the original Markdown, preserving export/replay. Preview sanitization changes no stored content or structured task references. Citations, mentions, task links, and hidden agent-block stripping around the fence keep their existing behavior.

## Minimum tests and evidence

Tests must fail for a plausible observed user regression, not inspect source strings or mirror production expectations.

1. **Library/protocol contract:** parse independent literal examples with the real pinned parser/library; assert exact card title, table cells, bar-series labels/values, and no errors at completion. Fail if generated protocol/spec drifts from the actual display library or unsupported components/tool/state constructs are advertised/accepted. Include escaped TextContent image/link/script syntax with no img/a/script nodes or requests; a built-in expression rejected before Renderer; and real adapter rejection of 501 points, height above 600, and wrong slot/object data that upstream schema materialization alone accepts. Verify controller source and built `dist` can produce the protocol without React/DOM/runtime lookups.
2. **Renderer integration:** extend MarkdownViewer coverage for multiple mixed prose/OpenUI/Mermaid fences, aliases, malformed closed input, and unclosed prefixes. Assert the expected visible content/error and that adjacent task/citation links survive. No duplicate wrapper-only unit suite.
3. **Progressive contract:** update the same real MarkdownViewer through root-only, first child complete, second child partial, and final closed chunks. Assert first child becomes visible before final completion, final chart/table appears, incomplete status clears, and no raw DSL or error flashing. Assert the first child's DOM identity survives update. Open a narrow visualization Dialog, append text, and prove the Dialog remains open with focus retained. Exercise this while the Markdown search components map refreshes as well. Include correction/replacement after an invalid prefix. Run this with real OpenUI packages, not a mocked Renderer. Verify both the 32,000-character per-fence error and the untouched 60,000-character whole-message raw fallback.
4. **Compact behavior/search:** cover one rich-fence-only quote/summary and mixed prose; prove no `root =`, component calls, or hidden instructions appear and ordinary text still does. The actual filterTeamMessages regression proves invisible DSL cannot match while adjacent prose and participant names still can; retain ordinary-code search behavior.
5. **Briefing integration:** focused controller tests verify identical single protocol in lead/member canonical briefings. Initial lead and native compact/fallback tests verify the atomic full contract or explicit refresh fallback without changing bootstrap silence/readiness behavior.
6. **Hosted desktop E2E/visual evidence:** TypeScript harness under `scripts/e2e`, added to desktop E2E tsconfig, with actual Electron renderer via `pnpm dev:mcp` CDP 9222. Reuse existing Cdp/evaluation and fixture/bootstrap helpers rather than a new automation stack. Stage only a new `.test-only` sandbox project/team/message history. Exercise main team, one group, and one DM; verify wide inline, narrow card/Dialog, keyboard/focus, resizing a narrow message on a wide window, multiple blocks, light/dark, errors, quote preview, and incremental fixture message updates. Capture screenshots plus structured assertions, console errors, source SHA, dependency versions, and fixture ids. Fixtures can prove incremental presentation; they do not prove a runtime emits token deltas.
7. **One real agent generation:** run a sandbox team/member through the current source orchestrator launcher on the hosted machine. Locate and verify that host's `cli-source` rather than assume the macOS path exists. Deliver a bounded request to compare three synthetic values and send a final card/table/bar chart in the prescribed fence. Record actual briefing/protocol version, tool-delivered inbox message id/text, parse result, and screenshot of the final app display. Prefer a supported hosted runtime lane with current auth; do not read/copy credentials. A generated artifact sent to an app-visible mailbox/group is required, not just an agent console response. If the runtime exposes only completed inbox writes, report that limit and prove final delivery plus independent incremental UI input; do not claim live token streaming or invent it. A runtime failure must be diagnosed via the existing artifact pack/runbook before changing lifecycle code.

The harness owns its scratch directories, Xvfb display, app process, ports, sandbox team, and launched teammates. Use the verified scratch filesystem under `/srv/workers`; capture host machine-id/resources/mount evidence. Reserve CDP 9222 for this isolated run; other parallel harnesses use separately configured ports only when the existing launcher supports them. Never kill shared OpenCode hosts, unrelated tmux panes, or user teams. Cleanup only the run's owned processes/team and preserve evidence.

## Verification commands

Execute on Hetzner. The current installed CodingV1 route supports admitted shell operations; the older blanket read/edit-only assumption is stale. Workers may run focused admitted checks where the actual job contract permits them. The orchestrator still owns authoritative integrated-SHA checks, desktop E2E, real agent proof, and retained logs. A worker patch alone is not validation evidence. Capture exit status with pipefail and keep full logs as artifacts while showing only the tail.

```sh
pnpm lint:fast:files -- <changed TS/TSX production and harness files>
pnpm exec vitest run <focused visualization/MarkdownViewer/search tests>
pnpm --filter agent-teams-controller test -- <focused briefing tests>
pnpm --filter agent-teams-controller build
pnpm typecheck
pnpm guard:source-file-size
pnpm guard:team-provisioning-architecture
pnpm lint
pnpm build
pnpm exec tsx scripts/<protocol-generator>.ts --check
pnpm dev:mcp
pnpm exec tsx scripts/e2e/chat-visualizations-desktop.ts <exact-source-sha>
```

Replace placeholders with actual owned files before dispatch. Do not run lint:fix, a second global tsc7, browser mode, Computer Use, or a native folder picker. Full lint is appropriate because this slice touches an architecture boundary; full build catches package/CSS/runtime packaging issues the focused tests cannot.

## Parallel hosted worker ownership and ordering

All implementation workers use `mimo-v2.6-pro` with supported thinking, isolated workspaces from the reviewed plan/base, disjoint writes, full Q/task rules, and patch/evidence output. They are not alone and must not revert others. No worker starts before independent plan review/correction. Run a minimal hosted vendor contract check first; freeze the resulting catalog/public contracts so lanes do not invent competing APIs.

| Lane | Exclusive ownership | Dependency/handoff |
| --- | --- | --- |
| A: feature renderer | `src/features/chat-visualizations/renderer/**`, feature README and entrypoints, minimal English team localization strings, focused real-vendor renderer tests | Publishes library factory/module, VisualizationBlock API and agreed DOM attributes/labels, CSS/theme/width policy; no package/lock/controller edits |
| B: Markdown composition | MarkdownViewer pre seam, adjacent helper, Mermaid presentation delegation, ReplyQuoteBlock, shared fence summary/search, necessary ActivityItem extraction, their focused tests | Uses frozen feature public API; no OpenUI schemas/vendor imports |
| C: agent protocol | TypeScript protocol generator, generated controller artifact, briefing protocol module/controller exports/types, canonical and startup briefing integration/tests | Generates from A's actual library after integration; before that implements reader/wiring against agreed artifact shape, never a handwritten competing schema |
| D: verification harness | `scripts/e2e/chat-visualizations-desktop.ts`, owned fixture helpers, desktop E2E tsconfig inclusion | Implements observable assertions against agreed selectors/labels; orchestrator executes it after lanes integrate |
| Orchestrator | package.json/pnpm-lock, initial hosted contract experiment, integration commits, generator execution, all shell checks/live proof, review/delivery | Resolves bounded overlap mechanically; owns exact-head evidence and runtime cleanup |

A and C have an explicit generation dependency rather than writing the same library. B and D can proceed against the agreed stable props/selectors after the vendor checkpoint. Keep selector hooks minimal and meaningful to the production UI; do not add app runtime state hooks solely for tests.

## Estimates, risks, and rollback

Revised estimate: **500-800 handwritten production LOC**, **220-400 focused test LOC**, **250-450 TypeScript harness LOC**, plus approximately **40-100 documentation/generator wiring LOC**. Generated protocol/schema, dependency lockfile, and moved existing pre/briefing code are reported separately. Expected total handwritten additions roughly **1010-1750 LOC**, one coherent feature PR within the owner's review budget. The earlier 350-650 estimate omitted the now-required progressive contract, real generation proof, compact-native briefing case, and frozen-file extractions. Do not add components/abstractions merely to consume this range.

Material implementation risks: actual materialized child/Series shapes and vendor positional signatures; peer dependency/CSS/theming imports; atomic protocol fitting native startup budgets; real sandbox provider availability; and existing message-update granularity. Resolve each through the earliest focused contract/proof above. None justifies a full AST validator, new transport, generic artifact platform, or a lifecycle rewrite.

Rollback is a normal revert of this coherent slice: remove OpenUI dispatch and protocol injection together while retaining original stored Markdown. Unsupported OpenUI fences then fall back to ordinary code; Mermaid behavior remains. No data migration, persistent kill switch, or new preference is needed.

Acceptance requires: all existing team/group/direct surfaces show both visualization families without duplicated rendering; measured-container responsive behavior and accessible Dialog; final real agent-generated OpenUI display; independently demonstrated progressive rendering; no raw DSL in compact summaries/quotes and no invisible-source search hits; one authoritative complete schema/protocol or an explicit compact-bootstrap refresh fallback; no new actions/network execution/storage; frozen-size/architecture/type/lint/build gates pass; and evidence bound to the final integrated SHA. Independent code review follows implementation; passing plan review does not replace it.
