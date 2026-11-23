# NEARL

**The safety layer for onchain agents on Robinhood Chain.**

Before an AI agent or a trader buys a token or sends money, NEARL checks the token and limits what can be spent.

Website: <https://nearlagent.com> · X: [@nearlagent](https://x.com/nearlagent) · Telegram: [t.me/nearlagent](https://t.me/nearlagent)

## Products

| Product | What it does | Status |
|---|---|---|
| **Check** | A 0–100 safety score for any token: simulated buy, sell and transfer, owner powers, upgradeable code, holders, first-block bundles and snipers, the creator's other launches, and official vs. copycat Robinhood stock tokens | Live on mainnet |
| **Swap** | Swaps routed to Uniswap, with a NEARL check before every buy. No NEARL fee, no limit per swap | Live on mainnet |
| **Guard** | Agent wallets with daily and per-transaction limits, an allowlist of destinations, pause, and withdrawals only to the owner | Live on mainnet and testnet |
| **Earn** | "Stay Above" reward pools that pay out at each check while the ETH price stays above a safety line | Mainnet (small, capped pools) and testnet |
| **API & MCP** | `GET /api/check` and an MCP server at `POST /mcp` (tool `nearl_check_token`) for agents | Live |

NEARL offers **no credit or lending**. The contracts are **not audited**, so mainnet deposit limits are kept small. Nothing here is investment advice.

## Network

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | 4663 | 46630 |
| RPC | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | <https://robinhoodchain.blockscout.com> | <https://explorer.testnet.chain.robinhood.com> |

Contract addresses are listed below, in [`web/deployments/`](web/deployments), and on the website's [Contracts page](https://nearlagent.com/contracts.html). Mainnet contracts are verified on Sourcify and Blockscout; the inputs used are in [`verify/`](verify).

## Swap

