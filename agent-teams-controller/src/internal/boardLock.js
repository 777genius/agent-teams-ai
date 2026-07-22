const path = require('path');

const { withFileLockSync } = require('./fileLock.js');

const reentrantLockStateByScope = new Map();

function getTeamBoardLockScope(paths) {
  return path.join(paths.teamDir, 'board-state');
}

function getTeamBoardLockContext(paths) {
  return reentrantLockStateByScope.get(getTeamBoardLockScope(paths))?.context;
}

function withTeamBoardLock(paths, fn) {
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

  return withFileLockSync(scope, () => {
    reentrantLockStateByScope.set(scope, {
      context: new Map(),
      depth: 1,
    });
    try {
      return fn();
    } finally {
      reentrantLockStateByScope.delete(scope);
    }
  });
}

module.exports = {
  getTeamBoardLockContext,
  getTeamBoardLockScope,
  withTeamBoardLock,
};
