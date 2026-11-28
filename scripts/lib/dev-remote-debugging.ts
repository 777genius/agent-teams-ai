import net from 'node:net';
import process from 'node:process';

const remoteDebuggingPortArg = '--remoteDebuggingPort';

type RemoteDebuggingPortArgument =
  | { index: number; valueIndex: number; port: number; style: 'split' }
  | { index: number; port: number; style: 'equals' };

function parseRemoteDebuggingPortArg(args: readonly string[]): RemoteDebuggingPortArgument | null {
  // Explicit run arguments override the package script's default port.
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = args[index]!;
    if (arg === remoteDebuggingPortArg) {
      const rawPort = args[index + 1];
      const port = Number.parseInt(rawPort ?? '', 10);
      return Number.isFinite(port) && port > 0
        ? { index, valueIndex: index + 1, port, style: 'split' }
        : null;
    }

    const prefix = `${remoteDebuggingPortArg}=`;
    if (arg.startsWith(prefix)) {
      const port = Number.parseInt(arg.slice(prefix.length), 10);
      return Number.isFinite(port) && port > 0 ? { index, port, style: 'equals' } : null;
    }
  }

  return null;
}

function isTcpPortAvailable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    let settled = false;

    const finish = (available: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(available);
    };

    server.unref();
    server.once('error', () => finish(false));
    server.listen({ host: '127.0.0.1', port }, () => {
      server.close(() => finish(true));
    });
  });
}

async function findAvailableTcpPort(preferredPort: number): Promise<number> {
  for (let port = preferredPort; port < preferredPort + 100; port += 1) {
    if (await isTcpPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`No available remote debugging port near ${preferredPort}`);
}

export async function resolveElectronViteArgs(args: string[]): Promise<string[]> {
  const remoteDebuggingPort = parseRemoteDebuggingPortArg(args);
  if (!remoteDebuggingPort) {
    return args;
  }

  const availablePort = await findAvailableTcpPort(remoteDebuggingPort.port);
  if (availablePort !== remoteDebuggingPort.port) {
    process.stdout.write(
      `Remote debugging port ${remoteDebuggingPort.port} is busy; using ${availablePort}.\n`
    );
  }
  // Forward exactly one value: repeated options can become an array in the Vite CLI.
  const prefix = `${remoteDebuggingPortArg}=`;
  const nextArgs = args.filter(
    (arg, index) =>
      arg !== remoteDebuggingPortArg &&
      !arg.startsWith(prefix) &&
      (index === 0 || args[index - 1] !== remoteDebuggingPortArg)
  );
  return [...nextArgs, `${remoteDebuggingPortArg}=${availablePort}`];
}
