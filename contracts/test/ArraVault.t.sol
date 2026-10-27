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
    bytes32 constant REF = keccak256("order-1");

    function setUp() public {
        usdt = new MockUSDT();
        vault = new ArraVault(IERC20(address(usdt)), 500e6, owner);
        usdt.mint(buyer, 1_000e6);
        vm.prank(buyer);
        usdt.approve(address(vault), type(uint256).max);
    }

    function _create() internal returns (uint256 id) {
        vm.prank(buyer);
        id = vault.createOrder(supplier, TOTAL, DEP, uint64(block.timestamp + 30 days), WINDOW, REF);
    }

    // ------------------------------------------------------------ creation

    function test_create_paysDepositAndLocksBalance() public {
        uint256 id = _create();
        assertEq(usdt.balanceOf(supplier), 30e6, "deposit to supplier");
        assertEq(usdt.balanceOf(address(vault)), 70e6, "balance locked");
        assertEq(usdt.balanceOf(buyer), 900e6);
        ArraVault.Order memory o = vault.getOrder(id);
        assertEq(o.buyer, buyer);
        assertEq(o.supplier, supplier);
        assertEq(o.balance, 70e6);
        assertEq(uint8(o.status), uint8(ArraVault.Status.Funded));
        assertEq(o.ref, REF);
    }

    function test_create_rejectsBadInputs() public {
        uint64 shipBy = uint64(block.timestamp + 30 days);
        vm.startPrank(buyer);
        vm.expectRevert(ArraVault.BadSupplier.selector);
        vault.createOrder(address(0), TOTAL, DEP, shipBy, WINDOW, REF);
        vm.expectRevert(ArraVault.BadSupplier.selector);
        vault.createOrder(buyer, TOTAL, DEP, shipBy, WINDOW, REF);
        vm.expectRevert(ArraVault.BadSupplier.selector);
        vault.createOrder(address(vault), TOTAL, DEP, shipBy, WINDOW, REF);
        vm.expectRevert(ArraVault.BadAmount.selector);
        vault.createOrder(supplier, 0, DEP, shipBy, WINDOW, REF);
        vm.expectRevert(ArraVault.BadAmount.selector);
        vault.createOrder(supplier, 501e6, DEP, shipBy, WINDOW, REF);
        vm.expectRevert(ArraVault.BadDeposit.selector);
        vault.createOrder(supplier, TOTAL, 9_001, shipBy, WINDOW, REF);
        vm.expectRevert(ArraVault.BadShipBy.selector);
        vault.createOrder(supplier, TOTAL, DEP, uint64(block.timestamp), WINDOW, REF);
        vm.expectRevert(ArraVault.BadShipBy.selector);
        vault.createOrder(supplier, TOTAL, DEP, uint64(block.timestamp + 181 days), WINDOW, REF);
        vm.expectRevert(ArraVault.BadWindow.selector);
        vault.createOrder(supplier, TOTAL, DEP, shipBy, 1 hours, REF);
        vm.expectRevert(ArraVault.BadWindow.selector);
        vault.createOrder(supplier, TOTAL, DEP, shipBy, 31 days, REF);
        vm.stopPrank();
    }

    function test_create_rejectsFeeOnTransferToken() public {
        FeeToken fee = new FeeToken();
        ArraVault v = new ArraVault(IERC20(address(fee)), 500e18, owner);
        fee.mint(buyer, 1_000e18);
        vm.startPrank(buyer);
        fee.approve(address(v), type(uint256).max);
        vm.expectRevert(ArraVault.TransferMismatch.selector);
        v.createOrder(supplier, 100e18, DEP, uint64(block.timestamp + 1 days), WINDOW, REF);
        vm.stopPrank();
    }

    function test_create_zeroDepositLocksEverything() public {
        vm.prank(buyer);
        uint256 id = vault.createOrder(supplier, TOTAL, 0, uint64(block.timestamp + 1 days), WINDOW, REF);
        assertEq(usdt.balanceOf(supplier), 0);
        assertEq(vault.getOrder(id).balance, TOTAL);
    }

    // --------------------------------------------------------- happy paths

    function test_release_paysSupplier() public {
        uint256 id = _create();
        vm.prank(buyer);
        vault.release(id);
        assertEq(usdt.balanceOf(supplier), TOTAL);
        assertEq(usdt.balanceOf(address(vault)), 0);
        assertEq(uint8(vault.getOrder(id).status), uint8(ArraVault.Status.Released));
    }

    function test_shipThenClaimAfterWindow() public {
        uint256 id = _create();
        vm.prank(supplier);
        vault.markShipped(id, keccak256("TRACK123"));
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(ArraVault.TooEarly.selector);
        vault.claim(id);
        vm.warp(block.timestamp + 1);
        vm.prank(stranger); // the agent, or anyone, can trigger it
        vault.claim(id);
        assertEq(usdt.balanceOf(supplier), TOTAL, "funds go to supplier, not caller");
        assertEq(usdt.balanceOf(stranger), 0);
    }

    function test_reclaimAfterShipByIfNotShipped() public {
        uint256 id = _create();
        vm.expectRevert(ArraVault.TooEarly.selector);
        vault.reclaim(id);
        vm.warp(block.timestamp + 30 days + 1);
        vm.prank(stranger);
        vault.reclaim(id);
        assertEq(usdt.balanceOf(buyer), 970e6, "balance back to buyer");
        assertEq(usdt.balanceOf(stranger), 0);
        assertEq(uint8(vault.getOrder(id).status), uint8(ArraVault.Status.Refunded));
    }

    function test_supplierCancelRefundsBuyer() public {
        uint256 id = _create();
        vm.prank(supplier);
        vault.cancel(id);
        assertEq(usdt.balanceOf(buyer), 970e6);
        assertEq(usdt.balanceOf(address(vault)), 0);
    }

    // ------------------------------------------------------------- disputes

    function test_disputeBlocksClaim_thenResolvedByRelease() public {
        uint256 id = _create();
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

    function test_disputeResolvedBySupplierCancel() public {
        uint256 id = _create();
        vm.prank(supplier);
        vault.markShipped(id, bytes32(0));
        vm.prank(buyer);
        vault.dispute(id);
        vm.prank(supplier);
        vault.cancel(id);
        assertEq(usdt.balanceOf(buyer), 970e6);
    }

    function test_disputeTooLate() public {
        uint256 id = _create();
        vm.prank(supplier);
        vault.markShipped(id, bytes32(0));
        vm.warp(block.timestamp + WINDOW + 1);
        vm.prank(buyer);
        vm.expectRevert(ArraVault.TooLate.selector);
        vault.dispute(id);
    }

    function test_markShippedAfterShipByFails() public {
        uint256 id = _create();
        vm.warp(block.timestamp + 30 days + 1);
        vm.prank(supplier);
        vm.expectRevert(ArraVault.TooLate.selector);
        vault.markShipped(id, bytes32(0));
    }

    function test_shippedOrderCannotBeReclaimed() public {
        uint256 id = _create();
        vm.prank(supplier);
        vault.markShipped(id, bytes32(0));
        vm.warp(block.timestamp + 31 days);
        vm.expectRevert(ArraVault.WrongStatus.selector);
        vault.reclaim(id);
    }

    // -------------------------------------------------------- access control

    function test_onlyBuyerCanReleaseOrDispute() public {
        uint256 id = _create();
        vm.prank(stranger);
        vm.expectRevert(ArraVault.NotBuyer.selector);
        vault.release(id);
        vm.prank(supplier);
        vm.expectRevert(ArraVault.NotBuyer.selector);
        vault.release(id);
        vm.prank(supplier);
        vault.markShipped(id, bytes32(0));
        vm.prank(stranger);
        vm.expectRevert(ArraVault.NotBuyer.selector);
        vault.dispute(id);
    }

    function test_onlySupplierCanShipOrCancel() public {
        uint256 id = _create();
        vm.prank(buyer);
        vm.expectRevert(ArraVault.NotSupplier.selector);
        vault.markShipped(id, bytes32(0));
        vm.prank(stranger);
        vm.expectRevert(ArraVault.NotSupplier.selector);
        vault.cancel(id);
    }

    function test_ownerCannotTouchFunds_andPauseOnlyBlocksNewOrders() public {
        uint256 id = _create();
        vm.prank(stranger);
        vm.expectRevert();
        vault.setPaused(true);
        vm.prank(owner);
        vault.setPaused(true);
        vm.prank(buyer);
        vm.expectRevert(ArraVault.IsPaused.selector);
        vault.createOrder(supplier, TOTAL, DEP, uint64(block.timestamp + 1 days), WINDOW, REF);
        // existing order still settles while paused
        vm.prank(buyer);
        vault.release(id);
        assertEq(usdt.balanceOf(supplier), TOTAL);
    }

    function test_noDoublePayout() public {
        uint256 id = _create();
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
        uint256 startBuyer = usdt.balanceOf(buyer);
        vm.prank(buyer);
        uint256 id = vault.createOrder(supplier, total, bps, uint64(block.timestamp + 1 days), WINDOW, REF);
        uint256 dep = (uint256(total) * bps) / 10_000;
        assertEq(usdt.balanceOf(supplier), dep);
        assertEq(usdt.balanceOf(address(vault)), total - dep);
        assertEq(startBuyer - usdt.balanceOf(buyer), total);
        // balance is never less than 10% of total
        assertGe(uint256(vault.getOrder(id).balance) * 10, total);
    }
}

