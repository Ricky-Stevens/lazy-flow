# Security policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Email `security@lazy-flow.dev` (or the maintainer address in `package.json`) with:

- A description of the vulnerability and its potential impact.
- Steps to reproduce (proof-of-concept or a minimal test case).
- The version / commit hash affected.

You will receive an acknowledgement within 48 hours and a full response (including
timeline for a fix) within 5 business days. We follow coordinated disclosure: please
allow us a reasonable window to patch before publishing.

---

## Security posture

### Secrets — storage and handling

- **Never committed.** API tokens, OAuth credentials, and personal access tokens are
  stored in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret
  Service / `pass`) and surfaced to the MCP server as environment variables at runtime.
  They are never written to the SQLite database, logs, or any file in the repository.
- **Env-only at runtime.** The MCP server reads secrets exclusively from `process.env`
  (injected by the Claude Code plugin manifest via `.mcp.json`). The config schema
  marks these fields `secret: true`; the plugin host redacts them from logs.
- **Least-privilege OAuth scopes.** The GitHub App and Jira OAuth 3LO integrations
  request read-only scopes only. The scope set is recorded as a `coverageFingerprint`
  so cross-install comparisons can refuse to plot when credential coverage differs.

### Ingest-time scrubbing (WP-SCRUB)

Before any payload is persisted to the database, the ingest pipeline runs a field
allowlist + entropy / regex secret detector over free-text fields (`review_comments.raw`,
`issues.raw`, etc.). Patterns matched: high-entropy tokens, common secret formats
(GitHub PATs, AWS keys, JWT headers, PEM blocks), and bare email addresses in bodies
where retention is not required.

Scrubbing runs **before** persistence — secrets never reach disk even transiently.

### Pseudonymisation (keyed HMAC)

Where pseudonymisation is configured (e.g. for GDPR-aware deployments), contributor
identities are replaced with a keyed HMAC — `HMAC-SHA256(org_secret, canonical_id)`.

A plain reversible hash (e.g. `SHA256(email)`) is **not** a privacy control: it is
trivially reversible for known email addresses. The HMAC key is org-scoped and stored
in the keychain, not the database.

### Database — at-rest encryption status

**Honest statement:** `node:sqlite` (the Node.js built-in SQLite driver used by
`NodeSqliteStore`) does not include SQLCipher and therefore does not provide
transparent at-rest encryption of the database file itself.

Mitigations in place:
- The database is stored under `${CLAUDE_PLUGIN_DATA}`, a per-user application-data
  directory. File permissions are set to `0600` (owner read/write only) at
  database-open time.
- **OS-level full-disk encryption** (FileVault, BitLocker, LUKS) is the recommended
  protection for the data directory. This is documented in the install guide.
- Org-bound DB: the store hard-errors if a `LAZY_FLOW_ORG_ID` mismatch is detected,
  preventing accidental cross-org data access.
- For deployments that require transparent database encryption, the `Store` interface
  is designed to be swapped for a SQLCipher-backed implementation without changing any
  higher-level code (the interface is the only seam).

### SQL injection

All SQL in `NodeSqliteStore` uses **parameterised statements only**. Dynamic table
names (used in a handful of rollup queries) are validated against an allowlist of
known table names before interpolation. There is no string interpolation of
user-supplied values into SQL.

### Dependency supply chain

Dependencies are pinned to exact versions in `package-lock.json` (npm lockfile).
Third-party licenses are audited as part of the `WP-RELEASE` process; tree-sitter
grammars (MIT) are the main third-party asset bundled into `server.js`.

Run `npm audit` to check for known vulnerabilities in the dependency tree.

---

## What is and is not a security boundary

**Visibility is a presentation switch, not a security control.** All lazy-flow metrics
derive from data already accessible to any authenticated member of the GitHub
organisation or Jira site via the public APIs. The `visibility` setting (`public` /
`team` / `self`) controls what the MCP tools *surface* in-session — it does not prevent
a determined user from computing the same numbers themselves via the APIs.

If your organisation requires stronger access controls (e.g. hiding per-person metrics
from all but the individual), this should be enforced at the infrastructure layer
(separate credentials scoped to each person's data), not relied upon as a product
feature of lazy-flow.

---

## Known limitations and caveats

| Area | Limitation |
|---|---|
| At-rest DB encryption | `node:sqlite` lacks SQLCipher; mitigated by OS full-disk + `0600` perms |
| Audit log tamper-evidence | `ai_verdicts` are append-only by convention, not cryptographically signed |
| LLM outputs | Hybrid / probabilistic metrics are advisory; never use as the sole basis for personnel decisions |
| Identity stitching | Auto-merge only on verified full-email matches; fuzzy matches require human confirmation |
