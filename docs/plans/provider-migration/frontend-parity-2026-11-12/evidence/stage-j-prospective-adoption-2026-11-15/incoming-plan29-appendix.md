
## Original Windows WOW64 path binding — 15 November 2026

### R1: observed fixture refusal and bounded correction

Exact diagnostic source `4dc08dea7eeed5c286cf310e09a2ba26d84a9546`
fails the original [ARM64 job132968371746](https://github.com/777genius/agent-teams-ai/actions/runs/43765103075/job/132968371746).
At `2026-11-15T21:52:59.7797577Z` the retained record is:

```json
{"nativeServiceReadinessFailure":{"rootExitCode":62,"rootCount":1,"childCount":0,"rootChildCount":0,"wow64Completed":false,"churnCompleted":false,"prerequisite":{"stage":5}}}
```

Stage5 is `Wow64Path`: `wow64Command()` returned empty before the x86
child was created. Both preceding application-breakpoint checks completed.
The original ten-second readiness error is now preserved through cleanup;
the outer controller drains with rootExitCode1 and activeProcesses0.
Source A/B is not reached. The same-source
[x64 job132968371549](https://github.com/777genius/agent-teams-ai/actions/runs/43765103075/job/132968371549)
is still queued at this review and has no qualification result.

The helper currently asks the physical `Kernel32.dll` module for
`GetSystemWow64Directory2W`. Microsoft's generated
[Windows SDK import mappings](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/libMappings.rsp)
instead map that entry to `api-ms-win-core-wow64-l1-1-1.dll`, while mapping
`IsWow64Process2` and `GetSystemWow64DirectoryW` to `KERNEL32.dll`.
Microsoft's [API-set guidance](https://learn.microsoft.com/en-us/windows/win32/apiindex/windows-apisets)
explains that the contract routes to its implementation independently of a
physical module name. A missing physical-module export is therefore the leading
source-level explanation, not a measured `GetProcAddress` error: stage5 also
groups a zero or oversized directory result. No breakpoint-policy or deadline
change is justified by this evidence.

Keep the correction in `tools/owned-process-broker/nativeFixture.cpp`:

- Define `_WIN32_WINNT 0x0A00` before `windows.h`, matching the existing broker.
- Replace the helper's module/function-pointer lookup with the declared SDK call
  `GetSystemWow64Directory2W(path,MAX_PATH,IMAGE_FILE_MACHINE_I386)`.
- Keep the existing zero/oversized-result refusal, `MAX_PATH` buffer, suffix and
  `IsWow64Process2` verification of the actual child. Preserve the closed stage5
  diagnostic, return62/63, original child actions, waits, handle closes,
  CREATE_NEW publication, application-breakpoint checks and eighty-child churn.

The [official SDK header](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/wow64apiset.h)
declares this function under `_WIN32_WINNT >= 0x0A00`; no NTDDI change is needed.
The [API reference](https://learn.microsoft.com/en-us/windows/win32/api/wow64apiset/nf-wow64apiset-getsystemwow64directory2w)
names `Kernel32.lib` and Windows10 version1511 or later. The fixture already uses
the ordinary MSVC/CMake Windows SDK libraries, including Kernel32; no additional
umbrella library, runtime module loader or fallback path is planned. The observed
ARM build selects SDK10.0.26100.0 for Windows10.0.26200 with MSVC19.51.36260.0.
This checks the declaration and intended link contract; actual resulting-source
x64/ARM64 native compilation and execution remain required.

Estimate: about10 changed TEST lines, zero product lines; complexity2/10,
reliability8/10, confidence8/10 in correcting the binding, with the original
stage5 subcause not independently measured. Root and qualification audit agree
on this narrow correction; publish this plan before source changes, then review
the exact source diff independently. Retain the prior failure evidence and await
both original resulting-source Windows gates. Superseded queued work remains
unqualified. No fallback, new process probe, ownership oracle, workflow, provider
invocation, Draft/base, main, release or activation change is included.

R2 `/root` independently read the exact ARM job log, Microsoft SDK import mapping,
SDK declaration and local CMake targets. GO for this TEST-only binding correction
after plan publication. The reviewed code must retain actual I386 verification;
the API mapping supports the correction but does not prove the unmeasured stage5
subcause or resulting native PASS. No additional product change is authorized by
this failure localization.

## Windows SDK import-library correction — 15 November 2026

Both original jobs for `332fbe3420c811c095dac4187d3f9664e8c47179`
failed before native qualification: [x64 job132973378700](https://github.com/777genius/agent-teams-ai/actions/runs/43766708055/job/132973378700)
at22:10:20Z and [ARM64 job132973379104](https://github.com/777genius/agent-teams-ai/actions/runs/43766708055/job/132973379104)
at22:12:43Z. Both report LNK2019 for
`__imp_GetSystemWow64Directory2W`, then LNK1120. This falsifies the previous
assumption that the ordinary Kernel32 import library is sufficient; neither
job reached the original runtime gate.

R1 `/root/qualification_audit` inspected Microsoft's official
[Windows SDK26100.1 x64 package](https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.cpp.x64/10.0.26100.1/microsoft.windows.sdk.cpp.x64.10.0.26100.1.nupkg)
and [ARM64 package](https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.cpp.arm64/10.0.26100.1/microsoft.windows.sdk.cpp.arm64.10.0.26100.1.nupkg).
Their Kernel32.Lib lacks this import. Both OneCore.Lib archives define the exact
import symbol and route its COFF import member to
`api-ms-win-core-wow64-l1-1-1.dll`; ZIP entries and CRCs were checked.
The inspected OneCore.Lib SHA-256 values are
`038b7c879acc32eb122597c9938af1025c8601ed1103558a52ef04c837439a44`
for x64 (2374038 bytes) and
`ede054272d34f637af76b9cb57e798afe2bbcf21a3875677fda5ae9132fbb46f`
for ARM64 (6585362 bytes). These are source-investigation artifacts, not
substitutes for the runner's selected SDK or native PASS.

A fixture-only OneCore link was reviewed as a possible repair. Before its plan
could be published, concurrent commit
[`bb48cb81493fbadb8b1e451ba5c35d7bc8488952`](https://github.com/777genius/agent-teams-ai/commit/bb48cb81493fbadb8b1e451ba5c35d7bc8488952)
instead repaired this helper through the documented API-set contract. The
compare-and-swap correctly rejected the stale plan publication. Preserve that
contributor's commit and do not add an unused import library on top of it.

Exact blob `ca0ded66441b8818bdf5726ee7d8ffa95abb8518` loads only
`api-ms-win-core-wow64-l1-1-1.dll` with
`LOAD_LIBRARY_SEARCH_SYSTEM32`, obtains the SDK-typed function pointer, makes
the same one I386 directory query and checks one FreeLibrary on every successful
load path. A missing entry still closes the module and returns the same refusal.
The decltype reference is unevaluated and introduces no static SDK import.
There is no directory fallback, new process probe, product edit or changed
action, timeout, child identity, release/cleanup check or control-channel rule.

R2 `/root/qualification_audit` independently accepted that exact preserved
source diff; `/root` inspected and imported it without overwriting concurrent
history. Microsoft's API-set guidance supports loading the named contract.
The SDK archive investigation above corroborates its contract name, but neither
review establishes the original stage5 subcause or a native PASS. Await both
original resulting-source Windows compile/runtime jobs. The earlier linker
failures and P08/P09 INCOMPLETE status remain explicit.
