/** Closed handshake facts of a failed bridge operation; never message text. */
export interface OpenCodeStopHandshakeFailureFacts {
  kind: string;
  sdkCode?: string;
  nativeOperation?: string;
  nativeErrno?: number;
  lockCode?: 'ELOCKED' | 'ECOMPROMISED';
  lockCategory?: 'registry' | 'profile' | 'startup' | 'unknown';
  messageShape?: 'code' | 'lock_operation' | 'unclassified';
}
