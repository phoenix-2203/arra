// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title ArraVault
/// @notice An "arra" is the ancient word for earnest money: the deposit that seals a deal.
///         A buyer funds an order. The supplier signs to accept it from their payout address,
///         which pays them the deposit at once and locks the balance for them alone.
///         Funds held here can only ever go to that supplier, or back to the buyer.
/// @dev    Order lifecycle:
///           Pending  -- supplier accept()                 --> Active (deposit paid to supplier)
///           Pending  -- buyer/supplier cancel, or accept-by passes --> Refunded (all back to buyer)
///           Active   -- supplier markShipped()            --> Shipped
///           Shipped  -- buyer dispute() within window     --> Disputed
///           Active|Shipped|Disputed:
///             buyer releasePart()/release()  -> balance (or part) to supplier
///             supplier cancel()              -> balance back to buyer
///             proposeSplit() + acceptSplit() -> agreed split, settled in one transaction
///           Shipped  -- buyer confirmArrival() starts the check window (else shippedAt + transit)
///           Shipped  -- window passes with no dispute, claim() --> Released to supplier
///           Disputed -- ignored offer (7 days) or 30 days unresolved, resolveDispute() --> Settled
///           Pending|Active -- buyer extendDeadlines() moves accept-by / ship-by later
///           Active   -- ship-by passes with no shipment, reclaim() --> Refunded to buyer
///         claim and reclaim can be triggered by anyone (the Arra agent automates them); the
///         funds still go only to the fixed party, except a fixed keeper fee (set once at
///         deployment, e.g. $0.01) paid to a caller who is neither the buyer nor the supplier,
///         so the agent that keeps deadlines pays for itself. The owner can pause new orders
///         and set the size cap, but can never move, freeze or redirect funds.
///         v3: keeper fee, and order numbers can start after a previous vault's.
///         v4: the buyer can move deadlines later (never earlier); the check period starts when
///         the buyer confirms arrival (or after a transit backstop); a dispute can't freeze money
///         forever: an ignored split offer settles after 7 days, and 30 days after the problem
///         was raised the balance is split 50/50.
contract ArraVault is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Pending, // funded by buyer, waiting for the supplier to accept
        Active, // accepted: deposit paid, balance locked, waiting for shipment
        Shipped, // supplier marked shipped; buyer dispute window running
        Disputed, // buyer disputed; resolved by release, cancel or an agreed split
        Released, // balance paid to supplier
        Refunded, // balance (and deposit, if never accepted) returned to buyer
        Settled // balance split between both parties by agreement
    }

    struct Order {
        address buyer;
        address supplier;
        uint128 total; // deposit + balance, in token units
        uint128 deposit; // paid to supplier on acceptance
        uint128 held; // what this contract currently holds for the order
        uint64 acceptBy; // supplier must accept by this time
        uint64 shipBy; // supplier must mark shipped by this time
        uint64 shippedAt; // when supplier marked shipped (0 if not)
        uint32 disputeWindow; // seconds the buyer has to dispute after shipment
        Status status;
        bytes32 ref; // fingerprint (hash) of the agreed order sheet
        uint32 transit; // v4: longest expected time from shipping to arrival (0 = delivered on the spot)
        uint64 arrivedAt; // v4: when the buyer confirmed arrival (0 if not)
        uint64 disputedAt; // v4: when the buyer raised a problem (0 if not)
    }

    struct SplitOffer {
        address proposer;
        uint128 toSupplier; // the rest of `held` goes to the buyer
        uint64 at; // v4: when the offer was made
    }

    uint16 public constant MAX_DEPOSIT_BPS = 9_000; // at least 10% is always locked
    uint32 public constant MIN_DISPUTE_WINDOW = 1 days;
    uint32 public constant MAX_DISPUTE_WINDOW = 30 days;
    uint64 public constant MAX_SHIP_PERIOD = 180 days;
    uint32 public constant MAX_TRANSIT = 120 days;
    uint64 public constant DISPUTE_REPLY = 7 days; // an offer ignored this long can be settled
    uint64 public constant DISPUTE_MAX = 30 days; // after this, an unresolved dispute splits 50/50

    IERC20 public immutable token;
    /// @notice Paid from the order to whoever triggers a due claim/reclaim, unless that is the
    ///         buyer or the supplier themselves. Never more than what the order still holds.
    uint128 public immutable keeperFee;
    uint256 public maxOrder;
    bool public paused;
    uint256 public nextId;
    mapping(uint256 => Order) private _orders;
    mapping(uint256 => SplitOffer) private _splits;

    event OrderCreated(
        uint256 indexed id,
        address indexed buyer,
        address indexed supplier,
        uint256 total,
        uint256 deposit,
        uint64 acceptBy,
        uint64 shipBy,
        uint32 disputeWindow,
        bytes32 ref
    );
    event OrderAccepted(uint256 indexed id, address indexed supplier, uint256 depositPaid);
    event OrderShipped(uint256 indexed id, bytes32 trackingHash, uint64 shippedAt);
    event OrderDisputed(uint256 indexed id);
    event OrderArrived(uint256 indexed id, uint64 arrivedAt);
    event DeadlinesExtended(uint256 indexed id, uint64 acceptBy, uint64 shipBy);
    event DisputeResolved(uint256 indexed id, bool byDefault);
    event PartReleased(uint256 indexed id, uint256 amount, uint256 remaining);
    event SplitProposed(uint256 indexed id, address indexed proposer, uint256 toSupplier, uint256 toBuyer);
    event SplitSettled(uint256 indexed id, uint256 toSupplier, uint256 toBuyer);
    event BalanceReleased(uint256 indexed id, address indexed supplier, uint256 amount);
    event BalanceRefunded(uint256 indexed id, address indexed buyer, uint256 amount);
    event KeeperPaid(uint256 indexed id, address indexed keeper, uint256 fee);
    event MaxOrderUpdated(uint256 maxOrder);
    event PausedSet(bool paused);

    error IsPaused();
    error BadSupplier();
    error BadAmount();
    error BadDeposit();
    error BadDates();
    error BadWindow();
    error NotBuyer();
    error NotSupplier();
    error NotParty();
    error WrongStatus();
    error TooLate();
    error TooEarly();
    error NoOffer();
    error OfferMismatch();
    error TransferMismatch();

    /// @param firstId  number of this vault's first order (continues a previous vault's numbering)
    /// @param keeperFee_ fee for a third party that triggers a due refund or payout
    constructor(IERC20 token_, uint256 maxOrder_, address owner_, uint256 firstId, uint128 keeperFee_)
        Ownable(owner_)
    {
        if (firstId == 0) revert BadAmount();
        token = token_;
        maxOrder = maxOrder_;
        nextId = firstId;
        keeperFee = keeperFee_;
        emit MaxOrderUpdated(maxOrder_);
    }

    // ------------------------------------------------------------------ views

    function getOrder(uint256 id) external view returns (Order memory) {
        return _orders[id];
    }

    function getSplitOffer(uint256 id) external view returns (SplitOffer memory) {
        return _splits[id];
    }

    // ------------------------------------------------------------------ buyer

    /// @notice Fund an order. Nothing reaches the supplier until they accept by `acceptBy`.
    ///         Caller must approve `total` first.
    function createOrder(
        address supplier,
        uint128 total,
        uint16 depositBps,
        uint64 acceptBy,
        uint64 shipBy,
        uint32 disputeWindow,
        uint32 transit,
        bytes32 ref
    ) external nonReentrant returns (uint256 id) {
        if (paused) revert IsPaused();
        if (supplier == address(0) || supplier == msg.sender || supplier == address(this)) revert BadSupplier();
        // The order must be worth more than ten keeper fees, so the fee stays small.
        if (total == 0 || total > maxOrder || total <= uint256(keeperFee) * 10) revert BadAmount();
        if (depositBps > MAX_DEPOSIT_BPS) revert BadDeposit();
        if (acceptBy <= block.timestamp || acceptBy > shipBy || shipBy > block.timestamp + MAX_SHIP_PERIOD) {
            revert BadDates();
        }
        if (disputeWindow < MIN_DISPUTE_WINDOW || disputeWindow > MAX_DISPUTE_WINDOW) revert BadWindow();
        if (transit > MAX_TRANSIT) revert BadWindow();

        uint128 deposit = uint128((uint256(total) * depositBps) / 10_000);

        id = nextId++;
        _orders[id] = Order({
            buyer: msg.sender,
            supplier: supplier,
            total: total,
            deposit: deposit,
            held: total,
            acceptBy: acceptBy,
            shipBy: shipBy,
            shippedAt: 0,
            disputeWindow: disputeWindow,
            status: Status.Pending,
            ref: ref,
            transit: transit,
            arrivedAt: 0,
            disputedAt: 0
        });

        // Hold the full amount, and reject tokens that take a fee on transfer.
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), total);
        if (token.balanceOf(address(this)) - before != total) revert TransferMismatch();

        emit OrderCreated(id, msg.sender, supplier, total, deposit, acceptBy, shipBy, disputeWindow, ref);
    }

    /// @notice Buyer pays part of the locked balance to the supplier (staged release).
    function releasePart(uint256 id, uint128 amount) external nonReentrant {
        Order storage o = _orders[id];
        if (msg.sender != o.buyer) revert NotBuyer();
        _requireLive(o);
        if (amount == 0 || amount > o.held) revert BadAmount();
        o.held -= amount;
        delete _splits[id];
        if (o.held == 0) o.status = Status.Released;
        token.safeTransfer(o.supplier, amount);
        emit PartReleased(id, amount, o.held);
        if (o.held == 0) emit BalanceReleased(id, o.supplier, amount);
    }

    /// @notice Buyer pays the whole remaining balance to the supplier.
    function release(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        if (msg.sender != o.buyer) revert NotBuyer();
        _requireLive(o);
        _payOut(id, o, o.supplier, Status.Released);
    }

    /// @notice Buyer disputes a shipment inside the dispute window. Funds then move only by
    ///         release, cancel or an agreed split.
    function dispute(uint256 id) external {
        Order storage o = _orders[id];
        if (msg.sender != o.buyer) revert NotBuyer();
        if (o.status != Status.Shipped) revert WrongStatus();
        if (block.timestamp > uint256(_checkStart(o)) + o.disputeWindow) revert TooLate();
        o.status = Status.Disputed;
        o.disputedAt = uint64(block.timestamp);
        emit OrderDisputed(id);
    }

    /// @notice Buyer confirms the goods arrived; their check period starts now. Only before the
    ///         transit backstop (shipping + transit), after which the period has started anyway.
    function confirmArrival(uint256 id) external {
        Order storage o = _orders[id];
        if (msg.sender != o.buyer) revert NotBuyer();
        if (o.status != Status.Shipped || o.arrivedAt != 0) revert WrongStatus();
        if (block.timestamp > uint256(o.shippedAt) + o.transit) revert TooLate();
        o.arrivedAt = uint64(block.timestamp);
        emit OrderArrived(id, uint64(block.timestamp));
    }

    /// @notice Buyer gives the supplier more time: deadlines can only move later. Pending: accept-by
    ///         and ship-by; accepted: ship-by (even after it passed, as long as nobody has reclaimed).
    function extendDeadlines(uint256 id, uint64 newAcceptBy, uint64 newShipBy) external {
        Order storage o = _orders[id];
        if (msg.sender != o.buyer) revert NotBuyer();
        if (o.status == Status.Pending) {
            if (newAcceptBy < o.acceptBy || newAcceptBy <= block.timestamp) revert BadDates();
            o.acceptBy = newAcceptBy;
        } else if (o.status != Status.Active) {
            revert WrongStatus();
        }
        if (newShipBy < o.shipBy || newShipBy < o.acceptBy || newShipBy <= block.timestamp) revert BadDates();
        if (newShipBy > block.timestamp + MAX_SHIP_PERIOD) revert BadDates();
        o.shipBy = newShipBy;
        emit DeadlinesExtended(id, o.acceptBy, newShipBy);
    }

    // --------------------------------------------------------------- supplier

    /// @notice Supplier accepts the order from their payout address. Proves they control it,
    ///         pays them the deposit, and locks the balance for them.
    function accept(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        if (msg.sender != o.supplier) revert NotSupplier();
        if (o.status != Status.Pending) revert WrongStatus();
        if (block.timestamp > o.acceptBy) revert TooLate();
        uint128 deposit = o.deposit;
        o.held -= deposit;
        o.status = Status.Active;
        if (deposit > 0) token.safeTransfer(o.supplier, deposit);
        emit OrderAccepted(id, o.supplier, deposit);
    }

    /// @notice Supplier marks the order shipped, on or before the ship-by date.
    function markShipped(uint256 id, bytes32 trackingHash) external {
        Order storage o = _orders[id];
        if (msg.sender != o.supplier) revert NotSupplier();
        if (o.status != Status.Active) revert WrongStatus();
        if (block.timestamp > o.shipBy) revert TooLate();
        o.status = Status.Shipped;
        o.shippedAt = uint64(block.timestamp);
        emit OrderShipped(id, trackingHash, uint64(block.timestamp));
    }

    // ----------------------------------------------------------- either party

    /// @notice Cancel the order and return everything held to the buyer.
    ///         Buyer: only before the supplier accepts. Supplier: at any point before settlement.
    function cancel(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        if (msg.sender == o.supplier) {
            if (o.status != Status.Pending) _requireLive(o);
        } else if (msg.sender == o.buyer) {
            if (o.status != Status.Pending) revert WrongStatus();
        } else {
            revert NotParty();
        }
        _payOut(id, o, o.buyer, Status.Refunded);
    }

    /// @notice Offer to settle by splitting what is held: `toSupplier` to the supplier, the
    ///         rest to the buyer. A new offer replaces the previous one.
    function proposeSplit(uint256 id, uint128 toSupplier) external {
        Order storage o = _orders[id];
        if (msg.sender != o.buyer && msg.sender != o.supplier) revert NotParty();
        _requireLive(o);
        if (toSupplier > o.held) revert BadAmount();
        _splits[id] = SplitOffer({proposer: msg.sender, toSupplier: toSupplier, at: uint64(block.timestamp)});
        emit SplitProposed(id, msg.sender, toSupplier, o.held - toSupplier);
    }

    /// @notice The other party accepts the standing offer. `toSupplier` must match it exactly,
    ///         so an offer cannot be swapped underneath the person accepting.
    function acceptSplit(uint256 id, uint128 toSupplier) external nonReentrant {
        Order storage o = _orders[id];
        if (msg.sender != o.buyer && msg.sender != o.supplier) revert NotParty();
        _requireLive(o);
        SplitOffer memory offer = _splits[id];
        if (offer.proposer == address(0)) revert NoOffer();
        if (offer.proposer == msg.sender) revert NotParty();
        if (offer.toSupplier != toSupplier || toSupplier > o.held) revert OfferMismatch();
        uint128 toBuyer = o.held - toSupplier;
        o.held = 0;
        o.status = Status.Settled;
        delete _splits[id];
        if (toSupplier > 0) token.safeTransfer(o.supplier, toSupplier);
        if (toBuyer > 0) token.safeTransfer(o.buyer, toBuyer);
        emit SplitSettled(id, toSupplier, toBuyer);
    }

    // ------------------------------------------------ anyone (agent automation)

    /// @notice After shipment and an undisputed window, pays the supplier. Callable by anyone.
    function claim(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        if (o.status != Status.Shipped) revert WrongStatus();
        if (block.timestamp <= uint256(_checkStart(o)) + o.disputeWindow) revert TooEarly();
        uint128 fee = _takeKeeperFee(o);
        _payOut(id, o, o.supplier, Status.Released);
        _sendKeeperFee(id, fee);
    }

    /// @notice Returns funds to the buyer if the supplier never accepted by the accept-by date,
    ///         or accepted but never shipped by the ship-by date. Callable by anyone.
    function reclaim(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        if (o.status == Status.Pending) {
            if (block.timestamp <= o.acceptBy) revert TooEarly();
        } else if (o.status == Status.Active) {
            if (block.timestamp <= o.shipBy) revert TooEarly();
        } else {
            revert WrongStatus();
        }
        uint128 fee = _takeKeeperFee(o);
        _payOut(id, o, o.buyer, Status.Refunded);
        _sendKeeperFee(id, fee);
    }

    /// @notice Ends a dispute nobody is resolving. Callable by anyone (the Arra agent automates it):
    ///         a split offer the other side ignored for DISPUTE_REPLY settles as offered; with no
    ///         settlement DISPUTE_MAX after the problem was raised, what's held splits 50/50.
    function resolveDispute(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        if (o.status != Status.Disputed) revert WrongStatus();
        SplitOffer memory offer = _splits[id];
        // The reply clock never starts before the dispute, so an old offer made earlier can't
        // settle the moment a problem is raised: the other side always gets DISPUTE_REPLY.
        uint256 offeredAt = offer.at > o.disputedAt ? offer.at : o.disputedAt;
        bool stale = offer.proposer != address(0) && block.timestamp > offeredAt + DISPUTE_REPLY;
        bool expired = block.timestamp > uint256(o.disputedAt) + DISPUTE_MAX;
        if (!stale && !expired) revert TooEarly();
        uint128 fee = _takeKeeperFee(o);
        uint128 held = o.held;
        uint128 toSupplier = stale ? (offer.toSupplier < held ? offer.toSupplier : held) : held / 2;
        uint128 toBuyer = held - toSupplier;
        o.held = 0;
        o.status = Status.Settled;
        delete _splits[id];
        if (toSupplier > 0) token.safeTransfer(o.supplier, toSupplier);
        if (toBuyer > 0) token.safeTransfer(o.buyer, toBuyer);
        emit SplitSettled(id, toSupplier, toBuyer);
        emit DisputeResolved(id, !stale);
        _sendKeeperFee(id, fee);
    }

    // ------------------------------------------------------------------ owner

    function setMaxOrder(uint256 maxOrder_) external onlyOwner {
        maxOrder = maxOrder_;
        emit MaxOrderUpdated(maxOrder_);
    }

    /// @notice Pausing only blocks new orders. Existing funds always stay withdrawable.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    // --------------------------------------------------------------- internal

    /// @dev The buyer's check period starts at confirmed arrival, else at the transit backstop.
    function _checkStart(Order storage o) private view returns (uint64) {
        return o.arrivedAt != 0 ? o.arrivedAt : o.shippedAt + o.transit;
    }

    function _requireLive(Order storage o) private view {
        if (o.status != Status.Active && o.status != Status.Shipped && o.status != Status.Disputed) {
            revert WrongStatus();
        }
    }

    /// @dev The keeper fee comes out of what the order holds; the buyer or supplier triggering
    ///      it themselves pays nothing.
    ///      Bookkeeping first (here), money second (_sendKeeperFee, after the payout).
    function _takeKeeperFee(Order storage o) private returns (uint128 fee) {
        if (keeperFee == 0 || msg.sender == o.buyer || msg.sender == o.supplier) return 0;
        fee = keeperFee < o.held ? keeperFee : o.held;
        o.held -= fee;
    }

    function _sendKeeperFee(uint256 id, uint128 fee) private {
        if (fee == 0) return;
        token.safeTransfer(msg.sender, fee);
        emit KeeperPaid(id, msg.sender, fee);
    }

    function _payOut(uint256 id, Order storage o, address to, Status finalStatus) private {
        uint128 amount = o.held;
        o.held = 0;
        o.status = finalStatus;
        delete _splits[id];
        if (amount > 0) token.safeTransfer(to, amount);
        if (finalStatus == Status.Released) emit BalanceReleased(id, to, amount);
        else emit BalanceRefunded(id, to, amount);
    }
}
