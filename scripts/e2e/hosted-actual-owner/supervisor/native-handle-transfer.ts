import { nativeActivationSocketIdentity } from '../../../../src/main/composition/hosted/hostedNativeActivationSocketIdentity';
import type { ChildProcess } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { Socket } from 'node:net';
import { decodeNativeSuccessorHandle, NATIVE_SUCCESSOR_HANDLE, type NativeSuccessorHandle } from '../../../../src/main/composition/hosted/hostedNativeSuccessorHandleContract';
import { observeProductGenerationAdoption } from './product-generation-transition';

import { decodeNativeActivationHandleSelection, NATIVE_ACTIVATION_HANDLE_CONTRACT,
  type NativeActivationHandleSelection } from '../../../../src/main/composition/hosted/hostedNativeActivationHandleContract';

type TransferHistory = { generation: number; starts: Set<string>; active: boolean };
const sent = new WeakMap<ChildProcess, TransferHistory>();
function start(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const end = stat.lastIndexOf(') ');
  const fields = stat.slice(end + 2).trim().split(/\s+/u);
  if (end < 0 || Number(fields[1]) !== process.pid || fields[0] === 'Z' || fields[0] === 'X' || !/^[1-9]\d*$/u.test(fields[19] ?? '')) {
    throw new Error('native_handle_product_process_lost');
  }
  return fields[19]!;
}

/** Transfers a real Unix endpoint into the already selected, separate Node
 * producer. Node's handle transport closes the sender copy (keepOpen:false);
 * the bounded IPC ownership reply confirms receiver adoption, not activation.
 * Ownership transfers on entry, including failure. Never retry this generation. */
export async function transferNativeActivationHandle(product: ChildProcess, socket: Socket,
  input: NativeActivationHandleSelection | NativeSuccessorHandle, signal?: AbortSignal) {
  let selection: NativeActivationHandleSelection;
  let productStartTicks: string;
  let ownedHistory: TransferHistory | undefined;
  try {
    const wire = input.contract === NATIVE_SUCCESSOR_HANDLE ? decodeNativeSuccessorHandle(input) : decodeNativeActivationHandleSelection(input);
    selection = wire.contract === NATIVE_SUCCESSOR_HANDLE ? wire.selection : wire;
    if (process.platform !== 'linux' || process.versions.bun || !product.send || !product.connected ||
      !product.pid || product.pid === process.pid || socket.destroyed || !socket.readable || !socket.writable ||
      socket.remoteAddress !== undefined || socket.localAddress !== undefined) {
      throw new Error('native_handle_node_ipc_required');
    }
    if (wire.contract === NATIVE_SUCCESSOR_HANDLE) {
      const endpoint = nativeActivationSocketIdentity(socket);
      if (endpoint.device !== wire.endpointIdentity.device || endpoint.inode !== wire.endpointIdentity.inode) {
        throw new Error('native_handle_endpoint_substituted');
      }
    }
    signal?.throwIfAborted();
    const productPid = product.pid;
    productStartTicks = start(productPid);
    const namespaces = () => ({
      pid: statSync(`/proc/${productPid}/ns/pid`, { bigint: true }).ino.toString(),
      network: statSync(`/proc/${productPid}/ns/net`, { bigint: true }).ino.toString(),
    });
    const retainedNamespaces = namespaces();
    if (retainedNamespaces.pid !== statSync('/proc/self/ns/pid', { bigint: true }).ino.toString() ||
      retainedNamespaces.network !== statSync('/proc/self/ns/net', { bigint: true }).ino.toString()) {
      throw new Error('native_handle_product_namespace');
    }
    const history = sent.get(product) ?? { generation: 0, starts: new Set<string>(), active: false };
    if (history.active) throw new Error('native_handle_transfer_in_progress');
    if (history.starts.size >= 32 || history.starts.has(selection.ownerProcessStartToken) ||
      selection.ownerGeneration <= history.generation) throw new Error('native_handle_generation_reused');
    history.generation = selection.ownerGeneration; history.starts.add(selection.ownerProcessStartToken);
    history.active = true; ownedHistory = history;
    sent.set(product, history);
    socket.pause();
    const adoption = observeProductGenerationAdoption(product, selection, signal,
      wire.contract === NATIVE_SUCCESSOR_HANDLE ? wire.successorManifest : undefined);
    // Ownership and adoption are distinct observations. Keep a rejected adoption
    // handled until the selected schedule consumes it, without swallowing failure.
    void adoption.catch(() => {});
    await new Promise<void>((resolve, reject) => {
      let ownership = false; let submitted = false; let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        if (!error && (!ownership || !submitted)) return;
        settled = true; clearTimeout(timer);
        product.off('message', owned); product.off('exit', exited); product.off('disconnect', disconnected);
        signal?.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve();
      };
      const owned = (message: unknown, handle: unknown) => {
        if (!message || typeof message !== 'object' || Array.isArray(message)) return;
        const row = message as Record<string, unknown>;
        if (row.contract !== `${NATIVE_ACTIVATION_HANDLE_CONTRACT}/owned`) return;
        if (handle || Object.keys(row).sort().join(',') !==
          'bootstrapV2HeaderSha256,contract,ownerGeneration,ownerProcessStartToken' ||
          row.ownerProcessStartToken !== selection.ownerProcessStartToken ||
          row.bootstrapV2HeaderSha256 !== selection.bootstrapV2HeaderSha256 ||
          row.ownerGeneration !== selection.ownerGeneration) {
          if (handle instanceof Socket) handle.destroy();
          finish(new Error('native_handle_ownership_binding')); return;
        }
        try {
          if (ownership || start(productPid) !== productStartTicks ||
            namespaces().pid !== retainedNamespaces.pid || namespaces().network !== retainedNamespaces.network) {
            throw new Error('native_handle_ownership_reused');
          }
          ownership = true; finish();
        } catch { finish(new Error('native_handle_product_process_lost')); }
      };
      const exited = () => finish(new Error('native_handle_product_exited'));
      const disconnected = () => finish(new Error('native_handle_product_disconnected'));
      const aborted = () => finish(new Error('native_handle_transfer_cancelled'));
      const timer = setTimeout(() => finish(new Error('native_handle_transfer_deadline')), 5000);
      product.on('message', owned); product.once('exit', exited); product.once('disconnect', disconnected);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) { aborted(); return; }
      try {
        product.send!(wire, socket, { keepOpen: false }, error => {
          if (error) finish(new Error('native_handle_send_failed'));
          else { submitted = true; finish(); }
        });
      } catch { finish(new Error('native_handle_send_failed')); }
    });
    return Object.freeze({ contract: 'agent-teams.hosted-native-activation-transfer/v1' as const,
      waitForAdoption: () => adoption, selection, productPid, productStartTicks, supervisorPid: process.pid,
      pidNamespaceInode: retainedNamespaces.pid, networkNamespaceInode: retainedNamespaces.network,
      observedMonotonicNs: process.hrtime.bigint().toString(), ownership: 'receiver-confirmed' as const });
  } finally {
    // A rejected concurrent invocation owns its supplied endpoint, but must
    // not release the first invocation's reservation or reuse its generation.
    if (ownedHistory) ownedHistory.active = false;
    socket.destroy();
  }
}
