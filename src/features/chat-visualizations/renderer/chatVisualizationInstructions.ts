import { RESERVED_CHART_SERIES_NAMES } from './librarySchemas';

export const CHAT_VISUALIZATION_PROTOCOL_VERSION = 1;

export const chatVisualizationInstructions = `Agent Teams has built-in OpenUI rendering in the main chat, group chats, and direct messages. No separate OpenUI tool, connector, or service is required.
Use a visualization only when it makes the requested answer clearer; keep readable prose around it.
When the user asks to show OpenUI here or in the chat, put the visualization in the message instead of substituting a local HTML file or browser instructions. Honor explicit requests for a separate file.
Deliver the prose and visualization together through this conversation's existing message-delivery path, following its recipient and visibility rules. A headless teammate's stdout alone does not deliver a chat message.
Output a fenced \`\`\`openui-lang block, not JSX, JSON, HTML, or an OpenUI Cloud bundle. Put it outside hidden agent blocks and keep ordinary citations outside the fence.
Keep each openui-lang block's source at or below 32,000 UTF-16 code units (JavaScript string.length), and the complete enclosing message, including prose and fences, at or below 60,000 in the same units. Longer blocks are rejected; longer messages use a raw preview instead of rendering Markdown. Reduce or summarize data as needed.
Each use of a named reference expands its data again. Keep the total expanded display small; repeated large tables, charts, or text can exceed the display budget even when the source and individual components fit their limits.
Use only the listed signatures and static values. Do not use Query, Mutation, state, actions, built-in functions, remote assets, or invented data.
Table cells must be strings, finite numbers, booleans, or null. Keep each chart at or below 500 total numeric points across all series.
Give each chart unique Series names; never use ${RESERVED_CHART_SERIES_NAMES.map((name) => JSON.stringify(name)).join(' or ')} as a Series name.
Pass component arguments positionally in the listed props order. Never use named arguments such as height: 240 or variant: "grouped". Omit trailing optional arguments, or use null for an optional position before a later argument.
Declare root = Stack([...]) first, then define each referenced statement as it becomes complete. Put every assignment on its own line; a trailing semicolon is optional and does not separate assignments on the same line. Close the fence.
Table and bar chart example:
root = Stack([Card([CardHeader("Report"), Table([Col("Name", ["Alpha", "Beta"], "string"), Col("Value", [10, 20], "number")]), BarChart(["Alpha", "Beta"], [Series("Count", [10, 20])])])]);
Separate example with a step line, explicit height after omitted axis labels, and a semicircular donut:
root = Stack([Card([CardHeader("Trend and share"), LineChart(["Mon", "Tue", "Wed"], [Series("Count", [2, 7, 3])], "step", null, null, 240), PieChart(["Rent", "Food"], [60, 40], "donut", "semiCircular")])]);`;
