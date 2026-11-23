const { boundControllerOptions } = require('./internal/desktopControlBinding.js');
const { createControllerContext } = require('./internal/context.js');
const tasks = require('./internal/tasks.js');
const kanban = require('./internal/kanban.js');
const review = require('./internal/review.js');
const taskBoard = require('./internal/taskBoard.js');
const messages = require('./internal/messages.js');
const processes = require('./internal/processes.js');
const maintenance = require('./internal/maintenance.js');
const crossTeam = require('./internal/crossTeam.js');
const runtime = require('./internal/runtime.js');
const appRouting = require('./internal/appRouting.js');
const workSync = require('./internal/workSync.js');
const groupChats = require('./internal/groupChats.js');
const agentBlocks = require('./internal/agentBlocks.js');
const taskCompletionClaim = require('./internal/taskCompletionClaim.js');
const reviewFlow = require('./internal/reviewFlow.js');
const {
  buildChatVisualizationProtocolText,
  buildChatVisualizationRefreshInstruction,
} = require('./internal/chatVisualizationProtocol.js');

function bindModule(context, moduleApi) {
  return Object.fromEntries(
    Object.entries(moduleApi).map(([name, fn]) => [name, (...args) => fn(context, ...args)])
  );
}

function createController(options) {
  const context = createControllerContext(boundControllerOptions(options));

  // tasks/kanban/review stay exposed for low-level compatibility.
  // New task-board lifecycle writes should enter through taskBoard.
  return {
    context,
    tasks: bindModule(context, tasks),
    kanban: bindModule(context, kanban),
    review: bindModule(context, review),
    taskBoard: bindModule(context, taskBoard),
    messages: bindModule(context, messages),
    processes: bindModule(context, processes),
    maintenance: bindModule(context, maintenance),
    crossTeam: bindModule(context, crossTeam),
    runtime: bindModule(context, runtime),
    appRouting: bindModule(context, appRouting),
    workSync: bindModule(context, workSync),
    groupChats: bindModule(context, groupChats),
  };
}

module.exports = {
  createController,
  createControllerContext,
  agentBlocks,
  // Storage of the global review-flow default, used by the Electron main process. Input validation
  // there uses its own TypeScript copy of the rules; a parity test keeps both equal.
  reviewFlowDefaults: {
    read: reviewFlow.readDefaults,
    write: reviewFlow.writeDefaults,
  },
  taskTextSignals: {
    isTaskCompletionClaimText: taskCompletionClaim.isTaskCompletionClaimText,
  },
  protocols: {
    buildChatVisualizationProtocolText,
    buildChatVisualizationRefreshInstruction,
    buildActionModeProtocolText: tasks.buildActionModeProtocolText,
    MEMBER_DELEGATE_DESCRIPTION: tasks.MEMBER_DELEGATE_DESCRIPTION,
    buildProcessProtocolText: tasks.buildProcessProtocolText,
  },
  tasks,
  kanban,
  review,
  taskBoard,
  messages,
  processes,
  maintenance,
  crossTeam,
  runtime,
  workSync,
  groupChats,
};
