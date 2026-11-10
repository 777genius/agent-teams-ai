# Messenger Connectors - Uncertainty Pass 30

Date: 2026-04-29
Scope: Telegram media and attachments for official shared bot mode, own-bot mode, inbox persistence, and no durable backend plaintext queue

## Executive Delta

The lowest-confidence boundary after webhook ACK timing is media:

```text
Telegram message with photo/document/voice
official backend receives update
backend may need bot token to fetch file bytes
desktop may be offline
local app currently persists attachments only for live lead messages
agent reply may need to reference or send files back
```

This is not just a file download problem. It changes the privacy story.

For official shared bot mode, the backend receives the update and can technically fetch Telegram files with the official bot token. Even if we do not store plaintext or media durably, the backend is in the transient data path. That is acceptable only if the product copy is precise:

```text
Default official bot:
- easiest setup
- no durable backend plaintext/media queue
- backend may transiently process messages while routing them
- if desktop is offline, we honestly say offline
```

Private own-bot mode is the clean privacy mode:

```text
Own bot:
- token stays in desktop
- desktop polls or receives webhooks directly when online
- backend does not receive lead messages or media
- offline reliability is lower unless user enables a separate relay/queue
```

⚠️ Recommendation update: launch official shared bot as text-first. Treat Telegram media as metadata-only/unsupported in the first official MVP. Add private own-bot media support before official shared bot media streaming if privacy is a core selling point.

## Source Facts Rechecked

Telegram official facts checked on 2026-04-29:

- Bot API is token-based. API calls are made to `https://api.telegram.org/bot<token>/METHOD_NAME`.
- Webhook responses can call a Bot API method inline, but Telegram does not return the method result to us in that webhook response.
- Incoming updates are stored by Telegram until received, but not longer than 24 hours.
- `Update.message` can be any kind of message, including text, photo, sticker, and more.
- `getFile` returns a `File` object and prepares a file for download.
- File download URL shape is `https://api.telegram.org/file/bot<token>/<file_path>`.
- Telegram guarantees that the file download link is valid for at least 1 hour.
- Standard cloud Bot API download limit is 20 MB.
- Local Bot API server can download without a size limit, upload up to 2000 MB, and can return a local `file_path`.
- `sendPhoto` supports `message_thread_id` and `direct_messages_topic_id`; uploaded photos are limited to 10 MB.
- `sendDocument` supports `message_thread_id` and `direct_messages_topic_id`; uploaded files are currently up to 50 MB.
- `sendMediaGroup` sends albums of 2-10 media items.
- `createForumTopic` can create a topic in a forum supergroup or a private chat with a user.
- Bot API 9.6 Managed Bots expose `getManagedBotToken`; the manager bot can fetch the managed bot token.

Sources:

- https://core.telegram.org/bots/api#making-requests
- https://core.telegram.org/bots/api#making-requests-when-getting-updates
- https://core.telegram.org/bots/api#getting-updates
- https://core.telegram.org/bots/api#file
- https://core.telegram.org/bots/api#getfile
- https://core.telegram.org/bots/api#using-a-local-bot-api-server
- https://core.telegram.org/bots/api#sendphoto
- https://core.telegram.org/bots/api#senddocument
- https://core.telegram.org/bots/api#sendmediagroup
- https://core.telegram.org/bots/api#createforumtopic
- https://core.telegram.org/bots/api#getmanagedbottoken

Local code facts:

- `AttachmentPayload` contains base64 data and metadata.
- `AttachmentMeta` is persisted on message rows and may include a local file path.
- `TeamAttachmentStore` writes files under app data `attachments/{teamName}/{messageId}` and stores `_index.json`.
- `TeamAttachmentStore` sanitizes path segments and stored filenames.
- Main-process IPC currently accepts only these message attachment MIME types: PNG, JPEG, GIF, WebP, PDF, and plain text.
- Main-process IPC currently limits message attachments to 5 files, 10 MB per file, and 20 MB total.
- `handleSendMessage` allows attachments only when sending to the live team lead.
- If stdin delivery fails after attachments were requested, the current code fails instead of silently dropping attachments.
- The inbox path is described as offline lead or regular members with no attachment support.
- OpenCode secondary runtime delivery marks attachment messages as terminal failure because attachments are not supported for secondary runtime.
- Renderer composer blocks attachments for cross-team messages, non-lead recipients, and offline teams.

