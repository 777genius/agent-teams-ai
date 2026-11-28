# Alice/Bob native peer fixture: settle the original human seed

Status: approved fixture correction plan, published before implementation. No implementation or runtime result is claimed. Three fixture/test paths, zero application/runtime production paths. R1: provider_team_parity source/artifact review. R2: root independently checked the synthetic decision and required human delivery contract. R3: frontend_parity independently reviewed the exact plan and source; author repeated the exact-result/envelope/physical-proof checks.

## Exact evidence and conclusion

Official RealRuntimeProviderCount run 46105391531, job 140856906683, checked out synthetic merge 8cb95b591a70a74539409f27794d54cde744ac33. Parent independently verified its tree 81bbaf717d8f3869bdf9851b715be806f69b890f equals cf0d178aeb350c8a0fb113ec89e44836030966ee. The inspected ZIP is /tmp/TEST-pr982-alice-bob-46105391531.zip, SHA256 702a4907162e426b0f6b7103dc3a46e336da32b616721761fafa6d7dbc464470, containing peer-read-receipts.json, model-requests.ndjson and one screenshot.

The fixture reached clean launch success for all three original OpenCode members, distinct Alice/Bob sessions, and reported no model-protocol errors. It timed out in peer-challenge-and-ack on the second direction. The artifact contains 12 model requests:

- 05:54:21.219: Alice processes human seed cd48b5f3-8450-4989-a346-ad491b67edbf and sends CHALLENGE to Bob. Tool success follows at .277; the synthetic next decision is empty text.
- 05:54:32.721: Bob processes that challenge and sends ACK to Alice with source=runtime_delivery and relayOfMessageId=28d9d783-2acd-4635-960d-53cadc7c5c97. Its tool succeeds.
- 05:54:45.220: Bob processes human seed fff1c7f6-c544-42b6-9eea-87b47bb20bc7 and sends CHALLENGE to Alice. Tool success follows at .252; the synthetic next decision is empty text.
- Alice receives no model call for the first ACK or second challenge. At 05:56:30.667 and 05:56:54.475 the original human-seed watchdogs explicitly request missing visible replies for seed IDs 18dc6ca0-c6bc-45b8-9b5a-0ae68ce76721 and 3852d09d-8aa1-4047-ae9d-6208d12ae4cf. The fixture returns generic READY text because those retry frames no longer contain its three recognized nonce markers.

This establishes a fixture contract violation: the peer challenge is real, but it is not a correlated reply to the human who sent the seed. Returning empty text leaves that required human delivery unsettled. Application source explains why later messages to that member can then wait behind it. No captured actual peer-delivery ledger was preserved in the failed ZIP, so do not call an exact ledger row/status directly observed; the conclusion combines the real watchdog/model evidence with the unchanged source. There is no evidence here justifying a production queue bypass.

Relevant cf0d source blobs:

| Path                                                                               | Blob / decisive behavior                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| scripts/e2e/opencode-alice-bob-local-model.mjs                                     | 410d40f742b3a25a5db2f900c08e299499c99869: syntheticModelTurn sends seed challenge to the peer without the human reply envelope, then returns empty after any matching tool result; only ACK gets original peer relay metadata.                              |
| src/main/services/team/runtime/OpenCodeRuntimeMessageText.ts                       | 5079fa23099e8a99daeaba53513b64f0a434826b: human delivery supplies the required user/source/relay envelope and explicitly forbids ending the turn empty.                                                                                                     |
| src/main/services/team/opencode/delivery/OpenCodeMemberMessageDeliveryService.ts   | f0e8932cc1c16ca3cbd28c974557a7a0ed46d1a0: lines541–599 select active original and return queuedBehindMessageId/accepted:false before another native prompt; lines1397–1451 resolve original visible reply/read permission and schedule missing-proof retry. |
| src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger.ts           | 1a66f7a9e6adfa62dbb520dc18e2f8c096420ae6: lines286–305 select oldest nonterminal delivery for the same member/run/lane.                                                                                                                                     |
| src/main/services/team/opencode/delivery/OpenCodePromptDeliveryReadCommitPolicy.ts | 290e49205b85de3c5df4f74924d41a8398fba428: completed silent child is allowed for an independently known peer, not a human request; original visible recipient/relay proof remains required.                                                                  |

## Minimal fixture behavior

Keep the two human PEER_SEED requests, real native OpenCode processes/sessions, genuine app IPC and real message_send tool. Do not replace the seed with a synthetic ledger record or relax application delivery rules.

