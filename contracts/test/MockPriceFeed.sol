// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @notice TESTNET ONLY. Chainlink-compatible feed whose price the owner sets by hand.
///         Keeps every round, with round ids shaped like a Chainlink proxy in phase 1
///         ((1 << 64) | n, n starting at 1). Unknown rounds read as zeros, like Chainlink.
contract MockPriceFeed is AggregatorV3Interface, Ownable {
    uint80 private constant PHASE = uint80(1) << 64;

    uint8 public immutable override decimals;
    string public override description;
    uint80 private _round; // latest round id
    mapping(uint80 => int256) private _answers;
    mapping(uint80 => uint256) private _updated;

    event PriceSet(uint80 roundId, int256 price);

    constructor(uint8 decimals_, string memory description_, int256 initialPrice) Ownable(msg.sender) {
        decimals = decimals_;
        description = description_;
        _round = PHASE;
        _set(initialPrice);
    }

    function setPrice(int256 price) external onlyOwner {
        _set(price);
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return (_round, _answers[_round], _updated[_round], _updated[_round], _round);
    }

    function getRoundData(uint80 roundId) external view override returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, _answers[roundId], _updated[roundId], _updated[roundId], roundId);
    }

    function _set(int256 price) private {
        _round += 1;
        _answers[_round] = price;
        _updated[_round] = block.timestamp;
        emit PriceSet(_round, price);
    }
}
