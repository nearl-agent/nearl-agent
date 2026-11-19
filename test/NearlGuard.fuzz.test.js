// Randomised (fuzz) test of NearlGuard. Thousands of random actions by the owner, the agent and an
// outsider, with random time jumps, are run against a real Guard. After every single action the test
// checks that the Guard behaved exactly as its rules say, using an independent model:
//   - the agent can only spend while not paused, on tokens with a limit, to approved recipients or
//     approved contracts, within the per-payment cap and the daily cap of the current UTC day;
//   - nobody but the owner can change rules or withdraw, and withdrawals only ever go to the owner;
//   - the Guard's balance always equals what the model expects (no tokens leak anywhere else);
//   - an approved contract never keeps an allowance after an agent call.
// Deterministic seed, so any failure can be replayed. FUZZ_RUNS=200 npx hardhat test runs it longer.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const RUNS = Number(process.env.FUZZ_RUNS || 40);
const STEPS = 60;
const DAY = 86400n;

// small deterministic PRNG (mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("NearlGuard fuzz (randomised invariants)", function () {
  this.timeout(0);

  it(`keeps every rule across ${RUNS} random runs of ${STEPS} actions`, async function () {
    const [owner, agent, shop, other, stranger] = await ethers.getSigners();
    let checked = 0, allowedSpends = 0, refused = 0;

    for (let run = 0; run < RUNS; run++) {
      const r = rng(1000 + run);
      const pick = (arr) => arr[Math.floor(r() * arr.length)];
      const amt = (max) => BigInt(Math.floor(r() * Number(max)));

      const usd = await ethers.deployContract("MockUSD");
      const extra = await ethers.deployContract("MockUSD"); // a token that never gets a limit
      const factory = await ethers.deployContract("NearlGuardFactory");
      await factory.connect(owner).createGuard(agent.address);
      const g = await ethers.getContractAt("NearlGuard", (await factory.guardsOf(owner.address)).at(-1));
      const ga = await g.getAddress(), U = await usd.getAddress(), X = await extra.getAddress();
      const router = await ethers.deployContract("MockTarget");
      const R = await router.getAddress();
      const start = 10_000n * 10n ** 6n;
      await usd.transfer(ga, start);
      await extra.transfer(ga, start);

      // the model
      const m = { paused: false, daily: 0n, perTx: 0n, recip: new Map(), target: new Map(), spent: new Map(), bal: start };
      let now = BigInt(await time.latest());

      for (let step = 0; step < STEPS; step++) {
        now += BigInt(1 + Math.floor(r() * (r() < 0.15 ? 40 * 3600 : 600))); // sometimes jump past a day
        await time.setNextBlockTimestamp(now);
        const day = now / DAY;
        const spent = m.spent.get(day) || 0n;
        const kind = pick(["limit", "recipient", "target", "pause", "withdraw", "pay", "pay", "pay", "exec", "exec", "stranger", "agentAdmin", "other"]);
        let tx, expectOk, effect = () => {};

        if (kind === "limit") {
          const daily = amt(3000n * 10n ** 6n), perTx = amt(1500n * 10n ** 6n);
          tx = g.connect(owner).setLimit(U, daily, perTx); expectOk = true;
          effect = () => { m.daily = daily; m.perTx = perTx > daily ? daily : perTx; }; // the contract caps per-payment at the daily limit
        } else if (kind === "recipient") {
          const who = pick([shop.address, other.address]), on = r() < 0.6;
          tx = g.connect(owner).setRecipient(who, on); expectOk = true;
          effect = () => m.recip.set(who, on);
        } else if (kind === "target") {
          const on = r() < 0.6;
          tx = g.connect(owner).setTarget(R, on); expectOk = true;
          effect = () => m.target.set(R, on);
        } else if (kind === "pause") {
          const p = r() < 0.3;
          tx = g.connect(owner).setPaused(p); expectOk = true;
          effect = () => { m.paused = p; };
        } else if (kind === "withdraw") {
          const a = amt(m.bal / 3n + 1n);
          const before = await usd.balanceOf(owner.address);
          tx = g.connect(owner).withdraw(U, a); expectOk = true;
          effect = async () => { m.bal -= a; expect(await usd.balanceOf(owner.address)).to.equal(before + a); };
        } else if (kind === "pay") {
          const to = pick([shop.address, other.address, stranger.address]);
          const a = 1n + amt(1200n * 10n ** 6n);
          expectOk = !m.paused && m.daily > 0n && m.recip.get(to) === true && a <= m.perTx && spent + a <= m.daily && a <= m.bal;
          const before = await usd.balanceOf(to);
          tx = g.connect(agent).pay(U, to, a);
          effect = async () => { m.bal -= a; m.spent.set(day, spent + a); expect(await usd.balanceOf(to)).to.equal(before + a); };
        } else if (kind === "exec") {
          const maxSpend = 1n + amt(1200n * 10n ** 6n);
          const pull = r() < 0.2 ? maxSpend + 1n + amt(100n * 10n ** 6n) : amt(maxSpend + 1n); // sometimes tries to take more than allowed
          const data = router.interface.encodeFunctionData("swap", [U, pull, U, 0]);
          expectOk = !m.paused && m.target.get(R) === true && m.daily > 0n && maxSpend <= m.perTx && pull <= maxSpend && pull <= m.bal && spent + pull <= m.daily;
          tx = g.connect(agent).execute(R, data, U, maxSpend); m.lastExec = { maxSpend: String(maxSpend), pull: String(pull) };
          effect = () => { m.bal -= pull; m.spent.set(day, spent + pull); };
        } else if (kind === "stranger") {
          tx = pick([() => g.connect(stranger).withdraw(U, 1), () => g.connect(stranger).setLimit(U, 10n ** 12n, 10n ** 12n), () => g.connect(stranger).pay(U, stranger.address, 1), () => g.connect(stranger).setAgent(stranger.address)])();
          expectOk = false;
        } else if (kind === "agentAdmin") {
          tx = pick([() => g.connect(agent).withdraw(U, 1), () => g.connect(agent).setLimit(U, 10n ** 12n, 10n ** 12n), () => g.connect(agent).setRecipient(agent.address, true), () => g.connect(agent).setPaused(false)])();
          expectOk = false;
        } else {
          // a token with no limit set can never be spent
          tx = g.connect(agent).pay(X, shop.address, 1); expectOk = false;
        }

        let ok = true, why = "";
        try { await (await tx).wait(); } catch (e) { ok = false; why = (e.shortMessage || e.message || "").slice(0, 160); }
        if (ok !== expectOk) {
          throw new Error(`run ${run} step ${step}: ${kind} ${ok ? "went through" : "was refused"} but the rules say it should ${expectOk ? "go through" : "be refused"} [${why}] (model ${JSON.stringify({ paused: m.paused, daily: String(m.daily), perTx: String(m.perTx), spent: String(spent), bal: String(m.bal), lastExec: m.lastExec })})`);
        }
        if (ok) { await effect(); if (kind === "pay" || kind === "exec") allowedSpends++; } else refused++;

        // invariants after every action
        expect(await usd.balanceOf(ga)).to.equal(m.bal);
        expect(await extra.balanceOf(ga)).to.equal(start);
        expect(await usd.allowance(ga, R)).to.equal(0n);
        expect(await g.spentToday(U)).to.equal(m.spent.get(day) || 0n);
        checked++;
      }
    }
    console.log(`      ${checked} random actions checked (${allowedSpends} allowed spends, ${refused} refused), 0 rule violations`);
  });
});
