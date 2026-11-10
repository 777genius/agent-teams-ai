# Project editor tabs

This renderer-only feature stores ordered file paths and the active path per
project. Content and live CodeMirror instances continue to belong to the existing
editor/draft lifecycle. Restored files use the normal read/error UI.

The versioned schema validates absolute, in-project paths, preserves display
spelling, and uses case-insensitive Windows and case-sensitive POSIX identities.
Metadata is bounded to 64 tabs per project, 32 recent projects, and 512 KiB of
serialized metadata. Storage failures fall back to the latest in-memory snapshot.

The store adapter suspends persistence during reset/open and restores after the
current IPC open succeeds. It observes tab changes, including rename/move/delete,
without writing on content edits. Closing all tabs intentionally saves an empty
session; cancelling or failing initialization preserves the previous session.
