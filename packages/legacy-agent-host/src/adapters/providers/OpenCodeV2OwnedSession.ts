import type { NativePermissionReadback } from './OpenCodeV2PermissionReadback.js';
import type { NativeInitialContextCapture, NativeInitialContextReadback } from './OpenCodeV2InitialContextReadback.js';

/**
 * A separately selected, TEST-owned native V2 engine and session. The provider
 * does not launch a shared CLI, adopt a V1 session, read user configs, or
 * manufacture a process identity. The owner must prove its actual engine
 * executable, PID/start identity, effective permissions, MCP and isolation.
 *
 * This contract is not a production owner implementation. In particular,
 * provider factory openness does not qualify Desktop's 2.1.4 distribution.
 */
export interface OpenCodeV2OwnedSession {
  readPassword(): string;
  probe(signal: AbortSignal): Promise<boolean>;
  /**
   * Fresh readback from the ACTUAL running native executable, not the npm
   * wrapper, an archive digest, or a cached profile. The owner must measure
   * the process's executable bytes and PID/start identity on every probe.
   * Missing or changed evidence makes this capture permanently unready.
   */
  readNativeCustody(signal: AbortSignal): Promise<Readonly<{
    executablePath: string;
    executableSha256: string;
    pid: number;
    startIdentity: string;
    version: string;
  }> | undefined>;
  /**
   * Read back fully assembled rules AND selected provider/model/variant from
   * THIS owned native session, not a user config fragment. Bind to real PID
   * and start identity, not just the credentials or loopback address.
   */
  readNativeEffectivePermissions(signal: AbortSignal): Promise<NativePermissionReadback | undefined>;
  /** Captured product policy; V2's permissive default is never inherited. */
  readonly requiredExternalDirectory: 'ask' | 'deny';
  /**
   * Install exact launch instructions in THIS native session and read back
   * identity-bound confirmation. Must not replay a mutation after lost ACK.
   * Without a real native implementation this contract remains HOLD.
   */
  installAndAttestInitialContext(
    capture: NativeInitialContextCapture,
    signal: AbortSignal
  ): Promise<NativeInitialContextReadback | undefined>;
  /** Read back the current native instruction entry on EVERY readiness probe.
   * Unlike the initial PUT, this MUST be read-only and must never replay an
   * uncertain instruction mutation or trust a cached installation receipt. */
  readAndAttestInitialContext(
    capture: NativeInitialContextCapture,
    signal: AbortSignal
  ): Promise<NativeInitialContextReadback | undefined>;
  /** Stop ONLY this capture's process tree, never a user/shared V1 process. */
  stopOwned(): Promise<boolean>;
  /** Confirm physical termination of the same PID/start identity. */
  confirmStopped(): Promise<boolean>;
}
