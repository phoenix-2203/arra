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
        vault = new ArraVault(IERC20(address(usdt)), 500e6, owner);
        usdt.mint(buyer, START);
        vm.prank(buyer);
        usdt.approve(address(vault), type(uint256).max);
    }

    function _create() internal returns (uint256 id) {
        vm.prank(buyer);
        id = vault.createOrder(
            supplier, TOTAL, DEP, uint64(block.timestamp + 3 days), uint64(block.timestamp + 30 days), WINDOW, REF
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
        vault.createOrder(address(0), TOTAL, DEP, a, s, WINDOW, REF);
        vm.expectRevert(ArraVault.BadSupplier.selector);
        vault.createOrder(buyer, TOTAL, DEP, a, s, WINDOW, REF);
        vm.expectRevert(ArraVault.BadSupplier.selector);
        vault.createOrder(address(vault), TOTAL, DEP, a, s, WINDOW, REF);
        vm.expectRevert(ArraVault.BadAmount.selector);
        vault.createOrder(supplier, 0, DEP, a, s, WINDOW, REF);
        vm.expectRevert(ArraVault.BadAmount.selector);
        vault.createOrder(supplier, 501e6, DEP, a, s, WINDOW, REF);
        vm.expectRevert(ArraVault.BadDeposit.selector);
        vault.createOrder(supplier, TOTAL, 9_001, a, s, WINDOW, REF);
        vm.expectRevert(ArraVault.BadDates.selector);
        vault.createOrder(supplier, TOTAL, DEP, uint64(block.timestamp), s, WINDOW, REF);
        vm.expectRevert(ArraVault.BadDates.selector);
        vault.createOrder(supplier, TOTAL, DEP, s + 1, s, WINDOW, REF);
        vm.expectRevert(ArraVault.BadDates.selector);
        vault.createOrder(supplier, TOTAL, DEP, a, uint64(block.timestamp + 181 days), WINDOW, REF);
        vm.expectRevert(ArraVault.BadWindow.selector);
        vault.createOrder(supplier, TOTAL, DEP, a, s, 1 hours, REF);
        vm.expectRevert(ArraVault.BadWindow.selector);
        vault.createOrder(supplier, TOTAL, DEP, a, s, 31 days, REF);
        vm.stopPrank();
    }

    function test_create_rejectsFeeOnTransferToken() public {
        FeeToken fee = new FeeToken();
        ArraVault v = new ArraVault(IERC20(address(fee)), 500e18, owner);
        fee.mint(buyer, 1_000e18);
        vm.startPrank(buyer);
        fee.approve(address(v), type(uint256).max);
        vm.expectRevert(ArraVault.TransferMismatch.selector);
        v.createOrder(supplier, 100e18, DEP, uint64(block.timestamp + 1 days), uint64(block.timestamp + 2 days), WINDOW, REF);
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
        vault.createOrder(supplier, TOTAL, DEP, uint64(block.timestamp + 1 days), uint64(block.timestamp + 2 days), WINDOW, REF);
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
            supplier, total, bps, uint64(block.timestamp + 1 days), uint64(block.timestamp + 2 days), WINDOW, REF
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
        total = uint128(bound(total, 1, 50e6));
        bps = uint16(bound(bps, 0, 9_000));
        vm.prank(buyer);
        ids.push(
            vault.createOrder(
                supplier, total, bps, uint64(block.timestamp + 1 days), uint64(block.timestamp + 3 days), 1 days, bytes32(0)
            )
        );
    }

    function act(uint256 seed, uint8 action, uint128 amount) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        uint128 held = vault.getOrder(id).held;
        uint128 amt = held == 0 ? 0 : uint128(bound(amount, 0, held));
        action = action % 13;
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
            try vault.claim(id) {} catch {}
        } else if (action == 8) {
            try vault.reclaim(id) {} catch {}
        } else if (action == 9) {
            vm.prank(seed % 2 == 0 ? buyer : supplier);
            try vault.proposeSplit(id, amt) {} catch {}
        } else if (action == 10) {
            uint128 offered = vault.getSplitOffer(id).toSupplier;
            vm.prank(seed % 2 == 0 ? supplier : buyer);
            try vault.acceptSplit(id, offered) {} catch {}
        } else {
            vm.warp(block.timestamp + 12 hours);
        }
    }

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
        vault = new ArraVault(IERC20(address(usdt)), 50e6, makeAddr("owner"));
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
        assertEq(usdt.balanceOf(buyer) + usdt.balanceOf(supplier) + usdt.balanceOf(address(vault)), START);
    }
}
