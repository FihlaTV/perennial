// Copyright 2018, University of Colorado Boulder

/**
 * Represents a modified simulation release branch, with either pending or applied (and not published) changes.
 *
 * @author Jonathan Olson <jonathan.olson@colorado.edu>
 */

/* eslint-env browser, node */
'use strict';

const assert = require( 'assert' );
const checkoutDependencies = require( './checkoutDependencies' );
const ChipperVersion = require( '../common/ChipperVersion' );
const getDependencies = require( './getDependencies' );
const gitCheckout = require( './gitCheckout' );
const gitIsAncestor = require( './gitIsAncestor' );
const gitPull = require( './gitPull' );
const Patch = require( './Patch' );
const ReleaseBranch = require( './ReleaseBranch' );
const SimVersion = require( './SimVersion' );

module.exports = ( function() {

  class ModifiedBranch {
    /**
     * @public
     * @constructor
     *
     * @param {ReleaseBranch} releaseBranch
     * @param {Object} [changedDependencies]
     * @param {Array.<Patch>} [neededPatches]
     * @param {Array.<string>} [pendingMessages]
     * @param {Array.<string>} [pushedMessages]
     * @param {SimVersion|null} [deployedVersion]
     */
    constructor( releaseBranch, changedDependencies = {}, neededPatches = [], pendingMessages = [], pushedMessages = [], deployedVersion = null ) {
      assert( releaseBranch instanceof ReleaseBranch );
      assert( typeof changedDependencies === 'object' );
      assert( Array.isArray( neededPatches ) );
      neededPatches.forEach( patch => assert( patch instanceof Patch ) );
      assert( Array.isArray( pushedMessages ) );
      pushedMessages.forEach( message => assert( typeof message === 'string' ) );
      assert( deployedVersion === null || deployedVersion instanceof SimVersion );

      // @public {ReleaseBranch}
      this.releaseBranch = releaseBranch;

      // @public {Object} - Keys are repo names, values are SHAs
      this.changedDependencies = changedDependencies;

      // @public {Array.<Patch>}
      this.neededPatches = neededPatches;

      // @public {Array.<string>} - Messages from already-applied patches or other changes NOT included in dependencies.json yet
      this.pendingMessages = pendingMessages;

      // @public {Array.<string>} - Messages from already-applied patches or other changes that have been included in dependencies.json
      this.pushedMessages = pushedMessages;

      // @public {string}
      this.repo = releaseBranch.repo;
      this.branch = releaseBranch.branch;

      // @public {Array.<string>}
      this.brands = releaseBranch.brands;

      // @public {SimVersion|null} - The deployed version for the latest patches applied. Will be reset to null when
      // updates are made.
      this.deployedVersion = deployedVersion;
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
        pendingMessages: this.pendingMessages,
        pushedMessages: this.pushedMessages,
        deployedVersion: this.deployedVersion ? this.deployedVersion.serialize() : null
      };
    }

    /**
     * Takes a serialized form of the ModifiedBranch and returns an actual instance.
     * @public
     *
     * @param {Object}
     * @param {Array.<Patch>} - We only want to store patches in one location, so don't fully save the info.
     * @returns {ModifiedBranch}
     */
    static deserialize( { releaseBranch, changedDependencies, neededPatches, pendingMessages, pushedMessages, deployedVersion }, patches ) {
      return new ModifiedBranch(
        ReleaseBranch.deserialize( releaseBranch ),
        changedDependencies,
        neededPatches.map( repo => patches.find( patch => patch.repo === repo ) ),
        pendingMessages,
        pushedMessages,
        deployedVersion ? SimVersion.deserialize( deployedVersion ) : null
      );
    }

    /**
     * Whether there is no need to keep a reference to us.
     * @public
     *
     * @returns {boolean}
     */
    get isUnused() {
      return this.neededPatches.length === 0 &&
             Object.keys( this.changedDependencies ).length === 0 &&
             this.pushedMessages.length === 0 &&
             this.pendingMessages.length === 0;
    }

    /**
     * Whether it is safe to deploy a release candidate for this branch.
     * @public
     *
     * @returns {boolean}
     */
    get isReadyForReleaseCandidate() {
      return this.neededPatches.length === 0 &&
             this.pushedMessages.length > 0 &&
             this.deployedVersion === null;
    }

    /**
     * Whether it is safe to deploy a production version for this branch.
     * @public
     *
     * @returns {boolean}
     */
    get isReadyForProduction() {
      return this.neededPatches.length === 0 &&
             this.pushedMessages.length > 0 &&
             this.deployedVersion !== null &&
             this.deployedVersion.testType === 'rc';
    }

    /**
     * Returns the branch name that should be used in dependency repositories.
     * @public
     *
     * @returns {string}
     */
    get dependencyBranch() {
      return `${this.repo}-${this.branch}`;
    }

    /**
     * Returns whether phet-io.standalone is the correct phet-io query parameter (otherwise it's the newer
     * phetioStandalone).
     * Looks for the presence of https://github.com/phetsims/chipper/commit/4814d6966c54f250b1c0f3909b71f2b9cfcc7665.
     * @public
     *
     * @returns {Promise.<boolean>}
     */
    async usesOldPhetioStandalone() {
      await gitCheckout( this.repo, this.branch );
      const dependencies = await getDependencies( this.repo );
      const sha = dependencies.chipper.sha;
      await gitCheckout( this.repo, 'master' );

      return !( await gitIsAncestor( 'chipper', '4814d6966c54f250b1c0f3909b71f2b9cfcc7665', sha ) );
    }

    /**
     * Returns whether the relativeSimPath query parameter is used for wrappers (instead of launchLocalVersion).
     * Looks for the presence of https://github.com/phetsims/phet-io/commit/e3fc26079358d86074358a6db3ebaf1af9725632
     * @public
     *
     * @returns {Promise.<boolean>}
     */
    async usesRelativeSimPath() {
      await gitCheckout( this.repo, this.branch );
      const dependencies = await getDependencies( this.repo );

      if ( !dependencies[ 'phet-io' ] ) {
        return true; // Doesn't really matter now, does it?
      }

      const sha = dependencies[ 'phet-io' ].sha;
      await gitCheckout( this.repo, 'master' );

      return await gitIsAncestor( 'phet-io', 'e3fc26079358d86074358a6db3ebaf1af9725632', sha );
    }

    /**
     * Returns whether an additional folder exists in the build directory of the sim based on the brand.
     * @public
     *
     * @returns {Promise.<boolean>}
     */
    async usesChipper2() {
      await gitCheckout( this.repo, this.branch );
      const dependencies = await getDependencies( this.repo );
      await gitCheckout( 'chipper', dependencies.chipper.sha );

      const chipperVersion = ChipperVersion.getFromRepository();

      const result = chipperVersion.major !== 0 || chipperVersion.minor !== 0;

      await gitCheckout( this.repo, 'master' );
      await gitCheckout( 'chipper', 'master' );

      return result;
    }

    /**
     * Returns a list of deployed links for testing (depending on the brands deployed).
     * @public
     *
     * @param {boolean} [includeMessages]
     * @returns {Promise.<Array.<string>>}
     */
    async getDeployedLinkLines( includeMessages = true ) {
      assert( this.deployedVersion !== null );

      const linkSuffixes = [];
      const versionString = this.deployedVersion.toString();

      const standaloneParams = ( await this.usesOldPhetioStandalone() ) ? 'phet-io.standalone' : 'phetioStandalone';
      const proxiesParams = ( await this.usesRelativeSimPath() ) ? 'relativeSimPath' : 'launchLocalVersion';
      const usesChipper2 = await this.usesChipper2();
      const phetFolder = usesChipper2 ? '/phet' : '';
      const phetioFolder = usesChipper2 ? '/phet-io' : '';
      const phetSuffix = usesChipper2 ? '_phet' : '';
      const phetioSuffix = usesChipper2 ? '_all_phet-io' : '_en-phetio';

      if ( this.deployedVersion.testType === 'rc' ) {
        if ( this.brands.includes( 'phet' ) ) {
          linkSuffixes.push( `](https://phet-dev.colorado.edu/html/${this.repo}/${versionString}${phetFolder}/${this.repo}_en${phetSuffix}.html)` );
        }
        if ( this.brands.includes( 'phet-io' ) ) {
          linkSuffixes.push( ` phet-io](https://phet-dev.colorado.edu/html/${this.repo}/${versionString}${phetioFolder}/${this.repo}${phetioSuffix}.html?${standaloneParams})` );
          linkSuffixes.push( ` phet-io Instance Proxies](https://phet-dev.colorado.edu/html/${this.repo}/${versionString}${phetioFolder}/wrappers/instance-proxies/instance-proxies.html?sim=${this.repo}&${proxiesParams})` );
        }
      }
      else {
        if ( this.brands.includes( 'phet' ) ) {
          linkSuffixes.push( `](https://phet.colorado.edu/sims/html/${this.repo}/${versionString}/${this.repo}_en${phetSuffix}.html)` );
        }
        if ( this.brands.includes( 'phet-io' ) ) {
          linkSuffixes.push( ` phet-io](https://phet-io.colorado.edu/sims/${this.repo}/${versionString}${phetioFolder}${phetFolder}/${this.repo}${phetioSuffix}.html?${standaloneParams})` );
          linkSuffixes.push( ` phet-io Instance Proxies](https://phet-io.colorado.edu/sims/${this.repo}/${versionString}${phetioFolder}/wrappers/instance-proxies/instance-proxies.html?sim=${this.repo}&${proxiesParams})` );
        }
      }

      const results = linkSuffixes.map( link => `- [ ] [${this.repo} ${versionString}${link}` );
      if ( includeMessages ) {
        results.unshift( `\n${this.repo} ${this.branch} (${this.pushedMessages.join( ', ' )})\n` );
      }
      return results;
    }

    async checkout( includeNpmUpdate = true ) {
      await gitCheckout( this.repo, this.branch );
      await gitPull( this.repo );
      const dependencies = await getDependencies( this.repo );
      for ( let key of Object.keys( this.changedDependencies ) ) {
        // This should exist hopefully
        dependencies[ key ].sha = this.changedDependencies[ key ];
      }
      return await checkoutDependencies( this.repo, dependencies, includeNpmUpdate );
    }
  }

  return ModifiedBranch;
} )();