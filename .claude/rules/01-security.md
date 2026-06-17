# Security (PARAMOUNT)

Treat every violation as a blocking issue.

## Secrets

- Use environment variables or secret managers for all secrets.
- Before every commit, verify no secrets are staged.
- Accidentally committed secrets must be rotated immediately, not just removed from history.
- Keep `.env` and credential files in `.gitignore`.

## Input Validation & Output Encoding

- Validate ALL external input. Reject invalid input — never attempt to fix it.
- Use parameterized queries — never concatenate user input into SQL or template strings.
- Avoid shell invocation; use language-native APIs. If unavoidable, escape rigorously.
- Encode output contextually (HTML, URL, JSON). XSS prevention = output encoding, not input sanitization.
- Apply least privilege — minimum permissions, minimum scopes.

## Access Control

- Deny by default — explicit authorization on every request, not just authentication.
- Validate resource ownership on every access (IDOR prevention).

## Authentication

- Rate-limit login endpoints. Support MFA. Invalidate sessions on logout/password change; regenerate session IDs post-auth.

## Cryptography

- No MD5/SHA-1. Use SHA-256+ for hashing, Argon2/bcrypt/scrypt for passwords.

## Secure Defaults

- HTTPS, encrypted storage, httpOnly cookies, strict CORS.
- Check dependencies for CVEs before adding. Run audit tools after dependency changes.

When in doubt, choose more security. Flag concerns explicitly.
