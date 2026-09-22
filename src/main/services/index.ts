/**
 * Services barrel export - Re-exports all services for backward compatibility.
 *
 * Domain organization:
 * - analysis/: Chunk building and session analysis
 * - discovery/: Scanning and locating session data
 * - error/: Error detection and notification triggers
 * - infrastructure/: Core application infrastructure
 * - parsing/: Parsing JSONL and configuration files
 */

export * from './analysis';
export * from './discovery';
export * from './error';
export * from './extensions';
export * from './infrastructure';
export * from './parsing';
export * from './schedule';
export * from './team';
