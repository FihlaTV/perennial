// Copyright 2018, University of Colorado Boulder

/**
 * Represents a modified simulation release branch, with either pending or applied (and not published) changes.
 *
 * @author Jonathan Olson <jonathan.olson@colorado.edu>
 */

/* eslint-env browser, node */
'use strict';

const assert = require( 'assert' );
const Patch = require( './Patch' );
const ReleaseBranch = require( './ReleaseBranch' );

module.exports = ( function() {

  class ModifiedReleaseBranch {
    /**
     * @public
     * @constructor
     *
     * @param {ReleaseBranch} releaseBranch
     * @param {Object} [changedDependencies]
     * @param {Array.<Patch>} [neededPatches]
     * @param {Array.<string>} [messages]
     */
    constructor( releaseBranch, changedDependencies = {}, neededPatches = [], messages = [] ) {
      assert( releaseBranch instanceof ReleaseBranch );
      assert( typeof changedDependencies === 'object' );
      assert( Array.isArray( neededPatches ) && neededPatches.forEach( patch => assert( patch instanceof Patch ) ) );
      assert( Array.isArray( messages ) && messages.forEach( message => assert( typeof message === 'string' ) ) );

      // @public {ReleaseBranch}
      this.releaseBranch = releaseBranch;

      // @public {Object} - Keys are repo names, values are SHAs
      this.changedDependencies = changedDependencies;

      // @public {Array.<Patch>}
      this.neededPatches = neededPatches;

      // @public {Array.<string>} - Messages from already-applied patches or other changes
      this.messages = messages;
    }

    /**
     * Convert into a plain JS object meant for JSON serialization.
     * @public
     *
     * @returns {Object}
     */
    serialize() {
      return {
        releaseBranch: this.releaseBranch.serialize(),
        changedDependencies: this.changedDependencies,
        neededPatches: this.neededPatches.map( patch => patch.repo ),
        messages: this.messages
      };
    }

    /**
     * Takes a serialized form of the ModifiedReleaseBranch and returns an actual instance.
     * @public
     *
     * @param {Object}
     * @param {Array.<Patch>} - We only want to store patches in one location, so don't fully save the info.
     * @returns {ModifiedReleaseBranch}
     */
    static deserialize( { releaseBranch, changedDependencies, neededPatches, messages }, patches ) {
      return new ModifiedReleaseBranch(
        ReleaseBranch.deserialize( releaseBranch ),
        changedDependencies,
        neededPatches.map( repo => patches.find( patch => patch.repo === repo ) ),
        messages
      );
    }
  }

  return ModifiedReleaseBranch;
} )();