Implication:

```text
Current app has a useful local attachment store,
but messenger media cannot safely reuse offline inbox delivery until we add
a durable provider-neutral media acceptance protocol.
```

## 1. Why Media Is Harder Than Text

Text flow can be bounded:

```text
backend receives plaintext text
desktop accepts locally
backend ACKs Telegram
backend forgets plaintext
```

Media flow needs at least one more side effect:

```text
backend receives file_id/file_unique_id/caption
backend calls getFile
backend downloads bytes using URL that embeds bot token
desktop writes bytes to local attachment store
desktop commits message row with attachment metadata
backend ACKs Telegram
```

Every step can fail independently.

The dangerous half-states are:

- backend ACKs Telegram, but desktop never wrote the file;
- desktop wrote the file, but message row did not commit;
- message row committed, but attachment file write failed;
- backend downloaded media but desktop disconnected;
- duplicate webhook retries download the same media multiple times;
- media group arrives as multiple updates and only some items are accepted;
- file is too large for Telegram cloud `getFile`;
- file link expires while desktop is offline;
- file_id is stored durably and becomes a capability to fetch content later with the bot token;
- provider MIME/type says one thing, actual bytes are another.

This is why media should not be part of the default official MVP unless it has its own state machine.

## 2. Privacy Reality

There are three privacy tiers.

### Tier A: official shared bot, text-only

```text
Backend transiently sees message text.
Backend stores only redaction-safe receipts and hashes.
No media bytes pass through backend because media is unsupported.
```

Privacy story:

```text
Simple default connection.
No durable backend plaintext queue.
Not end-to-end private from our backend.
```

### Tier B: official shared bot, ephemeral media streaming

```text
Backend transiently sees file metadata and file bytes.
Backend does not write bytes to disk.
Desktop must be online and must commit the attachment locally.
```

Privacy story:

```text
Convenient, but backend is a transient processor for media.
No durable backend media store.
```

### Tier C: own bot, local token

```text
Desktop holds token.
Desktop downloads Telegram files directly.
Backend never receives message text or media.
```

Privacy story:

```text
Best privacy.
More setup.
Works only while desktop app or local service is running, unless user adds their own hosting.
```

Managed Bots do not eliminate token exposure if our manager bot is the manager. Telegram added `getManagedBotToken`, and the official docs say the token can be fetched by the manager bot. Therefore, Managed Bots are a UX feature, not a clean no-token-access privacy feature for us.

## 3. Treat file_id As Sensitive

Telegram `file_id` is not the file bytes, but it is not harmless metadata.

Reason:

```text
file_id + bot token -> getFile -> download URL -> file bytes
```

Therefore:

- do not store raw `file_id` in durable official backend receipts unless encrypted;
- do not put raw `file_id` in logs;
- do not expose raw `file_id` to renderer unless the renderer needs it for an explicit action;
- prefer local desktop storage of raw provider file ids only after user acceptance;
- store `file_unique_id` only for dedupe if needed, but remember it cannot download or reuse the file;
- store HMACs for backend idempotency where possible.

Suggested receipt fields:

```ts
type ProviderMediaReceipt = {
  provider: 'telegram';
  scope: 'official' | 'own_bot';
  updateId: number;
  providerMessageKey: string;
  providerMediaKeyHash: string;
  providerFileUniqueIdHash: string | null;
  providerFileIdEncrypted?: string;
  mediaKind: 'photo' | 'document' | 'voice' | 'audio' | 'video' | 'animation' | 'sticker' | 'unknown';
  declaredMimeType: string | null;
  declaredSizeBytes: number | null;
  captionHash: string | null;
  status:
    | 'received'
    | 'unsupported_policy'
    | 'desktop_claim_started'
    | 'desktop_media_committed'
    | 'desktop_text_only_committed'
    | 'offline_notice_started'
    | 'offline_notice_sent'
    | 'offline_notice_ambiguous'
    | 'acknowledged'
    | 'failed_terminal';
};
```

