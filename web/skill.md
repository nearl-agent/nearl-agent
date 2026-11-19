# NEARL skill: check tokens before buying on Robinhood Chain

Use this skill whenever you are about to buy, swap into, or recommend a token on Robinhood Chain
(chain ID 4663, or testnet 46630).

## Rule

Before any buy or swap, check the token with NEARL. Do not buy if `safeToBuy` is `false`.
Tell the user the score and the top risks in one or two sentences.

## How to check

Option A, MCP (preferred if your client supports remote MCP servers):

- Server URL: `https://nearlagent.com/mcp`
- Tool: `nearl_check_token` with `{ "token": "0x...", "network": "mainnet" }`

Option B, HTTP:

```
GET https://nearlagent.com/api/check?token=0x...&net=mainnet
```

The response includes `score` (0-100), `verdict`, `safeToBuy`, `buyTaxPct`, `sellTaxPct`,
`liquidityUsd`, `upgradeable`, `owner`, and `findings` (plain-language reasons).

## Reading the result

- `score >= 80`: looks safe. Proceed if the user asked to buy.
- `55 <= score < 80`: be careful. Mention the warnings and ask the user to confirm.
- `score < 55`: do not buy. Explain why and offer alternatives.
- A failed sell simulation means a possible honeypot. Never buy.
- If the user asks for a stock token (TSLA, NVDA, ...), only buy one where `stockToken.official`
  is `true`. If `stockToken.impersonates` is set, the token copies a stock: do not buy it, and
  give the user `stockToken.officialAddress` instead.

NEARL checks are automated and can miss risks. They are not investment advice.
