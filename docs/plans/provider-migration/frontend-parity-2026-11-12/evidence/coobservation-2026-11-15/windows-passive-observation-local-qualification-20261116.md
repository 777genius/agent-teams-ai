# Windows passive readiness observation — bounded local qualification (2026-11-16)

## Result and exact source

The authorized changed-input Host build, complete three-file Node regression and five scoped guards/closure checks all passed on published 47d9f29602bae778f20ae8cc133ca332e458e59a, tree 2db80678bf674cf8708ee3571e6bf4e22820a468. All seven commands exited zero. The runtime reported **87 PASS, zero FAIL/SKIP/CANCEL/TODO**, in exactly the accepted RED case order, retaining all 69 original cases. This is a finite diagnostic-contract qualification on that source. It does not resolve the original Windows fifteen-second business failures.

The commit's sole parent is c9b2c324fa76e9792791bf16777bb7833834c268. Its only changed leaves are the five producers listed below. Every other leaf, including all three tests, the Teams producer/test, getter correction, provider archives, privacy helper/test, workflows, manifests and lockfiles, remains exact. Root and independent reviewers accepted the full source, unique forward/inverse journals, complete tree and published readback before the build or runtime command.

| Producer | Published blob | Physical lines | Diff from original |
| --- | --- | ---: | --- |
| packages/legacy-agent-host/src/owned-process/HostWindowsLaunch.ts | febc16323b68c0e66d6fd55baaa9a020b451f0fc | 582 | +12 / −11 |
| packages/legacy-agent-host/src/adapters/providers/CodexMemberProvider.ts | f1d7efcb34f5c91953b474828bf09dbf3c092e98 | 348 | +58 / −4 |
| tools/owned-process-broker/nativeEmulatedSourceProfile.ts | 740f654c9c04318779fb4fd9f15b79b76711e53f | 322 | +60 / −2 |
| tools/owned-process-broker/nativeEmulatedSourceReadiness.ts | 24aeae90de179269ff616a725d38ccc49374094b | 181 | +95 / −0 |
| tools/owned-process-broker/nativeEmulatedSourceScenario.ts | f2af726dd2f352a1ecc0fa40753b76e72d008e14 | 799 | +17 / −5 |

The published R1 is blob 15ce6bf109b0bf9b2ffdf33df229cdffd6eb352a in commit 78baa7668cc67c96dc1629863b38c1cded2e8ed8. Producer audit 89a0cdc46c334781e3365a80a60e3f177b7faae1 contains the complete original/proposed identities and forward/inverse journals. The root static supplement 86ec07cd067453a05997cc391b52e801b41b840b independently records call-site counts, exact preserved blocks and conservative serialized-width arithmetic.

## Test-first baseline and executed GREEN

The three test-only sources were published in 534ab2e before any producer postimage. Their unchanged blobs are c7dc0f97576ce03c9371d4bd62fe7cd993ac7773 (custody recovery), e56cdabf97cfe2596b7622719237811560624bd6 (Codex member provider) and 43325a4e2b4d7ad2b69bacab51275a2a2af9bd8f (runtime team host). Full test audit 07e450ad9a82854b34dab01239915e8a4019b9b0 restores the prior sources exactly.

The original RED ran once against the unchanged producers and pre-existing verified build: 87 cases, 71 PASS and 16 semantic FAIL, with all 69 original cases and two new isolation cases passing. Raw 434c07590fd1fc5d201ccc97dbfe6083483e6950 and manifest 67bda5ac85dbed5e15998505ddac0470ae11399e are preserved by published checkpoint b3e3bc604e2053b70de75d3d5307f408a04920a4. Independent acceptance preceded producer authoring.

| Authorized GREEN command | Actual result |
| --- | --- |
| pnpm --filter @agent-teams/legacy-agent-host build | One attempt; original ledger prebuild and original Host build; exit 0 |
| node --test packages/legacy-agent-host/tests/host-custody-recovery.test.ts packages/legacy-agent-host/tests/codex-member-provider.test.ts packages/legacy-agent-host/tests/runtime-team-host.test.ts | 87 PASS, zero other outcomes; exit 0 |
| pnpm lint:fast:files on exactly five producers and three tests | exit 0 |
| pnpm guard:source-file-size | exit 0; 5,020 production files, 141 frozen exceptions, 800-line limit |
| pnpm guard:team-provisioning-architecture | exit 0 |
| git diff --check 78baa766..47d9f296 on exactly those eight paths | exit 0; empty output |
| Declared original profile source-pin closure | exit 0; 17 exact paths, including ten diagnostic source/dist paths, seven own-source paths and five compiled pins |

