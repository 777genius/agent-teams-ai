const runtimeHelpers = require('./runtimeHelpers.js');

function createControllerContext(options = {}) {
  const teamName = String(options.teamName || '').trim();
  if (!teamName) {
    throw new Error('Missing teamName');
  }

  const flags = {};
  if (typeof options.claudeDir === 'string' && options.claudeDir.trim()) {
    flags['claude-dir'] = options.claudeDir.trim();
  }

  const paths = runtimeHelpers.getPaths(flags, teamName);
  return {
    teamName,
    claudeDir: paths.claudeDir,
    paths,
    allowUserMessageSender: options.allowUserMessageSender !== false,
  };
}

module.exports = {
  createControllerContext,
};
