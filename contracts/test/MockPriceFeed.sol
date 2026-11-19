// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @notice TESTNET ONLY. Chainlink-compatible feed whose price the owner sets by hand.
contract MockPriceFeed is AggregatorV3Interface, Ownable {
    uint8 public immutable override decimals;
    string public override description;
    uint80 private _round;
    int256 private _answer;
    uint256 private _updatedAt;

    event PriceSet(int256 price);

    constructor(uint8 decimals_, string memory description_, int256 initialPrice) Ownable(msg.sender) {
        decimals = decimals_;
        description = description_;
        _set(initialPrice);
    }

    function setPrice(int256 price) external onlyOwner {
        _set(price);
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return (_round, _answer, _updatedAt, _updatedAt, _round);
    }

    function _set(int256 price) private {
        _round += 1;
        _answer = price;
        _updatedAt = block.timestamp;
        emit PriceSet(price);
    }
}
