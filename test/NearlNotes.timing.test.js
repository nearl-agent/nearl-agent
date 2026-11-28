// Regression tests for GHSA-qg3c-phh6-4273 (reported by HEY Research Lab): the price for a date
// must not depend on who calls start()/observe(), or when. Each scenario mirrors one of their PoCs
// (series parameters from series.mainnet.json) and now checks that the date's price is used.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const USD = (n) => ethers.parseUnits(String(n), 6);
const PRICE = (n) => ethers.parseUnits(String(n), 8);
const HOUR = 3600, DAY = 24 * HOUR;
const Status = { Subscription: 0, Active: 1, Autocalled: 2, Matured: 3, Emergency: 4 };

async function setup() {
  const [issuer, alice, bob] = await ethers.getSigners();
  const usd = await ethers.deployContract("MockUSD");
  const feed = await ethers.deployContract("MockPriceFeed", [8, "ETH / USD", PRICE(3000)]);
  const notes = await ethers.deployContract("NearlNotes", [await usd.getAddress(), issuer.address]);
  for (const u of [alice, bob]) {
    await usd.transfer(u.address, USD(100));
    await usd.connect(u).approve(await notes.getAddress(), ethers.MaxUint256);
  }
  await usd.approve(await notes.getAddress(), ethers.MaxUint256);
  const now = await time.latest();
  const subscriptionEnd = now + 72 * HOUR;
  const p = {
    feed: await feed.getAddress(), barrierBps: 7000, autocallBps: 10000, couponBps: 100,
    maxPriceAge: 3 * HOUR, subscriptionEnd,
    observationTimes: [1, 2, 3].map((i) => subscriptionEnd + i * 7 * DAY),
    perUserCap: USD(10), totalCap: USD(30),
  };
  await notes.createSeries(p);
  await notes.connect(alice).deposit(0, USD(10));
  await notes.connect(bob).deposit(0, USD(10));
  return { issuer, alice, bob, usd, feed, notes, p };
}

// Start at 3000 and run the first two observations at 2900 (coupons, no autocall).
async function toFinalDate(ctx) {
  const { feed, notes, p } = ctx;
  await time.increaseTo(p.subscriptionEnd);
  await feed.setPrice(PRICE(3000));
  await notes.start(0);
  for (const i of [0, 1]) {
    await time.increaseTo(p.observationTimes[i]);
    await feed.setPrice(PRICE(2900));
    await notes.observe(0);
  }
}

const latestRound = async (feed) => (await feed.latestRoundData())[0];

