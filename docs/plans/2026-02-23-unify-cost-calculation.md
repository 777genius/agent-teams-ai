# Unify Cost Calculation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace dual cost calculation systems with a single shared pricing module used by both main and renderer processes.

**Architecture:** Create `src/shared/utils/pricing.ts` that statically imports `resources/pricing.json` and exports all pricing functions. Both `jsonl.ts` (main) and `sessionAnalyzer.ts` (renderer) consume this module instead of maintaining their own pricing logic.

**Tech Stack:** TypeScript, Vitest, electron-vite (resolveJsonModule)

---

### Task 1: Create the shared pricing module with tests

**Files:**
- Create: `src/shared/utils/pricing.ts`
- Test: `test/shared/utils/pricing.test.ts`

**Step 1: Write the failing tests**

Create `test/shared/utils/pricing.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  getPricing,
  calculateTieredCost,
  calculateMessageCost,
  getDisplayPricing,
} from '@shared/utils/pricing';

describe('Shared Pricing Module', () => {
  describe('getPricing', () => {
    it('should find pricing by exact model name', () => {
      // Use a model known to exist in pricing.json
      const pricing = getPricing('claude-3-5-sonnet-20241022');
      expect(pricing).not.toBeNull();
      expect(pricing!.input_cost_per_token).toBeGreaterThan(0);
      expect(pricing!.output_cost_per_token).toBeGreaterThan(0);
    });

    it('should find pricing case-insensitively', () => {
      const pricing = getPricing('Claude-3-5-Sonnet-20241022');
      expect(pricing).not.toBeNull();
    });

    it('should return null for unknown models', () => {
      const pricing = getPricing('totally-fake-model-xyz');
      expect(pricing).toBeNull();
    });
  });

  describe('calculateTieredCost', () => {
    it('should use base rate for tokens below 200k', () => {
      const cost = calculateTieredCost(100_000, 0.000003);
      expect(cost).toBeCloseTo(0.3, 6);
    });

    it('should apply tiered rate above 200k', () => {
      const cost = calculateTieredCost(250_000, 0.000003, 0.000006);
      // (200000 * 0.000003) + (50000 * 0.000006) = 0.6 + 0.3 = 0.9
      expect(cost).toBeCloseTo(0.9, 6);
    });

    it('should use base rate when no tiered rate provided', () => {
      const cost = calculateTieredCost(250_000, 0.000015);
      expect(cost).toBeCloseTo(3.75, 6);
    });

    it('should return 0 for zero or negative tokens', () => {
      expect(calculateTieredCost(0, 0.000003)).toBe(0);
      expect(calculateTieredCost(-100, 0.000003)).toBe(0);
    });
  });

  describe('calculateMessageCost', () => {
    it('should compute cost for a known model', () => {
      // claude-3-5-sonnet-20241022: input=0.000003, output=0.000015
      const cost = calculateMessageCost('claude-3-5-sonnet-20241022', 1000, 500, 0, 0);
      // (1000 * 0.000003) + (500 * 0.000015) = 0.003 + 0.0075 = 0.0105
      expect(cost).toBeCloseTo(0.0105, 6);
    });

    it('should return 0 for unknown models', () => {
      const cost = calculateMessageCost('unknown-model', 1000, 500, 0, 0);
      expect(cost).toBe(0);
    });

    it('should include cache token costs', () => {
      const cost = calculateMessageCost('claude-3-5-sonnet-20241022', 1000, 500, 300, 200);
      expect(cost).toBeGreaterThan(0.0105); // more than just input+output
    });
  });

  describe('getDisplayPricing', () => {
    it('should return per-million rates for a known model', () => {
      const dp = getDisplayPricing('claude-3-5-sonnet-20241022');
      expect(dp).not.toBeNull();
      expect(dp!.input).toBeCloseTo(3.0, 1); // $3/M input
      expect(dp!.output).toBeCloseTo(15.0, 1); // $15/M output
    });

    it('should return null for unknown models', () => {
      expect(getDisplayPricing('unknown-model')).toBeNull();
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/shared/utils/pricing.test.ts`
Expected: FAIL — module does not exist

**Step 3: Create the shared pricing module**

Create `src/shared/utils/pricing.ts`:

