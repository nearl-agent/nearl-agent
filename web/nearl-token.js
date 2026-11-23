/* The official $NEARL token. This file is the one place its contract address is set.
   Before launch: leave address empty, and the site says $NEARL is not live yet.
   After launch on Pons (Robinhood Chain): paste the contract address below, and the Pons page link if you have it,
   then push. The $NEARL page, the menu and Check all read it from here. */
(function (g) {
  g.NearlToken = {
    address: "0x77770B77616FD7E8F2994a45D88cd0cD8d1cbf92", // the token's contract address (CA) on Robinhood Chain mainnet
    ponsUrl: "", // optional: the token's page on Pons
    fomoUrl: "https://fomo.family/profile/nearlagent?r=nearlagent", // optional: NEARL on the fomo app
    launched: "", // optional: launch date, e.g. "2026-12-01"
  };
})(typeof window !== "undefined" ? window : globalThis);
