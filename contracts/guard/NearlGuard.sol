// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title NEARL Guard: a wallet an AI agent can use but cannot empty
/// @notice The owner funds the wallet and sets rules. The agent key can only:
///           - send tokens to recipients the owner approved, or
///           - call contracts the owner approved (e.g. a DEX router), spending one token per call,
///         and every spend counts against a daily limit and a per-transaction limit per token.
///         Withdrawals only ever go to the owner. The owner can pause the agent at any time.
/// @dev    UNAUDITED. Spend limits bound the loss if the agent key leaks, but an approved
///         target (e.g. a router) may still send swap output to any address chosen by the agent.
contract NearlGuard is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant ETH = address(0);

    struct Limit {
        uint128 daily;   // max spend per UTC day (0 = token not allowed)
        uint128 perTx;   // max spend per action
    }

    address public immutable owner;
    address public agent;
    bool public paused;

    mapping(address => Limit) public limits;              // token => limits
    mapping(address => mapping(uint256 => uint256)) public spentOn; // token => day => spent
    mapping(address => bool) public allowedTarget;         // contracts the agent may call
    mapping(address => bool) public allowedRecipient;      // wallets the agent may pay

    event AgentChanged(address indexed agent);
    event Paused(bool paused);
    event LimitSet(address indexed token, uint256 daily, uint256 perTx);
    event TargetSet(address indexed target, bool allowed);
    event RecipientSet(address indexed recipient, bool allowed);
    event Spent(address indexed token, address indexed to, uint256 amount, bytes4 selector, uint256 day);
    event Withdrawn(address indexed token, uint256 amount);
    event Funded(address indexed from, uint256 amount);

    error NotOwner();
    error NotAgent();
    error IsPaused();
    error NotAllowed();
    error OverPerTx();
    error OverDaily();
    error CallFailed(bytes reason);
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        if (paused) revert IsPaused();
        _;
    }

    constructor(address owner_, address agent_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        agent = agent_;
        emit AgentChanged(agent_);
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    // ---------------------------------------------------------------- owner

    function setAgent(address agent_) external onlyOwner {
        agent = agent_;
        emit AgentChanged(agent_);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit Paused(p);
    }

    /// @param token use address(0) for ETH. daily = 0 blocks the token.
    function setLimit(address token, uint128 daily, uint128 perTx) external onlyOwner {
        limits[token] = Limit(daily, perTx > daily ? daily : perTx);
        emit LimitSet(token, daily, perTx > daily ? daily : perTx);
    }

    function setTarget(address target, bool allowed) external onlyOwner {
        if (target == address(this)) revert NotAllowed();
        allowedTarget[target] = allowed;
        emit TargetSet(target, allowed);
    }

    function setRecipient(address recipient, bool allowed) external onlyOwner {
        allowedRecipient[recipient] = allowed;
        emit RecipientSet(recipient, allowed);
    }

    /// @notice Withdrawals only go to the owner.
    function withdraw(address token, uint256 amount) external onlyOwner nonReentrant {
        if (token == ETH) {
            (bool ok, bytes memory r) = owner.call{value: amount}("");
            if (!ok) revert CallFailed(r);
        } else {
            IERC20(token).safeTransfer(owner, amount);
        }
        emit Withdrawn(token, amount);
    }

    // ---------------------------------------------------------------- agent

    /// @notice Pay an approved recipient.
    function pay(address token, address to, uint256 amount) external onlyAgent nonReentrant {
        if (!allowedRecipient[to]) revert NotAllowed();
        _spend(token, amount);
        if (token == ETH) {
            (bool ok, bytes memory r) = to.call{value: amount}("");
            if (!ok) revert CallFailed(r);
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
        emit Spent(token, to, amount, bytes4(0), _day());
    }

    /// @notice Call an approved contract (e.g. a DEX router), spending at most `maxSpend` of `token`.
    ///         For ERC-20s the target gets an exact, temporary allowance that is reset after the call.
    ///         The real amount spent is measured from the balance change and checked against limits.
    function execute(address target, bytes calldata data, address token, uint256 maxSpend)
        external
        onlyAgent
        nonReentrant
        returns (bytes memory result)
    {
        if (!allowedTarget[target]) revert NotAllowed();
        Limit memory l = limits[token];
        if (l.daily == 0) revert NotAllowed();
        if (maxSpend > l.perTx) revert OverPerTx();

        uint256 before = _balance(token);
        bool ok;
        if (token == ETH) {
            (ok, result) = target.call{value: maxSpend}(data);
        } else {
            IERC20(token).forceApprove(target, maxSpend);
            (ok, result) = target.call(data);
            IERC20(token).forceApprove(target, 0);
        }
        if (!ok) revert CallFailed(result);

        uint256 afterBal = _balance(token);
        uint256 spent = before > afterBal ? before - afterBal : 0;
        _spend(token, spent);
        emit Spent(token, target, spent, data.length >= 4 ? bytes4(data[:4]) : bytes4(0), _day());
    }

    // ---------------------------------------------------------------- views

    function spentToday(address token) external view returns (uint256) {
        return spentOn[token][_day()];
    }

    function remainingToday(address token) external view returns (uint256) {
        uint256 s = spentOn[token][_day()];
        uint256 d = limits[token].daily;
        return s >= d ? 0 : d - s;
    }

    // ---------------------------------------------------------------- internal

    function _spend(address token, uint256 amount) private {
        Limit memory l = limits[token];
        if (l.daily == 0) revert NotAllowed();
        if (amount > l.perTx) revert OverPerTx();
        uint256 d = _day();
        uint256 s = spentOn[token][d] + amount;
        if (s > l.daily) revert OverDaily();
        spentOn[token][d] = s;
    }

    function _balance(address token) private view returns (uint256) {
        return token == ETH ? address(this).balance : IERC20(token).balanceOf(address(this));
    }

    function _day() private view returns (uint256) {
        return block.timestamp / 1 days;
    }
}
