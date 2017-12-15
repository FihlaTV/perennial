// Copyright 2002-2017, University of Colorado Boulder

/**
 * PhET build and deploy server. The server is designed to run on the same host as the production site (phet-server.int.colorado.edu).
 * This file initializes the app and the main process queue.
 *
 * @author Aaron Davis
 * @author Matt Pennington
 */

/* eslint-env node */
'use strict';

// constants
const constants = require( './constants' );

// modules
const async = require( 'async' );
const express = require( 'express' );
const winston = require( './log.js' ); // eslint-disable-line
const parseArgs = require( 'minimist' ); // eslint-disable-line
const _ = require( 'lodash' ); // eslint-disable-line

// functions
const logRequest = require( './logRequest' );
const sendEmail = require( './sendEmail' );
const taskWorker = require( './taskWorker' );

// set this process up with the appropriate permissions, value is in octal
process.umask( parseInt( '0002', 8 ) );

/**
 * Handle command line input
 * First 2 args provide info about executables, ignore
 */
const parsedCommandLineOptions = parseArgs( process.argv.slice( 2 ), {
  boolean: true
} );

const defaultOptions = {
  verbose: constants.BUILD_SERVER_CONFIG.verbose, // can be overridden by a flag on the command line

  // options for supporting help
  help: false,
  h: false
};

for ( let key in parsedCommandLineOptions ) {
  if ( key !== '_' && parsedCommandLineOptions.hasOwnProperty( key ) && !defaultOptions.hasOwnProperty( key ) ) {
    console.error( 'Unrecognized option: ' + key );
    console.error( 'try --help for usage information.' );
    process.exit( 1 );
  }
}

// If help flag, print help and usage info
if ( parsedCommandLineOptions.hasOwnProperty( 'help' ) || parsedCommandLineOptions.hasOwnProperty( 'h' ) ) {
  console.log( 'Usage:' );
  console.log( '  node build-server.js [options]' );
  console.log( '' );
  console.log( 'Options:' );
  console.log(
    '  --help (print usage and exit)\n' +
    '    type: bool  default: false\n' +
    '  --verbose (output grunt logs in addition to build-server)\n' +
    '    type: bool  default: false\n'
  );
  process.exit( 1 );
}

// Merge the default and supplied options.
const options = _.extend( defaultOptions, parsedCommandLineOptions );
const verbose = options.verbose;

const taskQueue = async.queue( taskWorker, 1 ); // 1 is the max number of tasks that can run concurrently

/**
 * Handle chipper 1.0 requests
 *
 * @param {express.Request} req
 * @param {express.Response} res
 * @param {String} key - one of 'query' or 'body', used to differentiate query parameters or POST data.
 */
function queueDeployApiVersion1( req, res, key ) {
  const repos = decodeURIComponent( req[ key ][ constants.REPOS_KEY ] );
  const simName = decodeURIComponent( req[ key ][ constants.SIM_NAME_KEY ] );
  const version = decodeURIComponent( req[ key ][ constants.VERSION_KEY ] );
  const locales = decodeURIComponent( req[ key ][ constants.LOCALES_KEY ] ) || null;
  const option = decodeURIComponent( req[ key ][ constants.OPTION_KEY ] ) || 'default';
  const email = decodeURIComponent( req[ key ][ constants.EMAIL_KEY ] ) || null;
  const translatorId = decodeURIComponent( req[ key ][ constants.USER_ID_KEY ] ) || null;
  const authorizationKey = decodeURIComponent( req[ key ][ constants.AUTHORIZATION_KEY ] );

  const servers = ( option === 'rc' ) ? [ constants.PRODUCTION_SERVER ] : [ constants.DEV_SERVER ];
  const brands = version.indexOf( 'phetio' ) < 0 ? [ constants.PHET_BRAND ] : [ constants.PHET_IO_BRAND ];

  queueDeploy( '1.0', repos, simName, version, locales, servers, brands, email, translatorId, authorizationKey, req, res );
}

function getQueueDeploy( req, res ) {
  logRequest( req, 'query', winston );
  queueDeployApiVersion1( req, res, 'query' );
}

