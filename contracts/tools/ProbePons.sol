// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20P {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @dev The parts of a Pons V2 bonding curve (PonsV2BondingCurve) that a trade needs.
interface IPonsCurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256);
}

/// @notice Never deployed. NEARL Check injects this code into a simulated eth_call (with a state
///         override that gives it ETH or the pair token) to buy a token on its Pons launch curve and
///         sell everything straight back, measuring what really arrives at each step.
contract ProbePons {
    /// @param curve      the token's Pons V2 bonding curve
    /// @param token      the launch token
    /// @param pairToken  the quote asset, or address(0) for native ETH
    /// @param quoteIn    how much quote to spend on the buy
    /// @return buyOk     the buy went through
    /// @return tokensOut launch tokens that actually arrived
    /// @return sellOk    selling all of them back went through
    /// @return quoteBack quote asset that actually came back
    /// @return err       revert data of the step that failed, if any
    function roundTrip(address curve, address token, address pairToken, uint256 quoteIn)
        external
        returns (bool buyOk, uint256 tokensOut, bool sellOk, uint256 quoteBack, bytes memory err)
    {
        bool native = pairToken == address(0);
        uint256 tokBefore = IERC20P(token).balanceOf(address(this));

        bytes memory r;
        if (native) {
            (buyOk, r) = curve.call{value: quoteIn}(abi.encodeCall(IPonsCurve.buy, (quoteIn, 0, address(this))));
        } else {
            IERC20P(pairToken).approve(curve, quoteIn);
            (buyOk, r) = curve.call(abi.encodeCall(IPonsCurve.buy, (quoteIn, 0, address(this))));
        }
        if (!buyOk) return (false, 0, false, 0, r);
        tokensOut = IERC20P(token).balanceOf(address(this)) - tokBefore;
        if (tokensOut == 0) return (true, 0, false, 0, "");

        uint256 quoteBefore = native ? address(this).balance : IERC20P(pairToken).balanceOf(address(this));
        IERC20P(token).approve(curve, tokensOut);
        (sellOk, r) = curve.call(abi.encodeCall(IPonsCurve.sell, (tokensOut, 0, address(this))));
        if (!sellOk) return (true, tokensOut, false, 0, r);
        uint256 quoteAfter = native ? address(this).balance : IERC20P(pairToken).balanceOf(address(this));
        quoteBack = quoteAfter - quoteBefore;
    }

    receive() external payable {}
}
