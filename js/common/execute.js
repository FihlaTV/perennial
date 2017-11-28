// Copyright 2017, University of Colorado Boulder

/**
 * Command execution wrapper (with common settings)
 *
 * @author Jonathan Olson <jonathan.olson@colorado.edu>
 */
/* eslint-env node */
'use strict';

// modules
const child_process = require( 'child_process' );
const winston = require( 'winston' );

/**
 * Executes a command, with specific arguments and in a specific directory (cwd).
 * @public
 *
 * Resolves with the stdout: {string}
 * Rejects with { code: {number}, stdout: {string} } -- Happens if the exit code is non-zero.
 *
 * @param {string} cmd - The process to execute. Should be on the current path.
 * @param {Array.<string>} args - Array of arguments. No need to extra-quote things.
 * @param {string} cwd - The working directory where the process should be run from
 * @returns {Promise}
 */
module.exports = function( cmd, args, cwd ) {
  return new Promise( ( resolve, reject ) => {
    const process = child_process.spawn( cmd, args, {
      cwd: cwd
    } );
    winston.debug( `running ${cmd} ${args.join( ' ' )} from ${cwd}` );

    var stdout = ''; // to be appended to

    process.stderr.on( 'data', data => winston.debug( 'stderr: ' + data ) );
    process.stdout.on( 'data', data => {
      stdout += data;
      winston.debug( 'stdout: ' + data );
    } );

    process.on( 'close', code => {
      if ( code !== 0 ) {
        reject( { code, stdout } );
      }
      else {
        resolve( stdout );
      }
    } );
  } );
};
