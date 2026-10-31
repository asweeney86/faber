# Security

Faber stores the text of confidential work documents on your machine. The threat model and defences are summarised in the README's *Privacy and security* section; the enforcement lives in:

- `packages/daemon/src/security.ts`: Host and Origin checks (cross-site and DNS rebinding), refusal of unidentifiable extension requests, and the `x-faber-method` read override
- `packages/core/src/extensions.ts`: extension pairing
- `packages/core/src/providers/index.ts`: the `privacy.allow_remote` guard

Please report vulnerabilities privately via GitHub's "Report a vulnerability" button (Security tab) rather than a public issue. If that button isn't available, open an issue asking for a private contact, without details. Include steps to reproduce. We aim to respond within a week.
