// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title ArraVault
/// @notice An "arra" is the ancient word for earnest money: the deposit that seals a deal.
///         A buyer pays a deposit to a supplier now and locks the balance for that one
///         supplier. The balance can only ever go to the supplier, or back to the buyer.
/// @dev    Money paths, and the only ones:
///         1. createOrder  -> deposit to supplier, balance locked here
///         2. release      -> buyer sends the balance to the supplier
///         3. claim        -> supplier gets the balance after marking shipped and the
///                            buyer's dispute window passes with no dispute
///         4. cancel       -> supplier returns the balance to the buyer
///         5. reclaim      -> balance returns to the buyer if nothing shipped by the ship-by date
///         claim and reclaim can be triggered by anyone (e.g. the Arra agent); funds still
///         go only to the fixed party. The owner can pause new orders and set the size cap,
///         but can never move, freeze or redirect funds.
contract ArraVault is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Funded, // deposit paid, balance locked, waiting for shipment
        Shipped, // supplier marked shipped; buyer dispute window running
        Disputed, // buyer disputed; resolved only by release or cancel
        Released, // balance paid to supplier
        Refunded // balance returned to buyer
    }

    struct Order {
        address buyer;
        address supplier;
        uint128 total; // deposit + balance, in token units
        uint128 balance; // amount locked in this contract
        uint64 shipBy; // supplier must mark shipped by this time
        uint64 shippedAt; // when supplier marked shipped (0 if not)
        uint32 disputeWindow; // seconds the buyer has to dispute after shipment
        Status status;
        bytes32 ref; // hash of off-chain order details
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

    event OrderCreated(
        uint256 indexed id,
        address indexed buyer,
        address indexed supplier,
        uint256 total,
        uint256 deposit,
        uint256 balance,
        uint64 shipBy,
        uint32 disputeWindow,
        bytes32 ref
    );
    event OrderShipped(uint256 indexed id, bytes32 trackingHash, uint64 shippedAt);
    event OrderDisputed(uint256 indexed id);
    event BalanceReleased(uint256 indexed id, address indexed supplier, uint256 amount);
    event BalanceRefunded(uint256 indexed id, address indexed buyer, uint256 amount);
    event MaxOrderUpdated(uint256 maxOrder);
    event PausedSet(bool paused);

    error IsPaused();
    error BadSupplier();
    error BadAmount();
    error BadDeposit();
    error BadShipBy();
    error BadWindow();
    error NotBuyer();
    error NotSupplier();
    error WrongStatus();
    error TooLate();
    error TooEarly();
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

    // ------------------------------------------------------------------ buyer

    /// @notice Create an order: pays `depositBps` of `total` to the supplier now and
    ///         locks the rest for that supplier. Caller must approve `total` first.
    function createOrder(
        address supplier,
        uint128 total,
        uint16 depositBps,
        uint64 shipBy,
        uint32 disputeWindow,
        bytes32 ref
    ) external nonReentrant returns (uint256 id) {
        if (paused) revert IsPaused();
        if (supplier == address(0) || supplier == msg.sender || supplier == address(this)) revert BadSupplier();
        if (total == 0 || total > maxOrder) revert BadAmount();
        if (depositBps > MAX_DEPOSIT_BPS) revert BadDeposit();
        if (shipBy <= block.timestamp || shipBy > block.timestamp + MAX_SHIP_PERIOD) revert BadShipBy();
        if (disputeWindow < MIN_DISPUTE_WINDOW || disputeWindow > MAX_DISPUTE_WINDOW) revert BadWindow();

        uint128 deposit = uint128((uint256(total) * depositBps) / 10_000);
        uint128 balance = total - deposit;

        id = nextId++;
        _orders[id] = Order({
            buyer: msg.sender,
            supplier: supplier,
            total: total,
            balance: balance,
            shipBy: shipBy,
            shippedAt: 0,
            disputeWindow: disputeWindow,
            status: Status.Funded,
            ref: ref
        });

        // Lock the balance here, and reject tokens that take a fee on transfer.
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), balance);
        if (token.balanceOf(address(this)) - before != balance) revert TransferMismatch();

        // Pay the deposit straight from buyer to supplier.
        if (deposit > 0) token.safeTransferFrom(msg.sender, supplier, deposit);

        emit OrderCreated(id, msg.sender, supplier, total, deposit, balance, shipBy, disputeWindow, ref);
    }

    /// @notice Buyer pays the locked balance to the supplier (goods received, or deal resolved).
    function release(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        if (msg.sender != o.buyer) revert NotBuyer();
        if (o.status != Status.Funded && o.status != Status.Shipped && o.status != Status.Disputed) {
            revert WrongStatus();
        }
        _payOut(id, o, o.supplier, Status.Released);
    }

    /// @notice Buyer disputes a shipment inside the dispute window. Funds then move only
    ///         when the buyer releases or the supplier cancels.
    function dispute(uint256 id) external {
        Order storage o = _orders[id];
        if (msg.sender != o.buyer) revert NotBuyer();
        if (o.status != Status.Shipped) revert WrongStatus();
        if (block.timestamp > uint256(o.shippedAt) + o.disputeWindow) revert TooLate();
        o.status = Status.Disputed;
        emit OrderDisputed(id);
    }

    // --------------------------------------------------------------- supplier

    /// @notice Supplier marks the order shipped, on or before the ship-by date.
    function markShipped(uint256 id, bytes32 trackingHash) external {
        Order storage o = _orders[id];
        if (msg.sender != o.supplier) revert NotSupplier();
        if (o.status != Status.Funded) revert WrongStatus();
        if (block.timestamp > o.shipBy) revert TooLate();
        o.status = Status.Shipped;
        o.shippedAt = uint64(block.timestamp);
        emit OrderShipped(id, trackingHash, uint64(block.timestamp));
    }

    /// @notice Supplier returns the locked balance to the buyer (cannot fulfil, or settles a dispute).
    function cancel(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        if (msg.sender != o.supplier) revert NotSupplier();
        if (o.status != Status.Funded && o.status != Status.Shipped && o.status != Status.Disputed) {
            revert WrongStatus();
        }
        _payOut(id, o, o.buyer, Status.Refunded);
    }

    // ------------------------------------------------ anyone (agent automation)

    /// @notice After shipment and an undisputed window, pays the supplier. Callable by anyone.
    function claim(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        if (o.status != Status.Shipped) revert WrongStatus();
        if (block.timestamp <= uint256(o.shippedAt) + o.disputeWindow) revert TooEarly();
        _payOut(id, o, o.supplier, Status.Released);
    }

    /// @notice If nothing shipped by the ship-by date, returns the balance to the buyer.
    ///         Callable by anyone.
    function reclaim(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        if (o.status != Status.Funded) revert WrongStatus();
        if (block.timestamp <= o.shipBy) revert TooEarly();
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

    function _payOut(uint256 id, Order storage o, address to, Status finalStatus) private {
        uint128 amount = o.balance;
        o.balance = 0;
        o.status = finalStatus;
        if (amount > 0) token.safeTransfer(to, amount);
        if (finalStatus == Status.Released) emit BalanceReleased(id, to, amount);
        else emit BalanceRefunded(id, to, amount);
    }
}
