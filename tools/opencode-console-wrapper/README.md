# OpenCode console wrapper (Windows)

`OpenCodeConsoleWrapper.cs` builds a GUI-subsystem launcher that starts the real
`opencode.exe` with `CREATE_NO_WINDOW`.

## Why

The orchestrator starts `opencode serve` hosts **detached**, i.e. without a
console. Every console-subsystem child such a host spawns (`cmd.exe` for the bash
tool, `cursor-agent.cmd` → `powershell`, …) therefore allocates a _new visible_
console window, which flashes on screen and steals focus from whatever the user
is doing. A team with a few OpenCode teammates does this continuously for as long
as it works.

## How

Running the host through this wrapper gives it a hidden console that all of its
descendants inherit, so nothing flashes. The wrapper:

- rebuilds the command line with the real binary in place of its own argv[0] and
  passes the rest through unchanged;
- inherits stdin/stdout/stderr, so the orchestrator still reads the host's output;
- starts the real binary with `CREATE_NO_WINDOW`;
- propagates the real binary's exit code;
- puts the real host in a kill-on-job-close job object, so the whole process tree
  dies with the wrapper rather than outliving it.

It finds the real binary through the `OPENCODE_CONSOLE_WRAPPER_TARGET` env var,
then an `opencode.real.path` sidecar next to itself, then an `opencode.real.exe`
sibling — and exits `112` with a message on stderr if none of those resolve.

## Build

```
node scripts/stage-opencode-console-wrapper.mjs
```

It compiles with the `csc.exe` that ships with the .NET Framework
(`%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`) and writes
`resources/runtime/opencode-console/opencode.exe`, which is gitignored like the
rest of `resources/runtime`. Set `AGENT_TEAMS_CSC_PATH` to use a different
compiler, `--require` to turn a skip into a failure, `--clean` to remove the
staged build.

`pnpm dist`, `pnpm dist:win`, `pnpm dist:win:x64` and `pnpm dist:win:arm64` run
the staging step before electron-builder; on non-Windows hosts or targets, or
without a compiler, it skips with a notice and the runtime keeps launching the
real binary directly.

The build is AnyCPU and stays AnyCPU: the wrapper is pure IL over `kernel32`
P/Invokes, so the CLR runs it on x64 and arm64 alike, and the .NET Framework
compiler cannot emit an arm64 image in the first place. An AnyCPU image carries
the legacy i386 machine stamp in its PE header, so
`scripts/electron-builder/afterPack.cjs` allows this one bundled path — and only
this one — to report `ia32` in a Windows bundle. That allowance also covers
`scripts/electron-builder/verifyBundle.cjs`, which validates the packed bundle
through the same `validateNativeBinaries`.

## Runtime wiring

`src/main/services/runtime/openCodeRuntimeBinaryEnv.ts` points the orchestrator at
the wrapper **only when the built file exists**, and publishes the real binary
through the `OPENCODE_CONSOLE_WRAPPER_TARGET` env var plus an
`opencode.real.path` sidecar next to the wrapper. `PATH` keeps pointing at the
real runtime directory so `opencode`-through-`PATH` lookups still resolve the
real binary. Without the build, the runtime keeps launching the real binary
directly.

Set `AGENT_TEAMS_OPENCODE_CONSOLE_WRAPPER=0` to bypass the wrapper at runtime.
