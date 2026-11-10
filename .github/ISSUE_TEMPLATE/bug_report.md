---
name: Bug report
about: Report a problem with the Agent Teams desktop app
title: "[BUG]"
labels: bug
assignees: ''

---

**Summary**
A clear description of what went wrong.

**Area**
Which part of the app is affected?
- Agent teams / teammate launch
- Team messaging / inboxes
- Tasks / kanban board
- Code review / diffs
- Built-in editor / Git
- Provider runtime (Claude, Codex, OpenCode)
- Settings / authentication
- Installer / updater
- Other:

**Steps to reproduce**
1. Go to '...'
2. Click on '...'
3. Run / create / send '...'
4. See the problem

**Frequency**
How often does this happen? [Always / Often / Sometimes / Once]

**Regression**
Did this work before? If yes, what was the last known good version or commit?

**Actual behavior**
What happened instead?

**Expected behavior**
What did you expect to happen?

**Environment**
- OS and version: [e.g. macOS 15.5, Windows 11, Ubuntu 24.04]
- App version or commit hash:
- Install type: [GitHub release / source checkout / other]
- Provider/runtime involved: [Claude / Codex / OpenCode / not sure / not relevant]
- Desktop app mode: Electron

**Logs and diagnostics**
If relevant, include redacted logs or diagnostics.
- Do not paste API keys, access tokens, private repository contents, or other secrets.
- For team launch hangs or missing teammate replies, check the newest artifact pack under `~/.claude/teams/<team>/launch-failure-artifacts/latest.json` and include the redacted `manifest.json` summary if you can.
- For UI errors, include the Electron DevTools console error if one is shown.

**Screenshots or recording**
If applicable, add screenshots or a short recording.

**Additional context**
Anything else that might help debug this.
