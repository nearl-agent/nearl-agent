// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {NearlGuard} from "./NearlGuard.sol";

/// @notice Anyone can create a Guard wallet for their agent. The caller becomes its owner.
contract NearlGuardFactory {
    mapping(address => address[]) private _guardsOf;
    mapping(address => bool) public isGuard;
    address[] public allGuards;

    event GuardCreated(address indexed owner, address indexed agent, address guard);

    function createGuard(address agent) external returns (address guard) {
        guard = address(new NearlGuard(msg.sender, agent));
        _guardsOf[msg.sender].push(guard);
        isGuard[guard] = true;
        allGuards.push(guard);
        emit GuardCreated(msg.sender, agent, guard);
    }

    function guardsOf(address owner) external view returns (address[] memory) {
        return _guardsOf[owner];
    }

    function guardCount() external view returns (uint256) {
        return allGuards.length;
    }
}
