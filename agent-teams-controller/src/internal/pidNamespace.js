const fs = require('fs');

let ownPidNamespace;

// Linux PID namespace inode of this process. Hosted agents write the shared team
// tree from the host while Product runs in a container, so a recorded PID is only
// probeable from the namespace that wrote it. Other platforms keep PID-only records.
function currentPidNamespace() {
  if (ownPidNamespace === undefined) {
    ownPidNamespace = null;
    if (process.platform === 'linux') {
      try {
        const link = /^pid:\[([1-9][0-9]*)\]$/.exec(fs.readlinkSync('/proc/self/ns/pid'));
        ownPidNamespace = link ? link[1] : null;
      } catch {
        // Without procfs the records stay PID-only, exactly as before.
      }
    }
  }
  return ownPidNamespace;
}

// ESRCH or an unrelated local process says nothing about a PID recorded in another
// namespace. Records without a namespace keep the PID-only answer.
function isForeignPidNamespace(namespace) {
  return namespace !== undefined && namespace !== currentPidNamespace();
}

module.exports = { currentPidNamespace, isForeignPidNamespace };
