# Temporary node-forge 1.4.0 security patch

GHSA-86w9-cpqp-85rv describes RSA PKCS#1 v1.5 signature forgery caused by extra
children in the nested DigestAlgorithm sequence. npm has no patched stable
release as of 2026-10-02. Keep 1.4.0 and apply the bounded validation fix from
[digitalbazaar/forge#1152](https://github.com/digitalbazaar/forge/pull/1152),
reviewed at `ceba34402e329f0365134f23fe19898756527d65`.

The workspace installs it through pnpm patchedDependencies. The standalone
landing npm installation applies the same fix in postinstall. Both CI audits
use the shared audit wrapper. It verifies the installed patch before allowing
only GHSA-86w9-cpqp-85rv, including npm's dependent vulnerability entries.
Other high/critical advisories and audit infrastructure failures still block CI.
A missing or modified package fails closed. Verification binds the exception to
the Node `lib/index.js` entry and patched `lib/rsa.js`. The affected dependency
graph uses that entry; bundled browser files are not patched or used here.

Regression checks must reject the malformed signature accepted by unpatched
1.4.0 and preserve verification of a legitimate signature. Audit tests also
cover a different high advisory and malformed/error reports.

When a compatible stable upstream security release becomes available, upgrade
both dependency graphs, remove the local patch and advisory-specific audit
handling, and rerun the regression checks and both audits. Never remove the
patch while retaining the exception.

Related upstream report: [digitalbazaar/forge#1149](https://github.com/digitalbazaar/forge/issues/1149).
