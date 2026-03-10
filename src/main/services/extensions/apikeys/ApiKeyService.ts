/**
 * ApiKeyService — encrypted API key storage with CRUD operations.
 *
 * Encryption strategy (in priority order):
 * 1. Electron safeStorage (OS keychain: macOS Keychain / Windows DPAPI / Linux gnome-libsecret/kwallet)
 * 2. AES-256-GCM with machine-derived key (Linux fallback when no keyring is available)
 *
 * File permissions: 0o600 (owner read/write only) on Unix systems.
 * Storage file: ~/.claude/api-keys.json
 */

import { safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { createLogger } from '@shared/utils/logger';
import type {
  ApiKeyEntry,
  ApiKeyLookupResult,
  ApiKeySaveRequest,
  ApiKeyStorageStatus,
} from '@shared/types/extensions';

const logger = createLogger('Extensions:ApiKeys');
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,100}$/i;

/** How the value was encrypted on disk */
type EncryptionMethod = 'safeStorage' | 'aes-local' | 'base64';

interface StoredApiKey {
  id: string;
  name: string;
  envVarName: string;
  encryptedValue: string;
  /** @deprecated Use encryptionMethod instead. Kept for migration. */
  encrypted?: boolean;
  encryptionMethod?: EncryptionMethod;
  scope: 'user' | 'project';
  createdAt: string;
  updatedAt?: string;
}

/** AES-256-GCM constants */
const AES_IV_BYTES = 12;
const AES_TAG_BYTES = 16;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_BYTES = 32;
const PBKDF2_SALT = 'claude-apikey-storage-v1';

export class ApiKeyService {
  private readonly filePath: string;
  private cache: StoredApiKey[] | null = null;
  private aesKey: Buffer | null = null;

  constructor(claudeDir?: string) {
    const baseDir = claudeDir ?? path.join(os.homedir(), '.claude');
    this.filePath = path.join(baseDir, 'api-keys.json');
  }

  // ── Public API ──────────────────────────────────────────────────────────

  async list(): Promise<ApiKeyEntry[]> {
    const keys = await this.readStore();
    return keys.map((k) => ({
      id: k.id,
      name: k.name,
      envVarName: k.envVarName,
      maskedValue: this.mask(this.decrypt(k)),
      scope: k.scope,
      createdAt: k.createdAt,
    }));
  }

  async save(request: ApiKeySaveRequest): Promise<ApiKeyEntry> {
    if (!request.name?.trim()) throw new Error('Key name is required');
    if (!request.envVarName?.trim()) throw new Error('Environment variable name is required');
    if (!ENV_KEY_RE.test(request.envVarName)) {
      throw new Error(
        `Invalid env var name: "${request.envVarName}". Use uppercase letters, digits, underscores.`
      );
    }
    if (!request.value) throw new Error('Key value is required');

    const keys = await this.readStore();
    const now = new Date().toISOString();
    const { method, value } = this.encrypt(request.value);

    if (request.id) {
      const idx = keys.findIndex((k) => k.id === request.id);
      if (idx === -1) throw new Error(`API key not found: ${request.id}`);
      keys[idx] = {
        ...keys[idx],
        name: request.name.trim(),
        envVarName: request.envVarName.trim(),
        encryptedValue: value,
        encryptionMethod: method,
        scope: request.scope,
        updatedAt: now,
      };
      // Remove legacy field
      delete keys[idx].encrypted;
    } else {
      keys.push({
        id: crypto.randomUUID(),
        name: request.name.trim(),
        envVarName: request.envVarName.trim(),
        encryptedValue: value,
        encryptionMethod: method,
        scope: request.scope,
        createdAt: now,
      });
    }

    await this.writeStore(keys);
    const saved = keys[request.id ? keys.findIndex((k) => k.id === request.id) : keys.length - 1];
    return {
      id: saved.id,
      name: saved.name,
      envVarName: saved.envVarName,
      maskedValue: this.mask(request.value),
      scope: saved.scope,
      createdAt: saved.createdAt,
    };
  }

