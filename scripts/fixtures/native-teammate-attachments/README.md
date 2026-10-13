# Native teammate attachment fixtures

These fixtures are consumed by `scripts/native-teammate-attachments-desktop.ts`.
The harness derives unpredictable nonce, color-order, layout, and marker values
at run time and writes the generated image, text, and PDF artifacts only below
its job-owned scratch directory. The generated PNG contains readable text and
color blocks, the PDF uses real structural newlines and an xref table, and the
filenames are random so the prompt and filenames do not reveal expected values.
The files in this directory are safe source fixtures and do not contain
credentials, provider responses, or expected model answers.

The harness is intentionally source-only. It must run from the separate hosted
E2E worktree with existing official provider auth and the edited runtime source
launcher. It reuses the existing `CdpClient`, visible composer, and
`teams.createTeam` IPC; it never changes `HOME`, `CLAUDE_CONFIG_DIR`, or the
normal Claude root on macOS.
