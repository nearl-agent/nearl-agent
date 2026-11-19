/* The official $NEARL token. This file is the one place its contract address is set.
   Before launch: leave address empty, and the site says $NEARL is not live yet.
   After launch on Pons (Robinhood Chain): paste the contract address below, and the Pons page link if you have it,
   then push. The $NEARL page, the menu and Check all read it from here. */
(function (g) {
  g.NearlToken = {
    address: "", // e.g. "0x1234…abcd", the token's contract address (CA) on Robinhood Chain mainnet
    ponsUrl: "", // optional: the token's page on Pons
    launched: "", // optional: launch date, e.g. "2026-12-01"
  };
})(typeof window !== "undefined" ? window : globalThis);
