// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

error OffchainLookup(
    address sender,
    string[] urls,
    bytes callData,
    bytes4 callbackFunction,
    bytes extraData
);

contract BitLazarusWildcardResolver is IERC165 {
    bytes4 private constant ERC165_INTERFACE_ID = 0x01ffc9a7;
    bytes4 private constant EXTENDED_RESOLVER_INTERFACE_ID = 0x9061b923;

    address public owner;
    string[] public urls;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(string[] memory initialUrls) {
        owner = msg.sender;
        urls = initialUrls;
    }

    function setUrls(string[] calldata nextUrls) external onlyOwner {
        delete urls;
        for (uint256 i = 0; i < nextUrls.length; i++) {
            urls.push(nextUrls[i]);
        }
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        require(nextOwner != address(0), "zero owner");
        owner = nextOwner;
    }

    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory) {
        bytes memory callData = abi.encode(name, data);
        revert OffchainLookup(
            address(this),
            urls,
            callData,
            this.resolveWithProof.selector,
            ""
        );
    }

    function resolveWithProof(bytes calldata response, bytes calldata) external pure returns (bytes memory) {
        return response;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == ERC165_INTERFACE_ID || interfaceId == EXTENDED_RESOLVER_INTERFACE_ID;
    }
}