```typescript
import pricingData from '../../../resources/pricing.json';

export interface LiteLLMPricing {
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
  input_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
  cache_creation_input_token_cost_above_200k_tokens?: number;
  cache_read_input_token_cost_above_200k_tokens?: number;
  [key: string]: unknown;
}

export interface DisplayPricing {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

const TIER_THRESHOLD = 200_000;

const pricingMap = pricingData as Record<string, unknown>;

function tryGetPricing(key: string): LiteLLMPricing | null {
  const entry = pricingMap[key];
  if (
    entry &&
    typeof entry === 'object' &&
    'input_cost_per_token' in entry &&
    'output_cost_per_token' in entry
  ) {
    return entry as LiteLLMPricing;
  }
  return null;
}

export function getPricing(modelName: string): LiteLLMPricing | null {
  const exact = tryGetPricing(modelName);
  if (exact) return exact;

  const lowerName = modelName.toLowerCase();
  const lower = tryGetPricing(lowerName);
  if (lower) return lower;

  for (const key of Object.keys(pricingMap)) {
    if (key.toLowerCase() === lowerName) {
      const match = tryGetPricing(key);
      if (match) return match;
    }
  }

  return null;
}

export function calculateTieredCost(
  tokens: number,
  baseRate: number,
  tieredRate?: number
): number {
  if (tokens <= 0) return 0;
  if (!tieredRate || tokens <= TIER_THRESHOLD) {
    return tokens * baseRate;
  }
  const costBelow = TIER_THRESHOLD * baseRate;
  const costAbove = (tokens - TIER_THRESHOLD) * tieredRate;
  return costBelow + costAbove;
}

export function calculateMessageCost(
  modelName: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number
): number {
  const pricing = getPricing(modelName);
  if (!pricing) return 0;

  const inputCost = calculateTieredCost(
    inputTokens,
    pricing.input_cost_per_token,
    pricing.input_cost_per_token_above_200k_tokens
  );
  const outputCost = calculateTieredCost(
    outputTokens,
    pricing.output_cost_per_token,
    pricing.output_cost_per_token_above_200k_tokens
  );
  const cacheCreationCost = calculateTieredCost(
    cacheCreationTokens,
    pricing.cache_creation_input_token_cost ?? 0,
    pricing.cache_creation_input_token_cost_above_200k_tokens
  );
  const cacheReadCost = calculateTieredCost(
    cacheReadTokens,
    pricing.cache_read_input_token_cost ?? 0,
    pricing.cache_read_input_token_cost_above_200k_tokens
  );

  return inputCost + outputCost + cacheCreationCost + cacheReadCost;
}

export function getDisplayPricing(modelName: string): DisplayPricing | null {
  const pricing = getPricing(modelName);
  if (!pricing) return null;

  return {
    input: pricing.input_cost_per_token * 1_000_000,
    output: pricing.output_cost_per_token * 1_000_000,
    cache_read: (pricing.cache_read_input_token_cost ?? 0) * 1_000_000,
    cache_creation: (pricing.cache_creation_input_token_cost ?? 0) * 1_000_000,
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/shared/utils/pricing.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/shared/utils/pricing.ts test/shared/utils/pricing.test.ts
git commit -m "feat: add shared pricing module with LiteLLM data"
```

---

### Task 2: Wire jsonl.ts to use the shared pricing module

**Files:**
- Modify: `src/main/utils/jsonl.ts:219-400` (remove pricing functions, update calculateMetrics)
- Test: `test/main/utils/costCalculation.test.ts` (update to remove fs mocking)

**Step 1: Update the cost calculation test to use static imports**

The existing tests mock `fs.readFileSync` to provide pricing data. Since the shared module uses a static JSON import, the tests should instead test against real pricing data or mock the shared module.

Update `test/main/utils/costCalculation.test.ts`:
- Remove `import * as fs from 'fs'` and `vi.mock('fs')`
- Remove `mockPricingData` and the `beforeEach` that mocks `fs.readFileSync`
- Update model names in tests to match models that exist in `resources/pricing.json` (the existing `claude-3-5-sonnet-20241022` and `claude-3-opus-20240229` should already be there)
- Update expected cost values to match the actual rates from `pricing.json` (verify they match the existing mock data — they should be identical since the mock was based on real rates)
- Remove the "pricing data load failure" test (line 409-449) — there's no runtime file loading to fail anymore
- Keep all other test cases and assertions as-is

**Step 2: Run updated tests to verify they fail**

Run: `pnpm vitest run test/main/utils/costCalculation.test.ts`
Expected: FAIL — jsonl.ts still has old imports

**Step 3: Update jsonl.ts**

In `src/main/utils/jsonl.ts`:
- Remove lines 219-320: the `fs`/`path` imports, `ModelPricing` interface, `TIER_THRESHOLD`, `pricingCache`, `loadPricingData()`, `calculateTieredCost()`, `getPricing()`
- Add import at top of file: `import { calculateMessageCost } from '@shared/utils/pricing';`
- In `calculateMetrics()` (lines 354-400), replace the inline cost calculation block (lines 374-398) with:

```typescript
if (msg.model) {
  costUsd += calculateMessageCost(
    msg.model,
    msgInputTokens,
    msgOutputTokens,
    msgCacheReadTokens,
    msgCacheCreationTokens
  );
}
```