describe("NearlNotes observation timing (GHSA-qg3c-phh6-4273)", function () {
  it("final observation: a late call after a dip still uses the price on the date", async function () {
    const ctx = await setup();
    const { issuer, alice, usd, feed, notes, p } = ctx;
    await toFinalDate(ctx);

    await time.increaseTo(p.observationTimes[2]);
    await feed.setPrice(PRICE(2600)); // 87% of initial, above the 70% barrier
    await time.increase(5 * DAY);
    await feed.setPrice(PRICE(1500)); // a dip five days later
    // The latest round is the dip, so the walk back needs the hint here (or finds it within 48 rounds).
    await notes.connect(issuer).observe(0);

    const s = await notes.getSeries(0);
    expect(s.status).to.equal(Status.Matured);
    expect(s.payoutRatio).to.equal(ethers.parseUnits("1", 18));

    const before = await usd.balanceOf(alice.address);
    await notes.connect(alice).claim(0);
    expect((await usd.balanceOf(alice.address)) - before).to.equal(USD("10.3")); // 3 coupons + full principal
  });

  it("start(): the initial price is the first round after subscription closes, not a later spike", async function () {
    const { feed, notes, p } = await setup();
    await time.increaseTo(p.subscriptionEnd);
    await feed.setPrice(PRICE(3000));
    await time.increase(6 * DAY);
    await feed.setPrice(PRICE(3600));
    await notes.start(0);
    expect((await notes.getSeries(0)).initialPrice).to.equal(PRICE(3000));
  });

  it("works the same for depositors: a later rebound is not used either", async function () {
    const ctx = await setup();
    const { alice, feed, notes, p } = ctx;
    await toFinalDate(ctx);
    await time.increaseTo(p.observationTimes[2]);
    await feed.setPrice(PRICE(1800)); // below the barrier on the date
    await time.increase(3 * DAY);
    await feed.setPrice(PRICE(2200)); // rebound
    await notes.connect(alice).observe(0);
    expect((await notes.getSeries(0)).payoutRatio).to.equal((PRICE(1800) * 10n ** 18n) / PRICE(3000));
  });

  it("if the feed has no round within maxPriceAge of the date, only the emergency exit remains", async function () {
    const ctx = await setup();
    const { issuer, alice, usd, feed, notes, p } = ctx;
    await toFinalDate(ctx);
    await time.increaseTo(p.observationTimes[2] + 10 * DAY);
    await feed.setPrice(PRICE(2000)); // first round after the date comes 10 days late
    await expect(notes.connect(issuer).observe(0)).to.be.revertedWithCustomError(notes, "StalePrice");

    await notes.triggerEmergency(0);
    const before = await usd.balanceOf(alice.address);
    await notes.connect(alice).claim(0);
    expect((await usd.balanceOf(alice.address)) - before).to.equal(USD("10.2")); // 2 coupons + full principal
  });

  it("observeAt() accepts only the first round after the date", async function () {
    const ctx = await setup();
    const { feed, notes, p } = ctx;
    await toFinalDate(ctx);
    await time.increaseTo(p.observationTimes[2]);
    await feed.setPrice(PRICE(2600));
    const first = await latestRound(feed);
    await feed.setPrice(PRICE(1500));
    const later = await latestRound(feed);

    await expect(notes.observeAt(0, later)).to.be.revertedWithCustomError(notes, "WrongRound");
    await expect(notes.observeAt(0, first - 1n)).to.be.revertedWithCustomError(notes, "WrongRound"); // before the date
    await expect(notes.observeAt(0, later + 1n)).to.be.revertedWithCustomError(notes, "WrongRound"); // does not exist yet
    await expect(notes.observeAt(0, 0)).to.be.revertedWithCustomError(notes, "WrongRound");
    await expect(notes.observeAt(0, first)).to.emit(notes, "PriceRound");
    expect((await notes.getSeries(0)).payoutRatio).to.equal(ethers.parseUnits("1", 18));
  });

  it("observe() walks back at most MAX_ROUND_STEPS rounds; a later call passes the round", async function () {
    const ctx = await setup();
    const { feed, notes, p } = ctx;
    await toFinalDate(ctx);
    await time.increaseTo(p.observationTimes[2]);
    await feed.setPrice(PRICE(2600));
    const first = await latestRound(feed);
    for (let i = 0; i < 50; i++) await feed.setPrice(PRICE(1500 + i));

    await expect(notes.observe(0)).to.be.revertedWithCustomError(notes, "RoundHintNeeded");
    await notes.observeAt(0, first);
    expect((await notes.getSeries(0)).payoutRatio).to.equal(ethers.parseUnits("1", 18));
  });

  it("startAt() refuses a later round too", async function () {
    const { feed, notes, p } = await setup();
    await time.increaseTo(p.subscriptionEnd);
    await feed.setPrice(PRICE(3000));
    const first = await latestRound(feed);
    await feed.setPrice(PRICE(3600));
    await expect(notes.startAt(0, first + 1n)).to.be.revertedWithCustomError(notes, "WrongRound");
    await notes.startAt(0, first);
    expect((await notes.getSeries(0)).initialPrice).to.equal(PRICE(3000));
  });

  it("the owner cannot renounce ownership (the reserve would be locked)", async function () {
    const { issuer, notes } = await setup();
    await expect(notes.connect(issuer).renounceOwnership()).to.be.revertedWithCustomError(notes, "RenounceDisabled");
    expect(await notes.owner()).to.equal(issuer.address);
  });
});