/// Invariant: the vault always holds exactly the sum of locked balances,
/// and money only ever reaches the buyer or the supplier.
contract Handler is Test {
    ArraVault public vault;
    MockUSDT public usdt;
    address public buyer;
    address public supplier;
    uint256[] public ids;

    constructor(ArraVault v, MockUSDT u, address b, address s) {
        vault = v;
        usdt = u;
        buyer = b;
        supplier = s;
    }

    function create(uint128 total, uint16 bps) external {
        total = uint128(bound(total, 1, 50e6));
        bps = uint16(bound(bps, 0, 9_000));
        vm.prank(buyer);
        ids.push(vault.createOrder(supplier, total, bps, uint64(block.timestamp + 3 days), 1 days, bytes32(0)));
    }

    function act(uint256 seed, uint8 action) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        action = action % 7;
        if (action == 0) {
            vm.prank(buyer);
            try vault.release(id) {} catch {}
        } else if (action == 1) {
            vm.prank(supplier);
            try vault.cancel(id) {} catch {}
        } else if (action == 2) {
            vm.prank(supplier);
            try vault.markShipped(id, bytes32(0)) {} catch {}
        } else if (action == 3) {
            vm.prank(buyer);
            try vault.dispute(id) {} catch {}
        } else if (action == 4) {
            try vault.claim(id) {} catch {}
        } else if (action == 5) {
            try vault.reclaim(id) {} catch {}
        } else {
            vm.warp(block.timestamp + 1 days);
        }
    }

    function lockedSum() external view returns (uint256 s) {
        for (uint256 i; i < ids.length; i++) s += vault.getOrder(ids[i]).balance;
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
        handler = new Handler(vault, usdt, buyer, supplier);
        usdt.mint(buyer, START);
        vm.prank(buyer);
        usdt.approve(address(vault), type(uint256).max);
        targetContract(address(handler));
    }

    function invariant_vaultHoldsExactlyLockedBalances() public view {
        assertEq(usdt.balanceOf(address(vault)), handler.lockedSum());
    }

    function invariant_moneyOnlyReachesBuyerOrSupplier() public view {
        assertEq(usdt.balanceOf(buyer) + usdt.balanceOf(supplier) + usdt.balanceOf(address(vault)), START);
    }
}
