export {};

const role = process.argv[2];
if (role !== 'owned' && role !== 'sentinel') throw new Error('Invalid process fixture role');

process.on('SIGTERM', () => {
  process.send?.({ event: 'term', role, pid: process.pid });
});

// The watchdog also retires the fixture if its parent test fails or disappears.
setTimeout(() => process.exit(71), 20_000);
setInterval(() => undefined, 1000);
process.send?.({ event: 'ready', role, pid: process.pid });
