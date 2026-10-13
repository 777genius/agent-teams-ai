import { z } from 'zod';

export const RESERVED_CHART_SERIES_NAMES = ['category', '__proto__'] as const;

export const cardHeaderProps = z.object({
  title: z.string().max(500).optional(),
  subtitle: z.string().max(500).optional(),
});
export const textContentProps = z.object({
  text: z.string().max(10_000),
  size: z.enum(['small', 'default', 'large', 'small-heavy', 'large-heavy']).optional(),
});
export const colProps = z.object({
  label: z.string().max(500),
  data: z.array(z.union([z.string(), z.number().finite(), z.boolean(), z.null()])).max(500),
  type: z.enum(['string', 'number']).optional(),
});
export const seriesProps = z.object({
  category: z.string().max(500),
  values: z.array(z.number().finite()).max(500),
});
export const chartLabels = z.array(z.string()).max(500);
export const chartHeight = z.number().int().min(160).max(600).optional();
export const pieChartProps = z.object({
  labels: chartLabels,
  values: z.array(z.number().finite()).max(500),
  variant: z.enum(['pie', 'donut']).optional(),
  appearance: z.enum(['circular', 'semiCircular']).optional(),
});
