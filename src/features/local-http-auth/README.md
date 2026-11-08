# Local HTTP authentication

The API ingress checks the listener authority, exact configured browser origins and bearer header before handlers and SSE. Static renderer assets contain no credential. Desktop settings supply the generated access key through trusted IPC; the browser gate verifies it before mounting data effects.

Private authority descriptors bind a profile, app instance, generation, endpoint and key. Token-free references switch under a cross-process publication lock. Cleanup removes only the matching instance and generation. POSIX ownership/modes and Windows effective ACL checks protect these files.

Profile changes pause admission and drain old handlers and streams. The initiating HTTP response can finish before the listener resumes with fresh services and credentials. Browser sessions expire on 401 and the fetch stream stops retrying until the user enters a new key.
