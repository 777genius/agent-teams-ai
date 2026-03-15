const { createControllerContext } = require('./internal/context.js');
const tasks = require('./internal/tasks.js');
const kanban = require('./internal/kanban.js');
const review = require('./internal/review.js');
const messages = require('./internal/messages.js');
const processes = require('./internal/processes.js');
const maintenance = require('./internal/maintenance.js');
const crossTeam = require('./internal/crossTeam.js');
const runtime = require('./internal/runtime.js');

function bindModule(context, moduleApi) {
  return Object.fromEntries(
    Object.entries(moduleApi).map(([name, fn]) => [
      name,
      (...args) => fn(context, ...args),
    ])
  );
}

function createController(options) {
  const context = createControllerContext(options);

  return {
    context,
    tasks: bindModule(context, tasks),
    kanban: bindModule(context, kanban),
    review: bindModule(context, review),
    messages: bindModule(context, messages),
    processes: bindModule(context, processes),
    maintenance: bindModule(context, maintenance),
    crossTeam: bindModule(context, crossTeam),
    runtime: bindModule(context, runtime),
  };
}

module.exports = {
  createController,
  createControllerContext,
  tasks,
  kanban,
  review,
  messages,
  processes,
  maintenance,
  crossTeam,
  runtime,
};
