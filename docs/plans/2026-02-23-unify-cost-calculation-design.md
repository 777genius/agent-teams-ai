# Unify Cost Calculation — Design Document

**Date:** 2026-02-23
**Branch:** `feat/unify-cost-calculation`
**Related:** PR #60 (Session Analysis Report), PR #65 (Cost Calculation Metric), Issue #72 (Plan Usage Tracking)

## Problem

Cost calculation exists in two places with different pricing data and logic:

1. **Main process** (`src/main/utils/jsonl.ts`): Uses LiteLLM-sourced `pricing.json` (206 models, tiered 200k-token pricing). Populates `SessionMetrics.costUsd` for the chat UI.
2. **Renderer** (`src/renderer/utils/sessionAnalyzer.ts`): Uses a hardcoded 6-model pricing table with no tiered pricing. Generates per-model cost breakdown for the Session Report.

The two systems can produce different cost numbers for the same session and will drift further as models change.

## Solution

Create a single shared pricing module that both processes import.

### New Module: `src/shared/utils/pricing.ts`

**Exports:**

| Export | Description |
|--------|-------------|
| `ModelPricing` | Interface for per-model rates (input, output, cache read, cache creation, plus tiered variants) |
| `getPricing(modelName: string): ModelPricing \| null` | Model lookup: exact match, lowercase, case-insensitive scan |
| `calculateTieredCost(tokens, baseRate, tieredRate?): number` | Applies 200k-token tier threshold |
| `calculateMessageCost(model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens): number` | Computes cost for a single API call |

**Pricing data:** Static `import pricingData from '../../../resources/pricing.json'` with `resolveJsonModule: true`. Replaces `fs.readFileSync` runtime loading.

### Consumer Changes

**`src/main/utils/jsonl.ts`:**
- Remove: `ModelPricing` interface, `loadPricingData()`, `calculateTieredCost()`, `getPricing()`, `fs`/`path` imports
- Keep: `calculateMetrics()` function
- Change: inline cost loop body → call `calculateMessageCost()` from `@shared/utils/pricing`

**`src/renderer/utils/sessionAnalyzer.ts`:**
- Remove: `MODEL_PRICING` table (~40 lines), `DEFAULT_PRICING`, local `getPricing()`, local `costUsd()`
- Change: calls at lines 476 and 900 → `calculateMessageCost()` from `@shared/utils/pricing`

**Tests:**
- `test/main/utils/costCalculation.test.ts` → update to test shared module functions
- `test/renderer/utils/sessionAnalyzer.test.ts` → mock `@shared/utils/pricing` instead of local functions
- New `test/shared/utils/pricing.test.ts` for the shared module

### Pricing JSON Import Strategy

- `pricing.json` stays in `resources/` for Electron's `extraResources` packaging
- Both Vite (renderer) and electron-vite (main) resolve the JSON import at compile time
- Remove the `fs.readFileSync` dev/prod path logic from `jsonl.ts`

### Fallback Behavior

- `getPricing()` returns `null` for unknown models
- `calculateMessageCost()` returns `0` for unknown models (matches current `jsonl.ts` behavior)
- Session analyzer callers can apply a default if needed

### What Changes for Users

- Report costs become more accurate (tiered pricing, 206 models instead of 6)
- Cost numbers between chat view and Session Report now agree exactly
- Small UI change: Visible Context header adds a "parent only · view full cost" action when available

## Out of Scope

- Plan usage tracking (see Issue #72 — pending community feedback)
- New UI surfaces for cost display
- Changes to the `costFormatting.ts` shared utility
