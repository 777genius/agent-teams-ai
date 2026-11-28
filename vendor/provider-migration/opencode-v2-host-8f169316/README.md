# Host V2 provider request admission

Immutable build from provider source `8f169316e98ba34c014caa3561a48c8215de1e42` (tree `2bcaa92534c82bd9be0369782c84f80042ac36c8`), provider PR #5. Built from the identical reviewed local source tree with Node 24.21.0 and pnpm 11.18.0. No vendored dist was edited.

Implementation archive SHA-256: `f09f5bef6736e3549bd186225a5950ccc257549fd938a48909d726298a5367ae`. Source checks: 474 tests and two packed consumers passed locally; remote gates and full native Host V2 acceptance remain pending. This archive adds bounded request admission before native credential reads and keeps V1 and the neutral Session SPI compatible.
