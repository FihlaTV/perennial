// Copyright 2017, University of Colorado Boulder

/**
 * Returns the version of the current checked-in repo's package.json
 *
 * @author Jonathan Olson <jonathan.olson@colorado.edu>
 */
/* eslint-env node */
'use strict';

// modules
const loadJSON = require( './loadJSON' );
const SimVersion = require( './SimVersion' );
const winston = require( 'winston' );

/**
 * Returns the version for a current checked-in repo
 * @public
 *
 * @param {string} repo - The repository name
 * @returns {Promise} - Resolves to version: {SimVersion}
 */
module.exports = async function( repo ) {
  winston.debug( `Reading version from package.json for ${repo}` );

  const packageObject = await loadJSON( `../${repo}/package.json` );
  return SimVersion.parse( packageObject.version );
};