function postQueueDeploy( req, res ) {
  logRequest( req, 'body', winston );

  const api = decodeURIComponent( req.body[ constants.API_KEY ] );

  if ( api && api.startsWith( '2.' ) ) {
    const repos = JSON.parse( req.body[ constants.DEPENDENCIES_KEY ] );
    const simName = req.body[ constants.SIM_NAME_KEY ];
    const version = req.body[ constants.VERSION_KEY ];
    const locales = req.body[ constants.LOCALES_KEY ] || null;
    const servers = req.body[ constants.SERVERS_KEY ];
    const brands = req.body[ constants.BRANDS_KEY ];
    const authorizationKey = req.body[ constants.AUTHORIZATION_KEY ];
    const translatorId = req.body[ constants.TRANSLATOR_ID_KEY ] || null;
    const email = req.body[ constants.EMAIL_KEY ] || null;

    queueDeploy( api, repos, simName, version, locales, brands, servers, email, translatorId, authorizationKey, req, res );
  }
  else {
    queueDeployApiVersion1( req, res, 'body' );
  }
}

/**
 * Adds the request to the processing queue and handles email notifications about success or failures
 *
 * @param {String} api
 * @param {Object} repos
 * @param {String} simName
 * @param {String} version
 * @param {Array.<String>} locales
 * @param {Array.<String>} brands
 * @param {Array.<String>} servers
 * @param {String} email
 * @param {String} translatorId
 * @param {String} authorizationKey
 * @param {express.Request} req
 * @param {express.Response} res
 */
function queueDeploy( api, repos, simName, version, locales, brands, servers, email, translatorId, authorizationKey, req, res ) {

  if ( repos && simName && version && authorizationKey ) {
    const productionBrands = [ constants.PHET_BRAND, constants.PHET_IO_BRAND ];

    if ( authorizationKey !== constants.BUILD_SERVER_CONFIG.buildServerAuthorizationCode ) {
      const err = 'wrong authorization code';
      winston.log( 'error', err );
      res.send( err );
    }
    else if ( servers.indexOf( constants.PRODUCTION_SERVER ) >= 0 && brands.some( brand => { return !productionBrands.includes( brand ); } ) ) {
      const err = 'Cannot complete production deploys for brands outside of phet and phet-io';
      winston.log( 'error', err );
      res.send( err );
    }
    else {
      winston.log( 'info', 'queuing build for ' + simName + ' ' + version );
      taskQueue.push( { api, repos, simName, version, locales, servers, brands, email, translatorId, res }, function( err ) {
        const simInfoString = 'Sim = ' + simName +
                              ' Version = ' + version +
                              ' Locales = ' + locales;

        if ( err ) {
          let shas = repos;

          // try to format the JSON nicely for the email, but don't worry if it is invalid JSON
          try {
            shas = JSON.stringify( JSON.parse( shas ), null, 2 );
          }
          catch( e ) {
            // invalid JSON
          }
          const errorMessage = 'Build failed with error: ' + err + '. ' + simInfoString + ' Shas = ' + shas;
          winston.log( 'error', errorMessage );
          sendEmail( 'BUILD ERROR', errorMessage, email );
        }
        else {
          winston.log( 'info', 'build for ' + simName + ' finished successfully' );
          sendEmail( 'Build Succeeded', simInfoString, email, true );
        }

        // reset email parameter to null after build finishes or errors, since this email address may be different on every build
        email = null;
      } );

      res.send( 'build process initiated, check logs for details' );
    }
  }
  else {
    const errorString = 'missing one or more required query parameters: dependencies, simName, version, authorizationCode';
    winston.log( 'error', errorString );
    res.send( errorString );
  }
}

// Create the ExpressJS app
const app = express();

// to support JSON-encoded bodies
const bodyParser = require( 'body-parser' ); // eslint-disable-line require-statement-match
app.use( bodyParser.json() );

// add the route to build and deploy
app.get( '/deploy-html-simulation', getQueueDeploy );
app.post( '/deploy-html-simulation', postQueueDeploy );

// start the server
app.listen( constants.LISTEN_PORT, function() {
  winston.log( 'info', 'Listening on port ' + constants.LISTEN_PORT );
  winston.log( 'info', 'Verbose mode: ' + verbose );
} );