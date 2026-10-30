// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArraVault} from "../src/ArraVault.sol";

contract MockUSDT is ERC20 {
    constructor() ERC20("Tether USD", "USDT") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract FeeToken is ERC20 {
    constructor() ERC20("Fee", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            super._update(from, to, value - value / 100);
            super._update(from, address(0xdead), value / 100);
        } else {
            super._update(from, to, value);
        }
    }
}

contract ArraVaultTest is Test {
    MockUSDT usdt;
    ArraVault vault;

    address owner = makeAddr("owner");
    address buyer = makeAddr("buyer");
    address supplier = makeAddr("supplier");
    address stranger = makeAddr("stranger");

    uint128 constant TOTAL = 100e6; // $100
    uint16 constant DEP = 3_000; // 30%
    uint32 constant WINDOW = 7 days;
    bytes32 constant REF = keccak256("order-sheet-v1");
    uint256 constant START = 1_000e6;

    function setUp() public {
        usdt = new MockUSDT();
        vault = new ArraVault(IERC20(address(usdt)), 500e6, owner, 1, 0);
        usdt.mint(buyer, START);
        vm.prank(buyer);
        usdt.approve(address(vault), type(uint256).max);
    }

    function _create() internal returns (uint256 id) {
        vm.prank(buyer);
        id = vault.createOrder(
            supplier, TOTAL, DEP, uint64(block.timestamp + 3 days), uint64(block.timestamp + 30 days), WINDOW, 0, REF
        );
    }

    function _createAccepted() internal returns (uint256 id) {
        id = _create();
        vm.prank(supplier);
        vault.accept(id);
    }

    function _status(uint256 id) internal view returns (uint8) {
        return uint8(vault.getOrder(id).status);
    }

    // ------------------------------------------------------- create + accept

    function test_create_holdsEverythingUntilAccepted() public {
        uint256 id = _create();
        assertEq(usdt.balanceOf(address(vault)), TOTAL, "all held");
        assertEq(usdt.balanceOf(supplier), 0, "nothing to supplier yet");
        ArraVault.Order memory o = vault.getOrder(id);
        assertEq(o.held, TOTAL);
        assertEq(o.deposit, 30e6);
        assertEq(o.ref, REF);
        assertEq(uint8(o.status), uint8(ArraVault.Status.Pending));
    }

    function test_accept_paysDepositAndLocksBalance() public {
        uint256 id = _createAccepted();
        assertEq(usdt.balanceOf(supplier), 30e6, "deposit paid on acceptance");
        assertEq(usdt.balanceOf(address(vault)), 70e6, "balance locked");
        assertEq(vault.getOrder(id).held, 70e6);
        assertEq(_status(id), uint8(ArraVault.Status.Active));
    }

    function test_accept_onlyFromPayoutAddress() public {
        uint256 id = _create();
        vm.prank(stranger);
        vm.expectRevert(ArraVault.NotSupplier.selector);
        vault.accept(id);
        vm.prank(buyer);
        vm.expectRevert(ArraVault.NotSupplier.selector);
        vault.accept(id);
    }

    function test_accept_afterAcceptByFails_andBuyerReclaimsEverything() public {
        uint256 id = _create();
        vm.warp(block.timestamp + 3 days + 1);
        vm.prank(supplier);
        vm.expectRevert(ArraVault.TooLate.selector);
        vault.accept(id);
        vm.prank(stranger); // the agent can trigger it
        vault.reclaim(id);
        assertEq(usdt.balanceOf(buyer), START, "full refund, deposit included");
        assertEq(usdt.balanceOf(stranger), 0);
        assertEq(_status(id), uint8(ArraVault.Status.Refunded));
    }

    function test_reclaimPendingBeforeAcceptByFails() public {
        uint256 id = _create();
        vm.expectRevert(ArraVault.TooEarly.selector);
        vault.reclaim(id);
    }

    function test_buyerCanCancelBeforeAcceptance_notAfter() public {
        uint256 id = _create();
        vm.prank(buyer);
        vault.cancel(id);
        assertEq(usdt.balanceOf(buyer), START);

        uint256 id2 = _createAccepted();
        vm.prank(buyer);
        vm.expectRevert(ArraVault.WrongStatus.selector);
        vault.cancel(id2);
    }

    function test_supplierCanDeclinePending() public {
        uint256 id = _create();
        vm.prank(supplier);
        vault.cancel(id);
        assertEq(usdt.balanceOf(buyer), START);
        assertEq(usdt.balanceOf(supplier), 0);
    }

    function test_create_rejectsBadInputs() public {
        uint64 a = uint64(block.timestamp + 3 days);
        uint64 s = uint64(block.timestamp + 30 days);
        vm.startPrank(buyer);
        vm.expectRevert(ArraVault.BadSupplier.selector);
        vault.createOrder(address(0), TOTAL, DEP, a, s, WINDOW, 0, REF);
        vm.expectRevert(ArraVault.BadSupplier.selector);
        vault.createOrder(buyer, TOTAL, DEP, a, s, WINDOW, 0, REF);
        vm.expectRevert(ArraVault.BadSupplier.selector);
        vault.createOrder(address(vault), TOTAL, DEP, a, s, WINDOW, 0, REF);
        vm.expectRevert(ArraVault.BadAmount.selector);
        vault.createOrder(supplier, 0, DEP, a, s, WINDOW, 0, REF);
        vm.expectRevert(ArraVault.BadAmount.selector);
        vault.createOrder(supplier, 501e6, DEP, a, s, WINDOW, 0, REF);
        vm.expectRevert(ArraVault.BadDeposit.selector);
        vault.createOrder(supplier, TOTAL, 9_001, a, s, WINDOW, 0, REF);
        vm.expectRevert(ArraVault.BadDates.selector);
        vault.createOrder(supplier, TOTAL, DEP, uint64(block.timestamp), s, WINDOW, 0, REF);
        vm.expectRevert(ArraVault.BadDates.selector);
        vault.createOrder(supplier, TOTAL, DEP, s + 1, s, WINDOW, 0, REF);
        vm.expectRevert(ArraVault.BadDates.selector);
        vault.createOrder(supplier, TOTAL, DEP, a, uint64(block.timestamp + 181 days), WINDOW, 0, REF);
        vm.expectRevert(ArraVault.BadWindow.selector);
        vault.createOrder(supplier, TOTAL, DEP, a, s, 1 hours, 0, REF);
        vm.expectRevert(ArraVault.BadWindow.selector);
        vault.createOrder(supplier, TOTAL, DEP, a, s, 31 days, 0, REF);
        vm.stopPrank();
    }

    function test_create_rejectsFeeOnTransferToken() public {
        FeeToken fee = new FeeToken();
        ArraVault v = new ArraVault(IERC20(address(fee)), 500e18, owner, 1, 0);
        fee.mint(buyer, 1_000e18);
        vm.startPrank(buyer);
        fee.approve(address(v), type(uint256).max);
        vm.expectRevert(ArraVault.TransferMismatch.selector);
        v.createOrder(supplier, 100e18, DEP, uint64(block.timestamp + 1 days), uint64(block.timestamp + 2 days), WINDOW, 0, REF);
        vm.stopPrank();
    }

    // ---------------------------------------------------------- happy paths

    function test_release_paysSupplier() public {
        uint256 id = _createAccepted();
        vm.prank(buyer);
        vault.release(id);
        assertEq(usdt.balanceOf(supplier), TOTAL);
        assertEq(usdt.balanceOf(address(vault)), 0);
        assertEq(_status(id), uint8(ArraVault.Status.Released));
    }

    function test_cannotReleaseBeforeAcceptance() public {
        uint256 id = _create();
        vm.prank(buyer);
        vm.expectRevert(ArraVault.WrongStatus.selector);
        vault.release(id);
    }

    function test_stagedRelease() public {
        uint256 id = _createAccepted();
        vm.startPrank(buyer);
        vault.releasePart(id, 40e6); // bill of lading received
        assertEq(usdt.balanceOf(supplier), 70e6);
        assertEq(vault.getOrder(id).held, 30e6);
        assertEq(_status(id), uint8(ArraVault.Status.Active));
        vm.expectRevert(ArraVault.BadAmount.selector);
        vault.releasePart(id, 31e6);
        vm.expectRevert(ArraVault.BadAmount.selector);
        vault.releasePart(id, 0);
        vault.releasePart(id, 30e6); // goods delivered
        vm.stopPrank();
        assertEq(usdt.balanceOf(supplier), TOTAL);
        assertEq(_status(id), uint8(ArraVault.Status.Released));
    }

    function test_shipThenClaimAfterWindow() public {
        uint256 id = _createAccepted();
        vm.prank(supplier);
        vault.markShipped(id, keccak256("MSCU1234565"));
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(ArraVault.TooEarly.selector);
        vault.claim(id);
        vm.warp(block.timestamp + 1);
        vm.prank(stranger);
        vault.claim(id);
        assertEq(usdt.balanceOf(supplier), TOTAL, "funds go to supplier, not caller");
        assertEq(usdt.balanceOf(stranger), 0);
    }

    function test_reclaimAfterShipByIfAcceptedButNotShipped() public {
        uint256 id = _createAccepted();
        vm.expectRevert(ArraVault.TooEarly.selector);
        vault.reclaim(id);
        vm.warp(block.timestamp + 30 days + 1);
        vm.prank(stranger);
        vault.reclaim(id);
        assertEq(usdt.balanceOf(buyer), START - 30e6, "balance back, deposit stays with supplier");
        assertEq(_status(id), uint8(ArraVault.Status.Refunded));
    }

    function test_supplierCancelAfterAcceptanceRefundsBalance() public {
        uint256 id = _createAccepted();
        vm.prank(supplier);
        vault.cancel(id);
        assertEq(usdt.balanceOf(buyer), START - 30e6);
        assertEq(usdt.balanceOf(address(vault)), 0);
    }

    // ------------------------------------------------------- split settlement

    function test_split_buyerProposesSupplierAccepts() public {
        uint256 id = _createAccepted();
        vm.prank(supplier);
        vault.markShipped(id, bytes32(0));
        vm.prank(buyer);
        vault.dispute(id);
        vm.prank(buyer);
        vault.proposeSplit(id, 56e6); // 80% of the 70 balance
        vm.prank(supplier);
        vault.acceptSplit(id, 56e6);
        assertEq(usdt.balanceOf(supplier), 30e6 + 56e6);
        assertEq(usdt.balanceOf(buyer), START - TOTAL + 14e6);
        assertEq(usdt.balanceOf(address(vault)), 0);
        assertEq(_status(id), uint8(ArraVault.Status.Settled));
    }

    function test_split_proposerCannotAcceptOwnOffer() public {
        uint256 id = _createAccepted();
        vm.startPrank(buyer);
        vault.proposeSplit(id, 10e6);
        vm.expectRevert(ArraVault.NotParty.selector);
        vault.acceptSplit(id, 10e6);
        vm.stopPrank();
    }

    function test_split_amountMustMatchOffer() public {
        uint256 id = _createAccepted();
        vm.prank(supplier);
        vault.proposeSplit(id, 60e6);
        vm.prank(buyer);
        vm.expectRevert(ArraVault.OfferMismatch.selector);
        vault.acceptSplit(id, 50e6);
    }

    function test_split_newOfferReplacesOld_andStrangersBlocked() public {
        uint256 id = _createAccepted();
        vm.prank(buyer);
        vault.proposeSplit(id, 20e6);
        vm.prank(supplier);
        vault.proposeSplit(id, 60e6);
        assertEq(vault.getSplitOffer(id).toSupplier, 60e6);
        vm.prank(stranger);
        vm.expectRevert(ArraVault.NotParty.selector);
        vault.proposeSplit(id, 1);
        vm.prank(buyer);
        vault.acceptSplit(id, 60e6);
        assertEq(usdt.balanceOf(supplier), 90e6);
    }

    function test_split_offerClearedByPartialRelease() public {
        uint256 id = _createAccepted();
        vm.prank(supplier);
        vault.proposeSplit(id, 60e6);
        vm.prank(buyer);
        vault.releasePart(id, 20e6);
        vm.prank(buyer);
        vm.expectRevert(ArraVault.NoOffer.selector);
        vault.acceptSplit(id, 60e6);
    }

    function test_split_cannotExceedHeld() public {
        uint256 id = _createAccepted();
        vm.prank(buyer);
        vm.expectRevert(ArraVault.BadAmount.selector);
        vault.proposeSplit(id, 70e6 + 1);
    }

    function test_split_notWhilePending() public {
        uint256 id = _create();
        vm.prank(buyer);
        vm.expectRevert(ArraVault.WrongStatus.selector);
        vault.proposeSplit(id, 10e6);
    }

    // -------------------------------------------------------------- disputes

    function test_disputeBlocksClaimAndReclaim() public {
        uint256 id = _createAccepted();
        vm.prank(supplier);
        vault.markShipped(id, bytes32(0));
        vm.prank(buyer);
        vault.dispute(id);
        vm.warp(block.timestamp + 60 days);
        vm.expectRevert(ArraVault.WrongStatus.selector);
        vault.claim(id);
        vm.expectRevert(ArraVault.WrongStatus.selector);
        vault.reclaim(id);
        vm.prank(buyer);
        vault.release(id);
        assertEq(usdt.balanceOf(supplier), TOTAL);
    }

    function test_disputeTooLate() public {
        uint256 id = _createAccepted();
        vm.prank(supplier);
        vault.markShipped(id, bytes32(0));
        vm.warp(block.timestamp + WINDOW + 1);
        vm.prank(buyer);
        vm.expectRevert(ArraVault.TooLate.selector);
        vault.dispute(id);
    }

    function test_markShippedRules() public {
        uint256 id = _create();
        vm.prank(supplier);
        vm.expectRevert(ArraVault.WrongStatus.selector);
        vault.markShipped(id, bytes32(0)); // must accept first
        vm.prank(supplier);
        vault.accept(id);
        vm.warp(block.timestamp + 30 days + 1);
        vm.prank(supplier);
        vm.expectRevert(ArraVault.TooLate.selector);
        vault.markShipped(id, bytes32(0));
    }

    // -------------------------------------------------------- access control

    function test_onlyBuyerReleasesOrDisputes() public {
        uint256 id = _createAccepted();
        vm.prank(stranger);
        vm.expectRevert(ArraVault.NotBuyer.selector);
        vault.release(id);
        vm.prank(supplier);
        vm.expectRevert(ArraVault.NotBuyer.selector);
        vault.releasePart(id, 1);
        vm.prank(supplier);
        vault.markShipped(id, bytes32(0));
        vm.prank(stranger);
        vm.expectRevert(ArraVault.NotBuyer.selector);
        vault.dispute(id);
    }

    function test_strangerCannotCancel() public {
        uint256 id = _create();
        vm.prank(stranger);
        vm.expectRevert(ArraVault.NotParty.selector);
        vault.cancel(id);
    }

    function test_ownerCannotTouchFunds_andPauseOnlyBlocksNewOrders() public {
        uint256 id = _createAccepted();
        vm.prank(stranger);
        vm.expectRevert();
        vault.setPaused(true);
        vm.prank(owner);
        vault.setPaused(true);
        vm.prank(buyer);
        vm.expectRevert(ArraVault.IsPaused.selector);
        vault.createOrder(supplier, TOTAL, DEP, uint64(block.timestamp + 1 days), uint64(block.timestamp + 2 days), WINDOW, 0, REF);
        vm.prank(buyer);
        vault.release(id);
        assertEq(usdt.balanceOf(supplier), TOTAL);
    }

    function test_noDoublePayout() public {
        uint256 id = _createAccepted();
        vm.prank(buyer);
        vault.release(id);
        vm.prank(buyer);
        vm.expectRevert(ArraVault.WrongStatus.selector);
        vault.release(id);
        vm.prank(supplier);
        vm.expectRevert(ArraVault.WrongStatus.selector);
        vault.cancel(id);
        vm.expectRevert(ArraVault.WrongStatus.selector);
        vault.claim(id);
        vm.expectRevert(ArraVault.WrongStatus.selector);
        vault.reclaim(id);
        vm.prank(supplier);
        vm.expectRevert(ArraVault.WrongStatus.selector);
        vault.accept(id);
    }

    function test_unknownOrderReverts() public {
        vm.expectRevert(ArraVault.WrongStatus.selector);
        vault.claim(999);
        vm.expectRevert(ArraVault.WrongStatus.selector);
        vault.reclaim(999);
        vm.prank(buyer);
        vm.expectRevert(ArraVault.NotBuyer.selector);
        vault.release(999);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_depositMathAndConservation(uint128 total, uint16 bps) public {
        total = uint128(bound(total, 1, 500e6));
        bps = uint16(bound(bps, 0, 9_000));
        vm.prank(buyer);
        uint256 id = vault.createOrder(
            supplier, total, bps, uint64(block.timestamp + 1 days), uint64(block.timestamp + 2 days), WINDOW, 0, REF
        );
        assertEq(usdt.balanceOf(address(vault)), total);
        vm.prank(supplier);
        vault.accept(id);
        uint256 dep = (uint256(total) * bps) / 10_000;
        assertEq(usdt.balanceOf(supplier), dep);
        assertEq(usdt.balanceOf(address(vault)), total - dep);
        assertEq(START - usdt.balanceOf(buyer), total);
        assertGe(uint256(vault.getOrder(id).held) * 10, total, "at least 10% stays locked");
    }

    function testFuzz_splitConservesFunds(uint128 toSupplier) public {
        uint256 id = _createAccepted();
        toSupplier = uint128(bound(toSupplier, 0, 70e6));
        vm.prank(supplier);
        vault.proposeSplit(id, toSupplier);
        vm.prank(buyer);
        vault.acceptSplit(id, toSupplier);
        assertEq(usdt.balanceOf(supplier) + usdt.balanceOf(buyer), START);
        assertEq(usdt.balanceOf(address(vault)), 0);
    }
}

/// Invariant: the vault always holds exactly the sum of what each order holds,
/// and money only ever reaches the buyer or the supplier.
contract Handler is Test {
    ArraVault public vault;
    address public buyer;
    address public supplier;
    uint256[] public ids;

    constructor(ArraVault v, address b, address s) {
        vault = v;
        buyer = b;
        supplier = s;
    }

    function create(uint128 total, uint16 bps) external {
        total = uint128(bound(total, 100_001, 50e6)); // over ten $0.01 keeper fees
        bps = uint16(bound(bps, 0, 9_000));
        vm.prank(buyer);
        ids.push(
            vault.createOrder(
                supplier, total, bps, uint64(block.timestamp + 1 days), uint64(block.timestamp + 3 days), 1 days, 2 days, bytes32(0)
            )
        );
    }

    function act(uint256 seed, uint8 action, uint128 amount) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        uint128 held = vault.getOrder(id).held;
        uint128 amt = held == 0 ? 0 : uint128(bound(amount, 0, held));
        action = action % 16;
        if (action == 0) {
            vm.prank(supplier);
            try vault.accept(id) {} catch {}
        } else if (action == 1) {
            vm.prank(buyer);
            try vault.release(id) {} catch {}
        } else if (action == 2) {
            vm.prank(buyer);
            try vault.releasePart(id, amt) {} catch {}
        } else if (action == 3) {
            vm.prank(supplier);
            try vault.cancel(id) {} catch {}
        } else if (action == 4) {
            vm.prank(buyer);
            try vault.cancel(id) {} catch {}
        } else if (action == 5) {
            vm.prank(supplier);
            try vault.markShipped(id, bytes32(0)) {} catch {}
        } else if (action == 6) {
            vm.prank(buyer);
            try vault.dispute(id) {} catch {}
        } else if (action == 7) {
            try vault.claim(id) {
                keeperCalls++;
            } catch {}
        } else if (action == 8) {
            try vault.reclaim(id) {
                keeperCalls++;
            } catch {}
        } else if (action == 9) {
            vm.prank(seed % 2 == 0 ? buyer : supplier);
            try vault.proposeSplit(id, amt) {} catch {}
        } else if (action == 10) {
            uint128 offered = vault.getSplitOffer(id).toSupplier;
            vm.prank(seed % 2 == 0 ? supplier : buyer);
            try vault.acceptSplit(id, offered) {} catch {}
        } else if (action == 13) {
            vm.prank(buyer);
            try vault.confirmArrival(id) {} catch {}
        } else if (action == 14) {
            vm.prank(buyer);
            try vault.extendDeadlines(id, uint64(block.timestamp + 1 days), uint64(block.timestamp + 2 days)) {} catch {}
        } else if (action == 15) {
            try vault.resolveDispute(id) {
                keeperCalls++;
            } catch {}
        } else {
            vm.warp(block.timestamp + 12 hours);
        }
    }

    uint256 public keeperCalls;

    function heldSum() external view returns (uint256 s) {
        for (uint256 i; i < ids.length; i++) s += vault.getOrder(ids[i]).held;
    }
}

