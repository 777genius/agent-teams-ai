import { describe, it, expect, vi } from 'vitest';
import {
  getPricing,
  calculateTieredCost,
  calculateMessageCost,
  getDisplayPricing,
} from '@shared/utils/pricing';

describe('Shared Pricing Module', () => {
  describe('getPricing', () => {
    it('should find pricing by exact model name', () => {
      const pricing = getPricing('claude-4-sonnet-20250514');
      expect(pricing).not.toBeNull();
      expect(pricing!.input_cost_per_token).toBeGreaterThan(0);
      expect(pricing!.output_cost_per_token).toBeGreaterThan(0);
    });

    it('should find pricing case-insensitively', () => {
      const pricing = getPricing('Claude-4-Sonnet-20250514');
      expect(pricing).not.toBeNull();
    });

    it('should find pricing for codex runtime models', () => {
      const pricing = getPricing('gpt-5.1-codex-mini');
      expect(pricing).not.toBeNull();
      expect(pricing!.input_cost_per_token).toBeGreaterThan(0);
      expect(pricing!.output_cost_per_token).toBeGreaterThan(0);
    });

    it('should alias codex spark pricing to the closest published codex tier', () => {
      const sparkPricing = getPricing('gpt-5.3-codex-spark');
      const codexPricing = getPricing('gpt-5.3-codex');
      expect(sparkPricing).not.toBeNull();
      expect(sparkPricing).toEqual(codexPricing);
    });

    it('should find pricing for gemini runtime models', () => {
      const pricing = getPricing('gemini-2.5-flash-lite');
      expect(pricing).not.toBeNull();
      expect(pricing!.input_cost_per_token).toBeGreaterThan(0);
      expect(pricing!.output_cost_per_token).toBeGreaterThan(0);
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
      const cost = calculateMessageCost('claude-4-sonnet-20250514', 1000, 500, 0, 0);
      expect(cost).toBeCloseTo(0.0105, 6);
    });

    it('should return 0 for unknown models', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const cost = calculateMessageCost('unknown-model', 1000, 500, 0, 0);
      expect(cost).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        '[pricing] No pricing data for model "unknown-model", cost will be $0'
      );
      warnSpy.mockRestore();
    });

    it('should include cache token costs', () => {
      const cost = calculateMessageCost('claude-4-sonnet-20250514', 1000, 500, 300, 200);
      expect(cost).toBeGreaterThan(0.0105);
    });
  });

  describe('getDisplayPricing', () => {
    it('should return per-million rates for a known model', () => {
      const dp = getDisplayPricing('claude-4-sonnet-20250514');
      expect(dp).not.toBeNull();
      expect(dp!.input).toBeCloseTo(3.0, 1);
      expect(dp!.output).toBeCloseTo(15.0, 1);
    });

    it('should return null for unknown models', () => {
      expect(getDisplayPricing('unknown-model')).toBeNull();
    });
  });
});
