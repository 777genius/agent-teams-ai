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
const workSync = require('./internal/workSync.js');
const agentBlocks = require('./internal/agentBlocks.js');
const taskCompletionClaim = require('./internal/taskCompletionClaim.js');
const hostedBoardIdentity = require('./internal/hostedBoardIdentity.js');
const hostedBoardProjection = require('./internal/hostedBoardProjection.js');
const hostedTaskCommand = require('./internal/hostedTaskCommand.js');

function bindModule(context, moduleApi) {
  return Object.fromEntries(
    Object.entries(moduleApi).map(([name, fn]) => [name, (...args) => fn(context, ...args)])
  );
}

function createController(options) {
  const context = createControllerContext(options);

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
    workSync: bindModule(context, workSync),
  };
}

module.exports = {
  createController,
  createControllerContext,
  agentBlocks,
  hostedBoardIdentity,
  hostedBoardProjection,
  hostedTaskCommand: {
    executeHostedTaskCommand: hostedTaskCommand.executeHostedTaskCommand,
    HostedTaskCommandInputError: hostedTaskCommand.HostedTaskCommandInputError,
  },
  taskTextSignals: {
    isTaskCompletionClaimText: taskCompletionClaim.isTaskCompletionClaimText,
  },
  protocols: {
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
};