contract ArraVaultInvariantTest is Test {
    MockUSDT usdt;
    ArraVault vault;
    Handler handler;
    address buyer = makeAddr("buyer");
    address supplier = makeAddr("supplier");
    uint256 constant START = 1_000_000e6;

    function setUp() public {
        usdt = new MockUSDT();
        vault = new ArraVault(IERC20(address(usdt)), 50e6, makeAddr("owner"), 1, 10_000); // with a $0.01 keeper fee
        handler = new Handler(vault, buyer, supplier);
        usdt.mint(buyer, START);
        vm.prank(buyer);
        usdt.approve(address(vault), type(uint256).max);
        targetContract(address(handler));
    }

    function invariant_vaultHoldsExactlyWhatOrdersHold() public view {
        assertEq(usdt.balanceOf(address(vault)), handler.heldSum());
    }

    function invariant_moneyOnlyReachesBuyerOrSupplier() public view {
        // The handler triggers claim/reclaim as a third party, so it is the keeper here.
        assertEq(
            usdt.balanceOf(buyer) + usdt.balanceOf(supplier) + usdt.balanceOf(address(vault))
                + usdt.balanceOf(address(handler)),
            START
        );
    }

    function invariant_keeperGetsOnlyTheFixedFee() public view {
        assertLe(usdt.balanceOf(address(handler)), handler.keeperCalls() * 10_000);
    }
}

