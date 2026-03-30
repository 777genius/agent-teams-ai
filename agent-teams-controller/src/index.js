const controller = require('./controller.js');
const mcpToolCatalog = require('./mcpToolCatalog.js');

module.exports = {
  ...controller,
  ...mcpToolCatalog,
};
