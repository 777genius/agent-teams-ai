# Typed quality validation v2

Immutable successor to typed quality validation v1.
SHA-256: `dad39edf2f02a23ae68768722b5bba2e7beddf2125ae79d0bacb4e8b303d1dce`.

Only `dist/features/provider-session-implementation/adapters/claude-sdk/capture.js`
changes from v1. Its two capture waits preserve existing settlement promises and
use a resolved promise only when the settlement is absent. The typed quality
corrections, capture-gap guards, deadlines and budgets remain in this successor.

The archive contains 209 regular files, including 206 dist files. Session SPI is
unchanged. Native/Desktop qualification is separate; previous archives and
evidence remain immutable.
