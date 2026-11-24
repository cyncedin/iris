# Security

Iris handles mail, calendar data and API keys, so security reports are very welcome.

Please do **not** open a public issue for a vulnerability. Use GitHub's private reporting instead: Security tab → "Report a vulnerability".

In scope: the local daemon (HTTP on 127.0.0.1 with a token), the MCP server, token and key storage in the macOS Keychain, HTML mail rendering (sandboxing, remote content, trackers) and the agent send guard.

Out of scope: an attacker who already has shell access as your macOS user.
