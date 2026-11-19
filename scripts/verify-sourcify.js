// Verifies NEARL contracts on Sourcify (supports Robinhood Chain 4663 and testnet 46630).
// Sourcify reads the chain itself, so this works even when the local network cannot reach the RPC.
// Blockscout explorers pick up Sourcify-verified sources.
// Usage: node scripts/verify-sourcify.js <chainId> <address> <standard-input.json> <path.sol:ContractName>
const fs = require("fs");

const [chainId, address, inputFile, contractIdentifier] = process.argv.slice(2);
if (!contractIdentifier) {
  console.error("Usage: node scripts/verify-sourcify.js <chainId> <address> <standard-input.json> <path.sol:ContractName>");
  process.exit(1);
}
const API = "https://sourcify.dev/server";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const check = await fetch(`${API}/v2/contract/${chainId}/${address}`).then((r) => r.json()).catch(() => null);
  if (check && check.match) return console.log(`Already verified on Sourcify (${check.match}).`);

  const body = {
    stdJsonInput: JSON.parse(fs.readFileSync(inputFile, "utf8")),
    compilerVersion: "0.8.24+commit.e11b9ed9",
    contractIdentifier,
  };
  const res = await fetch(`${API}/v2/verify/${chainId}/${address}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const job = await res.json();
  if (!res.ok) return console.error("Submit failed:", res.status, JSON.stringify(job).slice(0, 400));
  console.log("Submitted, job", job.verificationId);

  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const s = await fetch(`${API}/v2/verify/${job.verificationId}`).then((r) => r.json());
    if (s.isJobCompleted) {
      if (s.error) return console.error("Verification failed:", JSON.stringify(s.error).slice(0, 400));
      return console.log(`Verified: ${s.contract && s.contract.match} match. https://repo.sourcify.dev/${chainId}/${address}`);
    }
  }
  console.log("Still running; check later at", `${API}/v2/contract/${chainId}/${address}`);
})().catch((e) => console.error(e.message));
