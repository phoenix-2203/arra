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
///           Shipped  -- window passes with no dispute, claim() --> Released to supplier
///           Active   -- ship-by passes with no shipment, reclaim() --> Refunded to buyer
///         claim and reclaim can be triggered by anyone (the Arra agent automates them); the
///         funds still go only to the fixed party. The owner can pause new orders and set the
///         size cap, but can never move, freeze or redirect funds.
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
    }

    struct SplitOffer {
        address proposer;
        uint128 toSupplier; // the rest of `held` goes to the buyer
    }

    uint16 public constant MAX_DEPOSIT_BPS = 9_000; // at least 10% is always locked
    uint32 public constant MIN_DISPUTE_WINDOW = 1 days;
    uint32 public constant MAX_DISPUTE_WINDOW = 30 days;
    uint64 public constant MAX_SHIP_PERIOD = 180 days;

    IERC20 public immutable token;
    uint256 public maxOrder;
    bool public paused;
    uint256 public nextId = 1;
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
    event PartReleased(uint256 indexed id, uint256 amount, uint256 remaining);
    event SplitProposed(uint256 indexed id, address indexed proposer, uint256 toSupplier, uint256 toBuyer);
    event SplitSettled(uint256 indexed id, uint256 toSupplier, uint256 toBuyer);
    event BalanceReleased(uint256 indexed id, address indexed supplier, uint256 amount);
    event BalanceRefunded(uint256 indexed id, address indexed buyer, uint256 amount);
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

    constructor(IERC20 token_, uint256 maxOrder_, address owner_) Ownable(owner_) {
        token = token_;
        maxOrder = maxOrder_;
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
        bytes32 ref
    ) external nonReentrant returns (uint256 id) {
        if (paused) revert IsPaused();
        if (supplier == address(0) || supplier == msg.sender || supplier == address(this)) revert BadSupplier();
        if (total == 0 || total > maxOrder) revert BadAmount();
        if (depositBps > MAX_DEPOSIT_BPS) revert BadDeposit();
        if (acceptBy <= block.timestamp || acceptBy > shipBy || shipBy > block.timestamp + MAX_SHIP_PERIOD) {
            revert BadDates();
        }
        if (disputeWindow < MIN_DISPUTE_WINDOW || disputeWindow > MAX_DISPUTE_WINDOW) revert BadWindow();

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
            ref: ref
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
        if (block.timestamp > uint256(o.shippedAt) + o.disputeWindow) revert TooLate();
        o.status = Status.Disputed;
        emit OrderDisputed(id);
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
        _splits[id] = SplitOffer({proposer: msg.sender, toSupplier: toSupplier});
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
        if (block.timestamp <= uint256(o.shippedAt) + o.disputeWindow) revert TooEarly();
        _payOut(id, o, o.supplier, Status.Released);
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
        _payOut(id, o, o.buyer, Status.Refunded);
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

    function _requireLive(Order storage o) private view {
        if (o.status != Status.Active && o.status != Status.Shipped && o.status != Status.Disputed) {
            revert WrongStatus();
        }
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