  async delete(id: string): Promise<void> {
    const keys = await this.readStore();
    const filtered = keys.filter((k) => k.id !== id);
    if (filtered.length === keys.length) throw new Error(`API key not found: ${id}`);
    await this.writeStore(filtered);
  }

  async lookup(envVarNames: string[]): Promise<ApiKeyLookupResult[]> {
    if (!envVarNames.length) return [];
    const keys = await this.readStore();
    const nameSet = new Set(envVarNames);
    return keys
      .filter((k) => nameSet.has(k.envVarName))
      .map((k) => ({
        envVarName: k.envVarName,
        value: this.decrypt(k),
      }));
  }

  async getStorageStatus(): Promise<ApiKeyStorageStatus> {
    const secure = this.isSecureBackend();
    const backend = this.getBackendName();
    let fileSecure = true;
    if (process.platform !== 'win32') {
      try {
        const stat = await fs.stat(this.filePath);
        fileSecure = (stat.mode & 0o077) === 0;
      } catch {
        // File doesn't exist yet — considered secure
      }
    }
    return {
      encryptionMethod: secure ? 'os-keychain' : 'aes-local',
      backend,
      fileSecure,
    };
  }

  // ── Encryption ──────────────────────────────────────────────────────────

  /**
   * Check if the OS provides a real secure backend (not basic_text).
   * On Linux, safeStorage.isEncryptionAvailable() returns true even with basic_text
   * backend (hardcoded password), so we must check the actual backend name.
   */
  private isSecureBackend(): boolean {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      if (process.platform === 'linux') {
        const backend = safeStorage.getSelectedStorageBackend();
        return backend !== 'basic_text' && backend !== 'unknown';
      }
      return true; // macOS Keychain / Windows DPAPI are always reliable
    } catch {
      return false;
    }
  }

  private getBackendName(): string {
    if (process.platform === 'darwin') return 'macOS Keychain';
    if (process.platform === 'win32') return 'Windows DPAPI';
    try {
      return safeStorage.getSelectedStorageBackend();
    } catch {
      return 'unknown';
    }
  }

  private encrypt(value: string): { method: EncryptionMethod; value: string } {
    // Try OS keychain first
    if (this.isSecureBackend()) {
      try {
        const buf = safeStorage.encryptString(value);
        return { method: 'safeStorage', value: buf.toString('base64') };
      } catch (err) {
        logger.warn('safeStorage encryption failed, falling back to AES-local:', err);
      }
    }

    // Fallback: AES-256-GCM with machine-derived key
    return { method: 'aes-local', value: this.encryptAesLocal(value) };
  }

  private decrypt(stored: StoredApiKey): string {
    try {
      const method = this.resolveMethod(stored);

      switch (method) {
        case 'safeStorage': {
          const buf = Buffer.from(stored.encryptedValue, 'base64');
          return safeStorage.decryptString(buf);
        }
        case 'aes-local':
          return this.decryptAesLocal(stored.encryptedValue);
        case 'base64':
          return Buffer.from(stored.encryptedValue, 'base64').toString('utf-8');
      }
    } catch (err) {
      logger.error(`Failed to decrypt API key "${stored.name}":`, err);
      return '';
    }
  }

  /** Resolve encryption method, handling legacy entries without encryptionMethod field */
  private resolveMethod(stored: StoredApiKey): EncryptionMethod {
    if (stored.encryptionMethod) return stored.encryptionMethod;
    // Legacy migration: encrypted boolean → method
    return stored.encrypted ? 'safeStorage' : 'base64';
  }

  // ── AES-256-GCM local encryption ───────────────────────────────────────

  /**
   * Derive an AES key from machine-specific info.
   * Not as secure as OS keychain (extractable with root), but far better than plaintext.
   * Protects against casual read by other users.
   */
  private getAesKey(): Buffer {
    if (this.aesKey) return this.aesKey;

    const material = [os.hostname(), os.userInfo().username, this.getMachineId()].join(':');

    this.aesKey = crypto.pbkdf2Sync(
      material,
      PBKDF2_SALT,
      PBKDF2_ITERATIONS,
      PBKDF2_KEY_BYTES,
      'sha512'
    );
    return this.aesKey;
  }

  private getMachineId(): string {
    if (process.platform !== 'linux') {
      return `${process.platform}-${os.arch()}-${os.cpus()[0]?.model ?? 'unknown'}`;
    }
    // Linux: try /etc/machine-id (systemd) or /var/lib/dbus/machine-id
    const candidates = ['/etc/machine-id', '/var/lib/dbus/machine-id'];
    for (const p of candidates) {
      try {
        // Synchronous read is OK — called once, result cached in aesKey
        const { readFileSync } = require('node:fs') as typeof import('node:fs');
        const id = readFileSync(p, 'utf-8').trim();
        if (id) return id;
      } catch {
        // Try next candidate
      }
    }
    return `linux-${os.arch()}-${os.cpus()[0]?.model ?? 'unknown'}`;
  }

  private encryptAesLocal(value: string): string {
    const key = this.getAesKey();
    const iv = crypto.randomBytes(AES_IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Format: iv:tag:ciphertext (all base64)
    return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
  }

  private decryptAesLocal(stored: string): string {
    const parts = stored.split(':');
    if (parts.length !== 3) throw new Error('Invalid AES-local format');
    const [ivB64, tagB64, dataB64] = parts;
    const key = this.getAesKey();
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');

    if (iv.length !== AES_IV_BYTES) throw new Error('Invalid IV length');
    if (tag.length !== AES_TAG_BYTES) throw new Error('Invalid auth tag length');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(data).toString('utf-8') + decipher.final('utf-8');
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private mask(value: string): string {
    if (value.length <= 3) return '***';
    return '*'.repeat(Math.min(value.length - 3, 20)) + value.slice(-3);
  }

  // ── Storage I/O ─────────────────────────────────────────────────────────

  private async readStore(): Promise<StoredApiKey[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const data = JSON.parse(raw);
      const keys: StoredApiKey[] = Array.isArray(data) ? data : [];

      // Fix file permissions if insecure
      await this.ensureFilePermissions();

      // Migrate legacy entries (base64 → current method)
      const migrated = this.migrateKeys(keys);
      if (migrated) {
        await this.writeStore(keys);
      }

      this.cache = keys;
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  /**
   * Migrate legacy entries: re-encrypt base64 entries with current best method.
   * Returns true if any entries were migrated.
   */
  private migrateKeys(keys: StoredApiKey[]): boolean {
    let migrated = false;
    for (let i = 0; i < keys.length; i++) {
      const method = this.resolveMethod(keys[i]);
      if (method === 'base64') {
        try {
          const plaintext = Buffer.from(keys[i].encryptedValue, 'base64').toString('utf-8');
          if (!plaintext) continue;
          const { method: newMethod, value } = this.encrypt(plaintext);
          keys[i] = {
            ...keys[i],
            encryptedValue: value,
            encryptionMethod: newMethod,
          };
          delete keys[i].encrypted;
          migrated = true;
          logger.info(`Migrated API key "${keys[i].name}" from base64 to ${newMethod}`);
        } catch (err) {
          logger.warn(`Failed to migrate API key "${keys[i].name}":`, err);
        }
      }
    }
    return migrated;
  }

  private async writeStore(keys: StoredApiKey[]): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = this.filePath + `.tmp.${crypto.randomUUID()}`;
    await fs.writeFile(tmpPath, JSON.stringify(keys, null, 2), 'utf-8');

    // Set restrictive permissions before rename (Unix only)
    if (process.platform !== 'win32') {
      try {
        await fs.chmod(tmpPath, 0o600);
      } catch {
        // Best-effort — Windows or restricted FS
      }
    }

    await fs.rename(tmpPath, this.filePath);
    this.cache = keys;
  }

  /** Ensure the storage file has owner-only permissions */
  private async ensureFilePermissions(): Promise<void> {
    if (process.platform === 'win32') return;
    try {
      const stat = await fs.stat(this.filePath);
      if ((stat.mode & 0o077) !== 0) {
        logger.warn('API keys file has insecure permissions, fixing to 0600');
        await fs.chmod(this.filePath, 0o600);
      }
    } catch {
      // File may not exist yet
    }
  }
}
