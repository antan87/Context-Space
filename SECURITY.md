# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.5.x   | :white_check_mark: |
| 2.4.x   | :x:                |
| < 2.4   | :x:                |

## Reporting a Vulnerability

The ContextSpace team takes the security of our application and its users seriously. If you believe you have found a security vulnerability in ContextSpace, please report it to us responsibly.

### How to Report

Please **do not** report security vulnerabilities through public GitHub issues.

Instead, please report security issues through one of the following methods:
1. **GitHub Security Advisory:** Submit a private vulnerability report via the [ContextSpace Security Advisories](https://github.com/antan87/Context-Space/security/advisories/new) page.
2. **Email:** Send details to the project maintainers at `patronant@gmail.com` with the subject line `[SECURITY] ContextSpace Vulnerability Report`.

Please include:
- A description of the issue and its potential impact.
- Step-by-step instructions or proof-of-concept code to reproduce the issue.
- Any suggested remediations or patches if available.

### Response Timeline

- **Initial Response:** Within 48 hours of receiving the report.
- **Status Updates:** Regular updates during investigation and fix development.
- **Public Disclosure:** Coordinated disclosure after a fix has been released across all supported channels (npm, GitHub releases, VS Code extension).

## Security Architecture & Threat Model

ContextSpace implements multiple layers of defense-in-depth:
- **Localhost Containment:** Background HTTP/WebSocket daemon explicitly binds to `127.0.0.1` and enforces strict `Host` header and `Origin` validation to protect against DNS-rebinding attacks.
- **Workroom Isolation:** Optional Workrooms run on a separate HTTPS listener bound to one user-selected LAN/VPN address. One-use invitations, password hashing, certificate fingerprint pinning, host approval, revocable hashed human/agent credentials, bounded admission, role authorization, rate limiting, and no-store responses protect the remote surface; remote browser origins are rejected. Persisted human host authority is password-encrypted, guest human credentials stay in memory, and localhost Workroom reads and mutations require an exact-dashboard bootstrap; active-room data and ordinary mutations additionally require a generation-bound HttpOnly human session. Losing that session requires the room password for host recovery, while a guest must leave and rejoin. The host agent token is deliberately stored in plaintext inside the mode-`0600` host credential file: it is a reusable remote credential, but its server permissions are limited to read-and-propose operations. Collaborator-authored MCP context is labeled untrusted and is exposed only on read-only/review tool surfaces.
- **Resource Supply Chain:** Shared skill, agent, and workflow versions are immutable and SHA-256 verified. Package paths, sizes, Windows portability, collisions, exact definition-to-file mapping, declared platform/version compatibility, and aggregate catalog limits are validated before quarantine caching and compatibility is rechecked at apply. Installation shows the exact applied definition and every file, then requires approval bound to both the incoming package digest and the reviewed local resource revision. Catalog writes recheck that revision under the shared write lock after staging the complete replacement and immediately before the atomic swap. Hosts may release exhausted quota only through an audited quarantine-then-purge flow; this cannot revoke review-cache copies already downloaded onto another developer's computer.
- **Path Isolation & Containment:** Workspace creation, repository additions, and WebSocket session paths are strictly contained within authorized workspace directories.
- **Release Verification:** Update installers are cryptographically verified against SHA-256 hashes before execution.
- **Subprocess Isolation:** AI agent sessions and PM2 services run under strict, dedicated process namespaces with isolated working directories.

The Workroom browser boundary prevents unrelated loopback ports, cross-origin web pages, and DNS-rebinding requests from reading Workroom data or acquiring human authority. It does not defend against malicious code already running as the same operating-system user, which can access that user's loopback services and local NexusFlow files; endpoint protection and OS account isolation remain required for that threat.
