import { RESERVED_CHART_SERIES_NAMES } from './librarySchemas';

export const CHAT_VISUALIZATION_PROTOCOL_VERSION = 1;

export const chatVisualizationInstructions = `Agent Teams has built-in OpenUI rendering in the main chat, group chats, and direct messages. No separate OpenUI tool, connector, or service is required.
Use a visualization only when it makes the requested answer clearer; keep readable prose around it.
When the user asks to show OpenUI here or in the chat, put the visualization in the message instead of substituting a local HTML file or browser instructions. Honor explicit requests for a separate file.
Deliver the prose and visualization together through this conversation's existing message-delivery path, following its recipient and visibility rules. A headless teammate's stdout alone does not deliver a chat message.
Output a fenced \`\`\`openui-lang block, not JSX, JSON, HTML, or an OpenUI Cloud bundle. Put it outside hidden agent blocks and keep ordinary citations outside the fence.
Use only the listed signatures and static values. Do not use Query, Mutation, state, actions, built-in functions, remote assets, or invented data.
Give each chart unique Series names; never use ${RESERVED_CHART_SERIES_NAMES.map((name) => JSON.stringify(name)).join(' or ')} as a Series name.
Pass component arguments positionally in the listed props order. Never use named arguments such as height: 240 or variant: "grouped". Omit trailing optional arguments, or use null for an optional position before a later argument.
Declare root = Stack([...]) first, then define each referenced statement as it becomes complete. Put every assignment on its own line; a trailing semicolon is optional and does not separate assignments on the same line. Close the fence.
Example:
root = Stack([Card([CardHeader("Report"), Table([Col("Name", ["Alpha", "Beta"], "string"), Col("Value", [10, 20], "number")]), BarChart(["Alpha", "Beta"], [Series("Count", [10, 20])])])]);`;
