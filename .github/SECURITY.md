# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.3.x   | ✅ Current |
| < 0.3.0 | ❌ No longer supported |

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Email **support@bitconcepts.tech** with:

- Description of the vulnerability
- Steps to reproduce
- Potential impact and affected surface
- Suggested fix (if any)

We will acknowledge receipt within **48 hours** and aim to provide a fix or mitigation within **7 days** for critical issues.

You may also use [GitHub's private security advisory](https://github.com/BitConcepts/specsmith-vscode/security/advisories/new) workflow.

## Scope

This policy covers:

- The VS Code extension TypeScript source
- API key handling via `ApiKeyManager.ts` / VS Code `SecretStorage`
- Integration with the specsmith CLI subprocess
- Any credential or token transmission

## Out of Scope

- The specsmith Python CLI itself — report those at [BitConcepts/specsmith](https://github.com/BitConcepts/specsmith/security)
- The VS Code platform itself — report at [microsoft/vscode](https://github.com/microsoft/vscode/security)
- LLM provider APIs (Anthropic, OpenAI, etc.)

## Security Practices

- **API keys** are stored in VS Code `SecretStorage` (Windows Credential Manager / macOS Keychain). Keys are never written to `settings.json`, plain text files, or committed to version control.
- **Dependabot** monitors npm dependencies for known CVEs weekly.
- **Content Security Policy** in WebviewPanels restricts script and style sources.
- **No direct network calls** from the extension — all LLM and provider requests go through the specsmith CLI subprocess, which runs with user-level permissions.
- **Process isolation** — each agent session is a separate `specsmith run --json-events` process with a 5-minute timeout per turn.
