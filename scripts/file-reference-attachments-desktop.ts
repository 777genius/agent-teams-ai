#!/usr/bin/env -S pnpm exec tsx
/** Coordinator-only real Codex native TXT/JSON plus arbitrary binary tool-read scenario. */
process.argv.push('--file-references');
if (!process.argv.includes('--provider')) process.argv.push('--provider', 'codex');
await import('./native-teammate-attachments-desktop.ts');
export {};
