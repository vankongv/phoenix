# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| v5.x | Yes |
| < v5 | No |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Email the maintainers privately at: `security@phoenix.dev` (or open a [GitHub private security advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)).

Include:
- A description of the vulnerability and its potential impact
- Steps to reproduce
- Any proof-of-concept code (treated as confidential)

You should receive a response within 72 hours. We'll keep you updated as we work on a fix and coordinate disclosure timing with you.

## Threat model

Phoenix is designed to run **locally or on a private server you control**. It is not hardened for multi-tenant or public-internet deployment without additional controls.

### What Phoenix handles

- **GitHub Personal Access Tokens** — stored in browser `localStorage` and sent as Bearer tokens to the agent backend. Tokens are never logged or persisted server-side.
- **Anthropic / LLM API keys** — read from environment variables on the server; never exposed to the frontend.
- **Git credentials** — the `GITHUB_TOKEN` is embedded in clone URLs during worktree setup and not written to disk outside of the temporary git config for that process.
- **Repository source code** — agent worktrees are created in the system temp directory and cleaned up after each run (or on the next server start).

### Known limitations

- The agent executes arbitrary shell commands inside git worktrees via the OpenHands terminal tool. Do not point Phoenix at a repository with untrusted CI scripts if running without a sandbox.
- CORS is configured permissively (`*`) in development mode. Set `CORS_ORIGINS` to an explicit origin list in any non-local deployment.
- SQLite database at `~/.pnx/pnx.db` is stored unencrypted. It contains run logs and issue movement history but not credentials.
