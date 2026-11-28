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
  // Trusted composition may read app-wide defaults outside this owner's team storage.
  // It never changes the task/kanban write namespace.
  if (options.reviewFlowDefaultsDirectory !== undefined) {
    if (typeof options.reviewFlowDefaultsDirectory !== 'string' ||
        !require('path').isAbsolute(options.reviewFlowDefaultsDirectory) ||
        options.reviewFlowDefaultsDirectory.includes('\0')) {
      throw new Error('Invalid review flow defaults directory');
    }
    paths.reviewFlowDefaultsDirectory = options.reviewFlowDefaultsDirectory;
  }
  return {
    teamName,
    claudeDir: paths.claudeDir,
    paths,
    allowUserMessageSender: options.allowUserMessageSender !== false,
    boundTaskTools: options.boundTaskTools === true,
  };
}

module.exports = {
  createControllerContext,
};
