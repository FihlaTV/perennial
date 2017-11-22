// Copyright 2017, University of Colorado Boulder

/**
 * Handling for writing JSON to a file.
 *
 * @author Jonathan Olson <jonathan.olson@colorado.edu>
 */
/* eslint-env node */
'use strict';

// modules
var fs = require( 'fs' );
var winston = require( 'winston' );

/**
 * Write JSON to a file
 * @public
 *
 * @param {string} file
 * @param {Object} content
 * @returns {Promise}
 */
module.exports = function( file, content ) {
  return new Promise( ( resolve, reject ) => {
    winston.debug( 'Writing JSON to ' + file );

    fs.writeFile( file, JSON.stringify( content, null, 2 ), function( err ) {
      if ( err ) {
        reject( 'Could not write to file: ' + file + ' due to: ' + err );
      }
      else {
        resolve();
      }
    } );
  } );
};