[nearlagent.com/swap](https://nearlagent.com/swap) buys and sells any Robinhood Chain token with ETH or USDG. NEARL only routes the order: Uniswap's public contracts fill the trade, and the liquidity is Uniswap's.

- **Check before every buy.** If the test sell fails (a possible honeypot), the buy is blocked. A score below 55 needs an extra confirmation.
- **Best route** across Uniswap v3 and v4 pools, including Pons launch pools.
- **You sign** every approval and swap in your own wallet. NEARL never holds funds.
- **No NEARL fee and no limit per swap.** Slippage protection (0.5%, 1% or 3%) cancels the trade if the result would be below "min received".

Source: [`web/swap.html`](web/swap.html) and [`web/swap.js`](web/swap.js).

## API & MCP for agents

Both run as Netlify Functions from this repository. Free to use, limited to 20 requests per minute per IP, results cached for 2 minutes.

| | Endpoint | Source |
|---|---|---|
| HTTP API | `GET https://nearlagent.com/api/check?token=0x...&net=mainnet` | [`netlify/functions/check.js`](netlify/functions/check.js) |
| MCP server | `POST https://nearlagent.com/mcp`, tool `nearl_check_token` with `{ "token": "0x...", "network": "mainnet" }` | [`netlify/functions/mcp.js`](netlify/functions/mcp.js) |
| Check engine (shared by both) | runs the same checks as the website | [`netlify/functions/lib/engine.js`](netlify/functions/lib/engine.js), [`web/check.js`](web/check.js) |
| Rate limit and cache | | [`netlify/functions/lib/limits.js`](netlify/functions/lib/limits.js) |
| Check counter for the Stats page | `GET https://nearlagent.com/api/count` (totals only: no token, IP or wallet stored) | [`netlify/functions/count.js`](netlify/functions/count.js) |
| Share links and card images | `/s` and `/og` | [`netlify/functions/share.js`](netlify/functions/share.js), [`netlify/functions/og.js`](netlify/functions/og.js) |

Try it:

```bash
curl "https://nearlagent.com/api/check?token=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168&net=mainnet"
```

The response includes `score` (0–100), `verdict`, `safeToBuy`, `buyTaxPct`, `sellTaxPct`, `liquidityUsd`, `upgradeable`, `owner` and `findings`. A ready-made agent skill is in [`web/skill.md`](web/skill.md).

## Deployed contracts

The source of every deployed contract is in [`contracts/`](contracts). Addresses are also kept in [`web/deployments/`](web/deployments).

### Mainnet (chain 4663)

| Contract | Source | Address |
|---|---|---|
| NearlNotes (Earn pools) | [`contracts/NearlNotes.sol`](contracts/NearlNotes.sol) | [`0xBC4433dcf2C04c6a5f2ebF435519682636261996`](https://robinhoodchain.blockscout.com/address/0xBC4433dcf2C04c6a5f2ebF435519682636261996) |
| NearlGuardFactory (Guard wallets) | [`contracts/guard/NearlGuardFactory.sol`](contracts/guard/NearlGuardFactory.sol) | [`0x0205E79CBc7680B4231C8330296e965bC9630dd1`](https://robinhoodchain.blockscout.com/address/0x0205E79CBc7680B4231C8330296e965bC9630dd1) |
| NearlGuard (one per agent, made by the factory) | [`contracts/guard/NearlGuard.sol`](contracts/guard/NearlGuard.sol) | created per user |

External contracts NEARL uses on mainnet (not written by NEARL): USDG [`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`](https://robinhoodchain.blockscout.com/address/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168) and the ETH / USD price feed [`0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`](https://robinhoodchain.blockscout.com/address/0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9).

### Testnet (chain 46630)

| Contract | Source | Address |
|---|---|---|
| NearlNotes | [`contracts/NearlNotes.sol`](contracts/NearlNotes.sol) | [`0x99c972591a4Fb694dCe6aea07e597d0d16773AbE`](https://explorer.testnet.chain.robinhood.com/address/0x99c972591a4Fb694dCe6aea07e597d0d16773AbE) |
| NearlGuardFactory | [`contracts/guard/NearlGuardFactory.sol`](contracts/guard/NearlGuardFactory.sol) | [`0xEBc3FAbd5C044b0Cae5D34dB1dc9A2cBA2f668E6`](https://explorer.testnet.chain.robinhood.com/address/0xEBc3FAbd5C044b0Cae5D34dB1dc9A2cBA2f668E6) |
| MockUSD (tUSD, test token with faucet) | [`contracts/test/MockUSD.sol`](contracts/test/MockUSD.sol) | [`0xBC4433dcf2C04c6a5f2ebF435519682636261996`](https://explorer.testnet.chain.robinhood.com/address/0xBC4433dcf2C04c6a5f2ebF435519682636261996) |
| MockPriceFeed (test ETH / USD) | [`contracts/test/MockPriceFeed.sol`](contracts/test/MockPriceFeed.sol) | [`0x45879E7a84de8b4C00e4222c4abb6a7F489564BF`](https://explorer.testnet.chain.robinhood.com/address/0x45879E7a84de8b4C00e4222c4abb6a7F489564BF) |

The probe contracts in [`contracts/tools/`](contracts/tools) are never deployed. NEARL Check loads them into a simulated call (`eth_call` with state overrides) to test a buy, sell and transfer without spending anything.

## Repository

| Folder | Contents |
|---|---|
| `contracts/` | Solidity contracts: Guard wallets and factory, Earn notes, and the probe used to simulate trades |
| `test/` | Hardhat tests, including fuzz tests for Guard |
| `web/` | The website (static HTML, CSS and JavaScript). Check runs in the browser against the public RPC |
| `netlify/functions/` | The Check API, the MCP server, and share-card images |
| `scripts/` | Build helpers: the trade probe, the official stock-token list, and contract verification |

Deployment and keeper scripts are kept private because they handle wallet keys.

## Run it

```bash
npm install
npm test        # compile and run the contract tests
npm run web     # serve the website locally
```

## Security

Found a problem? Please do not open a public issue for anything that could put funds at risk. Contact NEARL on X or Telegram ([t.me/nearlagent](https://t.me/nearlagent)) first.

## License

MIT, see [LICENSE](LICENSE).
