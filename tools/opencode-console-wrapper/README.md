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
- inherits only the explicit stdin/stdout/stderr handle list, so unrelated
  inheritable sockets and handles cannot reach the real host;
- starts the real binary with `CREATE_NO_WINDOW`;
- propagates the real binary's exit code;
- puts the real host in a kill-on-job-close job object, so the whole process tree
  dies with the wrapper rather than outliving it.

Job creation, configuration and assignment must succeed before the suspended
child resumes. A failure exits `112` and terminates only that invocation's owned
child. The packaged Windows workflow compiles `WrapperNativeFixture.cs` and
checks a real unrelated inheritable loopback socket is excluded, stdio and exit
code survive, and terminating the fixture-owned wrapper drains its child tree.
This does not claim a fix for a socket already inherited by the wrapper itself.

It finds the real binary through the `OPENCODE_CONSOLE_WRAPPER_TARGET` env var,
then an `opencode.real.path` sidecar next to itself, then an `opencode.real.exe`
sibling — and exits `112` with a message on stderr if none of those resolve.

## Build

```bash
node scripts/stage-opencode-console-wrapper.mjs
```

It compiles with the `csc.exe` that ships with the .NET Framework
(`%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`) and writes
`resources/runtime/opencode-console/opencode.exe`, which is gitignored like the
rest of `resources/runtime`. Set `AGENT_TEAMS_CSC_PATH` to use a different
compiler, `--require` to turn a skip into a failure, `--clean` to remove the
staged build.

`pnpm dist:win`, `pnpm dist:win:x64` and `pnpm dist:win:arm64` run the staging
step with `--require`, so an explicit Windows release build fails rather than
shipping without the wrapper when no compiler is available. The generic
`pnpm dist` runs it without `--require`: on a non-Windows host or target, or
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
