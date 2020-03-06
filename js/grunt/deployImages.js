// Copyright 2020, University of Colorado Boulder


// Copyright 2017, University of Colorado Boulder

/**
 * Sends a request to the build server.
 *
 * @author Jonathan Olson <jonathan.olson@colorado.edu>
 */

'use strict';

// modules
const assert = require( 'assert' );
const buildLocal = require( '../common/buildLocal' );
const request = require( 'request' );
const winston = require( 'winston' );

/**
 * Sends a request to the build server.
 * @public
 *
 * @param {string} branch
 * @param {string} brands - CSV
 * @returns {Promise} - No resolved value
 */
module.exports = async function(  branch, brands ) {
  return new Promise( ( resolve, reject ) => {

    winston.info( `sending build request for ${repo} ${version.toString()} with dependencies: ${JSON.stringify( dependencies )}` );

    servers.forEach( server => assert( [ 'dev', 'production' ].includes( server ), `Unknown server: ${server}` ) );

    const requestObject = {
      brands: brands,
      branch: branch,
      authorizationCode: buildLocal.buildServerAuthorizationCode
    };
    if ( buildLocal.buildServerNotifyEmail ) {
      requestObject.email = buildLocal.buildServerNotifyEmail;
    }

    const url = `${buildLocal.productionServerURL}/deploy-images`;

    winston.info( url );
    winston.info( JSON.stringify( requestObject ) );

    request.post( { url: url, json: requestObject }, function( error, response ) {
      if ( error ) {
        reject( new Error( `Image deploy request failed with error ${error}.` ) );
      }
      else if ( response.statusCode !== 200 && response.statusCode !== 202 ) {
        reject( new Error( `Image deploy request failed with status code ${response.statusCode}.` ) );
      }
      else {
        winston.info( 'Image deploy request sent successfully' );
        resolve();
      }
    } );

    winston.info( `request sent: ${url}` );
  } );
};
