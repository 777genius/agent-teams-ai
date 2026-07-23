# Team Message Delivery

Owns desktop IPC orchestration for user-to-team messages, process messages,
OpenCode delivery status, process liveness, and message attachments.

The core keeps delivery routing, ordering, timeout projection, and attachment
policy independent from Electron and concrete team services. Main-process
composition adapts the existing stateful services through narrow capability
ports so extraction does not create duplicate runtime state.
