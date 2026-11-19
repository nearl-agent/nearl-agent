// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

/// @notice Never deployed. NEARL Check injects this code into a simulated eth_call to run a real
///         Uniswap v4 swap through the PoolManager (including the pool's hook), so it can tell whether
///         a token can be bought and sold, and how many tokens actually arrive.
contract ProbeV4 {
    uint160 private constant MIN_LIMIT = 4295128740;
    uint160 private constant MAX_LIMIT = 1461446703485210103287273052203988822378723970341;

    IPoolManager private _pm;

    /// @return ok swap went through
    /// @return out amount the pool says we receive
    /// @return received amount that actually arrived (differs if the token takes a tax)
    function buy(address pm, PoolKey calldata key, address token, uint256 quoteIn)
        external
        returns (bool ok, uint256 out, uint256 received, bytes memory err)
    {
        return _run(pm, abi.encode(uint8(1), key, token, quoteIn));
    }

    function sell(address pm, PoolKey calldata key, address token, uint256 tokenIn)
        external
        returns (bool ok, uint256 out, uint256 received, bytes memory err)
    {
        return _run(pm, abi.encode(uint8(0), key, token, tokenIn));
    }

    function _run(address pm, bytes memory data)
        private
        returns (bool ok, uint256 out, uint256 received, bytes memory err)
    {
        _pm = IPoolManager(pm);
        (bool s, bytes memory r) = pm.call(abi.encodeWithSelector(IPoolManager.unlock.selector, data));
        if (!s) return (false, 0, 0, r);
        bytes memory inner = abi.decode(r, (bytes));
        (out, received) = abi.decode(inner, (uint256, uint256));
        return (true, out, received, "");
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(_pm), "pm");
        (uint8 mode, PoolKey memory key, address token, uint256 amountIn) = abi.decode(data, (uint8, PoolKey, address, uint256));
        bool tokenIs0 = key.currency0 == token;
        address quote = tokenIs0 ? key.currency1 : key.currency0;

        // mode 1 = buy (quote -> token), mode 0 = sell (token -> quote)
        address payIn = mode == 1 ? quote : token;
        address getOut = mode == 1 ? token : quote;
        bool zeroForOne = payIn == key.currency0;

        int256 delta = _pm.swap(
            key,
            SwapParams(zeroForOne, -int256(amountIn), zeroForOne ? MIN_LIMIT : MAX_LIMIT),
            ""
        );
        int128 d0 = int128(delta >> 128);
        int128 d1 = int128(delta);
        int128 dIn = zeroForOne ? d0 : d1;
        int128 dOut = zeroForOne ? d1 : d0;
        uint256 owed = dIn < 0 ? uint256(uint128(-dIn)) : 0;
        uint256 out = dOut > 0 ? uint256(uint128(dOut)) : 0;

        if (owed > 0) {
            if (payIn == address(0)) {
                _pm.settle{value: owed}();
            } else {
                _pm.sync(payIn);
                IERC20Min(payIn).transfer(address(_pm), owed);
                _pm.settle();
            }
        }
        uint256 before = _bal(getOut);
        if (out > 0) _pm.take(getOut, address(this), out);
        uint256 received = _bal(getOut) - before;
        return abi.encode(out, received);
    }

    function _bal(address c) private view returns (uint256) {
        return c == address(0) ? address(this).balance : IERC20Min(c).balanceOf(address(this));
    }

    receive() external payable {}
}