For each owned seed nonce, capture its human delivery envelope from the CURRENT actual native prompt. It must match this TEST team, expected actor, to=user, source=runtime_delivery and a nonempty actual relayOfMessageId. Pin that exact seed ID to the existing owned candidate; a conflicting later envelope refuses instead of retargeting the candidate.

The synthetic model still emits the existing one peer CHALLENGE. After its actual successful message_send tool result, it emits a SEPARATE concrete report to user using the original human seed envelope, for example “Sent the requested peer challenge CHALLENGE:<nonce> to <peer>.” Include a nonempty summary. Use a distinct deterministic seed-report tool-call ID derived from that owned nonce. The peer CHALLENGE is never relabelled as a user reply.

Recognize completion only from the matching real tool result. Error/ambiguous results do not become a completed report or fabricated physical message. After the separate user report succeeds, finish the original turn without another side effect. If a watchdog retry for the EXACT already-captured human seed arrives, send only the missing original report when the peer challenge was actually completed; never resend the challenge. An unrelated retry/nonce/actor cannot borrow that state. A completed report is not sent again.

Keep the four peer action records separate from the two human seed-report records. Existing actions.size===4 continues to mean four independent successful peer message_send results. The silent ACK-consumption branch stays unchanged; its real completed-child/read proof is still required by the application.

Within each existing direction's 180-second wait, also require the one physical original human report and corresponding original seed read commitment before moving on. Use the actual original run/lane/member/session and physical seed ID. This does not increase the deadline or count the human report among the four peer reads. Keep settleMessages' final requirement of EXACTLY FOUR distinct physical peer messages, accepted original prompts, observed original child, durable inbox-read commits and no cancellation. Keep the original real Stop submission and disappearance checks unchanged.

Before cleanup on failure, add a bounded allowlisted diagnostic of only this run's two owned seed deliveries and up to four owned peer messages: physical IDs/from/to/read/source/relay plus exact original receipt correlation/status/accepted/observed/read-commit fields. No whole team history, raw prompt transcript or new success inference. This will distinguish another real delivery defect from an unsatisfied fixture prerequisite if the native gate still fails.

## Exact candidate manifest

1. scripts/e2e/opencode-alice-bob-local-model.mjs: delegate its existing pure decision logic, add two separate seed-report assertions and bounded original-delivery diagnostics. Leave launch, four-peer settlement, Stop and all native/wait timeouts unchanged.
2. NEW scripts/e2e/opencode-peer-model-fixture.ts: mechanically extract text/last-user/tool-result/owned-nonce decision logic, then add the original human-report stage. Import Json/Decision as types from the existing group-chat-model-server; do not start a server/native process at import. State belongs to this fixture's existing candidate/action maps; no application owner/cache.
3. NEW test/scripts/opencodePeerModelFixture.test.ts: finite pure request/real-tool-result replay tests, using minimal sanitized TEST messages with the actual captured envelope/result shape. No native/runtime service launch and no real credentials.

Estimated new helper 120–180 lines; focused test roughly150–230 lines. Script loses its embedded decision body; no source ratchet exceptions or package/vendor/pin changes.

## Verification sequence and required assertions

First mechanically extract the CURRENT function without changing its behavior. A finite regression that presents a real human seed, obtains the peer CHALLENGE, then supplies its successful tool result must fail because the existing next decision is empty instead of the required separate user report. That is the intended baseline fixture RED, not a missing future export or setup failure. Do not label it a new native execution.

After the narrow fixture correction, verify:

- one initial peer challenge, then one separately correlated user report; final turn has no extra side effect;
- wrong/missing human envelope, different actor/nonce, different retained seed ID, error or ambiguous tool result cannot claim success;
- a retry of the exact captured seed requests only the missing human report and never duplicates the peer challenge;
- tool-result continuation from an unrelated previous nonce cannot satisfy the current seed;
- the peer CHALLENGE→ACK route retains its own physical relay; a peer ACK is still consumed silently;
- human report counts remain separate, four peer actions/physical read predicates are unchanged, and original Stop remains mandatory;
- bounded failure diagnostics retain exact seed/peer correlation without weakening a missing receipt into success.

Run only the focused ordinary unit/type checks after authorization. Actual Linux native Alice/Bob qualification remains the existing normal CI workflow with verified runtime inputs; do not manually rerun/dispatch, change pins, increase wait times or relax the four physical peer-read gate. A fixture unit PASS alone does not qualify the native peer workflow.
