import { describe, expect, it } from 'vitest';

import { detectClaudeStartupState } from '@features/workspace-trust/core/application';

describe('StartupDialogRules', () => {
  it('detects Claude workspace trust before a prompt-looking screen can be treated as ready', () => {
    const state = detectClaudeStartupState(`
      >
      Quick safety check: Is this a project you created or one you trust?
      Yes, I trust this folder
    `);

    expect(state).toMatchObject({
      phase: 'dialog',
      ruleId: 'claude.workspace_trust',
    });
  });

  it('detects Claude workspace trust when the TUI collapses prompt spacing', () => {
    const state = detectClaudeStartupState(`
      Accessingworkspace:
      /private/var/folders/project
      Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?
      ClaudeCode'llbeabletoread,edit,andexecutefileshere.
      ❯1.Yes,Itrustthisfolder
      2.No,exit
      Entertoconfirm·Esctocancel
    `);

    expect(state).toMatchObject({
      phase: 'dialog',
      ruleId: 'claude.workspace_trust',
    });
  });

  it('detects Claude workspace trust through conservative fuzzy wording', () => {
    const state = detectClaudeStartupState(`
      Claude Code can read, edit, and execute files here.
      Do you trust this workspace?
      1. Yes, trust this workspace
      2. No, exit
    `);

    expect(state).toMatchObject({
      phase: 'dialog',
      ruleId: 'claude.workspace_trust',
    });
  });

  it('does not classify generic trust copy as Claude trust without Claude-specific context', () => {
    expect(
      detectClaudeStartupState(`
        Do you trust this folder?
        Yes, trust this folder
      `)
    ).toEqual({ phase: 'loading' });
  });

  it('detects the Claude prompt marker only after trust/auth prompts have been ruled out', () => {
    expect(detectClaudeStartupState('Claude Code\n>')).toEqual({
      phase: 'ready',
      evidence: ['claude prompt marker'],
    });
  });

  it('detects Codex update before Codex workspace trust in the known startup chain', () => {
    const update = detectClaudeStartupState('Update available\nSkip');
    const trust = detectClaudeStartupState(
      'Do you trust the contents of this directory?\nYes, continue'
    );

    expect(update).toMatchObject({
      phase: 'dialog',
      ruleId: 'codex.update_available',
    });
    expect(trust).toMatchObject({
      phase: 'dialog',
      ruleId: 'codex.workspace_trust',
    });
  });

  it('classifies auth prompts as setup required and does not return actions', () => {
    const state = detectClaudeStartupState('Log in to Claude to continue');

    expect(state).toEqual({
      phase: 'setup_required',
      code: 'provider_auth_required',
      evidence: ['provider auth required prompt'],
    });
  });
});
