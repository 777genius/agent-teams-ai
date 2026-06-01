# Backend Workers

Backend services should keep queues and HTTP framework choices outside the
runtime package. The runtime provides worker pools and provider execution; host
apps decide whether to use BullMQ, Nest queues, direct calls, or another queue.

Recommended first deployment shape:

- one persistent volume for `/var/lib/subscription-runtime`;
- one encrypted file key in env;
- one Redis-backed queue;
- N Codex worker slots with prewarm enabled;
- async job API plus optional sync wait endpoint.
