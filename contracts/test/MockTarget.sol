// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice TEST ONLY. Stands in for a DEX router: pulls `amountIn` of a token from the caller
///         and sends back `amountOut` of another token.
contract MockTarget {
    function swap(IERC20 tokenIn, uint256 amountIn, IERC20 tokenOut, uint256 amountOut) external {
        tokenIn.transferFrom(msg.sender, address(this), amountIn);
        if (amountOut > 0) tokenOut.transfer(msg.sender, amountOut);
    }

    function fail() external pure {
        revert("nope");
    }

    receive() external payable {}
}
