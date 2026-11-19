// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Never deployed. NEARL Check injects this code into a simulated eth_call
///         (state override) to test whether a token can be transferred, and how many
///         tokens actually arrive (to detect buy/sell taxes and honeypots).
contract Probe {
    function probe(address token, address to, uint256 amount)
        external
        returns (bool ok, uint256 received, bytes memory err)
    {
        uint256 before = _bal(token, to);
        (bool s, bytes memory r) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!s) return (false, 0, r);
        if (r.length >= 32 && !abi.decode(r, (bool))) return (false, 0, r);
        uint256 afterBal = _bal(token, to);
        return (true, afterBal > before ? afterBal - before : 0, "");
    }

    function _bal(address token, address who) private view returns (uint256) {
        (bool s, bytes memory r) = token.staticcall(abi.encodeWithSelector(0x70a08231, who));
        return s && r.length >= 32 ? abi.decode(r, (uint256)) : 0;
    }
}
