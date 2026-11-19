# NEARL

**The safety layer for onchain agents on Robinhood Chain.**

Before an AI agent or a trader buys a token or sends money, NEARL checks the token and limits what can be spent.

Website: <https://funny-kataifi-fe49db.netlify.app> · X: [@nearlagent](https://x.com/nearlagent)

## Products

| Product | What it does | Status |
|---|---|---|
| **Check** | A 0–100 safety score for any token: simulated buy, sell and transfer, owner powers, upgradeable code, holders, first-block bundles and snipers, the creator's other launches, and official vs. copycat Robinhood stock tokens | Live on mainnet |
| **Swap** | Swaps routed to Uniswap, with a NEARL check before every buy | Live on mainnet |
| **Guard** | Agent wallets with daily and per-transaction limits, an allowlist of destinations, pause, and withdrawals only to the owner | Live on mainnet and testnet |
| **Earn** | "Stay Above" reward pools that pay out at each check while the ETH price stays above a safety line | Mainnet (one small pool) and testnet |
| **API & MCP** | `GET /api/check` and an MCP server at `POST /mcp` (tool `nearl_check_token`) for agents | Live |

NEARL offers **no credit or lending**. The contracts are **not audited**, so mainnet deposit limits are kept small. Nothing here is investment advice.

## Network

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | 4663 | 46630 |
| RPC | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | <https://robinhoodchain.blockscout.com> | <https://explorer.testnet.chain.robinhood.com> |

Contract addresses are in [`web/deployments/`](web/deployments) and on the website's Contracts page. Mainnet contracts are verified on Sourcify and Blockscout; the inputs used are in [`verify/`](verify).

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

Found a problem? Please do not open a public issue for anything that could put funds at risk. Contact NEARL on X first.

## License

MIT, see [LICENSE](LICENSE).
