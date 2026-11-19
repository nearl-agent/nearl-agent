const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const USD = (n) => ethers.parseUnits(String(n), 6);
const PRICE = (n) => ethers.parseUnits(String(n), 8);
const DAY = 24 * 60 * 60;
const Status = { Subscription: 0, Active: 1, Autocalled: 2, Matured: 3, Emergency: 4 };

async function deployFixture() {
  const [owner, alice, bob, carol, keeper] = await ethers.getSigners();

  const usd = await ethers.deployContract("MockUSD");
  const feed = await ethers.deployContract("MockPriceFeed", [8, "ETH / USD", PRICE(3000)]);
  const notes = await ethers.deployContract("NearlNotes", [await usd.getAddress(), owner.address]);

  for (const u of [alice, bob, carol]) {
    await usd.transfer(u.address, USD(10_000));
    await usd.connect(u).approve(await notes.getAddress(), ethers.MaxUint256);
  }
  await usd.approve(await notes.getAddress(), ethers.MaxUint256);

  return { usd, feed, notes, owner, alice, bob, carol, keeper };
}

async function params(feed, overrides = {}) {
  const now = await time.latest();
  const subscriptionEnd = now + DAY;
  return {
    feed: await feed.getAddress(),
    barrierBps: 7000,
    autocallBps: 10000,
    couponBps: 240,
    maxPriceAge: DAY,
    subscriptionEnd,
    observationTimes: [1, 2, 3, 4].map((i) => subscriptionEnd + i * 30 * DAY),
    perUserCap: USD(1_000),
    totalCap: USD(5_000),
    ...overrides,
  };
}

async function withSeries(overrides) {
  const ctx = await loadFixture(deployFixture);
  const p = await params(ctx.feed, overrides);
  await ctx.notes.createSeries(p);
  return { ...ctx, p, id: 0 };
}

// Move to an observation time, refresh the mock price, and observe.
async function observeAt(ctx, index, price) {
  await time.increaseTo(ctx.p.observationTimes[index]);
  await ctx.feed.setPrice(PRICE(price));
  await ctx.notes.connect(ctx.keeper).observe(ctx.id);
}

async function startAt(ctx, price = 3000) {
  await time.increaseTo(ctx.p.subscriptionEnd);
  await ctx.feed.setPrice(PRICE(price));
  await ctx.notes.connect(ctx.keeper).start(ctx.id);
}

