import { fstatSync } from 'node:fs';
import { Socket } from 'node:net';

export interface NativeActivationSocketIdentity {
  readonly device: string;
  readonly inode: string;
}

/** Node's transferred socket must still refer to the exact kernel object signed
 * at the native handoff. Numeric descriptor equality is deliberately irrelevant. */
export function nativeActivationSocketIdentity(socket: Socket): NativeActivationSocketIdentity {
  if (!(socket instanceof Socket) || socket.destroyed || !socket.readable || !socket.writable ||
    socket.remoteAddress !== undefined || socket.localAddress !== undefined) throw new Error('native_activation_socket_invalid');
  const handle: unknown = Reflect.get(socket, '_handle');
  const fd: unknown = handle && typeof handle === 'object' ? Reflect.get(handle, 'fd') : undefined;
  if (typeof fd !== 'number' || !Number.isSafeInteger(fd) || fd < 0) throw new Error('native_activation_socket_descriptor_missing');
  const identity = fstatSync(fd, { bigint: true });
  if (!identity.isSocket()) throw new Error('native_activation_socket_descriptor_invalid');
  return Object.freeze({ device: String(identity.dev), inode: String(identity.ino) });
}
