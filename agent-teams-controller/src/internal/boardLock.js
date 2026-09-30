const path = require('path');

const { withFileLockSync } = require('./fileLock.js');

const reentrantLockStateByScope = new Map();

function getTeamBoardLockScope(paths) {
  return path.join(paths.teamDir, 'board-state');
}

function getTeamBoardLockContext(paths) {
  return reentrantLockStateByScope.get(getTeamBoardLockScope(paths))?.context;
}

/**
 * `options.acquireTimeoutMs` bounds only the outermost acquisition; a reentrant call
 * runs under the lock its caller already holds. The default stays fileLock's.
 */
function withTeamBoardLock(paths, fn, options = {}) {
  const scope = getTeamBoardLockScope(paths);
  const currentState = reentrantLockStateByScope.get(scope);

  if (currentState) {
    currentState.depth += 1;
    try {
      return fn();
    } finally {
      currentState.depth -= 1;
    }
  }

  return withFileLockSync(
    scope,
    () => {
      reentrantLockStateByScope.set(scope, {
        context: new Map(),
        depth: 1,
      });
      try {
        return fn();
      } finally {
        reentrantLockStateByScope.delete(scope);
      }
    },
    options.acquireTimeoutMs === undefined ? {} : { acquireTimeoutMs: options.acquireTimeoutMs }
  );
}

module.exports = {
  getTeamBoardLockContext,
  getTeamBoardLockScope,
  withTeamBoardLock,
};