describe("NearlNotes", function () {
  describe("createSeries", function () {
    it("pulls the full coupon reserve from the issuer", async function () {
      const { usd, notes, feed } = await loadFixture(deployFixture);
      const p = await params(feed);
      // 5,000 cap * 2.4% * 4 observations = 480
      await expect(notes.createSeries(p)).to.changeTokenBalance(usd, notes, USD(480));
      const s = await notes.getSeries(0);
      expect(s.couponReserve).to.equal(USD(480));
      expect(s.status).to.equal(Status.Subscription);
    });

    it("rejects invalid parameters", async function () {
      const { notes, feed } = await loadFixture(deployFixture);
      const bad = [
        { barrierBps: 0 },
        { barrierBps: 10001 },
        { autocallBps: 6000 },
        { couponBps: 0 },
        { couponBps: 2001 },
        { maxPriceAge: 0 },
        { perUserCap: USD(6_000) },
        { observationTimes: [] },
      ];
      for (const o of bad) {
        await expect(notes.createSeries(await params(feed, o))).to.be.revertedWithCustomError(notes, "InvalidParams");
      }
      const p = await params(feed);
      await expect(
        notes.createSeries({ ...p, observationTimes: [p.subscriptionEnd + 10, p.subscriptionEnd + 5] }),
      ).to.be.revertedWithCustomError(notes, "InvalidParams");
      await expect(
        notes.createSeries({ ...p, observationTimes: [p.subscriptionEnd] }),
      ).to.be.revertedWithCustomError(notes, "InvalidParams");
    });

    it("is owner-only", async function () {
      const { notes, feed, alice } = await loadFixture(deployFixture);
      await expect(notes.connect(alice).createSeries(await params(feed))).to.be.revertedWithCustomError(
        notes,
        "OwnableUnauthorizedAccount",
      );
    });
  });

  describe("deposit", function () {
    it("enforces per-user and total caps", async function () {
      const ctx = await withSeries({ totalCap: USD(1_500) });
      const { notes, alice, bob, carol, id } = ctx;
      await notes.connect(alice).deposit(id, USD(1_000));
      await expect(notes.connect(alice).deposit(id, 1)).to.be.revertedWithCustomError(notes, "CapExceeded");
      await notes.connect(bob).deposit(id, USD(500));
      await expect(notes.connect(carol).deposit(id, 1)).to.be.revertedWithCustomError(notes, "CapExceeded");
    });

    it("closes at subscription end and when paused", async function () {
      const ctx = await withSeries();
      const { notes, alice, id } = ctx;
      await notes.pause();
      await expect(notes.connect(alice).deposit(id, USD(10))).to.be.revertedWithCustomError(notes, "EnforcedPause");
      await notes.unpause();
      await time.increaseTo(ctx.p.subscriptionEnd);
      await expect(notes.connect(alice).deposit(id, USD(10))).to.be.revertedWithCustomError(notes, "TooLate");
    });

    it("rejects zero amounts and unknown series", async function () {
      const { notes, alice } = await withSeries();
      await expect(notes.connect(alice).deposit(0, 0)).to.be.revertedWithCustomError(notes, "ZeroAmount");
      await expect(notes.connect(alice).deposit(9, 1)).to.be.revertedWithCustomError(notes, "UnknownSeries");
    });
  });

  describe("lifecycle", function () {
    it("pays coupons above the barrier and full principal at maturity", async function () {
      const ctx = await withSeries();
      const { notes, usd, alice, id } = ctx;
      await notes.connect(alice).deposit(id, USD(1_000));
      await startAt(ctx, 3000);

      await observeAt(ctx, 0, 2700); // 90% -> coupon
      await observeAt(ctx, 1, 1800); // 60% -> no coupon
      await observeAt(ctx, 2, 2400); // 80% -> coupon
      await observeAt(ctx, 3, 2250); // 75% -> coupon, above barrier at maturity

      const s = await notes.getSeries(id);
      expect(s.status).to.equal(Status.Matured);
      expect(s.couponsPaid).to.equal(3);
      // 1,000 principal + 3 * 24 coupons
      await expect(notes.connect(alice).claim(id)).to.changeTokenBalance(usd, alice, USD(1_072));
      await expect(notes.connect(alice).claim(id)).to.be.revertedWithCustomError(notes, "NothingToClaim");
    });

    it("autocalls early at or above the autocall level", async function () {
      const ctx = await withSeries();
      const { notes, usd, alice, id } = ctx;
      await notes.connect(alice).deposit(id, USD(500));
      await startAt(ctx, 3000);
      await observeAt(ctx, 0, 3000); // exactly 100%

      const s = await notes.getSeries(id);
      expect(s.status).to.equal(Status.Autocalled);
      await expect(notes.connect(ctx.keeper).observe(id)).to.be.revertedWithCustomError(notes, "WrongStatus");
      await expect(notes.connect(alice).claim(id)).to.changeTokenBalance(usd, alice, USD(512));
    });

    it("converts principal at the final price when below the barrier", async function () {
      const ctx = await withSeries();
      const { notes, usd, alice, owner, id } = ctx;
      await notes.connect(alice).deposit(id, USD(1_000));
      await startAt(ctx, 3000);
      await observeAt(ctx, 0, 2000);
      await observeAt(ctx, 1, 2000);
      await observeAt(ctx, 2, 2000);
      await observeAt(ctx, 3, 1500); // 50%

      await expect(notes.connect(alice).claim(id)).to.changeTokenBalance(usd, alice, USD(500));
      // issuer: reserve 480 - 0 coupons + 500 kept principal
      await expect(notes.settleIssuer(id)).to.changeTokenBalance(usd, owner, USD(980));
      expect(await usd.balanceOf(await notes.getAddress())).to.equal(0);
    });

    it("lets users claim coupons before maturity", async function () {
      const ctx = await withSeries();
      const { notes, usd, alice, id } = ctx;
      await notes.connect(alice).deposit(id, USD(1_000));
      await startAt(ctx);
      await observeAt(ctx, 0, 2900);
      await expect(notes.connect(alice).claim(id)).to.changeTokenBalance(usd, alice, USD(24));
      await expect(notes.connect(alice).claim(id)).to.be.revertedWithCustomError(notes, "NothingToClaim");
      await observeAt(ctx, 1, 2900);
      await expect(notes.connect(alice).claim(id)).to.changeTokenBalance(usd, alice, USD(24));
    });

    it("closes an empty series and returns the reserve to the issuer", async function () {
      const ctx = await withSeries();
      const { notes, usd, owner, id } = ctx;
      await time.increaseTo(ctx.p.subscriptionEnd);
      await notes.start(id);
      expect((await notes.getSeries(id)).status).to.equal(Status.Matured);
      await expect(notes.settleIssuer(id)).to.changeTokenBalance(usd, owner, USD(480));
      await expect(notes.settleIssuer(id)).to.be.revertedWithCustomError(notes, "WrongStatus");
    });

    it("blocks early start, early observation, and issuer settlement before the end", async function () {
      const ctx = await withSeries();
      const { notes, alice, id } = ctx;
      await notes.connect(alice).deposit(id, USD(100));
      await expect(notes.start(id)).to.be.revertedWithCustomError(notes, "TooEarly");
      await startAt(ctx);
      await expect(notes.observe(id)).to.be.revertedWithCustomError(notes, "TooEarly");
      await expect(notes.settleIssuer(id)).to.be.revertedWithCustomError(notes, "WrongStatus");
    });
  });

  describe("oracle safety", function () {
    it("rejects prices older than maxPriceAge or from before the observation date", async function () {
      const ctx = await withSeries();
      const { notes, feed, alice, id } = ctx;
      await notes.connect(alice).deposit(id, USD(100));
      await startAt(ctx);

      // Price last set at start; the observation date is 30 days later.
      await time.increaseTo(ctx.p.observationTimes[0]);
      await expect(notes.observe(id)).to.be.revertedWithCustomError(notes, "StalePrice");

      await feed.setPrice(PRICE(3000));
      await time.increase(DAY + 1);
      await expect(notes.observe(id)).to.be.revertedWithCustomError(notes, "StalePrice");
    });

    it("rejects zero or negative prices", async function () {
      const ctx = await withSeries();
      const { notes, feed, alice, id } = ctx;
      await notes.connect(alice).deposit(id, USD(100));
      await time.increaseTo(ctx.p.subscriptionEnd);
      await feed.setPrice(0);
      await expect(notes.start(id)).to.be.revertedWithCustomError(notes, "BadPrice");
      await feed.setPrice(-1);
      await expect(notes.start(id)).to.be.revertedWithCustomError(notes, "BadPrice");
    });

    it("allows an emergency exit with full principal when observations stop", async function () {
      const ctx = await withSeries();
      const { notes, usd, alice, owner, id } = ctx;
      await notes.connect(alice).deposit(id, USD(1_000));
      await startAt(ctx);
      await observeAt(ctx, 0, 2800); // one coupon paid

      const due = ctx.p.observationTimes[1];
      await time.increaseTo(due + 7 * DAY - 2);
      await expect(notes.triggerEmergency(id)).to.be.revertedWithCustomError(notes, "TooEarly");
      await time.increase(2);
      await notes.connect(alice).triggerEmergency(id);

      await expect(notes.connect(alice).claim(id)).to.changeTokenBalance(usd, alice, USD(1_024));
      await expect(notes.settleIssuer(id)).to.changeTokenBalance(usd, owner, USD(480 - 24));
      expect(await usd.balanceOf(await notes.getAddress())).to.equal(0);
    });

    it("allows an emergency exit if the series is never started", async function () {
      const ctx = await withSeries();
      const { notes, usd, alice, id } = ctx;
      await notes.connect(alice).deposit(id, USD(300));
      await time.increaseTo(ctx.p.subscriptionEnd + 7 * DAY);
      await notes.triggerEmergency(id);
      await expect(notes.connect(alice).claim(id)).to.changeTokenBalance(usd, alice, USD(300));
    });

    it("keeps claims working while deposits are paused", async function () {
      const ctx = await withSeries();
      const { notes, usd, alice, id } = ctx;
      await notes.connect(alice).deposit(id, USD(1_000));
      await startAt(ctx);
      await notes.pause();
      await observeAt(ctx, 0, 3100);
      await expect(notes.connect(alice).claim(id)).to.changeTokenBalance(usd, alice, USD(1_024));
    });
  });

  describe("solvency (randomized)", function () {
    it("always pays every user and the issuer exactly what the contract holds", async function () {
      // Deterministic pseudo-random scenarios. Each run must end with all claims succeeding
      // and the contract balance at or near zero (rounding dust only).
      let seed = 42;
      const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

      for (let run = 0; run < 12; run++) {
        const ctx = await loadFixture(deployFixture);
        const { notes, usd, feed, alice, bob, carol, owner } = ctx;
        const users = [alice, bob, carol];
        const nObs = 1 + Math.floor(rand() * 6);
        const now = await time.latest();
        const subscriptionEnd = now + DAY;
        const p = await params(feed, {
          barrierBps: 5000 + Math.floor(rand() * 4000),
          autocallBps: 10000 + Math.floor(rand() * 1000),
          couponBps: 1 + Math.floor(rand() * 2000),
          subscriptionEnd,
          observationTimes: Array.from({ length: nObs }, (_, i) => subscriptionEnd + (i + 1) * 7 * DAY),
          perUserCap: USD(1_000),
          totalCap: USD(3_000),
        });
        await notes.createSeries(p);
        const c = { ...ctx, p, id: 0 };

        for (const u of users) {
          const amt = BigInt(Math.floor(rand() * 1_000_000_000) + 1); // up to 1,000 USD, odd units
          await notes.connect(u).deposit(0, amt);
        }
        await startAt(c, 3000);

        for (let i = 0; i < nObs; i++) {
          const s = await notes.getSeries(0);
          if (Number(s.status) !== Status.Active) break;
          const price = 1000 + Math.floor(rand() * 3500);
          await observeAt(c, i, price);
          // some users claim coupons mid-way
          const who = users[Math.floor(rand() * 3)];
          const [cp] = await notes.claimable(0, who.address);
          if (cp > 0n) await notes.connect(who).claim(0);
        }

        for (const u of users) {
          const [cp, pr] = await notes.claimable(0, u.address);
          if (cp + pr > 0n) await notes.connect(u).claim(0);
        }
        await notes.connect(owner).settleIssuer(0);

        const dust = await usd.balanceOf(await notes.getAddress());
        expect(dust).to.be.lte(10n, `run ${run}: leftover ${dust}`);
      }
    });
  });
});
