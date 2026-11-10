# Research: Teammate Message Delivery Approaches

## Comparison of 3 Approaches

| Criterion | Inbox files | Agent SDK | CLI subprocess |
| --------- | :---------: | :-------: | :------------: |
| Speed | ~5ms | ~12s | 10-15s |
| Cost | $0 | $0.01-0.08/msg | tokens |
| Works with running teammates | **YES** | NO | NO |
| Interrupts mid-turn | NO | NO | NO |
| Requires API key | NO | YES | NO |
| Memory usage | 0 | 0 | 100-320MB |

---

## 1. Inbox Files (Chosen)

### How It Works

The app writes JSON directly to `~/.claude/teams/{team}/inboxes/{member}.json`. Claude Code watches these files through fs.watch and delivers messages to agents between turns.

### Pros

- **Instant write** (~5ms)
- **$0** - no API calls
- **Only** way to communicate with already-running teammates
- Works with idle and active agents, although delivery still happens between turns

### Cons

- Race condition during concurrent writes (see [research-inbox.md](./research-inbox.md))
- Undocumented format (internal API)
- Delivery happens between turns, not in real time

### Message Format

```json
{
  "from": "user",
  "text": "Do not touch auth.ts, I will change it myself",
  "timestamp": "2026-02-17T15:30:00.000Z",
  "read": false,
  "summary": "Do not modify auth.ts",
  "messageId": "uuid-for-retry-check"
}
```

---

## 2. Agent SDK (Rejected)

### How It Works

```typescript
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();
const response = await client.messages.create({
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'Send message to teammate...' }],
  tools: [/* SendMessage, TaskUpdate, etc. */],
});
```

### Why It Was Rejected

1. **Creates a new session** - does not attach to a running teammate. SendMessage and TaskCreate are model tools, not programmatic calls.
2. **~12 seconds** per call because of the full API round trip.
3. **Costs tokens** - $0.01-0.08 per message.
4. **Requires an API key** - separate billing, not a Claude subscription.

### When It May Be Useful

- Creating new teams programmatically.
- Workflow automation outside the real-time UI path.

---

## 3. CLI Subprocess (Rejected)

### How It Works

```bash
claude --message "Send message to teammate-1: stop working on X"
```

### Why It Was Rejected

1. **New process** - does not inject into a running teammate.
2. **10-15 second** cold start.
3. **100-320MB** of memory per process.
4. Each call costs tokens.

---

## Delivery Architecture (Updated 2026-03-23)

### Two Different Mechanisms: Lead vs Teammates

**Lead** reads ONLY stdin (stream-json). Messages to the lead are delivered with `relayLeadInboxMessages()`, which converts inbox entries into stream-json on stdin. Without relay, the lead does not see inbox messages.

**Teammates** are fully independent Claude Code processes. Each teammate watches its own inbox file through fs.watch and reads messages directly. Relay through the lead is not needed.

### Message Flow: User -> Teammate

```text
User -> [UI] -> TeamInboxWriter -> inboxes/{member}.json (read: false)
                                       |
                             Teammate CLI (fs.watch) -> reads -> handles
                                       |
                             Teammate -> inboxes/user.json (response)
                                       |
                             [UI] <- TeamInboxReader <- reads user.json
```

The lead is not part of this path. The message is delivered directly.

### Message Flow: User -> Lead

```text
User -> [UI] -> stdin (stream-json) -> Lead CLI
                                       |
Lead -> sentMessages.json / liveLeadProcessMessages
                                       |
                             [UI] <- reads and renders
```

For the lead, `relayLeadInboxMessages()` additionally runs when `inboxes/{lead}.json` changes.

### Teammate Responses

A teammate responds to the user through `SendMessage(to="user")`, which writes to `inboxes/user.json`. The UI reads this file through `TeamInboxReader.getMessages()`, which reads all inbox files in the directory.

Messages in `user.json` may not contain `messageId`; `TeamInboxReader` generates a deterministic ID from sha256(from + timestamp + text).

### from: "user" Is Confirmed To Work

`from: "user"` works correctly, confirmed empirically on 2026-03-23:

- Teammate receives the message.
- Teammate correctly identifies that it came from the user.
- Teammate responds in `inboxes/user.json`.
- Fallback to `from: "team-lead"` is not needed.

### Why Relay Through the Lead Was Disabled (2026-03-23)

Previously, when sending a DM to a teammate, the app called `relayMemberInboxMessages()` in addition to writing to the inbox. This instructed the lead to forward the message through `SendMessage(to=member)`. It caused 3 bugs:

1. **Lead replied instead of the teammate** - the LLM interpreted the relay instruction as addressed to itself and answered the user directly.
2. **Duplicate messages** - `markInboxMessagesRead()` wrote to the file, triggering FileWatcher, which re-ran relay and created a loop.
3. **Teammate did not reply to the user** - the relay prompt contained "Do NOT send to user", which the teammate also saw through the lead.

Relay is disabled in `teams.ts` (`handleSendMessage`) and `index.ts` (FileWatcher). The code is commented out, not deleted. Lead relay (`relayLeadInboxMessages`) is unaffected.

---

## Delivery: Timing and Constraints

### Teammate Turn Cycle

```text
Turn N:
  1. Reads inbox -> sees new messages with read: false
  2. Handles messages/tasks
  3. Calls tools
  4. Reasoning
  5. Output
  -> idle_notification -> IDLE

... wait ...

Turn N+1:
  1. Wake-up (new inbox message / assigned task)
  2. Reads inbox -> sees new messages
  ...
```

### Delay

- **Idle agent**: receives the message on the next wake-up, usually a fraction of a second if inbox-change triggers.
- **Active agent (mid-turn)**: receives the message only after the current turn completes, usually 1-30 seconds.

### No Mid-Turn Interrupt

If an agent has already called Edit/Bash, the tool will complete. Our message arrives after that.

**Example**:

```text
17:12:30 - Agent starts Edit on auth.ts
17:12:31 - We send "Do not touch auth.ts"
17:12:32 - Agent completes Edit (auth.ts changed)
17:12:33 - Agent reads inbox and sees our message
-> Too late, the file was already changed
```

### Hard Interrupt (Future)

Possible approaches:

1. **kill -SIGINT** the teammate process: hard interrupt, context loss.
2. **File flag** `.interrupt-{member}`: needs Claude Code support.
3. **Anthropic API**: if it becomes available.

Current decision: the delay is acceptable; hard interrupt is future work.

---

## Final Decision

### messageId Is Required In Every Outgoing Message

Every outgoing message includes `messageId: crypto.randomUUID()`:

```json
{
  "from": "user",
  "text": "Please review task #12",
  "timestamp": "2026-02-17T15:30:00.000Z",
  "read": false,
  "summary": "Review request for task #12",
  "messageId": "550e8400-e29b-41d4-a716-446655440000"
}
```

### Verify Immediately After Write

- After atomic write, read the inbox and look for our `messageId`.
- If missing, message loss was detected -> show a warning in the UI instead of failing silently.
- No automatic retry in MVP.

### 3 States For Offline Members

| State | Condition | Display |
| ----- | --------- | ------- |
| `ACTIVE` | idle < 5 minutes | Green dot |
| `IDLE` | idle > 5 minutes | Yellow dot |
| `TERMINATED` | Received `shutdown_response` with `approve: true` | Gray dot, "Terminated" |

State is determined from the timestamp of the latest event in the inbox (`idle_notification` or any message). `TERMINATED` is based only on an explicit `shutdown_response`.
