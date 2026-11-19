/* NEARL Swap engine (window.NearlSwap): quotes and builds swaps that run on Uniswap v3 and v4 on
 * Robinhood Chain. NEARL only routes the order: liquidity comes from Uniswap pools, the user signs
 * every transaction in their own wallet, and NEARL never holds funds or charges a fee.
 *
 * Contract addresses are Uniswap's official Robinhood Chain (4663) deployments:
 * https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments
 * https://developers.uniswap.org/docs/protocols/v4/deployments
 */
(function (root) {
  "use strict";
  const { ethers } = root;

  const A = {
    WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    v3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    v3Quoter: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
    swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
    universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
    v4Quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    stateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  };
  const ETH = ethers.ZeroAddress;
  const FEES = [100, 500, 3000, 10000];

  const I = {
    v3Quoter: new ethers.Interface(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)"]),
    router02: new ethers.Interface([
      "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
      "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
      "function multicall(uint256 deadline,bytes[] data) payable returns (bytes[])",
    ]),
    v4Quoter: new ethers.Interface(["function quoteExactInputSingle(((address,address,uint24,int24,address) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData)) returns (uint256 amountOut,uint256 gasEstimate)"]),
    ur: new ethers.Interface(["function execute(bytes commands,bytes[] inputs,uint256 deadline) payable"]),
    erc20: new ethers.Interface([
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
      "function balanceOf(address) view returns (uint256)",
      "function decimals() view returns (uint8)",
      "function symbol() view returns (string)",
    ]),
    permit2: new ethers.Interface([
      "function allowance(address user,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)",
      "function approve(address token,address spender,uint160 amount,uint48 expiration)",
    ]),
  };
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const lc = (a) => String(a).toLowerCase();

  async function call(p, to, iface, fn, args) {
    const data = iface.encodeFunctionData(fn, args);
    const r = await p.call({ to, data });
    return iface.decodeFunctionResult(fn, r);
  }

  /**
   * Best route for selling `amountIn` of `tokenIn` for `tokenOut` (ETH is address(0)).
   * One side must be ETH or USDG. Tries Uniswap v3 (all fee tiers) and v4 (common pool settings).
   */
  async function quote(p, tokenIn, tokenOut, amountIn) {
    const routes = [];
    // ---- v3: ETH is traded as WETH
    const v3In = tokenIn === ETH ? A.WETH : tokenIn;
    const v3Out = tokenOut === ETH ? A.WETH : tokenOut;
    await Promise.all(FEES.map(async (fee) => {
      try {
        const [out] = await call(p, A.v3Quoter, I.v3Quoter, "quoteExactInputSingle", [[v3In, v3Out, amountIn, fee, 0]]);
        if (out > 0n) routes.push({ venue: "v3", fee, amountOut: out, label: `Uniswap v3 · ${fee / 10000}% pool` });
      } catch (_) {}
    }));
    // ---- v4: find pools on the common settings (v4-pools.js), for both ETH and WETH/USDG pairs
    const token = [tokenIn, tokenOut].find((t) => t !== ETH && lc(t) !== lc(A.USDG) && lc(t) !== lc(A.WETH)) || tokenOut;
    const quoteSide = token === tokenIn ? tokenOut : tokenIn; // ETH or USDG
    if (root.NearlV4Known) {
      const cands = [];
      for (const [q, fee, ts, hooks] of root.NearlV4Known.CONFIGS) {
        const qa = q === "ETH" ? ETH : q === "WETH" ? A.WETH : A.USDG;
        const want = quoteSide === ETH ? [ETH, A.WETH] : [quoteSide];
        if (!want.some((w) => lc(w) === lc(qa))) continue;
        const tokenIs0 = BigInt(token) < BigInt(qa);
        const key = tokenIs0 ? [token, qa, fee, ts, hooks] : [qa, token, fee, ts, hooks];
        cands.push({ key, qa });
      }
      // Skip pools that do not exist (slot0 price 0) before asking the quoter.
      const sv = new ethers.Contract(A.stateView, ["function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)"], p);
      const live = [];
      for (let i = 0; i < cands.length; i += 15) {
        const batch = cands.slice(i, i + 15);
        const s = await Promise.all(batch.map((c) => sv.getSlot0(root.NearlV4Known.poolId(...c.key)).catch(() => null)));
        batch.forEach((c, k) => s[k] && s[k][0] > 0n && live.push(c));
      }
      await Promise.all(live.map(async (c) => {
        // Pools paired with WETH cannot take native ETH directly; only use them when ETH is not involved.
        const inCur = tokenIn === ETH ? (c.qa === ETH ? ETH : null) : tokenIn;
        const outCur = tokenOut === ETH ? (c.qa === ETH ? ETH : null) : tokenOut;
        if (inCur === null || outCur === null) return;
        const zeroForOne = lc(c.key[0]) === lc(inCur);
        try {
          const [out] = await call(p, A.v4Quoter, I.v4Quoter, "quoteExactInputSingle", [[c.key, zeroForOne, amountIn, "0x"]]);
          if (out > 0n) {
            const hooked = c.key[4] !== ETH;
            routes.push({ venue: "v4", key: c.key, zeroForOne, amountOut: out, inCur, outCur, label: `Uniswap v4 · ${c.qa === ETH ? "ETH" : c.qa === A.USDG ? "USDG" : "WETH"} pool${hooked ? " with hook" : ""}` });
          }
        } catch (_) {}
      }));
    }
    routes.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
    return routes;
  }

  /**
   * Transactions the user signs, in order: approvals first (if needed), then the swap.
   * Each item is { label, to, data, value }.
   */
  async function build(p, user, route, tokenIn, tokenOut, amountIn, minOut, deadlineSec = 1200) {
    const deadline = Math.floor(Date.now() / 1000) + deadlineSec;
    const txs = [];
    if (route.venue === "v3") {
      const v3In = tokenIn === ETH ? A.WETH : tokenIn;
      const v3Out = tokenOut === ETH ? A.WETH : tokenOut;
      if (tokenIn !== ETH) {
        const [allow] = await call(p, tokenIn, I.erc20, "allowance", [user, A.swapRouter02]);
        if (allow < amountIn) txs.push({ label: "Approve token for Uniswap", to: tokenIn, data: I.erc20.encodeFunctionData("approve", [A.swapRouter02, amountIn]), value: 0n });
      }
      const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
      const swap = I.router02.encodeFunctionData("exactInputSingle", [[v3In, v3Out, route.fee, tokenOut === ETH ? ADDRESS_THIS : user, amountIn, minOut, 0]]);
      const calls = [swap];
      if (tokenOut === ETH) calls.push(I.router02.encodeFunctionData("unwrapWETH9", [minOut, user]));
      txs.push({ label: "Swap on Uniswap v3", to: A.swapRouter02, data: I.router02.encodeFunctionData("multicall", [deadline, calls]), value: tokenIn === ETH ? amountIn : 0n });
      return txs;
    }
    // ---- v4 through the Universal Router: V4_SWAP with SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
    if (route.inCur !== ETH) {
      const [allow] = await call(p, route.inCur, I.erc20, "allowance", [user, A.permit2]);
      if (allow < amountIn) txs.push({ label: "Approve token for Permit2", to: route.inCur, data: I.erc20.encodeFunctionData("approve", [A.permit2, amountIn]), value: 0n });
      const [pAmt, pExp] = await call(p, A.permit2, I.permit2, "allowance", [user, route.inCur, A.universalRouter]);
      if (pAmt < amountIn || Number(pExp) < deadline) {
        txs.push({ label: "Allow the Uniswap router", to: A.permit2, data: I.permit2.encodeFunctionData("approve", [route.inCur, A.universalRouter, amountIn, deadline + 3600]), value: 0n });
      }
    }
    const actions = "0x060c0f";
    const params = [
      coder.encode(["tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,bytes)"], [[route.key, route.zeroForOne, amountIn, minOut, "0x"]]),
      coder.encode(["address", "uint256"], [route.inCur, amountIn]),
      coder.encode(["address", "uint256"], [route.outCur, minOut]),
    ];
    const input = coder.encode(["bytes", "bytes[]"], [actions, params]);
    txs.push({ label: "Swap on Uniswap v4", to: A.universalRouter, data: I.ur.encodeFunctionData("execute", ["0x10", [input], deadline]), value: route.inCur === ETH ? amountIn : 0n });
    return txs;
  }

  root.NearlSwap = { A, ETH, quote, build, I };
})(typeof window !== "undefined" ? window : globalThis);