For default official mode, omit `providerFileIdEncrypted` entirely.

## 4. Official MVP Policy

For official shared bot v1:

```text
Text, captions, commands:
- support

Photo/document/voice/audio/video/sticker:
- do not download
- route caption text if present
- include local metadata placeholder only if useful
- tell lead in Telegram that attachments are not supported yet or require desktop online
```

The system message should be explicit but not noisy:

```text
I received an attachment, but this connection currently supports text only.
Please send the key details as text, or connect a private bot for local file handling.
```

Rules:

- If a message has `caption`, deliver caption as the text turn.
- If a message has media and no caption, create a local event only if desktop is online and can persist a metadata-only placeholder.
- If desktop is offline, send one offline/unsupported notice and ACK Telegram.
- Deduplicate unsupported notices by `providerMessageKey`.
- Do not call `getFile` in official MVP.
- Do not store `file_id`.

This keeps the first version honest and avoids a half-built media pipeline.

## 5. Own-Bot Media Policy

Own-bot mode can support media earlier because the desktop has the token.

```text
desktop receives update via getUpdates or local webhook
desktop calls getFile directly
desktop downloads bytes directly
desktop writes TeamAttachmentStore
desktop writes message row
desktop sends ACK/offset after local commit
```

The exact update intake can be:

- desktop long polling with `getUpdates`;
- local webhook only if user has a reachable tunnel or local Bot API server;
- later, optional user-hosted relay.

For consumer desktop UX, long polling is simpler and more private:

```text
No inbound public port.
No server token storage.
Works while app is open.
Telegram can still be used from phone as the client UI.
```

Limitations:

- if desktop is asleep or app closed, no processing;
- Telegram retains updates only up to its limits;
- if the user also runs the same token elsewhere, `getUpdates` offset/webhook conflicts can appear;
- if webhook is set for the bot, `getUpdates` will not work until webhook is deleted.

## 6. Ephemeral Official Media Streaming

If we later support official shared bot media without durable backend media queue, use a strict active-desktop stream:

```text
Telegram webhook update
backend receipt persisted with hashes only
backend checks desktop session capability
backend calls getFile
backend streams file bytes to desktop over existing desktop connection
desktop writes temp file
desktop validates size/hash/MIME
desktop atomically moves into TeamAttachmentStore
desktop writes message row
desktop returns accepted_local_media
backend ACKs Telegram
```

Backend rules:

- stream only to an already authenticated desktop route session;
- do not write bytes to disk;
- limit file size before download using Telegram metadata when present;
- enforce hard byte counters during stream;
- abort stream if desktop disconnects;
- never log filename, file_id, or file_path;
- do not retry file downloads after request scope unless encrypted queue is enabled.

Desktop rules:

- write to a temp file outside final attachment path;
- compute SHA-256 while streaming;
- sniff magic bytes for supported types;
- verify final byte count;
- atomically move into local attachment store;
- only then commit message row;
- dedupe by `providerMessageKey + providerMediaPartKey`;
- return the existing local acceptance for duplicate delivery.

This needs a new storage API. Current `TeamAttachmentStore.saveAttachments` expects base64 payloads. Streaming media should not base64 all bytes through IPC.

Suggested extension:

```ts
interface AttachmentContentStore {
  saveBase64MessageAttachments(input: SaveBase64AttachmentsInput): Promise<SavedAttachment[]>;
  saveStreamedMessageAttachment(input: SaveStreamedAttachmentInput): Promise<SavedAttachment>;
  getMessageAttachmentFiles(input: GetAttachmentFilesInput): Promise<AttachmentFileData[]>;
}
```

The Telegram adapter should depend on this port, not on `TeamAttachmentStore` directly.

## 7. Inbox Integration Model

Current inbox rows can carry `AttachmentMeta[]`, but the inbox path does not guarantee bytes exist. Messenger media needs a stronger invariant:

```text
An inbox/message row may reference an attachment only after local bytes are committed,
unless the attachment is explicitly marked as metadata-only/unsupported.
```

Add a provider-neutral attachment state:

```ts
type MessengerAttachmentState =
  | 'available_local'
  | 'metadata_only'
  | 'unsupported_policy'
  | 'too_large'
  | 'download_failed'
  | 'expired'
  | 'blocked_security';

type MessengerAttachmentMeta = AttachmentMeta & {
  state: MessengerAttachmentState;
  provider: 'telegram' | 'whatsapp' | 'discord';
  providerKind: string;
  providerMessageKey: string;
  providerMediaPartKey: string;
  caption?: string;
  checksumSha256?: string;
  localCommittedAt?: string;
};
```

Do not overload `AttachmentMeta.filePath` absence as "unsupported". It already means metadata-only in comments, but messenger needs typed status for UI, retries, and support.

## 8. Media Group Edge Cases

Telegram albums arrive as multiple messages with a shared grouping concept. Do not assume one update equals one logical user turn.

Policy:

- collect album parts in a short local aggregation window, for example 800-1500 ms;
- if some parts are unsupported, deliver one consolidated turn with mixed attachment states;
- dedupe every part independently;
- do not block a text caption forever waiting for missing album parts;
- if the same album has multiple captions, preserve each caption near its part in the local model;
- if aggregation times out, commit what is available and mark late duplicates as follow-up parts.

For MVP text-only official mode:

- do not download album files;
- aggregate captions and unsupported media counts;
- send at most one notice per album.

## 9. Outbound Media From Agent To Telegram

Outbound media is easier only if the file already exists locally and the desktop is online.

Flow:

```text
agent/tool creates reply with attachment reference
desktop validates local file and policy
desktop sends request to provider adapter
official adapter uploads via backend
own-bot adapter uploads directly
provider returns message ids
local delivery ledger marks sent
```

Official shared bot outbound media privacy:

```text
If backend uploads the file to Telegram, backend transiently sees file bytes.
```

That is acceptable only under the same "transient processor, no durable media queue" contract.

MVP:

- outbound official: text only;
- outbound own-bot: optionally support local photos/documents after inbound media is solid;
- never let an agent silently send local files to Telegram without explicit policy gates.

## 10. Security Rules

Minimum rules before any media bytes are supported:

- allowlist MIME families by provider mode;
- enforce byte limits before and during download;
- store original filename only after sanitization;
- keep provider filename as untrusted display text;
- never use provider filename as path;
- sniff magic bytes for images/PDF/text where possible;
- reject archives in MVP;
- reject executable types;
- do not auto-open downloaded files;
- do not feed binary content to the model unless the app explicitly supports that type;
- captions and filenames are untrusted user input, not system instructions;
- strip or ignore path-like names;
- rate-limit media downloads per route;
- record redaction-safe diagnostics for failed media;
- design future malware scanning as an optional port, not hardcoded vendor logic.

For text extraction:

- plain text files can be included only after encoding validation and size cap;
- PDFs should be attached as model document blocks only when provider/runtime supports them;
- voice transcription should be a separate explicit feature, preferably local-first if privacy matters.

## 11. Failure Matrix

Critical cases:

- Update has media but no text.
  - Official MVP: unsupported notice, metadata-only local event if desktop online.
- Update has media plus caption.
  - Official MVP: deliver caption and mention unsupported attachment count.
- Duplicate webhook after unsupported notice.
  - Return completed receipt, do not resend notice.
- Duplicate webhook after desktop local commit.
  - Desktop returns existing local message id.
- Backend calls `getFile`, desktop disconnects before any bytes.
  - Abort stream, offline/unsupported policy, ACK according to receipt state.
- Backend streams bytes, desktop crashes before commit.
  - Duplicate webhook can retry only if backend has not ACKed yet.
- Desktop commits file, ACK to backend is lost.
  - Duplicate webhook redelivers, desktop dedupes and returns existing acceptance.
- File exceeds Telegram cloud download limit.
  - Mark too_large; suggest user resend as text or use own bot/local server mode later.
- File download URL expires.
  - In official no-queue mode, do not attempt later replay. Mark expired if it happens in active stream.
- Provider MIME lies.
  - Sniff bytes, reject if mismatch is dangerous.
