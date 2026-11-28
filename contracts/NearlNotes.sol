// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/// @title NEARL structured notes (cash-settled, coupon side)
/// @notice Users deposit a stablecoin into a note series. On each observation date the
///         underlying price (Chainlink feed) is compared with the price recorded at start.
///         "The price on a date" is always the first feed round updated at or after that date,
///         so it does not depend on who calls, or when (subscription end for the start price):
///           - price >= autocall level  -> coupon paid, note ends early, full principal back
///           - price >= barrier          -> coupon paid
///           - price <  barrier          -> no coupon
///         At the final observation, if the price is below the barrier, principal is paid
///         back multiplied by (final price / initial price). The difference goes to the issuer.
///
///         Solvency: the issuer (owner) pre-funds every possible coupon for the full series
///         capacity when the series is created, so the contract can always pay what it owes.
///
/// @dev    UNAUDITED. Only standard ERC20 tokens (no fee-on-transfer / rebasing tokens).
contract NearlNotes is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        Subscription, // accepting deposits
        Active,       // initial price recorded, observations running
        Autocalled,   // ended early, full principal
        Matured,      // ended at final observation
        Emergency     // oracle/keeper failure: full principal back, paid coupons kept
    }

    struct SeriesParams {
        AggregatorV3Interface feed;
        uint16 barrierBps;      // e.g. 7000 = 70% of initial price
        uint16 autocallBps;     // e.g. 10000 = 100% of initial price
        uint16 couponBps;       // coupon per observation, e.g. 240 = 2.4%
        uint32 maxPriceAge;     // the first round after a date must come within this many seconds of it
        uint64 subscriptionEnd; // deposits close at this timestamp
        uint64[] observationTimes; // strictly increasing, all after subscriptionEnd
        uint256 perUserCap;     // max deposit per wallet (asset units)
        uint256 totalCap;       // max total deposits (asset units)
    }

    struct Series {
        AggregatorV3Interface feed;
        uint16 barrierBps;
        uint16 autocallBps;
        uint16 couponBps;
        uint32 maxPriceAge;
        uint64 subscriptionEnd;
        uint8 nextObservation;
        uint8 couponsPaid;
        Status status;
        bool issuerSettled;
        int256 initialPrice;
        uint256 perUserCap;
        uint256 totalCap;
        uint256 totalDeposits;
        uint256 couponReserve;
        uint256 payoutRatio; // 1e18 = 100% of principal
        uint64[] observationTimes;
    }

    struct Position {
        uint256 deposit;
        uint8 couponsClaimed;
        bool principalClaimed;
    }

    uint256 public constant MAX_OBSERVATIONS = 12;
    uint256 public constant MAX_COUPON_BPS = 2000;   // 20% per observation
    uint256 public constant MAX_AUTOCALL_BPS = 20000; // 200%
    uint256 public constant EMERGENCY_DELAY = 7 days;
    /// @notice How many rounds start()/observe() walk back from the latest one. Later calls pass the round.
    uint256 public constant MAX_ROUND_STEPS = 48;
    uint256 private constant BPS = 10_000;
    uint256 private constant ONE = 1e18;

    IERC20 public immutable asset;

    uint256 public seriesCount;
    mapping(uint256 => Series) private _series;
    mapping(uint256 => mapping(address => Position)) private _positions;

    event SeriesCreated(uint256 indexed id, address indexed feed, uint256 couponReserve);
    event Deposited(uint256 indexed id, address indexed user, uint256 amount);
    event Started(uint256 indexed id, int256 initialPrice);
    event Observed(uint256 indexed id, uint8 indexed index, int256 price, bool couponPaid, Status status);
    event Claimed(uint256 indexed id, address indexed user, uint256 coupons, uint256 principal);
    event EmergencyTriggered(uint256 indexed id);
    event IssuerSettled(uint256 indexed id, uint256 amount);
    /// @notice The feed round used for a date: `index` 0 is the start price, i + 1 is observation i.
    event PriceRound(uint256 indexed id, uint8 indexed index, uint80 roundId, uint256 updatedAt);

    error InvalidParams();
    error WrongStatus();
    error TooEarly();
    error TooLate();
    error CapExceeded();
    error ZeroAmount();
    error BadPrice();
    error StalePrice();
    error NothingToClaim();
    error UnknownSeries();
    error WrongRound();
    error RoundHintNeeded();
    error RenounceDisabled();

    constructor(IERC20 asset_, address owner_) Ownable(owner_) {
        if (address(asset_) == address(0)) revert InvalidParams();
        asset = asset_;
    }

    // ------------------------------------------------------------------ issuer

    /// @notice Create a series. Pulls the full coupon reserve from the owner.
    function createSeries(SeriesParams calldata p) external onlyOwner nonReentrant returns (uint256 id) {
        uint256 n = p.observationTimes.length;
        if (
            address(p.feed) == address(0) || n == 0 || n > MAX_OBSERVATIONS || p.barrierBps == 0
                || p.barrierBps > BPS || p.autocallBps < p.barrierBps || p.autocallBps > MAX_AUTOCALL_BPS
                || p.couponBps == 0 || p.couponBps > MAX_COUPON_BPS || p.maxPriceAge == 0
                || p.subscriptionEnd <= block.timestamp || p.perUserCap == 0 || p.perUserCap > p.totalCap
        ) revert InvalidParams();

        uint64 prev = p.subscriptionEnd;
        for (uint256 i; i < n; ++i) {
            if (p.observationTimes[i] <= prev) revert InvalidParams();
            prev = p.observationTimes[i];
        }

        uint256 reserve = (p.totalCap * p.couponBps * n) / BPS;
        if (reserve == 0) revert InvalidParams();

        id = seriesCount++;
        Series storage s = _series[id];
        s.feed = p.feed;
        s.barrierBps = p.barrierBps;
        s.autocallBps = p.autocallBps;
        s.couponBps = p.couponBps;
        s.maxPriceAge = p.maxPriceAge;
        s.subscriptionEnd = p.subscriptionEnd;
        s.perUserCap = p.perUserCap;
        s.totalCap = p.totalCap;
        s.couponReserve = reserve;
        s.observationTimes = p.observationTimes;

        asset.safeTransferFrom(msg.sender, address(this), reserve);
        emit SeriesCreated(id, address(p.feed), reserve);
    }

    /// @notice After a series ends, the issuer withdraws the unused coupon reserve
    ///         plus any principal kept from a below-barrier maturity.
    function settleIssuer(uint256 id) external onlyOwner nonReentrant {
        Series storage s = _get(id);
        if (!_isFinal(s.status) || s.issuerSettled) revert WrongStatus();
        s.issuerSettled = true;

        uint256 couponsOwed = (s.totalDeposits * s.couponBps * s.couponsPaid) / BPS;
        uint256 principalKept = (s.totalDeposits * (ONE - s.payoutRatio)) / ONE;
        uint256 amount = s.couponReserve - couponsOwed + principalKept;

        if (amount > 0) asset.safeTransfer(msg.sender, amount);
        emit IssuerSettled(id, amount);
    }

    /// @notice Pause new deposits. Claims, observations and emergency exits keep working.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Disabled: without an owner, settleIssuer() could never run and the reserve would stay locked.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ------------------------------------------------------------------ users

    function deposit(uint256 id, uint256 amount) external nonReentrant whenNotPaused {
        Series storage s = _get(id);
        if (s.status != Status.Subscription) revert WrongStatus();
        if (block.timestamp >= s.subscriptionEnd) revert TooLate();
        if (amount == 0) revert ZeroAmount();

        Position storage pos = _positions[id][msg.sender];
        if (pos.deposit + amount > s.perUserCap || s.totalDeposits + amount > s.totalCap) revert CapExceeded();

        pos.deposit += amount;
        s.totalDeposits += amount;
        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(id, msg.sender, amount);
    }

    /// @notice Claim paid coupons at any time, and principal once the series has ended.
    function claim(uint256 id) external nonReentrant {
        Series storage s = _get(id);
        Position storage pos = _positions[id][msg.sender];
        (uint256 coupons, uint256 principal) = _claimable(s, pos);
        if (coupons + principal == 0) revert NothingToClaim();

        pos.couponsClaimed = s.couponsPaid;
        if (principal > 0 || _isFinal(s.status)) pos.principalClaimed = true;

        asset.safeTransfer(msg.sender, coupons + principal);
        emit Claimed(id, msg.sender, coupons, principal);
    }

    // ------------------------------------------------------------------ keepers (anyone)

    /// @notice Record the initial price once subscription has closed: the first feed round
    ///         at or after subscriptionEnd, found by walking back from the latest round.
    function start(uint256 id) external nonReentrant {
        _start(id, 0);
    }

    /// @notice Same as start(), for a late call: pass the first round at or after subscriptionEnd.
    ///         Any other round is refused, so the result is the same whoever calls.
    function startAt(uint256 id, uint80 roundId) external nonReentrant {
        if (roundId == 0) revert WrongRound();
        _start(id, roundId);
    }

    /// @notice Run the next due observation, at the first feed round at or after its date.
    function observe(uint256 id) external nonReentrant {
        _observe(id, 0);
    }

    /// @notice Same as observe(), for a late call: pass the first round at or after the date.
    function observeAt(uint256 id, uint80 roundId) external nonReentrant {
        if (roundId == 0) revert WrongRound();
        _observe(id, roundId);
    }

    function _start(uint256 id, uint80 hint) private {
        Series storage s = _get(id);
        if (s.status != Status.Subscription) revert WrongStatus();
        if (block.timestamp < s.subscriptionEnd) revert TooEarly();

        if (s.totalDeposits == 0) {
            // Nobody subscribed: close the series so the issuer can recover the reserve.
            s.status = Status.Matured;
            s.payoutRatio = ONE;
            emit Observed(id, 0, 0, false, Status.Matured);
            return;
        }

        int256 price = _priceAt(s, id, 0, s.subscriptionEnd, hint);
        s.initialPrice = price;
        s.status = Status.Active;
        emit Started(id, price);
    }

    function _observe(uint256 id, uint80 hint) private {
        Series storage s = _get(id);
        if (s.status != Status.Active) revert WrongStatus();

        uint8 i = s.nextObservation;
        uint64 t = s.observationTimes[i];
        if (block.timestamp < t) revert TooEarly();

        int256 price = _priceAt(s, id, i + 1, t, hint);
        uint256 levelBps = (uint256(price) * BPS) / uint256(s.initialPrice);
        bool couponPaid;

        if (levelBps >= s.autocallBps) {
            couponPaid = true;
            s.couponsPaid += 1;
            s.status = Status.Autocalled;
            s.payoutRatio = ONE;
        } else {
            if (levelBps >= s.barrierBps) {
                couponPaid = true;
                s.couponsPaid += 1;
            }
            s.nextObservation = i + 1;
            if (s.nextObservation == s.observationTimes.length) {
                s.status = Status.Matured;
                s.payoutRatio = levelBps >= s.barrierBps ? ONE : (uint256(price) * ONE) / uint256(s.initialPrice);
            }
        }
        emit Observed(id, i, price, couponPaid, s.status);
    }

    /// @notice If the oracle or keepers fail for EMERGENCY_DELAY after a due date,
    ///         anyone can end the series: depositors get full principal back.
    function triggerEmergency(uint256 id) external nonReentrant {
        Series storage s = _get(id);
        uint256 due;
        if (s.status == Status.Subscription) due = s.subscriptionEnd;
        else if (s.status == Status.Active) due = s.observationTimes[s.nextObservation];
        else revert WrongStatus();
        if (block.timestamp < due + EMERGENCY_DELAY) revert TooEarly();

        s.status = Status.Emergency;
        s.payoutRatio = ONE;
        emit EmergencyTriggered(id);
    }

    // ------------------------------------------------------------------ views

    function getSeries(uint256 id) external view returns (Series memory) {
        if (id >= seriesCount) revert UnknownSeries();
        return _series[id];
    }

    function getPosition(uint256 id, address user) external view returns (Position memory) {
        return _positions[id][user];
    }

    function claimable(uint256 id, address user) external view returns (uint256 coupons, uint256 principal) {
        if (id >= seriesCount) revert UnknownSeries();
        return _claimable(_series[id], _positions[id][user]);
    }

    // ------------------------------------------------------------------ internal

    function _get(uint256 id) private view returns (Series storage) {
        if (id >= seriesCount) revert UnknownSeries();
        return _series[id];
    }

    function _isFinal(Status st) private pure returns (bool) {
        return st == Status.Autocalled || st == Status.Matured || st == Status.Emergency;
    }

    function _claimable(Series storage s, Position storage pos)
        private
        view
        returns (uint256 coupons, uint256 principal)
    {
        if (pos.deposit == 0) return (0, 0);
        coupons = (pos.deposit * s.couponBps * (s.couponsPaid - pos.couponsClaimed)) / BPS;
        if (_isFinal(s.status) && !pos.principalClaimed) {
            principal = (pos.deposit * s.payoutRatio) / ONE;
        }
    }

    /// @dev The price for date `t`: the first feed round updated at or after `t`.
    ///      With `hint` 0 the round is found by walking back from the latest one (at most
    ///      MAX_ROUND_STEPS); otherwise `hint` must be that exact round. A round is the first
    ///      one if the round before it (same phase) was updated before `t`. The first round of a
    ///      phase has no earlier round in that phase and is accepted as is. The round must also
    ///      come within maxPriceAge of `t`; if the feed was silent longer, the date can only end
    ///      through triggerEmergency().
    function _priceAt(Series storage s, uint256 id, uint8 index, uint64 t, uint80 hint)
        private
        returns (int256)
    {
        AggregatorV3Interface feed = s.feed;
        uint80 rid = hint;
        int256 answer;
        uint256 updatedAt;
        if (rid == 0) {
            (rid, answer,, updatedAt,) = feed.latestRoundData();
            if (updatedAt < t) revert StalePrice(); // no round since the date yet
        } else {
            uint80 got;
            (got, answer,, updatedAt,) = feed.getRoundData(rid);
            if (got != rid || updatedAt == 0 || updatedAt < t) revert WrongRound();
        }

        for (uint256 steps;;) {
            if (uint64(rid) <= 1) break; // first round of its phase
            (, int256 prevAnswer,, uint256 prevUpdated,) = feed.getRoundData(rid - 1);
            if (prevUpdated == 0) revert BadPrice(); // a missing round: the first one cannot be proven
            if (prevUpdated < t) break;
            if (hint != 0) revert WrongRound(); // the hint is not the first round after the date
            if (++steps > MAX_ROUND_STEPS) revert RoundHintNeeded();
            rid -= 1;
            answer = prevAnswer;
            updatedAt = prevUpdated;
        }

        if (answer <= 0) revert BadPrice();
        if (updatedAt - t > s.maxPriceAge) revert StalePrice();
        emit PriceRound(id, index, rid, updatedAt);
        return answer;
    }
}
