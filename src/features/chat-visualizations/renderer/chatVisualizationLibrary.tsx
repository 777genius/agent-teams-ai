import './disableDevtools';

import { createElement } from 'react';

import { createLibrary, defineComponent } from '@openuidev/react-lang';
import { openuiLibrary } from '@openuidev/react-ui/genui-lib';
import { z } from 'zod';

import {
  cardHeaderProps,
  chartHeight,
  chartLabels,
  colProps,
  pieChartProps,
  seriesProps,
  textContentProps,
} from './librarySchemas';
import { guardChatVisualizationNode } from './programGuards';

import type { ComponentRenderProps } from '@openuidev/react-lang';
import type { ReactNode } from 'react';

// JSON-schema materialization does not enforce every Zod bound.
function renderDisplay(name: string, context: ComponentRenderProps): ReactNode {
  const checked = guardChatVisualizationNode({ typeName: name, props: context.props }, 'open');
  if (checked.status === 'rejected') throw new Error(checked.message);
  if (checked.status === 'progressive' && name !== 'Stack' && name !== 'Card') return null;
  return createElement(openuiLibrary.components[name].component, context);
}
const CardHeader = defineComponent({
  name: 'CardHeader',
  props: cardHeaderProps,
  description: 'Plain-text title and subtitle.',
  component: (context) => renderDisplay('CardHeader', context),
});
const TEXT_CLASSES = {
  small: 'text-xs',
  default: 'text-sm',
  large: 'text-base',
  'small-heavy': 'text-xs font-semibold',
  'large-heavy': 'text-base font-semibold',
};
const TextContent = defineComponent({
  name: 'TextContent',
  props: textContentProps,
  description: 'Literal plain text. Markdown, links, images, and scripts are not interpreted.',
  component: ({ props }) => {
    const checked = guardChatVisualizationNode({ typeName: 'TextContent', props }, 'open');
    if (checked.status === 'rejected') throw new Error(checked.message);
    if (checked.status === 'progressive') return null;
    return <span className={TEXT_CLASSES[props.size ?? 'default']}>{props.text}</span>;
  },
});
const Col = defineComponent({
  name: 'Col',
  props: colProps,
  description: 'Table column containing static scalar cells.',
  component: () => null,
});
const Table = defineComponent({
  name: 'Table',
  props: z.object({ columns: z.array(Col.ref).max(100) }),
  description: 'Read-only column-oriented table.',
  component: (context) => renderDisplay('Table', context),
});
const Series = defineComponent({
  name: 'Series',
  props: seriesProps,
  description: 'Named finite numeric series.',
  component: () => null,
});
const chartProps = {
  labels: chartLabels,
  series: z.array(Series.ref).max(20),
  variant: z.enum(['grouped', 'stacked']).optional(),
  xLabel: z.string().max(500).optional(),
  yLabel: z.string().max(500).optional(),
  height: chartHeight,
};
const BarChart = defineComponent({
  name: 'BarChart',
  props: z.object(chartProps),
  description: 'Categorical bar chart using static Series data.',
  component: (context) => renderDisplay('BarChart', context),
});
const LineChart = defineComponent({
  name: 'LineChart',
  props: z.object({ ...chartProps, variant: z.enum(['linear', 'natural', 'step']).optional() }),
  description: 'Categorical trend chart using static Series data.',
  component: (context) => renderDisplay('LineChart', context),
});
const PieChart = defineComponent({
  name: 'PieChart',
  props: pieChartProps,
  description: 'Part-to-whole chart using static values.',
  component: (context) => renderDisplay('PieChart', context),
});
const Card = defineComponent({
  name: 'Card',
  props: z.object({
    children: z
      .array(
        z.union([
          CardHeader.ref,
          TextContent.ref,
          Table.ref,
          BarChart.ref,
          LineChart.ref,
          PieChart.ref,
        ])
      )
      .max(24),
  }),
  description: 'Read-only summary card containing display content.',
  component: (context) => renderDisplay('Card', context),
});
const Stack = defineComponent({
  name: 'Stack',
  props: z.object({ children: z.array(Card.ref).max(500) }),
  description: 'Fixed vertical root stack containing Cards.',
  component: (context) => renderDisplay('Stack', context),
});
export const chatVisualizationLibrary = createLibrary({
  components: [
    Stack,
    Card,
    CardHeader,
    TextContent,
    Table,
    Col,
    BarChart,
    LineChart,
    PieChart,
    Series,
  ],
  root: 'Stack',
});
