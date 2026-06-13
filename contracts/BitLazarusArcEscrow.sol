// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract BitLazarusArcEscrow {
    enum Status {
        None,
        Open,
        Claimed,
        Submitted,
        Resolved,
        Refunded,
        Disputed
    }

    struct Bounty {
        bytes20 infoHash;
        address requester;
        address hunter;
        uint256 rewardAmount;
        Status status;
        bytes32 deliveryHash;
        string walrusBlobId;
        string spec;
        uint64 createdAt;
        uint64 deadlineAt;
    }

    IERC20 public immutable usdc;
    uint64 public immutable defaultDeadlineSeconds;
    uint256 public nextBountyId = 1;

    mapping(uint256 => Bounty) public bounties;
    mapping(bytes20 => uint256) public bountyIdByInfoHash;

    event BountyCreated(
        uint256 indexed bountyId,
        bytes20 indexed infoHash,
        address indexed requester,
        uint256 rewardAmount,
        uint64 deadlineAt,
        string spec
    );
    event BountyClaimed(uint256 indexed bountyId, address indexed hunter);
    event DeliverySubmitted(uint256 indexed bountyId, address indexed hunter, bytes32 deliveryHash, string walrusBlobId);
    event DeliveryConfirmed(uint256 indexed bountyId, address indexed hunter, bytes32 deliveryHash, string walrusBlobId);
    event BountyRefunded(uint256 indexed bountyId, address indexed requester);
    event BountyDisputed(uint256 indexed bountyId, address indexed requester);

    error InvalidInfoHash();
    error InvalidReward();
    error DuplicateInfoHash(bytes20 infoHash);
    error BountyNotFound(uint256 bountyId);
    error InvalidStatus(Status expected, Status actual);
    error NotRequester(address caller);
    error NotHunter(address caller);
    error DeadlineNotReached(uint64 deadlineAt);
    error TransferFailed();

    constructor(address usdcAddress, uint64 defaultDeadlineSeconds_) {
        require(usdcAddress != address(0), "USDC address required");
        usdc = IERC20(usdcAddress);
        defaultDeadlineSeconds = defaultDeadlineSeconds_;
    }

    function createBounty(
        bytes20 infoHash,
        uint256 rewardAmount,
        string calldata spec,
        uint64 deadlineAt
    ) external returns (uint256 bountyId) {
        if (infoHash == bytes20(0)) revert InvalidInfoHash();
        if (rewardAmount == 0) revert InvalidReward();
        if (bountyIdByInfoHash[infoHash] != 0) revert DuplicateInfoHash(infoHash);

        bountyId = nextBountyId++;
        uint64 effectiveDeadline = deadlineAt;
        if (effectiveDeadline == 0 && defaultDeadlineSeconds != 0) {
            effectiveDeadline = uint64(block.timestamp) + defaultDeadlineSeconds;
        }

        bounties[bountyId] = Bounty({
            infoHash: infoHash,
            requester: msg.sender,
            hunter: address(0),
            rewardAmount: rewardAmount,
            status: Status.Open,
            deliveryHash: bytes32(0),
            walrusBlobId: "",
            spec: spec,
            createdAt: uint64(block.timestamp),
            deadlineAt: effectiveDeadline
        });
        bountyIdByInfoHash[infoHash] = bountyId;

        if (!usdc.transferFrom(msg.sender, address(this), rewardAmount)) revert TransferFailed();

        emit BountyCreated(bountyId, infoHash, msg.sender, rewardAmount, effectiveDeadline, spec);
    }

    function claimBounty(uint256 bountyId) external {
        Bounty storage bounty = requireBounty(bountyId);
        requireStatus(bounty, Status.Open);

        bounty.hunter = msg.sender;
        bounty.status = Status.Claimed;

        emit BountyClaimed(bountyId, msg.sender);
    }

    function submitDelivery(
        uint256 bountyId,
        bytes32 deliveryHash,
        string calldata walrusBlobId
    ) external {
        Bounty storage bounty = requireBounty(bountyId);
        if (bounty.hunter != msg.sender) revert NotHunter(msg.sender);
        if (bounty.status != Status.Claimed && bounty.status != Status.Submitted) {
            revert InvalidStatus(Status.Claimed, bounty.status);
        }

        bounty.deliveryHash = deliveryHash;
        bounty.walrusBlobId = walrusBlobId;
        bounty.status = Status.Submitted;

        emit DeliverySubmitted(bountyId, msg.sender, deliveryHash, walrusBlobId);
    }

    function confirmDelivery(uint256 bountyId, string calldata walrusBlobId) external {
        Bounty storage bounty = requireBounty(bountyId);
        if (bounty.requester != msg.sender) revert NotRequester(msg.sender);
        requireStatus(bounty, Status.Submitted);

        bounty.walrusBlobId = walrusBlobId;
        bounty.status = Status.Resolved;

        if (!usdc.transfer(bounty.hunter, bounty.rewardAmount)) revert TransferFailed();

        emit DeliveryConfirmed(bountyId, bounty.hunter, bounty.deliveryHash, walrusBlobId);
    }

    function disputeDelivery(uint256 bountyId) external {
        Bounty storage bounty = requireBounty(bountyId);
        if (bounty.requester != msg.sender) revert NotRequester(msg.sender);
        requireStatus(bounty, Status.Submitted);

        bounty.status = Status.Disputed;

        emit BountyDisputed(bountyId, msg.sender);
    }

    function refundExpired(uint256 bountyId) external {
        Bounty storage bounty = requireBounty(bountyId);
        if (bounty.requester != msg.sender) revert NotRequester(msg.sender);
        if (bounty.deadlineAt == 0 || block.timestamp < bounty.deadlineAt) {
            revert DeadlineNotReached(bounty.deadlineAt);
        }
        if (bounty.status != Status.Open && bounty.status != Status.Claimed) {
            revert InvalidStatus(Status.Open, bounty.status);
        }

        bounty.status = Status.Refunded;

        if (!usdc.transfer(bounty.requester, bounty.rewardAmount)) revert TransferFailed();

        emit BountyRefunded(bountyId, msg.sender);
    }

    function getBountyByInfoHash(bytes20 infoHash) external view returns (Bounty memory bounty) {
        uint256 bountyId = bountyIdByInfoHash[infoHash];
        if (bountyId == 0) {
            return bounty;
        }

        return bounties[bountyId];
    }

    function requireBounty(uint256 bountyId) internal view returns (Bounty storage bounty) {
        bounty = bounties[bountyId];
        if (bounty.status == Status.None) revert BountyNotFound(bountyId);
    }

    function requireStatus(Bounty storage bounty, Status expected) internal view {
        if (bounty.status != expected) revert InvalidStatus(expected, bounty.status);
    }
}
