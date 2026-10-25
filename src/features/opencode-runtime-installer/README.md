# OpenCode managed installation

This process-limited slice owns generation selection and the native npm package
boundary. The legacy installer coordinates download, atomic activation, status and
resolver invalidation through the public main entrypoint. V2 versions come only
from the pinned runtime qualification contract; native metadata stays beside bin/.
The existing IPC/preload/store transports accept an optional generation choice.
Focused tests cover package identity, archive safety and managed activation.