The build ran 04:24:30.331044–04:24:33.540780 UTC (3.209746 seconds); the original three-file test command ran 04:24:33.541174–04:24:41.823262 UTC (8.282105 seconds). All seven steps finished at 04:24:46.163058 UTC. Node 24.21.0, executable SHA256 7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c, and pnpm 11.22.0 were pinned. AGENT_TEAMS_INSTALL_PROFILE was node-ci and AGENT_BACKEND_TEST_NODE selected that same Node. NODE_OPTIONS, GOMAXPROCS and GOMEMLIMIT were absent. The working tree was clean before and after.

There was no separate Host-test, backend, whole-workspace or scripts compiler retry. The one authorized changed-input Host build used its original task-change-ledger prebuild, with both original project compiler commands intact. It changed the two intended compiled producers: HostWindowsLaunch.js became 22,155 bytes / SHA256 d87c22056cd9add359f0e464f130723b263f859fd5261fdbcb383083872c795f; CodexMemberProvider.js became 15,817 bytes / SHA256 60c928eebc0d35588da54e209574fcd72402dec52c8f257b78b4727c278f226c. The retained privacy helper stayed 8,412 bytes / SHA256 5cb7e0122cbd8d9ebb3e224c7d0b2322df349c1f0a8092fe7aeaf8a19fd2d581. Management identity and ledger index also retained their recorded hashes.

All 253 regular files in the selected provider implementation archive and all 12 in the session-contract archive again matched the installed files byte-for-byte. Their archive SHA256 values remain a3ee7632c9685fafb4ccc57cb5548503c476fc9ed608bd13438ed74e5329f9d8 and 0ea08bacd3f19a54c065cfaebbe8ae0fb3a8e6770886402f435a96e97867d2bc. No package resolution or provider source was changed.

## Evidence and exact limits

Complete runtime raw b80cb3ee143ac1d0c78ea9b5a1b216b6630f22bc is 9,999 bytes / SHA256 802ff4e12f4aa6e983bfd1cd764c42cff8a0d73d1b7ca57ca75255044884089a. Complete manifest 67b16f879542e9ef4b685acfc579c2b42ba28554 is 13,715 bytes / SHA256 bf865d649bb25926bbc64dc77c9fdd660c2c93d18488e305864474d43d0739c9. It records all commands, timestamps, exits, source identities, compiled-before/after identities, archive checks and resource flags. Seven complete logs, that manifest, producer audit 89a0 and static supplement 86ec are preserved as ten exact UTF-8 body strings in passive-diagnostics-green-evidence-20261116.json; every body includes its original intended evidence path, length, Git blob and SHA256. The same bundle independently preserves the seven Teams bodies. No log is truncated or reformatted.

The executed cases establish the closed resume check-site record, finite readiness-await observations, failure isolation and strict bounded TEST ledger reader behavior, while retaining the old assertions. The original 512-byte collector, reader and action-probe blocks remain byte-exact. Original awaits, guards, currentness checks, cleanup, request order and 15/30-second deadline literals remain unchanged. Passive records supply no readiness, resume, custody or provider authority.

The permitted observation overhead is explicit: the profile adds two protected subscriptions and one protected exit write; an eligible failed Codex observation adds at most one lstat and one read after the original failure. Events are bounded, missing/capped/invalid data remains unknown, and the original accepted matching 512-byte projection, binding and single confirmed epoch are required. Global ordinal cutoff precedes context filtering. The conservative static maximum is 3,861 serialized bytes for the compact ledger and 6,158 for the output, including both worst-width identifiers, below each 8,192-byte bound. Those width shapes are arithmetic bounds, not claims of executed valid histories.

No Windows native business scenario, Electron GUI, real Claude/Codex, native OpenCode model turn, new CI workflow, packaged P08 or Darwin P09 execution occurred in this local gate. The earlier Windows x64 OpenCode and Windows ARM Codex fifteen-second failures remain failures. Their exact original sub-await or event behavior still requires a resulting-source original platform run; physical cleanup evidence is not business success. The Teams Windows GUI failure and all unreached packaged journeys likewise remain open. This qualification grants no replay, further build/compiler allowance, default activation, Stage2, Ready, release or blanket provider qualification.
