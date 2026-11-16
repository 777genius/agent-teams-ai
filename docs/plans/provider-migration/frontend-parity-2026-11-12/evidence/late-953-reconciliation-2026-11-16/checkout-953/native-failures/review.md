# Original 953 native first failures

Source: `953fd8a94dc97bcfe89a7a808043dc11843e19d8`; original pull-request runs, attempt 1. This audit reads the six original logs once and preserves their decoded bytes. It makes no resulting-delivery or native performance claim.

## Windows: five checkout refusals

All five Windows jobs fail **step 2, checkout**, on the same eight Stage N evidence paths with `Filename too long`. Node setup, dependency installation, Host/broker builds and original provider/native qualifications did not run. The later missing `native-evidence/` errors in both Process jobs are secondary consequences. Embedded V2 missing-receipt upload warnings are likewise secondary.

| Lane | Original job | First refused checkout timestamp (UTC) | Log SHA256 |
| --- | --- | --- | --- |
| Host Process Windows x64 | [133102585293](https://github.com/777genius/agent-teams-ai/actions/runs/43807841917/job/133102585293) | 2026-11-16T05:07:44.3894966Z | `eddc5edd47ca82d9588bfe9fd3c2b8b2baec143bd64f7d2daf4f4b73f076c6ec` |
| Host Process Windows ARM64 | [133102585672](https://github.com/777genius/agent-teams-ai/actions/runs/43807841917/job/133102585672) | 2026-11-16T05:06:31.3895485Z | `4029ebe542160e589ca4f43d4fb89c46f79424ee6d0895b8a78627bb90db9ed0` |
| V2 static Windows | [133102585065](https://github.com/777genius/agent-teams-ai/actions/runs/43807841826/job/133102585065) | 2026-11-16T05:07:49.1891397Z | `a3c8574504ef6eb9b42ec356ac243b4d9afc87204842874e5680a4d941002e21` |
| V2 embedded Windows ARM64 | [133102585195](https://github.com/777genius/agent-teams-ai/actions/runs/43807841826/job/133102585195) | 2026-11-16T05:05:03.0541313Z | `c2c9d4873e7097de5fd5a474f515c28c9f1734defc837b735b172b850e8b4206` |
| V2 embedded Windows x64 | [133102585222](https://github.com/777genius/agent-teams-ai/actions/runs/43807841826/job/133102585222) | 2026-11-16T05:09:53.5165402Z | `45bb9636f74ac5085edad897c276f9c8d27fce971348c6ab7ef2483dbfb5cadc` |

The exact shared eight-path list is retained in `audit.json`. All are below `evidence/stage-n-renderer-and-late-originals-2026-11-16/p11-v2-live-membership-proposal/`. These are checkout refusals, not evidence of new process-custody, readiness or cleanup behavior. Creation's existing longpaths command is after checkout; Process/V2 do not already execute an equivalent pre-checkout command. The separate five-workflow proposal must cover its six Windows job definitions without changing later gates. No repair is qualified by these failed logs.

## Darwin ARM: separate original P09 refusal

[V2 embedded Darwin ARM job 133102585206](https://github.com/777genius/agent-teams-ai/actions/runs/43807841826/job/133102585206) completes checkout and reaches original step 24, `Observe POSIX original-path exec and explicit mutation counterexamples`. At 05:10:04.6879680Z and 05:10:04.7532190Z its `adhoc-test-only:after-check` and `adhoc-test-only:writer-open` rows both record imageMatched/resumed/cleanup true, with library, constructor A and main A markers. The actual assertion output is `LIB\\nBIN:A\\nMAIN:A\\n`, while the original zero-marker rule requires an empty string. The one selected test fails at the original assertion in `registered-process-executable.native.ts:496:24`; the process exits 1 at 05:10:05.0756100Z.

This ARM log prints no `TEST_POSIX_IMAGE_WITNESS_FAILURE` or `-67062` row. The previous x64 unsigned-image evidence is not transferred here. Recorded original process/group cleanup does not satisfy the failed mutation oracle. P09 remains HOLD. Earlier successful step metadata does not replace a separate full native receipt/source audit.

## Retention and limits

Six files are `job-<id>.log`; all retain their original UTF-8 BOM and original line endings. Exact sizes, SHA256 values, source lines, mutation records and metadata references are in `audit.json`. The Darwin log is 108985 bytes, SHA256 `434b9ad29cf1c89ad2f77ac1ba5f5023c816e66db9f638deea8fd2003253ccab`. No new artifact ZIP was downloaded for this audit. No workflow, source, deadline, oracle or cleanup policy was changed; no project/native/provider/GUI command was executed. The original 608 packaged Windows audit remains separate and unchanged.
