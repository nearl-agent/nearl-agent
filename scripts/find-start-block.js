// Finds the block where NearlNotes was deployed and saves it as `startBlock` in the
// deployment file. The website reads events from that block onward (for Season points).
// Public RPCs keep no old state, so this scans backwards for the OwnershipTransferred
// event that the constructor emits.
const { ethers } = require("hardhat");
const { readDeployment, writeDeployment } = require("./lib");

const CHUNK = 50_000;

async function main() {
  const dep = readDeployment();
  const p = ethers.provider;
  const topic0 = ethers.id("OwnershipTransferred(address,address)");
  const fromZero = ethers.zeroPadValue(ethers.ZeroAddress, 32);
  let to = await p.getBlockNumber();

  for (let i = 0; i < 2000 && to >= 0; i++) {
    const from = Math.max(0, to - CHUNK + 1);
    const logs = await p.getLogs({ address: dep.notes, fromBlock: from, toBlock: to, topics: [topic0, fromZero] });
    if (logs.length) {
      dep.startBlock = logs[0].blockNumber;
      writeDeployment(dep);
      console.log(`NearlNotes deployed at block ${dep.startBlock}`);
      return;
    }
    to = from - 1;
  }
  throw new Error("Deployment event not found.");
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
