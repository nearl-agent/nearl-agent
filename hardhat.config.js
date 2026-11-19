require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const accounts = process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
  },
  networks: {
    // Local network. The chains entries let scripts/fork-test-mainnet.js run on a copy of Robinhood Chain.
    hardhat: {
      chains: {
        4663: { hardforkHistory: { cancun: 0 } },
        46630: { hardforkHistory: { cancun: 0 } },
      },
    },
    // Testnet: Robinhood Chain Testnet (free test ETH from faucets)
    robinhoodTestnet: {
      url: process.env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com",
      chainId: 46630,
      accounts,
    },
    // Mainnet: Robinhood Chain (real money)
    robinhood: {
      url: process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
      chainId: 4663,
      accounts,
    },
  },
  // Contract verification on the Blockscout explorers (no API key needed).
  etherscan: {
    apiKey: { robinhoodTestnet: "blockscout", robinhood: "blockscout" },
    customChains: [
      {
        network: "robinhoodTestnet",
        chainId: 46630,
        urls: {
          apiURL: "https://explorer.testnet.chain.robinhood.com/api",
          browserURL: "https://explorer.testnet.chain.robinhood.com",
        },
      },
      {
        network: "robinhood",
        chainId: 4663,
        urls: {
          apiURL: "https://robinhoodchain.blockscout.com/api",
          browserURL: "https://robinhoodchain.blockscout.com",
        },
      },
    ],
  },
  // Sourcify supports Robinhood Chain (4663) and testnet (46630). Used for mainnet verification,
  // because the mainnet Blockscout API is behind a bot challenge.
  sourcify: { enabled: true },
};
