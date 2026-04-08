# specsmith-vscode — Privacy Policy

**Last updated: April 2026**

## Summary

The specsmith VS Code extension collects no telemetry and sends no data to BitConcepts servers. It acts as a UI layer for the specsmith CLI; all external network activity is either user-initiated or routed through the LLM provider you configure.

---

## What data leaves your machine

### LLM providers (only when you run an agent session)

When you open a session, the extension spawns `specsmith run --json-events`, which sends your messages and project context to the LLM provider you have selected. The extension does not intercept or log this data — it passes through to the CLI unchanged.

See [specsmith PRIVACY.md](https://github.com/BitConcepts/specsmith/blob/main/PRIVACY.md) for the full list of providers and their privacy policies.

### Bug reporter (optional, always requires explicit consent)

The extension includes an optional bug reporter that can file GitHub issues in `BitConcepts/specsmith-vscode`. This feature:

- **Never activates automatically.** You must click a button and confirm a consent dialog.
- Shows you exactly what will be included before submitting (error summary, specsmith version, VS Code version, OS platform, and optionally error detail text which may contain local file paths).
- Uses the `gh` CLI on your machine — data is sent by your `gh` process directly to the GitHub API, not via BitConcepts.
- Falls back to clipboard copy + manual filing if `gh` is not available or not authenticated.

You can decline the consent dialog at any time and nothing will be sent.

### API keys

API keys you store via `specsmith: Set API Key` are saved in VS Code's `SecretStorage` (Windows Credential Manager / macOS Keychain / libsecret on Linux). They are never written to disk in plain text, never logged, and never sent to BitConcepts.

---

## What stays on your machine

- Chat history files (`.specsmith/chat/*.jsonl`) — stored in your project directory
- Session provider/model preferences (VS Code `globalState`) — stored locally in your VS Code profile
- Watched project list — stored in VS Code `globalState`

---

## No telemetry

The specsmith-vscode extension does **not**:

- Send usage analytics, crash reports, or telemetry to BitConcepts
- Track which commands you run, how often you use the extension, or session duration
- Use VS Code's telemetry API
- Make any background network requests (all network activity is triggered by explicit user actions)

---

## Self-update

The extension checks for specsmith CLI updates by querying `pypi.org/pypi/specsmith/json` at startup (once per session). This is the same check as `specsmith update --check`. PyPI may log your IP per their own privacy policy.

---

## Contact

For privacy questions: open an issue at https://github.com/BitConcepts/specsmith-vscode or email privacy@bitconcepts.dev
