/* NEARL RPC failover (window.NearlRPC). Works in the browser and in Netlify Functions.
 *
 * Every provider made here tries the official Robinhood Chain RPC first and, if it cannot be reached
 * (for example when an internet provider blocks the domain) or refuses the request (rate limit,
 * archive limits), moves on to public backups listed on chainlist.org.
 * The last RPC that worked is remembered, so later calls go straight to it.
 */
(function (root) {
  "use strict";
  const { ethers } = root;

  const LISTS = {
    4663: [
      "https://rpc.mainnet.chain.robinhood.com",
      "https://robinhood.api.pocket.network",
      "https://robinhood-rpc.publicnode.com",
      "https://rpc-robinhood.globalstake.io",
      "https://robinhood.rpc.blxrbdn.com",
    ],
    46630: [
      "https://rpc.testnet.chain.robinhood.com",
      "https://robinhood-sepolia-rpc.publicnode.com",
    ],
  };
  // Only these serve eth_getLogs over history for free (the others refuse or time out).
  const LOG_LISTS = {
    4663: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood.api.pocket.network"],
    46630: LISTS[46630],
  };

  // Provider-side refusals worth retrying on another RPC. Contract reverts are NOT in this list,
  // and neither are "block range too large" errors: getLogsAdaptive splits those ranges itself.
  // "historical state ... is not available" / "missing trie node": a pruned node that cannot read past blocks.
  const SKIP = /rate limit|too many requests|archive|personal token|not available on|not supported|unauthori[sz]ed|forbidden|over capacity|temporarily unavailable|historical state|state .{0,80}not available|missing trie node|pruned/i;
  const TIMEOUT_MS = 9000;
  const DEAD_MS = 120000; // an RPC that could not be reached is skipped for two minutes
  const good = {}; // "chainId:kind" -> index of the RPC that last worked
  const dead = {}; // url -> time until which it is skipped
  const spans = {}; // largest eth_getLogs block range the current RPC accepts, learned from its errors
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const decoder = new TextDecoder();

  function methodOf(req) {
    try { return JSON.parse(decoder.decode(req.body)).method || ""; } catch (_) { return ""; }
  }

  async function attempt(url, req) {
    for (let tries = 0; ; tries++) {
      const res = await fetch(url, {
        method: req.method || "POST",
        headers: req.headers,
        body: req.body ? req.body : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = new Uint8Array(await res.arrayBuffer());
      // A short rate-limit burst: pause once and ask the same RPC again before moving on.
      if (res.status === 429 && tries === 0) { await sleep(700); continue; }
      return { res, body };
    }
  }

  function makeGetUrl(chainId) {
    return async function (req) {
      const isLogs = methodOf(req) === "eth_getLogs";
      const kind = `${chainId}:${isLogs ? "logs" : "rpc"}`;
      const urls = (isLogs ? LOG_LISTS : LISTS)[chainId];
      const start = good[kind] || 0;
      const order = urls.map((_, k) => (start + k) % urls.length);
      // Skip RPCs that recently could not be reached, unless every one of them is marked.
      const now = Date.now();
      const alive = order.filter((i) => !(dead[urls[i]] > now));
      let lastErr = null;
      for (const i of alive.length ? alive : order) {
        try {
          const { res, body } = await attempt(urls[i], req);
          if (res.status === 429 || res.status === 401 || res.status === 403 || res.status >= 500) { lastErr = new Error(`${urls[i]}: HTTP ${res.status}`); continue; }
          const text = decoder.decode(body);
          if (text.includes('"error"') && SKIP.test(text)) { lastErr = new Error(text.slice(0, 240)); continue; }
          good[kind] = i;
          const headers = {};
          res.headers.forEach((v, key) => (headers[key] = v));
          return { statusCode: res.status, statusMessage: res.statusText, headers, body };
        } catch (e) {
          dead[urls[i]] = Date.now() + DEAD_MS; // blocked, offline or too slow
          lastErr = e;
        }
      }
      throw lastErr || new Error("No Robinhood Chain RPC could be reached.");
    };
  }

  /** A JsonRpcProvider for chain 4663 or 46630 with automatic failover. */
  function provider(chainId, opts = {}) {
    const urls = LISTS[chainId];
    if (!urls) throw new Error(`Unknown chain ${chainId}`);
    const req = new ethers.FetchRequest(urls[0]);
    req.getUrlFunc = makeGetUrl(chainId);
    req.timeout = 60000;
    const p = new ethers.JsonRpcProvider(req, chainId, { staticNetwork: true, batchMaxCount: 1, ...opts });
    p._nearlChain = chainId;
    return p;
  }

  const RANGE = /block range|range too large|range is too large|maximum block range|max(imum)? \d+ blocks|exceed(s|ed)? max|query returned more than|response size|too many (logs|results)/i;
  const errText = (e) => String((e && (e.shortMessage || e.message)) || e) + JSON.stringify((e && (e.info || e.error)) || "");
  const isRangeError = (e) => RANGE.test(errText(e));
  // "exceeds server limit of 50000", "maximum block range: 50000", "max 10001 blocks" -> that number.
  const limitFrom = (e) => { const m = errText(e).match(/(?:limit of|range:?|max(?:imum)?)\D{0,12}(\d{3,9})/i); return m ? Number(m[1]) - 1 : 0; };
  const spanKey = (p) => `${p._nearlChain}:${good[`${p._nearlChain}:logs`] || 0}`;

  /**
   * eth_getLogs over [from, to]. If an RPC refuses a range as too large, the largest size it accepts is
   * learned (from its error message, or by halving) and remembered, so later calls start at that size.
   * Newest blocks are fetched first, up to 4 requests at a time. It stops after maxRequests calls and
   * returns what it has, sorted oldest first.
   */
  async function getLogsAdaptive(p, filter, from, to, maxRequests = 80, deadline = Infinity) {
    const out = [];
    const stack = [[from, to, 0]];
    let n = 0, dropped = 0;
    const one = async ([a, z, tries]) => {
      try {
        out.push(...(await p.getLogs({ ...filter, fromBlock: a, toBlock: z })));
      } catch (e) {
        if (isRangeError(e) && z - a >= 1000) {
          const lim = limitFrom(e), half = Math.floor((z - a + 1) / 2);
          const next = Math.max(1000, lim && lim < z - a + 1 ? lim : half);
          const key = spanKey(p);
          if (!spans[key] || next < spans[key]) spans[key] = next;
          stack.push([a, z, tries]);
        } else if (tries < 2) {
          await sleep(1200 * (tries + 1)); // rate limit or a flaky RPC: pause, then try again
          stack.push([a, z, tries + 1]);
        } else {
          dropped++; // this range could not be read
        }
      }
    };
    while (stack.length && n < maxRequests && Date.now() < deadline) {
      const span = spans[spanKey(p)];
      const batch = [];
      // Without a known limit, send one request to learn it; with one, send up to 4 newest chunks.
      const width = span ? 4 : 1;
      while (stack.length && batch.length < width && n + batch.length < maxRequests) {
        const [a, z, tries] = stack.pop();
        if (a > z) continue;
        if (span && z - a + 1 > span) {
          stack.push([a, z - span, 0], [z - span + 1, z, tries]); // newest chunk is popped next
          continue;
        }
        batch.push([a, z, tries]);
      }
      n += batch.length;
      await Promise.all(batch.map(one));
    }
    out.sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index);
    // complete: every block in [from, to] was read. Callers that rebuild balances must check it.
    out.complete = stack.length === 0 && dropped === 0;
    return out;
  }

  /** Largest getLogs range the RPC in use is known to accept, or 0 if it has not refused any. */
  const maxSpan = (p) => spans[spanKey(p)] || 0;

  root.NearlRPC = { LISTS, provider, getLogsAdaptive, isRangeError, maxSpan };
})(typeof window !== "undefined" ? window : globalThis);