/// v3: the keeper fee and continuing order numbers.
contract ArraVaultKeeperFeeTest is Test {
    MockUSDT usdt;
    ArraVault vault;
    address buyer = makeAddr("buyer");
    address supplier = makeAddr("supplier");
    address keeper = makeAddr("keeper");
    uint128 constant FEE = 10_000; // $0.01
    uint128 constant TOTAL = 10e6;
    uint16 constant DEP = 3_000;

    function setUp() public {
        usdt = new MockUSDT();
        vault = new ArraVault(IERC20(address(usdt)), 50e6, makeAddr("owner"), 5, FEE);
        usdt.mint(buyer, 100e6);
        vm.prank(buyer);
        usdt.approve(address(vault), type(uint256).max);
    }

    function _create(uint128 total) internal returns (uint256 id) {
        vm.prank(buyer);
        id = vault.createOrder(
            supplier, total, DEP, uint64(block.timestamp + 1 days), uint64(block.timestamp + 10 days), 1 days, 0, bytes32(0)
        );
    }

    function test_numbersContinueFromPreviousVault() public {
        assertEq(_create(TOTAL), 5);
        assertEq(_create(TOTAL), 6);
        assertEq(vault.getOrder(4).buyer, address(0), "nothing below the first id");
    }

    function test_firstIdCannotBeZero() public {
        vm.expectRevert(ArraVault.BadAmount.selector);
        new ArraVault(IERC20(address(usdt)), 50e6, buyer, 0, FEE);
    }

    function test_keeperEarnsFeeOnRefund_buyerGetsTheRest() public {
        uint256 id = _create(TOTAL);
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectEmit(true, true, false, true);
        emit ArraVault.KeeperPaid(id, keeper, FEE);
        vm.prank(keeper);
        vault.reclaim(id);
        assertEq(usdt.balanceOf(keeper), FEE);
        assertEq(usdt.balanceOf(buyer), 100e6 - FEE);
        assertEq(usdt.balanceOf(address(vault)), 0);
    }

    function test_keeperEarnsFeeOnPayout_supplierGetsTheRest() public {
        uint256 id = _create(TOTAL);
        vm.prank(supplier);
        vault.accept(id);
        vm.prank(supplier);
        vault.markShipped(id, bytes32(0));
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(keeper);
        vault.claim(id);
        assertEq(usdt.balanceOf(keeper), FEE);
        assertEq(usdt.balanceOf(supplier), TOTAL - FEE, "deposit + balance minus one cent");
    }

    function test_noFeeWhenBuyerOrSupplierTriggerThemselves() public {
        uint256 a = _create(TOTAL);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(buyer);
        vault.reclaim(a);
        assertEq(usdt.balanceOf(buyer), 100e6, "full refund");

        uint256 b = _create(TOTAL);
        vm.prank(supplier);
        vault.accept(b);
        vm.prank(supplier);
        vault.markShipped(b, bytes32(0));
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(supplier);
        vault.claim(b);
        assertEq(usdt.balanceOf(supplier), TOTAL, "full payout");
    }

    function test_noFeeOnOrdinaryPaths() public {
        uint256 id = _create(TOTAL);
        vm.prank(supplier);
        vault.accept(id);
        vm.prank(buyer);
        vault.release(id);
        assertEq(usdt.balanceOf(supplier), TOTAL);
    }

    function test_tinyOrdersRefused_soTheFeeStaysSmall() public {
        vm.prank(buyer);
        vm.expectRevert(ArraVault.BadAmount.selector);
        vault.createOrder(supplier, 100_000, DEP, uint64(block.timestamp + 1 days), uint64(block.timestamp + 2 days), 1 days, 0, bytes32(0));
        _create(100_001); // just over ten fees is fine
    }

    function test_feeNeverExceedsWhatIsHeld() public {
        // 90% deposit on a $0.11 order leaves 1.1 cents held; the fee still fits, and the
        // supplier keeps the deposit.
        vm.prank(buyer);
        uint256 id = vault.createOrder(
            supplier, 110_000, 9_000, uint64(block.timestamp + 1 days), uint64(block.timestamp + 2 days), 1 days, 0, bytes32(0)
        );
        vm.prank(supplier);
        vault.accept(id);
        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(keeper);
        vault.reclaim(id);
        assertEq(usdt.balanceOf(keeper), FEE);
        assertEq(usdt.balanceOf(buyer), 100e6 - 110_000 + 1_000);
        assertEq(usdt.balanceOf(address(vault)), 0);
    }

    function testFuzz_feeConservesFunds(uint128 total, uint16 bps, bool claimPath) public {
        total = uint128(bound(total, 100_001, 50e6));
        bps = uint16(bound(bps, 0, 9_000));
        vm.prank(buyer);
        uint256 id = vault.createOrder(
            supplier, total, bps, uint64(block.timestamp + 1 days), uint64(block.timestamp + 2 days), 1 days, 0, bytes32(0)
        );
        if (claimPath) {
            vm.prank(supplier);
            vault.accept(id);
            vm.prank(supplier);
            vault.markShipped(id, bytes32(0));
            vm.warp(block.timestamp + 1 days + 1);
            vm.prank(keeper);
            vault.claim(id);
        } else {
            vm.warp(block.timestamp + 1 days + 1);
            vm.prank(keeper);
            vault.reclaim(id);
        }
        assertEq(usdt.balanceOf(keeper), FEE);
        assertEq(usdt.balanceOf(buyer) + usdt.balanceOf(supplier) + usdt.balanceOf(keeper), 100e6);
        assertEq(usdt.balanceOf(address(vault)), 0);
    }
}

