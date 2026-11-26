# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue:

1. Go to the **Security** tab of this repository.
2. Choose **Report a vulnerability** (GitHub private vulnerability reporting).
3. Describe the problem and, if you can, attach a test that shows it.

Only the NEARL team and you can see the report. We reply there, agree on a fix, and publish an advisory together with you once the fix is live.

If you cannot use GitHub, contact NEARL on X ([@nearlagent](https://x.com/nearlagent)) or Telegram ([t.me/nearlagent](https://t.me/nearlagent)) and ask for a private channel. NEARL admins never message you first.

## Scope

- Smart contracts in `contracts/`: NearlGuard, NearlGuardFactory and NearlNotes (Earn), and their deployed copies listed on [nearlagent.com/contracts](https://nearlagent.com/contracts).
- The website, the HTTP API (`/api/check`) and the MCP server (`/mcp`).

## Status

The contracts have not been audited by an outside firm. An independent security review is in progress. Mainnet amounts stay small and capped until its findings are fixed.
