/**
 * @license
 * Copyright 2020 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview A Blockly plugin that allows you to create more advanced
 * connection checks.
 */

import * as Blockly from 'blockly/core';
import {TypeHierarchy} from './type_hierarchy';
import {getCheck, isExplicitConnection} from './utils';

// TODO: Fix the version of Blockly being required in package.json.

/**
 * A connection checker that is targeted at helping Blockly model languages with
 * complex nominal typing systems, like C++, Java, or Rust.
 * @implements {Blockly.IConnectionChecker}
 */
export class NominalConnectionChecker extends Blockly.ConnectionChecker {
  /**
   * Constructs the connection checker.
   * @param {!Blockly.Workspace} workspace The workspace this connection checker
   *     belongs to.
   */
  constructor(workspace) {
    super();

    /**
     * The workspace this connection checker belongs to.
     * @type {!Blockly.Workspace}
     * @private
     */
    this.workspace_ = workspace;

    /**
     * The type hierarchy used by this connection checker. Defines which types
     * are subtypes of which other types.
     * @type {?TypeHierarchy}
     * @private
     */
    this.typeHierarchy_ = null;

    /**
     * A map of block ids to priority queue maps that associated generic types
     * with explicit types.
     * @type {Map<string, Map<string, string>>}
     * @private
     */
    this.explicitBindings_ = new Map();
  }

  /**
   * Initializes the connection checker with the given hierarchy def.
   * @param {!Object} hierarchyDef The definition of our type hierarchy.
   * TODO: Add some sort of JSON schema for the hierarchy.
   */
  init(hierarchyDef) {
    this.typeHierarchy_ = new TypeHierarchy(hierarchyDef);
  }

  /**
   * @override
   */
  doTypeChecks(a, b) {
    const {parent, child} = this.getParentAndChildConnections_(a, b);
    const parentTypes = this.getExplicitTypesOfConnection(parent);
    const childTypes = this.getExplicitTypesOfConnection(child);
    const typeHierarchy = this.getTypeHierarchy_();

    if (!parentTypes.length || !childTypes.length) {
      // At least one is an unbound generic.
      return true;
    }
    return childTypes.some((childType) => {
      return parentTypes.some((parentType) => {
        return typeHierarchy.typeFulfillsType(childType, parentType);
      });
    });
  }

  /**
   * Returns the explicit type(s) of the block generic type pair, if an explicit
   * type can be found.
   *
   * Note that we only get multiple types via type unification of types that
   * are externally bound, or associated with input connections.
   * @param {!Blockly.Block} block The block that provides the context for the
   *     genericType.
   * @param {string} genericType The generic type we want to get the explicit
   *     type of.
   * @return {!Array<string>} The explicit type bound to the generic type, if
   *     one can be found. Undefined otherwise.
   */
  getExplicitTypes(block, genericType) {
    genericType = genericType.toLowerCase();
    return this.getBoundTypes_(block, genericType);
  }

  /**
   * Returns the explicit type(s) of the given connection. If the connection is
   * itself explicit, this just returns that type. If the connection is generic
   * it attempts to find the explicit type(s) bound to it.
   *
   * Note that we only get multiple types via type unification of types that
   * are externally bound to generic types, or associated with generic
   * input connections.
   * @param {!Blockly.Connection} connection The connection to find the explicit
   *     type of.
   * @return {!Array<string>} The explicit type(s) of the connection.
   */
  getExplicitTypesOfConnection(connection) {
    const check = getCheck(connection);
    return isExplicitConnection(connection) ? [check]:
        this.getExplicitTypes(connection.getSourceBlock(), check);
  }

  /**
   * Binds the genericType to the explicitType in the context of the given
   * block.
   * @param {!Blockly.Block} block The block that provides context for the
   *     generic type binding.
   * @param {string} genericType The generic type that we want to bind.
   * @param {string} explicitType The explicit type we want to bind the generic
   *     type to.
   */
  bindType(block, genericType, explicitType) {
    genericType = genericType.toLowerCase();
    explicitType = explicitType.toLowerCase();
    let map = this.explicitBindings_.get(block.id);
    if (!map) {
      map = new Map();
      this.explicitBindings_.set(block.id, map);
    }
    map.set(genericType, explicitType);

    const parent = block.outputConnection &&
        block.outputConnection.targetConnection;
    if (parent) {
      block.outputConnection.disconnect();
    }
    const childMap = new Map();
    for (const input of block.inputList) {
      const connection = input.connection;
      if (input.type == Blockly.INPUT_VALUE && connection.isConnected()) {
        childMap.set(input.name, connection.targetConnection);
        connection.disconnect();
      }
    }

    if (parent) {
      parent.connect(block.outputConnection);
    }
    for (const input of block.inputList) {
      if (childMap.has(input.name)) {
        input.connection.connect(childMap.get(input.name));
      }
    }

    // Note: Using .rendered may cause issues. See blockly/#1676.
    if (block.rendered) {
      block.bumpNeighbours();
    }
  }

