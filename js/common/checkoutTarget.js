// Copyright 2017, University of Colorado Boulder

/**
 * Checks out a SHA/branch for a repository, and also checks out all of its dependencies.
 *
 * @author Jonathan Olson <jonathan.olson@colorado.edu>
 */
/* eslint-env node */
'use strict';

// modules
var checkoutDependencies = require( './checkoutDependencies' );
var getDependencies = require( './getDependencies' );
var gitCheckout = require( './gitCheckout' );
var gitPull = require( './gitPull' );
var winston = require( 'winston' );
var _ = require( 'lodash' ); // eslint-disable-line

/**
 * Checks out a SHA/branch for a repository, and also checks out all of its dependencies.
 * @public
 *
 * @param {string} repo - The repository name
 * @param {string} target - branch or SHA
 * @param {boolean} includeNpmUpdate
 * @returns {Promise} - Resolves with checkedOutRepos: {Array.<string>}
 */
module.exports = async function( repo, target, includeNpmUpdate ) {
  winston.info( 'checking out shas for ' + repo + ' ' + target );

  await gitCheckout( repo, target );
  await gitPull( repo ); // Does this work for a SHA?
  var dependencies = await getDependencies( repo );
  return await checkoutDependencies( repo, dependencies, includeNpmUpdate );
};
