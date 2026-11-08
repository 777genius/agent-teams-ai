# Bundled Git — third-party notices and source availability

Agent Teams desktop includes portable Git from `desktop/dugite-native`, pinned in
`managed-git.lock.json` and packaged under `resources/git`. It is a separate
command-line program, not a reimplementation of Git.

- Git 2.56.0: GPLv2. Source: https://github.com/git/git/releases/tag/v2.56.0
- Git for Windows 2.56.0.windows.4 (Windows binaries): source and license:
  https://github.com/git-for-windows/git/releases/tag/v2.56.0.windows.4
- Git LFS 3.8.1: https://github.com/git-lfs/git-lfs/releases/tag/v3.8.1
- Git Credential Manager 2.9.1: https://github.com/git-ecosystem/git-credential-manager/releases/tag/v2.9.1
- Portable binary assembly and corresponding build scripts:
  https://github.com/desktop/dugite-native/releases/tag/v2.56.0-2

Other bundled native components and their licenses are documented in the upstream
distribution/build sources. No rights to these projects are claimed by Agent Teams.

**Release requirement:** Before publishing an Agent Teams installer containing
these binaries, verify and provide each component's license texts and complete
corresponding source / compliant written-source offer, where required by its
license (including GPLv2 Section 3). Links alone are not asserted to meet every
redistribution obligation. Review every target archive and its dependencies.
The release must not be advertised as license-qualified until that is complete.
