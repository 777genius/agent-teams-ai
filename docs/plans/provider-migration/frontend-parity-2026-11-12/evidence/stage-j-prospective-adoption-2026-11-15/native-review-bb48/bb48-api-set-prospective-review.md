# Prospective native adoption review — exact bb48 API-set helper

**Independent source R2: APPROVE the exact helper for a separately published, bounded adoption R1. This is not a compiler or native PASS.** The reviewed source is `tools/owned-process-broker/nativeFixture.cpp` from commit `bb48cb81493fbadb8b1e451ba5c35d7bc8488952`, retained unchanged by docs-only head `462845722260dfd91111c37cb66fc54a01a3ecb7`. No tracked source, CMake, workflow, test, ref or CI action was performed for this review. The isolated I composition remains on its already selected 4dc fixture until root explicitly adopts the later history.

## Exact source and chronology

| State | Fixture blob | Bytes / lines | SHA-256 |
|---|---|---:|---|
| Isolated I / source 4dc | `579a7aadf70a284cb44f7ec3690dab32c4d76e92` | 17,237 / 322 | `5891d489d3587218900ae8864c64c29c4fbc594022b95132c0292074e3ce865c` |
| Direct SDK source 332, unchanged by docs-only 6e90 | `43603d29138a5c43547f46099c5dad39d3d75815` | 17,041 / 318 | `4ed2586ee2129d7a7ed471db795a4cc3ea28c2895d62db12fdb7c1abfffacfb0` |
| Exact bb48 candidate, unchanged by docs-only 462 | `ca0ded66441b8818bdf5726ee7d8ffa95abb8518` | 17,444 / 324 | `dc3cfdb3e8a7398d91dd2d0651bc31c11d2e6c357aaa03e83dba21c3b81adeb5` |

The single source commit bb48 has sole parent `6e90f38155f5a8edf57b0336b6d79e4ca60c110b` and changes only this file by +8/−2. Inverting that exact helper hunk reproduces the full 332/6e90 preimage byte-for-byte. The outer `wow64Startup` function, its original call order and every later child, machine-type, breakpoint, CREATE_NEW publication, churn, witness, wait, cleanup and negative assertion are unchanged by bb48. The preceding 332 change introduced `_WIN32_WINNT 0x0A00` and direct SDK binding; bb48 retains that definition while replacing only the helper's binding mechanism.

The relevant sequence is `4dc08dea7eeed5c286cf310e09a2ba26d84a9546 → 50bdfaf99223ab8368eb694b217947a88a3e42de → 332fbe3420c811c095dac4187d3f9664e8c47179 → 6e90f38155f5a8edf57b0336b6d79e4ca60c110b → bb48cb81493fbadb8b1e451ba5c35d7bc8488952 → 462845722260dfd91111c37cb66fc54a01a3ecb7`. The 50b Plan29 addition selected direct SDK binding and explicitly excluded a runtime module loader. The bb48 source predates the later 462 Plan29 47-line note, blob `411f9e7943bd9323006ea67ef470624b873419c9`. That later note records preservation of the concurrent helper; it must not be described as a previously published R1 for bb48. A fresh root adoption R1 must preserve the actual history and expressly amend the earlier no-runtime-loader clause and observation accounting. The 462 Plan32 addition is a separate activity-UI concern and is not native authority supplied by this review.

## Exact helper and fail-closed behavior

~~~cpp
static std::wstring wow64Command() {
  // Resolve the documented API-set contract with one bounded module lifetime.
  const auto module=LoadLibraryExW(L"api-ms-win-core-wow64-l1-1-1.dll",nullptr,LOAD_LIBRARY_SEARCH_SYSTEM32);
  if(!module) return {};
  const auto directory=reinterpret_cast<decltype(&GetSystemWow64Directory2W)>(
    GetProcAddress(module,"GetSystemWow64Directory2W"));
  wchar_t path[MAX_PATH]{};
  const auto length=directory?directory(path,MAX_PATH,IMAGE_FILE_MACHINE_I386):0;
  const bool closed=FreeLibrary(module)!=FALSE;
  if(!closed||!length||length>=MAX_PATH) return {};
  return std::wstring(path)+L"\\cmd.exe";
}
~~~

The load uses the one literal API-set name and the System32 search flag, with no alternate module, directory or machine fallback. A failed load returns the existing empty-result refusal. After a successful load, every normal-return path invokes exactly one `FreeLibrary`, including the missing-export branch. The function pointer is used only before that close; the directory is copied into the original stack buffer before module release. A successful directory query still requires the exact I386 input and `0 < length < MAX_PATH`. A missing export, zero/oversized result or failed `FreeLibrary` returns empty, so the new close failure cannot turn into qualification. `decltype` supplies the SDK declaration's pointer type without an evaluated direct call. These observations support the source change; actual resulting-source Windows linkage and execution remain required.

The outer code still obtains the `IsWow64Process2` entry, calls `wow64Command()`, then checks the already obtained machine entry before checking the executable result. The original error precedence and short-circuit order are retained. On an eventual new-source stage-5 refusal, the aggregate could cover load, export, directory-result or close failure. It would not, without another retained operand, identify one of them. In contrast, the historical 4dc stage-5 aggregate concerns its old GetModuleHandle/GetProcAddress/directory paths and contains no FreeLibrary branch.

## New work and unchanged acceptance boundaries

