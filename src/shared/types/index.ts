/**
 * Shared type definitions - re-exports types from main process for use in renderer.
 *
 * This module provides a stable import path (@shared/types) for types that
 * are shared between main and renderer processes, allowing proper boundary
 * separation while maintaining type safety.
 *
 * Usage:
 *   import type { Session, Chunk, ParsedMessage } from '@shared/types';
 */

// Re-export all types from main process types
export * from '@main/types';

// Re-export notification and config types
export * from './notifications';

// Re-export visualization types (WaterfallData, WaterfallItem)
export type * from './visualization';

// Re-export API types (ElectronAPI, ConfigAPI, etc.)
export type * from './api';

// Re-export shared IPC result shape
export type * from './ipc';

// Re-export Team Management types
export type * from './team';

// Re-export Review types (Phase 1)
export type * from './review';

// Re-export CLI Installer types
export type * from './cliInstaller';

// Re-export Terminal types
export type * from './terminal';

// Re-export Editor types
export type * from './editor';
