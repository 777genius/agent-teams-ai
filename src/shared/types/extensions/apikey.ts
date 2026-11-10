/**
 * API Key management types — stored encrypted, transmitted masked.
 */

/** API key entry returned from backend (with masked value) */
export interface ApiKeyEntry {
  id: string;
  name: string;
  envVarName: string;
  maskedValue: string;
  scope: 'user' | 'project';
  projectPath?: string;
  createdAt: string;
}

/** Request to create or update an API key */
export interface ApiKeySaveRequest {
  id?: string;
  name: string;
  envVarName: string;
  value: string;
  scope: 'user' | 'project';
  projectPath?: string;
}

/** Decrypted key lookup result (for auto-fill) */
export interface ApiKeyLookupResult {
  envVarName: string;
  value: string;
}

/** Storage encryption status (for UI display) */
export interface ApiKeyStorageStatus {
  /** How keys are encrypted: OS keychain or local AES-256-GCM */
  encryptionMethod: 'os-keychain' | 'aes-local';
  /** Human-readable backend name: "macOS Keychain", "gnome_libsecret", etc. */
  backend: string;
  /** Whether the storage file has secure permissions (0o600) */
  fileSecure: boolean;
}