Relative to direct-binding source 332, a successful helper adds one `LoadLibraryExW`, one `GetProcAddress` and one `FreeLibrary` around the same one directory query. Relative to the isolated I/4dc helper, it replaces `GetModuleHandleW` with `LoadLibraryExW` and adds `FreeLibrary`; the old helper already performed an export lookup and directory query. The missing-export branch now closes the acquired module before refusing. These are explicit new in-process API operations and a module lifetime, not an unchanged observation count. Loading can perform loader/dependency work, and all new synchronous work consumes the original budget. Finite call counts do not bound wall-clock latency or guarantee output/delivery.

The candidate adds no child, provider input, extra process probe, census, runtime RPC, signal, retry, fresh deadline or directory fallback. It does not change the original child identity, actual I386 verification, original HANDLE custody, release/cleanup predicates, control-channel rules, action sequence or success oracle. The existing phase/controller/native budgets remain unchanged; no earlier snapshot is reused across a mutable boundary. The exact CMake file `cf158110832d24afd7f97b6e9ef2dbf7472b0410` is untouched. No OneCore link change is proposed on top of the preserved helper.

## Primary source basis and its limits

Microsoft documents API-set names as logical contracts rather than a guaranteed physical implementation DLL, and explicitly permits loading an API set with the LoadLibrary family: [Windows API sets](https://learn.microsoft.com/en-us/windows/win32/apiindex/windows-apisets). [LoadLibraryExW](https://learn.microsoft.com/en-us/windows/win32/api/libloaderapi/nf-libloaderapi-loadlibraryexw) documents the System32 search flag, module loading and failure result. [FreeLibrary](https://learn.microsoft.com/en-us/windows/win32/api/libloaderapi/nf-libloaderapi-freelibrary) documents the acquired-module reference count and BOOL result. The candidate owns a LoadLibraryEx reference; it does not incorrectly free an unowned GetModuleHandle result. Microsoft's [decltype reference](https://learn.microsoft.com/en-us/cpp/cpp/decltype-cpp?view=msvc-170) supports the type-only use. The [GetSystemWow64Directory2W reference](https://learn.microsoft.com/en-us/windows/win32/api/wow64apiset/nf-wow64apiset-getsystemwow64directory2w) specifies its I386 directory query, zero failure and returned-length rules. These pages were actually opened during this finite review; their general contract does not prove availability or successful loading on either pending original runner.

Independent pinned source inspection used Microsoft's [win32metadata commit 15fc870a5e96df7c560877ff30136c0fb5a21e9b](https://github.com/microsoft/win32metadata/tree/15fc870a5e96df7c560877ff30136c0fb5a21e9b), tree `32ed0efbd28a018ec154f989433b030730428895`. Its [wow64apiset.h](https://github.com/microsoft/win32metadata/blob/15fc870a5e96df7c560877ff30136c0fb5a21e9b/generation/WinSDK/RecompiledIdlHeaders/um/wow64apiset.h), blob `2c10f96459c0e5b190f08e291f6b4e3a47a7c302`, gives the exact SDK declaration under the Windows-10 guard. Its [libMappings.rsp](https://github.com/microsoft/win32metadata/blob/15fc870a5e96df7c560877ff30136c0fb5a21e9b/generation/WinSDK/libMappings.rsp), blob `cd869237f7c43ea9e5d297a3d8901099380c55b8`, maps GetSystemWow64Directory2W to `api-ms-win-core-wow64-l1-1-1.dll` while mapping IsWow64Process2 to KERNEL32.dll. Inspection of the [mapping generator](https://github.com/microsoft/win32metadata/blob/15fc870a5e96df7c560877ff30136c0fb5a21e9b/scripts/CreateProcLibMappingForAllLibs.ps1), blob `7a7a2becace9ded1f001438850512ca1d711244d`, and [COFF import parser](https://github.com/microsoft/win32metadata/blob/15fc870a5e96df7c560877ff30136c0fb5a21e9b/sources/MetadataUtils/LibScraper.cs), blob `233b9560deb9f6c03a1b0314bd025c0e15431973`, also establishes a limit: the map does not identify which contributing SDK .lib supplied each symbol. This review did not independently download the official SDK NuGet archives cited by the later 462 author. Their sizes/digests and import-library conclusions remain that author's reported evidence, not a second independent archive audit.

## Actual historical evidence and prospective validation

The independently audited source-332 Process jobs `132973378700` (x64) and `132973379104` (ARM64), run `43766708055`, both failed original step 15 with `LNK2019 __imp_GetSystemWow64Directory2W` followed by LNK1120, before native runtime qualification. Their exact original ZIP/log/source joins are preserved in `native-audit-332/process-build-checkpoint-20261115-2219.json`. The earlier 4dc ARM original stage-5/readiness failure remains failed and is preserved in `native-audit-4dc/arm-terminal-checkpoint-20261115-2211.json`. Neither the API-set mapping nor the later helper identifies the old aggregate's inner subbranch or retrospectively changes its cleanup/custody qualification.

The exact resulting-source original Windows x64 and ARM compile/runtime commands remain decisive. No new finite test was manufactured to assert that replacing a source literal proves native correctness, and no project/native command was executed for this review. The successful source-332 V2 x64 leaf is a separate scenario that does not execute this C++ service-pair helper. The fresh source-462 Process/V2 initial API slice at 22:22:03 UTC had all 14 owned jobs queued. No resulting-source compiler, SDK-load, original child, native cleanup, P08, P09, product or release PASS is claimed here.