  /**
   * Unbinds the genericType from its explicit type in the context of the given
   * block.
   * @param {!Blockly.Block} block The block that provides context for the
   *     generic type binding.
   * @param {string} genericType The generic type that we want to unbind.
   * @return {boolean} True if the binding existed previously, false if it did
   *     not.
   */
  unbindType(block, genericType) {
    genericType = genericType.toLowerCase();
    if (this.explicitBindings_.has(block.id)) {
      return this.explicitBindings_.get(block.id).delete(genericType);
    }
    return false;
  }

  /**
   * Returns the type hierarchy if this connection checker has been initialized.
   * Otherwise throws an error.
   * @return {!TypeHierarchy} The type hierarchy of this connection checker.
   * @throws {Error}
   * @private
   */
  getTypeHierarchy_() {
    if (!this.typeHierarchy_) {
      throw Error('The connection checker has not been initialized.');
    }
    return /** @type{!TypeHierarchy} */ (this.typeHierarchy_);
  }

  /**
   * Returns an object which has the two given connections correctly assigned
   * to either 'parent' or 'child' depending on which is the parent connection
   * and which is the child connection.
   * @param {!Blockly.Connection} a The first connection.
   * @param {!Blockly.Connection} b The second connection.
   * @return {{parent: !Blockly.Connection, child: !Blockly.Connection}} An
   *     object containing the connections, which are now correctly assigned to
   *     either 'parent' or 'child'.
   * @private
   */
  getParentAndChildConnections_(a, b) {
    if (a.isSuperior()) {
      return {
        parent: a,
        child: b,
      };
    } else {
      return {
        parent: b,
        child: a,
      };
    }
  }

  /**
   * Returns the explicit type(s) bound to the block generic type pair if one
   * exists.
   *
   * Note that we only get multiple types via type unification of types that
   * are externally bound, or associated with input connections.
   * @param {!Blockly.Block} block The block that provides the context for the
   *     explicit binding.
   * @param {string} genericType The generic type we want to get the bound
   *     explicit type of.
   * @param {!Blockly.Connection=} connectionToSkip The connection to skip. If
   *     the connection matches this connection, it will be ignored.
   * @return {!Array<string>} The explicit type(s) bound to the generic type
   *     if one exists.
   * @private
   */
  getBoundTypes_(block, genericType, connectionToSkip = undefined) {
    genericType = genericType.toLowerCase();
    const types = [];

    const type = this.getExternalBinding_(block, genericType);
    if (type) {
      types.push(type);
    }

    types.push(...this.getConnectionTypes_(
        block.outputConnection, genericType, connectionToSkip));

    for (const input of block.inputList) {
      types.push(...this.getConnectionTypes_(
          input.connection, genericType, connectionToSkip));
    }

    if (types.length) {
      return this.getTypeHierarchy_().getNearestCommonParents(...types);
    }
    return [];
  }

  /**
   * Returns the externally bound explicit type associated with the given
   * genericType in the context of the given block, if one exists.
   * @param {!Blockly.Block} block The block that provides context for the
   *     explicit binding.
   * @param {string} genericType The generic type we want to get the externally
   *     bound explicit type of.
   * @return {string} The externally bound explicit type, if one exists.
   * @private
   */
  getExternalBinding_(block, genericType) {
    if (this.explicitBindings_.has(block.id)) {
      return this.explicitBindings_.get(block.id).get(genericType);
    }
    return '';
  }

  /**
   * Acts as a helper for the getBoundTypes_ function *and should only be used
   * as such*. Only operates on the connection if its check matches the passed
   * genericType, it is an input or output connection, and it is not the
   * connectionToSkip. Returns the bound type(s) associated with this
   * connection.
   * @param {!Blockly.Connection} connection The connection to get the bound
   *     type of.
   * @param {string} genericType The generic type to find the bound type of.
   * @param {!Blockly.Connection} connectionToSkip The connection to skip. If
   *     the connection matches this connection, it will be ignored.
   * @return {!Array<string>} The bound type(s) associated with the passed
   *     connection.
   * @private
   */
  getConnectionTypes_(connection, genericType, connectionToSkip) {
    if (!connection ||
        connection == connectionToSkip ||
        connection.type == Blockly.NEXT_STATEMENT ||
        getCheck(connection) != genericType ||
        !connection.targetConnection) {
      return [];
    }

    const target = connection.targetConnection;
    const check = getCheck(target);
    if (isExplicitConnection(target)) {
      return [check];
    }
    return this.getBoundTypes_(
        target.getSourceBlock(), check, target);
  }
}

export const registrationType = Blockly.registry.Type.CONNECTION_CHECKER;
export const registrationName = 'NominalConnectionChecker';

// Register the checker so that it can be used by name.
Blockly.registry.register(
    registrationType, registrationName, NominalConnectionChecker);

export const pluginInfo = {
  [registrationType]: registrationName,
};
