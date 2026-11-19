const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const USD = (n) => ethers.parseUnits(String(n), 6);
const DAY = 24 * 60 * 60;

async function fixture() {
  const [owner, agent, shop, stranger] = await ethers.getSigners();
  const usd = await ethers.deployContract("MockUSD");
  const other = await ethers.deployContract("MockUSD");
  const factory = await ethers.deployContract("NearlGuardFactory");
  await factory.createGuard(agent.address);
  const [addr] = await factory.guardsOf(owner.address);
  const guard = await ethers.getContractAt("NearlGuard", addr);
  const router = await ethers.deployContract("MockTarget");
  await usd.transfer(addr, USD(1_000));
  await other.transfer(await router.getAddress(), USD(1_000));
  return { owner, agent, shop, stranger, usd, other, factory, guard, router };
}

describe("NearlGuard", function () {
  it("is created by the factory with the caller as owner", async function () {
    const { factory, guard, owner, agent } = await loadFixture(fixture);
    expect(await guard.owner()).to.equal(owner.address);
    expect(await guard.agent()).to.equal(agent.address);
    expect(await factory.isGuard(await guard.getAddress())).to.equal(true);
    expect(await factory.guardCount()).to.equal(1);
  });

  it("only lets the owner change rules and withdraw, and only to the owner", async function () {
    const { guard, usd, agent, stranger, owner } = await loadFixture(fixture);
    for (const s of [agent, stranger]) {
      await expect(guard.connect(s).setLimit(await usd.getAddress(), 1, 1)).to.be.revertedWithCustomError(guard, "NotOwner");
      await expect(guard.connect(s).withdraw(await usd.getAddress(), 1)).to.be.revertedWithCustomError(guard, "NotOwner");
      await expect(guard.connect(s).setAgent(s.address)).to.be.revertedWithCustomError(guard, "NotOwner");
    }
    await expect(guard.withdraw(await usd.getAddress(), USD(100))).to.changeTokenBalance(usd, owner, USD(100));
  });

  it("lets the agent pay approved recipients within per-tx and daily limits", async function () {
    const { guard, usd, agent, shop, stranger } = await loadFixture(fixture);
    const t = await usd.getAddress();
    await guard.setLimit(t, USD(100), USD(40));
    await guard.setRecipient(shop.address, true);

    await expect(guard.connect(agent).pay(t, stranger.address, USD(1))).to.be.revertedWithCustomError(guard, "NotAllowed");
    await expect(guard.connect(agent).pay(t, shop.address, USD(41))).to.be.revertedWithCustomError(guard, "OverPerTx");
    await guard.connect(agent).pay(t, shop.address, USD(40));
    await guard.connect(agent).pay(t, shop.address, USD(40));
    await expect(guard.connect(agent).pay(t, shop.address, USD(21))).to.be.revertedWithCustomError(guard, "OverDaily");
    expect(await guard.remainingToday(t)).to.equal(USD(20));

    await time.increase(DAY);
    await expect(guard.connect(agent).pay(t, shop.address, USD(40))).to.changeTokenBalance(usd, shop, USD(40));
  });

  it("blocks tokens without a limit, strangers, and a paused agent", async function () {
    const { guard, usd, other, agent, shop, stranger } = await loadFixture(fixture);
    const t = await usd.getAddress();
    await guard.setRecipient(shop.address, true);
    await expect(guard.connect(agent).pay(await other.getAddress(), shop.address, 1)).to.be.revertedWithCustomError(guard, "NotAllowed");
    await guard.setLimit(t, USD(100), USD(100));
    await expect(guard.connect(stranger).pay(t, shop.address, 1)).to.be.revertedWithCustomError(guard, "NotAgent");
    await guard.setPaused(true);
    await expect(guard.connect(agent).pay(t, shop.address, 1)).to.be.revertedWithCustomError(guard, "IsPaused");
    await guard.setPaused(false);
    await guard.connect(agent).pay(t, shop.address, 1);
  });

  it("executes calls on approved targets, measures the real spend and resets the allowance", async function () {
    const { guard, usd, other, agent, router } = await loadFixture(fixture);
    const t = await usd.getAddress(), r = await router.getAddress(), g = await guard.getAddress();
    await guard.setLimit(t, USD(100), USD(50));
    const data = router.interface.encodeFunctionData("swap", [t, USD(30), await other.getAddress(), USD(29)]);

    await expect(guard.connect(agent).execute(r, data, t, USD(50))).to.be.revertedWithCustomError(guard, "NotAllowed");
    await guard.setTarget(r, true);
    await expect(guard.connect(agent).execute(r, data, t, USD(51))).to.be.revertedWithCustomError(guard, "OverPerTx");

    await guard.connect(agent).execute(r, data, t, USD(50));
    expect(await guard.spentToday(t)).to.equal(USD(30));
    expect(await other.balanceOf(g)).to.equal(USD(29));
    expect(await usd.allowance(g, r)).to.equal(0);

    // Router tries to pull more than maxSpend: the exact allowance stops it.
    const greedy = router.interface.encodeFunctionData("swap", [t, USD(45), await other.getAddress(), 0]);
    await expect(guard.connect(agent).execute(r, greedy, t, USD(40))).to.be.revertedWithCustomError(guard, "CallFailed");

    // Daily limit counts across execute calls.
    const big = router.interface.encodeFunctionData("swap", [t, USD(50), await other.getAddress(), 0]);
    await guard.connect(agent).execute(r, big, t, USD(50));
    const more = router.interface.encodeFunctionData("swap", [t, USD(21), await other.getAddress(), 0]);
    await expect(guard.connect(agent).execute(r, more, t, USD(21))).to.be.revertedWithCustomError(guard, "OverDaily");
  });

  it("caps ETH spending and lets the owner withdraw ETH", async function () {
    const { guard, agent, shop, owner } = await loadFixture(fixture);
    const g = await guard.getAddress();
    await owner.sendTransaction({ to: g, value: ethers.parseEther("1") });
    await guard.setLimit(ethers.ZeroAddress, ethers.parseEther("0.3"), ethers.parseEther("0.2"));
    await guard.setRecipient(shop.address, true);
    await expect(guard.connect(agent).pay(ethers.ZeroAddress, shop.address, ethers.parseEther("0.2"))).to.changeEtherBalance(shop, ethers.parseEther("0.2"));
    await expect(guard.connect(agent).pay(ethers.ZeroAddress, shop.address, ethers.parseEther("0.2"))).to.be.revertedWithCustomError(guard, "OverDaily");
    await expect(guard.withdraw(ethers.ZeroAddress, ethers.parseEther("0.8"))).to.changeEtherBalance(owner, ethers.parseEther("0.8"));
  });

  it("refuses to approve itself as a target", async function () {
    const { guard } = await loadFixture(fixture);
    await expect(guard.setTarget(await guard.getAddress(), true)).to.be.revertedWithCustomError(guard, "NotAllowed");
  });
});
