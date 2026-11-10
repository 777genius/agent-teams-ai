// Node-ABI copy of better-sqlite3 for tests. The main `better-sqlite3`
// dependency is rebuilt for Electron's ABI by the postinstall hook and cannot
// be loaded by the Node.js that runs vitest, so tests use this pnpm alias
// (npm:better-sqlite3@<adjacent-version>) which keeps its Node prebuild.
declare module 'better-sqlite3-node' {
  import Database from 'better-sqlite3';
  export = Database;
}