- Remove the unused `modelName` variable (line 338) and the block that sets it (lines 370-372)

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/main/utils/costCalculation.test.ts`
Expected: PASS

**Step 5: Run full test suite to check for regressions**

Run: `pnpm test`
Expected: All tests pass

**Step 6: Commit**

```bash
git add src/main/utils/jsonl.ts test/main/utils/costCalculation.test.ts
git commit -m "refactor: wire jsonl.ts to shared pricing module"
```

---

### Task 3: Wire sessionAnalyzer.ts and CostSection.tsx to use the shared pricing module

**Files:**
- Modify: `src/renderer/utils/sessionAnalyzer.ts:32,60-130` (remove local pricing)
- Modify: `src/renderer/types/sessionReport.ts:23-28` (update ModelPricing type)
- Modify: `src/renderer/components/report/sections/CostSection.tsx:3,10,39-46,204` (update imports and usage)

**Step 1: Run existing session analyzer tests as baseline**

Run: `pnpm vitest run test/renderer/utils/sessionAnalyzer.test.ts`
Expected: PASS (baseline)

**Step 2: Update sessionAnalyzer.ts**

In `src/renderer/utils/sessionAnalyzer.ts`:
- Remove the `ModelPricing` import from `@renderer/types/sessionReport` (line 32)
- Remove lines 60-130: `MODEL_PRICING` table, `DEFAULT_PRICING`, `getPricing()`, `costUsd()`
- Add import: `import { calculateMessageCost, getDisplayPricing } from '@shared/utils/pricing';`
- Export `getDisplayPricing` as `getPricing` for backward compat with CostSection: `export { getDisplayPricing as getPricing } from '@shared/utils/pricing';`
- Replace `costUsd(model, inpTok, outTok, cr, cc)` at line 476 with `calculateMessageCost(model, inpTok, outTok, cr, cc)`
- Replace `costUsd(subagentModel, ...)` at line 900 with `calculateMessageCost(subagentModel, proc.metrics.inputTokens, proc.metrics.outputTokens, proc.metrics.cacheReadTokens, proc.metrics.cacheCreationTokens)`

**Step 3: Update sessionReport.ts ModelPricing type**

In `src/renderer/types/sessionReport.ts`:
- Replace the existing `ModelPricing` interface (lines 23-28) with a re-export from the shared module:

```typescript
export type { DisplayPricing as ModelPricing } from '@shared/utils/pricing';
```

This keeps backward compatibility — `CostSection.tsx` imports `ModelPricing` from here and expects `{ input, output, cache_read, cache_creation }` which matches `DisplayPricing`.

**Step 4: Update CostSection.tsx**

In `src/renderer/components/report/sections/CostSection.tsx`:
- Line 3: Change `import { getPricing } from '@renderer/utils/sessionAnalyzer'` to `import { getPricing } from '@renderer/utils/sessionAnalyzer'` — no change needed if we re-export from sessionAnalyzer. Verify the import still resolves.
- The `ModelPricing` import from `@renderer/types/sessionReport` (line 10) continues to work via the re-export.
- The `CostBreakdownCard` (lines 34-46) uses `pricing.input`, `pricing.output`, etc. as per-million rates — this matches `DisplayPricing` from `getDisplayPricing()`.

**Step 5: Run session analyzer tests**

Run: `pnpm vitest run test/renderer/utils/sessionAnalyzer.test.ts`
Expected: PASS

**Step 6: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 7: Commit**

```bash
git add src/renderer/utils/sessionAnalyzer.ts src/renderer/types/sessionReport.ts src/renderer/components/report/sections/CostSection.tsx
git commit -m "refactor: wire session analyzer and CostSection to shared pricing"
```

---

### Task 4: Typecheck, lint, and verify the app runs

**Files:**
- No new files — verification only

**Step 1: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

**Step 2: Run linter**

Run: `pnpm lint:fix`
Expected: Clean or auto-fixed

**Step 3: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 4: Run the app and verify cost display**

Run: `pnpm dev`
- Open a session with known token usage
- Verify `TokenUsageDisplay` shows cost in the chat view
- Open the Session Report tab and verify cost-by-model breakdown renders
- Verify CostBreakdownCard expands with per-token-type rates
- Confirm chat view cost and report cost show the same total

**Step 5: Commit any fixes from verification**

If any fixes were needed, commit them:
```bash
git add -A
git commit -m "fix: address typecheck/lint issues from cost unification"
```

---

### Task 5: Clean up dead code from package.json extraResources

**Files:**
- Modify: `package.json` (optional — evaluate if `extraResources` for pricing.json is still needed)

**Step 1: Check if pricing.json is still loaded at runtime anywhere**

Search for any remaining `fs.readFileSync` or runtime references to `pricing.json`:

Run: `grep -r "pricing.json" src/`
Expected: Only the static import in `src/shared/utils/pricing.ts`

**Step 2: Evaluate extraResources**

If no runtime file loading remains, the `extraResources` entry for `pricing.json` in `package.json` is dead config. However, removing it is low-risk and low-priority — it just means the file gets copied to the app bundle uselessly. Leave it for now unless it causes issues. Document the decision.

**Step 3: Final commit**

```bash
git add docs/plans/2026-02-23-unify-cost-calculation.md
git commit -m "docs: finalize implementation plan for cost unification"
```
