// Copyright 2017, University of Colorado Boulder

/**
 * git commit
 *
 * @author Jonathan Olson <jonathan.olson@colorado.edu>
 */
/* eslint-env node */
'use strict';

// modules
var execute = require( './execute' );
var winston = require( 'winston' );

/**
 * Executes git commit
 * @public
 *
 * @param {string} repo - The repository name
 * @param {string} message - The message to include in the commit
 * @returns {Promise} - See execute for details
 */
module.exports = function( repo, message ) {
  winston.info( 'git commit on ' + repo + ' with message:\n' + message );

  return execute( 'git', [ 'commit', '-m', message ], '../' + repo );
};