- Filename is `../../x` or has control chars.
  - Sanitize and preserve original only as escaped display text if needed.
- Media group partially arrives.
  - Commit consolidated partial turn with per-part states.
- Backend crashes after downloading media but before desktop commit.
  - No backend disk means media is lost; webhook retry may redownload if not ACKed.
- Backend crashes after desktop commit but before HTTP 2xx.
  - Telegram retries; backend uses receipt and desktop dedupe to ACK.

## 12. Top 3 Options

### Option 1 - Official text-only MVP, media metadata/notice, own-bot media later

🎯 9   🛡️ 9   🧠 4

Approx changed LOC: 700-1800.

What it means:

- official shared bot supports text and captions;
- official shared bot does not call `getFile`;
- official shared bot does not store `file_id`;
- media-only messages get one clear unsupported notice;
- local UI can show "attachment received, not imported" metadata only when desktop is online;
- own-bot adapter is the first place where real media support can land.

Why this is best now:

- aligns with no durable backend plaintext/media queue;
- avoids token/file privacy ambiguity;
- matches current app constraints where attachments require live lead;
- minimizes risk of partial file delivery bugs;
- gives users a clean upgrade path: "connect private bot for local files".

Risk:

- less magical than users expect from Telegram;
- leads may send screenshots and expect them to work;
- product copy must be clear.

### Option 2 - Official ephemeral media streaming to active desktop

🎯 7   🛡️ 8   🧠 8

Approx changed LOC: 2500-6000.

What it means:

- backend downloads media only while desktop is connected;
- backend streams bytes to desktop and does not store them;
- desktop commits attachment bytes before message row;
- ACK waits for local acceptance or clean unsupported/offline decision.

Why it is viable:

- preserves convenience of official shared bot;
- no durable backend media store;
- can support common screenshots/documents.

Risk:

- backend still transiently sees file bytes;
- many failure states;
- requires new streaming attachment port;
- current base64 attachment path is not the right transport;
- harder to test than text.

### Option 3 - Backend encrypted media queue

🎯 6   🛡️ 8   🧠 9

Approx changed LOC: 3500-9000.

What it means:

- backend stores encrypted media or encrypted Telegram file capabilities for later desktop replay;
- desktop decrypts and commits when it comes online;
- official bot can feel reliable even while desktop is offline.

Why it is not first:

- this changes the product from "offline means offline" to "we queue sensitive content";
- encrypted media queue is still a data retention system;
- key management, replay, retention, deletion, and support diagnostics become much harder;
- it competes with a simpler premium/advanced reliability mode later.

Use only after:

- text routing is stable;
- ephemeral streaming is proven;
- user demand for offline media is strong enough.

## 13. Decision Update

Recommended sequence:

```text
1. Official shared bot:
   text + captions + topics + reply routing + no durable backend plaintext queue.

2. Own-bot adapter:
   local token + local polling + text first, then local media download.

3. Official shared bot media:
   ephemeral active-desktop streaming only, no backend disk.

4. Advanced reliability:
   encrypted backend queue for text/media only if explicitly enabled.
```

This keeps the architecture provider-neutral and honest:

```text
core messenger domain:
  route identity
  thread/topic mapping
  local message ledger
  attachment state machine
  delivery ledger

provider adapters:
  Telegram official adapter
  Telegram own-bot adapter
  future WhatsApp adapter
  future Discord adapter

storage ports:
  route registry
  inbound receipt store
  local turn ledger
  attachment content store
  outbound delivery ledger
```

The main design rule:

```text
No message row may claim an attachment is available unless the desktop has committed bytes locally.
```

## 14. Places Still Worth Deeper Research

Next low-confidence areas:

- exact Telegram private-chat topics UX across clients when many teams exist;
- whether `message_thread_id` behavior is consistent for private bot topics on desktop/mobile Telegram clients;
- how to represent teammate messages inside one team topic without confusing the user;
- whether captions/media groups should become one Agent Teams turn or multiple turns;
- how to prevent model/tool prompt injection through Telegram captions and filenames;
- which own-bot intake mode is best for desktop: long polling, local Bot API server, or optional tunnel.