/// v4: deadlines move only later, the check period starts at arrival, silence loses a dispute.
contract ArraVaultV4Test is Test {
    MockUSDT usdt;
    ArraVault vault;
    address buyer = makeAddr("buyer");
    address supplier = makeAddr("supplier");
    address keeper = makeAddr("keeper");
    uint128 constant FEE = 10_000;
    uint128 constant TOTAL = 10e6;
    uint16 constant DEP = 3_000; // $3 deposit, $7 balance
    uint32 constant WINDOW = 7 days;
    uint32 constant TRANSIT = 45 days;

    function setUp() public {
        usdt = new MockUSDT();
        vault = new ArraVault(IERC20(address(usdt)), 50e6, makeAddr("owner"), 9, FEE);
        usdt.mint(buyer, 100e6);
        vm.prank(buyer);
        usdt.approve(address(vault), type(uint256).max);
    }

    function _shipped() internal returns (uint256 id) {
        vm.prank(buyer);
        id = vault.createOrder(supplier, TOTAL, DEP, uint64(block.timestamp + 1 days), uint64(block.timestamp + 20 days), WINDOW, TRANSIT, bytes32(0));
        vm.startPrank(supplier);
        vault.accept(id);
        vault.markShipped(id, bytes32(0));
        vm.stopPrank();
    }

    function _disputed() internal returns (uint256 id) {
        id = _shipped();
        vm.prank(buyer);
        vault.confirmArrival(id);
        vm.prank(buyer);
        vault.dispute(id);
    }

    // ---- check period from arrival ----
    function test_supplierNotPaidBeforeGoodsCouldArrive() public {
        uint256 id = _shipped();
        vm.warp(block.timestamp + WINDOW + 1); // the old v3 rule would pay out here
        vm.expectRevert(ArraVault.TooEarly.selector);
        vault.claim(id);
        vm.warp(block.timestamp + TRANSIT); // backstop: shipping + transit + window
        vm.prank(keeper);
        vault.claim(id);
        assertEq(usdt.balanceOf(supplier), TOTAL - FEE);
    }

    function test_checkPeriodStartsAtConfirmedArrival() public {
        uint256 id = _shipped();
        vm.warp(block.timestamp + 10 days);
        vm.prank(buyer);
        vault.confirmArrival(id);
        assertEq(vault.getOrder(id).arrivedAt, block.timestamp);
        vm.warp(block.timestamp + WINDOW);
        vm.prank(buyer);
        vault.dispute(id); // still inside the window counted from arrival
        assertEq(uint8(vault.getOrder(id).status), uint8(ArraVault.Status.Disputed));
    }

    function test_arrivalOnlyByBuyer_once_andBeforeBackstop() public {
        uint256 id = _shipped();
        vm.prank(supplier);
        vm.expectRevert(ArraVault.NotBuyer.selector);
        vault.confirmArrival(id);
        vm.prank(buyer);
        vault.confirmArrival(id);
        vm.prank(buyer);
        vm.expectRevert(ArraVault.WrongStatus.selector);
        vault.confirmArrival(id);
        uint256 late = _shipped();
        vm.warp(block.timestamp + TRANSIT + 1);
        vm.prank(buyer);
        vm.expectRevert(ArraVault.TooLate.selector);
        vault.confirmArrival(late); // backstop already started the period
    }

    // ---- moving deadlines ----
    function test_buyerCanGiveMoreTime_evenAfterShipByPassed() public {
        vm.prank(buyer);
        uint256 id = vault.createOrder(supplier, TOTAL, DEP, uint64(block.timestamp + 1 days), uint64(block.timestamp + 5 days), WINDOW, TRANSIT, bytes32(0));
        vm.prank(supplier);
        vault.accept(id);
        vm.warp(block.timestamp + 6 days); // late, but nobody has reclaimed yet
        vm.prank(buyer);
        vault.extendDeadlines(id, 0, uint64(block.timestamp + 10 days));
        vm.expectRevert(ArraVault.TooEarly.selector);
        vault.reclaim(id);
        vm.prank(supplier);
        vault.markShipped(id, bytes32(0)); // ships within the new date
    }

    function test_deadlinesNeverMoveEarlier_andOnlyByBuyer() public {
        vm.prank(buyer);
        uint256 id = vault.createOrder(supplier, TOTAL, DEP, uint64(block.timestamp + 2 days), uint64(block.timestamp + 5 days), WINDOW, 0, bytes32(0));
        vm.prank(supplier);
        vm.expectRevert(ArraVault.NotBuyer.selector);
        vault.extendDeadlines(id, uint64(block.timestamp + 3 days), uint64(block.timestamp + 9 days));
        vm.startPrank(buyer);
        vm.expectRevert(ArraVault.BadDates.selector);
        vault.extendDeadlines(id, uint64(block.timestamp + 1 days), uint64(block.timestamp + 9 days)); // accept-by earlier
        vm.expectRevert(ArraVault.BadDates.selector);
        vault.extendDeadlines(id, uint64(block.timestamp + 3 days), uint64(block.timestamp + 4 days)); // ship-by earlier
        vm.expectRevert(ArraVault.BadDates.selector);
        vault.extendDeadlines(id, uint64(block.timestamp + 3 days), uint64(block.timestamp + 181 days)); // too far
        vault.extendDeadlines(id, uint64(block.timestamp + 3 days), uint64(block.timestamp + 9 days));
        vm.stopPrank();
        assertEq(vault.getOrder(id).acceptBy, block.timestamp + 3 days);
        vm.prank(supplier);
        vault.accept(id);
        vm.prank(supplier);
        vault.markShipped(id, bytes32(0));
        vm.prank(buyer);
        vm.expectRevert(ArraVault.WrongStatus.selector);
        vault.extendDeadlines(id, 0, uint64(block.timestamp + 20 days)); // not after shipping
    }

    // ---- silence loses a dispute ----
    function test_ignoredOfferSettlesAfterSevenDays() public {
        uint256 id = _disputed();
        vm.prank(supplier);
        vault.proposeSplit(id, 5e6); // $5 of the $7 balance to the supplier
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(ArraVault.TooEarly.selector);
        vault.resolveDispute(id);
        vm.warp(block.timestamp + 1);
        vm.prank(keeper);
        vault.resolveDispute(id);
        assertEq(usdt.balanceOf(supplier), 3e6 + 5e6, "deposit + offered share");
        assertEq(usdt.balanceOf(keeper), FEE);
        assertEq(usdt.balanceOf(buyer), 100e6 - TOTAL + 2e6 - FEE, "the rest, minus the keeper's cent");
        assertEq(uint8(vault.getOrder(id).status), uint8(ArraVault.Status.Settled));
    }

    function test_counterOfferRestartsTheClock() public {
        uint256 id = _disputed();
        vm.prank(supplier);
        vault.proposeSplit(id, 7e6);
        vm.warp(block.timestamp + 6 days);
        vm.prank(buyer);
        vault.proposeSplit(id, 2e6); // buyer answers with a counter-offer
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(ArraVault.TooEarly.selector);
        vault.resolveDispute(id);
        vm.warp(block.timestamp + 6 days);
        vault.resolveDispute(id); // the supplier ignored the counter for 7 days
        assertEq(usdt.balanceOf(supplier), 3e6 + 2e6);
    }

    function test_anOldOfferCantSettleTheMomentAProblemIsRaised() public {
        uint256 id = _shipped();
        vm.prank(supplier);
        vault.proposeSplit(id, 7e6); // offered while shipped, long before any dispute
        vm.warp(block.timestamp + 20 days);
        vm.prank(buyer);
        vault.confirmArrival(id);
        vm.prank(buyer);
        vault.dispute(id);
        vm.expectRevert(ArraVault.TooEarly.selector);
        vault.resolveDispute(id); // the buyer still gets 7 days to answer
        vm.warp(block.timestamp + 7 days + 1);
        vault.resolveDispute(id);
    }

    function test_noOffersThirtyDaysThenFiftyFifty() public {
        uint256 id = _disputed();
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(ArraVault.TooEarly.selector);
        vault.resolveDispute(id);
        vm.warp(block.timestamp + 1);
        vm.prank(buyer); // a party triggers it: no fee
        vault.resolveDispute(id);
        assertEq(usdt.balanceOf(supplier), 3e6 + 3.5e6);
        assertEq(usdt.balanceOf(buyer), 100e6 - TOTAL + 3.5e6);
    }

    function test_resolveOnlyForDisputes() public {
        uint256 id = _shipped();
        vm.warp(block.timestamp + 60 days);
        vm.expectRevert(ArraVault.WrongStatus.selector);
        vault.resolveDispute(id);
    }

    function test_transitIsBounded() public {
        vm.prank(buyer);
        vm.expectRevert(ArraVault.BadWindow.selector);
        vault.createOrder(supplier, TOTAL, DEP, uint64(block.timestamp + 1 days), uint64(block.timestamp + 2 days), WINDOW, 121 days, bytes32(0));
    }
}
