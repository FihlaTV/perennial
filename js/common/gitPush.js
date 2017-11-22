// Copyright 2017, University of Colorado Boulder

/**
 * git push
 *
 * @author Jonathan Olson <jonathan.olson@colorado.edu>
 */
/* eslint-env node */
'use strict';

// modules
var execute = require( './execute' );
var winston = require( 'winston' );

/**
 * Executes git push
 * @public
 *
 * @param {string} repo - The repository name
 * @param {string} remoteBranch - The branch that is getting pushed to, e.g. 'master' or '1.0'
 * @returns {Promise} - See execute for details
 */
module.exports = function( repo, remoteBranch ) {
  winston.info( 'git push on ' + repo + ' to ' + remoteBranch );

  return execute( 'git', [ 'push', '-u', 'origin', remoteBranch ], '../' + repo );
};
