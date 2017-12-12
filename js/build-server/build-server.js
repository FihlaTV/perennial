// Copyright 2002-2017, University of Colorado Boulder

/**
 * PhET build and deploy server. The server is designed to run on the same host as the production site (phet-server.int.colorado.edu).
 *
 * Starting and Stopping the Server
 * ================================
 *
 * To start, stop, or restart the build server on phet-server.int.colorado.edu (production) or phet-server.int.colorado.edu (test), run this command:
 * sudo systemctl [start|stop|restart] build-server
 *
 * To view the logs, run the following command.  A -f flag will tail the log.  Pressing Shift+F will scroll to the end (navigation is less-like).
 * sudo journalctl -u build-server
 *
 * To edit startup options, please see /usr/lib/systemd/system/build-server.service
 *
 * !!!DEPRECATED!!! - figaro has been decommisioned and simian is nearing end of life.
 * To start, stop, or restart the build server on figaro or simian, run this command:
 * sudo /etc/init.d/build-server [start|stop|restart]
 *
 * Build Server Configuration
 * ==========================
 *
 * All of the phet repos live on the production and dev servers under /data/share/phet/phet-repos. The build server
 * lives in perennial: /data/share/phet/phet-repos/perennial/js/build-server.
 *
 * The build-server is run as user "phet-admin". It requires the certain fields filled out in phet-admin's HOME/.phet/build-local.json
 * (see assertions in getBuildServerConfig.js). These fields are already filled out, but they may need to modified or updated.
 *
 * The build server is configured to send an email on build failure. The configuration for sending emails is also in
 * phet-admin's HOME/.phet/build-local.json (these fields are described in getBuildServerConfig.js). To add other email
 * recipients, you can add email addresses to the emailTo field in this file.
 *
 * Additionally, phet-admin needs an ssh key set up to copy files from the production server to spot. This should already be set up,
 * but should you to do to set it up somewhere else, you'll need to have an rsa key in ~/.ssh on the production server and authorized
 * (run "ssh-keygen -t rsa" to generate a key if you don't already have one).
 * Also, you will need to add an entry for spot in ~/.ssh/config like so:
 *
 * Host spot
 *     HostName spot.colorado.edu
 *     User [identikey]
 *     Port 22
 *     IdentityFile ~/.ssh/id_rsa
 *
 * On spot, you'll need to add the public key from phet-server to a file ~/.ssh/authorized_keys
 *
 * build-server log files can be tailed by running /usr/lib/systemd/system/build-server.service
 *
 * build-server needs to be able to make commits to github to notify rosetta that a new sim is translatable. To do this,
 * There must be valid git credentials in the .netrc file phet-admin's home directory.
 *
 *
 * Using the Build Server for Production Deploys
 * =============================================
 *
 * The build server starts a build process upon receiving an https POST request to /deploy-html-simulation.
 * It takes as input a JSON object with the following properties:
 * - repos - a json object with dependency repos and shas, in the form of dependencies.json files
 * - locales - a comma-separated list of locales to build [optional, defaults to all locales in babel]
 * - simName - the standardized name of the sim, lowercase with hyphens instead of spaces (i.e. area-builder)
 * - version - the version to be built. Production deploys will automatically strip everything after the major.minor.maintenance
 * - authorizationCode - a password to authorize legitimate requests
 * - option - optional parameter, can be set to "rc" to do an rc deploy instead of production
 * - email - optional parameter, used to send success/failure notifications
 * - translatorId - optional parameter for production/rc deploys, required for translation deploys from rosetta to add the user's credit to the website.
 *
 * Note: You will NOT want to assemble these request URLs manually, instead use "grunt deploy-production" for production deploys and
 * "grunt deploy-rc" for rc deploys.
 *
 *
 * What the Build Server Does
 * ==========================
 *
 * The build server does the following steps when a deploy request is received:
 * - checks the authorization code, unauthorized codes will not trigger a build
 * - puts the build task on a queue so multiple builds don't occur simultaneously
 * - pull perennial and npm update
 * - clone missing repos
 * - pull master for the sim and all dependencies
 * - grunt checkout-shas
 * - checkout sha for the current sim
 * - npm update in chipper and the sim directory
 * - grunt build-for-server --brand=phet for selected locales (see chipper's Gruntfile for details)
 *
 * - for rc deploys:
 *    - deploy to spot, checkout master for all repositories, and finish
 *
 * - for production deploys:
 *    - mkdir for the new sim version
 *    - copy the build files to the correct location in the server doc root
 *    - write the .htaccess file for indicating the latest directory and downloading the html files
 *    - write the XML file that tells the website which translations exist
 *    - notify the website that a new simulation/translation is published and should appear
 *    - add the sim to rosetta's simInfoArray and commit and push (if the sim isn't already there)
 *    - checkout master for all repositories
 *
 * If any of these steps fails, the build aborts and grunt checkout-master-all is run so all repos are back on master
 *
 * @author Aaron Davis
 */

/* eslint-env node */
'use strict';

// modules
const async = require( 'async' );
const child_process = require( 'child_process' );
const dateformat = require( 'dateformat' );
const email = require( 'emailjs/email' );
const express = require( 'express' );
const fs = require( 'fs.extra' ); // eslint-disable-line
const getBuildServerConfig = require( './getBuildServerConfig' );
const mimelib = require( 'mimelib' );
const parseArgs = require( 'minimist' ); // eslint-disable-line
const xml2js = require( 'xml2js' );
const parseString = xml2js.parseString;
const request = require( 'request' );
const winston = require( 'winston' );

const _ = require( 'lodash' ); // eslint-disable-line

// constants
const BUILD_SERVER_CONFIG = getBuildServerConfig( fs );
const LISTEN_PORT = 16371;
const REPOS_KEY = 'repos';
const DEPENDENCIES_KEY = 'dependencies';
const LOCALES_KEY = 'locales';
const API_KEY = 'api';
const SIM_NAME_KEY = 'simName';
const VERSION_KEY = 'version';
const OPTION_KEY = 'option';
const EMAIL_KEY = 'email';
const USER_ID_KEY = 'userId';
const TRANSLATOR_ID_KEY = 'translatorId';
const AUTHORIZATION_KEY = 'authorizationCode';
const SERVERS_KEY = 'servers';
const BRANDS_KEY = 'brands';
const PRODUCTION_SERVER = 'production';
const DEV_SERVER = 'dev';
const HTML_SIMS_DIRECTORY = BUILD_SERVER_CONFIG.htmlSimsDirectory;
const PHETIO_SIMS_DIRECTORY = BUILD_SERVER_CONFIG.phetioSimsDirectory;
const ENGLISH_LOCALE = 'en';
const PERENNIAL = '.';

/**
 * Define a helper function that will get a list of the PhET-style version directories at the given path.  The
 * directories must be named with three numbers separated by periods, e.g. 1.2.5.  The directories are sorted in
 * numerical order, which is different from the lexical ordering used by the Linux file system.  So, for example, valid
 * output from this method could be the array [ "1.1.8", "1.1.9", "1.1.10" ].  For more information on why this is
 * necessary, see https://github.com/phetsims/perennial/issues/28.
 *
 * @param path - Filename of the directory.  It's ok if the path does not exist.
 * @returns {Array} - returns a sorted array of version directories.  Returns an empty array if none exist or if the path does not exist.
 */
function getSortedVersionDirectories( path ) {

  let versions;

  if ( fs.existsSync( path ) ) {
    versions = fs.readdirSync( path );
  }
  else {
    versions = [];
  }

  // filter out names that don't match the required format
  versions = versions.filter( function( path ) {
    const splitPath = path.split( '.' );
    if ( splitPath.length !== 3 ) {
      return false;
    }
    for ( let i = 0; i < 3; i++ ) {
      if ( isNaN( splitPath[ i ] ) ) {
        return false;
      }
    }
    return true;
  } );

  // sort the names in numerical (not lexical) order
  versions.sort( function( a, b ) {
    const aTokenized = a.split( '.' );
    const bTokenized = b.split( '.' );
    let result = 0;
    for ( let i = 0; i < aTokenized.length; i++ ) {
      if ( parseInt( aTokenized[ i ], 10 ) < parseInt( bTokenized[ i ], 10 ) ) {
        result = -1;
        break;
      }
      else if ( parseInt( aTokenized[ i ], 10 ) > parseInt( bTokenized[ i ], 10 ) ) {
        result = 1;
        break;
      }
    }
    return result;
  } );
  return versions;
}

// set this process up with the appropriate permissions, value is in octal
process.umask( parseInt( '0002', 8 ) );

// for storing an email address to send build failure emails to that is passed as a parameter on a per build basis
let emailParameter = null;

// Handle command line input
// First 2 args provide info about executables, ignore
const parsedCommandLineOptions = parseArgs( process.argv.slice( 2 ), {
  boolean: true
} );

const defaultOptions = {
  verbose: BUILD_SERVER_CONFIG.verbose, // can be overridden by a flag on the command line

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

// add timestamps to log messages
winston.remove( winston.transports.Console );
winston.add( winston.transports.Console, {
  'timestamp': function() {
    return dateformat( new Date(), 'mmm dd yyyy HH:MM:ss Z' );
  }
} );

// configure email server
let emailServer;
if ( BUILD_SERVER_CONFIG.emailUsername && BUILD_SERVER_CONFIG.emailPassword && BUILD_SERVER_CONFIG.emailTo ) {
  emailServer = email.server.connect( {
    user: BUILD_SERVER_CONFIG.emailUsername,
    password: BUILD_SERVER_CONFIG.emailPassword,
    host: BUILD_SERVER_CONFIG.emailServer,
    tls: true
  } );
}
else {
  winston.log( 'warn', 'failed to set up email server, missing one or more of the following fields in build-local.json:\n' +
                       'emailUsername, emailPassword, emailTo' );
}

/**
 * Send an email. Used to notify developers if a build fails
 * @param subject
 * @param text
 * @param emailParameterOnly - if true send the email only to the passed in email, not to the default list as well
 */
function sendEmail( subject, text, emailParameterOnly ) {
  if ( emailServer ) {
    let emailTo = BUILD_SERVER_CONFIG.emailTo;

    if ( emailParameter ) {
      if ( emailParameterOnly ) {
        emailTo = emailParameter;
      }
      else {
        emailTo += ( ', ' + emailParameter );
      }
    }

    // don't send an email if no email is given
    if ( emailParameterOnly && !emailParameter ) {
      return;
    }

    winston.log( 'info', 'attempting to send email' );
    emailServer.send( {
        text: text,
        from: 'PhET Build Server <phethelp@colorado.edu>',
        to: emailTo,
        subject: subject
      },
      function( err, message ) {
        if ( err ) {
          winston.log( 'error', 'error when attempted to send email, err = ' + err );
        }
        else {
          winston.log( 'info', 'sent email to: ' + message.header.to +
                               ', subject: ' + mimelib.decodeMimeWord( message.header.subject ) +
                               ', text: ' + message.text );
        }
      }
    );
  }
}

/**
 * taskQueue ensures that only one build/deploy process will be happening at the same time.  The main build/deploy logic is here.
 *
 * @param {Object} task
 * @property {JSON} task.repos
 * @property {String} task.locales - comma separated list of locale codes
 * @property {String} task.simName - lower case simulation name used for creating files/directories
 * @property {String} task.version - sim version identifier string
 * @property {String} task.option - deployment type (dev/rc/production)
 * @property {String} task.email - used for sending notifications about success/failure
 * @property {String} task.translatorId - rosetta user id for adding translators to the website
 * @property {String} task.res - express response object
 */
const taskQueue = async.queue( function( task, taskCallback ) {

  //-------------------------------------------------------------------------------------
  // Parse and validate parameters
  //-------------------------------------------------------------------------------------

  const repos = JSON.parse( decodeURIComponent( task.repos ) );
  const locales = task.locales ? decodeURIComponent( task.locales ) : null;
  const simName = decodeURIComponent( task.simName );
  let version = decodeURIComponent( task.version );
  const res = task.res;

  // this may have been declared already?
  emailParameter = task.email ? decodeURIComponent( task.email ) : null;

  const userId = ( task.translatorId ) ? decodeURIComponent( task.translatorId ) : undefined;
  if ( userId ) {
    winston.log( 'info', 'setting userId = ' + userId );
  }


  //-----------------------------------------------------------------------------------------
  // Define helper functions for use in this function
  //-----------------------------------------------------------------------------------------

  /**
   * Execute a step of the build process. The build aborts if any step fails.
   *
   * @param command the command to be executed
   * @param dir the directory to execute the command from
   * @param callback the function that executes upon completion
   */
  const exec = function( command, dir, callback ) {
    winston.log( 'info', 'running command: ' + command );

    child_process.exec( command, { cwd: dir }, function( err, stdout, stderr ) {

      if ( verbose ) {
        if ( stdout ) { winston.log( 'info', stdout ); }
        if ( stderr ) { winston.log( 'info', stderr ); }
      }

      if ( !err ) {
        winston.log( 'info', command + ' ran successfully in directory: ' + dir );
        if ( callback ) { callback(); }
      }
      else {
        if ( command === 'grunt checkout-master-all' ) {

          // checkout master for all repos if the build fails so they don't get left at random shas
          winston.log( 'error', 'error running grunt checkout-master-all in ' + dir + ', build aborted to avoid infinite loop.' );
          taskCallback( 'error running command ' + command + ': ' + err ); // build aborted, so take this build task off of the queue
        }
        else {
          winston.log(
            'error',
            'error running command: ' + command + ' in ' + dir + ', err: ' + err + ', stdout: ' + stdout + ', build aborted.'
          );
          exec( 'grunt checkout-master-all', PERENNIAL, function() {
            winston.log( 'info', 'checking out master for every repo in case build shas are still checked out' );
            taskCallback( 'error running command ' + command + ': ' + err ); // build aborted, so take this build task off of the queue
          } );
        }
      }
    } );
  };

  const execWithoutAbort = function( command, dir, callback ) {
    child_process.exec( command, { cwd: dir }, function( err, stdout, stderr ) {

      if ( err ) {
        winston.log( 'warn', 'command \'' + command + '\' in dir \'' + dir + '\' had error ' + err );
      }

      if ( verbose ) {
        if ( stdout ) { winston.log( 'info', stdout ); }
        if ( stderr ) { winston.log( 'info', stderr ); }
      }

      callback( err );
    } );
  };

  /**
   * checkout master everywhere and abort build with err
   * @param err
   */
  const abortBuild = function( err ) {
    winston.log( 'error', 'BUILD ABORTED! ' + err );
    exec( 'grunt checkout-master-all', PERENNIAL, function() {
      winston.log( 'info', 'build aborted: checking out master for every repo in case build shas are still checked out' );
      taskCallback( err ); // build aborted, so take this build task off of the queue
    } );
  };

  const simNameRegex = /^[a-z-]+$/;

  // make sure the repos passed in validates
  for ( let key in repos ) {
    if ( repos.hasOwnProperty( key ) ) {

      // make sure all keys in repos object are valid sim names
      if ( !simNameRegex.test( key ) ) {
        abortBuild( 'invalid simName in repos: ' + simName );
        return;
      }

      const value = repos[ key ];
      if ( key === 'comment' ) {
        if ( typeof value !== 'string' ) {
          abortBuild( 'invalid comment in repos: should be a string' );
          return;
        }
      }
      else if ( value instanceof Object && value.hasOwnProperty( 'sha' ) ) {
        if ( !/^[a-f0-9]{40}$/.test( value.sha ) ) {
          abortBuild( 'invalid sha in repos. key: ' + key + ' value: ' + value + ' sha: ' + value.sha );
          return;
        }
      }
      else {
        abortBuild( 'invalid item in repos. key: ' + key + ' value: ' + value );
        return;
      }
    }
  }

  // validate simName
  if ( !simNameRegex.test( simName ) ) {
    abortBuild( 'invalid simName ' + simName );
    return;
  }

  // Infer brand from version string and keep unstripped version for phet-io
  const originalVersion = version;

  // validate version and strip suffixes since just the numbers are used in the directory name on dev and production servers
  const versionMatch = version.match( /^(\d+\.\d+\.\d+)(?:-.*)?$/ );
  if ( versionMatch && versionMatch.length === 2 ) {

    if ( option === 'rc' ) {

      // if deploying an rc version use the -rc.[number] suffix
      version = versionMatch[ 0 ];
    }
    else {

      // otherwise strip any suffix
      version = versionMatch[ 1 ];
    }
    winston.log( 'info', 'detecting version number: ' + version );
  }
  else {
    abortBuild( 'invalid version number: ' + version );
    return;
  }

  // define vars for build dir and sim dir
  const buildDir = './js/build-server/tmp';
  const simDir = '../' + simName;

  winston.log( 'info', 'building sim ' + simName );


  //-------------------------------------------------------------------------------------
  // Define other helper functions used in build process
  //-------------------------------------------------------------------------------------

  /**
   * Get all of the deployed locales from the latest version before publishing the next version,
   * so we know which locales to rebuild.
   * @param {string} locales
   * @param {Function} callback
   */
  const getLocales = function( locales, callback ) {
    let callbackLocales;

    if ( locales && locales !== '*' ) {

      // from rosetta
      callbackLocales = locales;
    }
    else {

      // from grunt deploy-production
      const simDirectory = HTML_SIMS_DIRECTORY + simName;
      const versionDirectories = getSortedVersionDirectories( simDirectory );
      if ( versionDirectories.length > 0 ) {
        const latest = versionDirectories[ versionDirectories.length - 1 ];
        const translationsXMLFile = HTML_SIMS_DIRECTORY + simName + '/' + latest + '/' + simName + '.xml';
        winston.log( 'info', 'path to translations XML file = ' + translationsXMLFile );
        const xmlString = fs.readFileSync( translationsXMLFile );
        parseString( xmlString, function( err, xmlData ) {
          if ( err ) {
            winston.log( 'error', 'error parsing XML, err = ' + err );
          }
          else {
            winston.log( 'info', 'data extracted from translations XML file:' );
            winston.log( 'info', JSON.stringify( xmlData, null, 2 ) );
            const simsArray = xmlData.project.simulations[ 0 ].simulation;
            const localesArray = [];
            for ( let i = 0; i < simsArray.length; i++ ) {
              localesArray.push( simsArray[ i ].$.locale );
            }
            callbackLocales = localesArray.join( ',' );
          }
        } );
      }
      else {
        // first deploy, sim directory will not exist yet, just publish the english version
        callbackLocales = 'en';
      }
    }

    winston.log( 'info', 'building locales=' + callbackLocales );
    callback( callbackLocales );
  };

  /**
   * Create a [sim name].xml file in the live sim directory in htdocs. This file tells the website which
   * translations exist for a given sim. It is used by the "synchronize" method in Project.java in the website code.
   * @param simTitleCallback
   * @param callback
   */
  const createTranslationsXML = function( simTitleCallback, callback ) {

    const rootdir = '../babel/' + simName;
    const englishStringsFile = simName + '-strings_en.json';
    const stringFiles = [ { name: englishStringsFile, locale: ENGLISH_LOCALE } ];

    // pull all the string filenames and locales from babel and store in stringFiles array
    try {
      const files = fs.readdirSync( rootdir );
      for ( let i = 0; i < files.length; i++ ) {
        const filename = files[ i ];
        const firstUnderscoreIndex = filename.indexOf( '_' );
        const periodIndex = filename.indexOf( '.' );
        const locale = filename.substring( firstUnderscoreIndex + 1, periodIndex );
        stringFiles.push( { name: filename, locale: locale } );
      }
    }
    catch( e ) {
      winston.log( 'warn', 'no directory for the given sim exists in babel' );
    }

    // try opening the english strings file so we can read the english strings
    let englishStrings;
    try {
      englishStrings = JSON.parse( fs.readFileSync( '../' + simName + '/' + englishStringsFile, { encoding: 'utf-8' } ) );
    }
    catch( e ) {
      abortBuild( 'English strings file not found' );
      return;
    }

    const simTitleKey = simName + '.title'; // all sims must have a key of this form

    if ( englishStrings[ simTitleKey ] ) {
      simTitleCallback( englishStrings[ simTitleKey ].value );
    }
    else {
      abortBuild( 'no key for sim title' );
      return;
    }

    // create xml, making a simulation tag for each language
    let finalXML = '<?xml version="1.0" encoding="utf-8" ?>\n' +
                   '<project name="' + simName + '">\n' +
                   '<simulations>\n';

    for ( let j = 0; j < stringFiles.length; j++ ) {
      const stringFile = stringFiles[ j ];
      const languageJSON = ( stringFile.locale === ENGLISH_LOCALE ) ? englishStrings :
                         JSON.parse( fs.readFileSync( '../babel' + '/' + simName + '/' + stringFile.name, { encoding: 'utf-8' } ) );

      const simHTML = HTML_SIMS_DIRECTORY + simName + '/' + version + '/' + simName + '_' + stringFile.locale + '.html';

      if ( fs.existsSync( simHTML ) ) {
        const localizedSimTitle = ( languageJSON[ simTitleKey ] ) ? languageJSON[ simTitleKey ].value : englishStrings[ simTitleKey ].value;
        finalXML = finalXML.concat( '<simulation name="' + simName + '" locale="' + stringFile.locale + '">\n' +
                                    '<title><![CDATA[' + localizedSimTitle + ']]></title>\n' +
                                    '</simulation>\n' );
      }
    }

    finalXML = finalXML.concat( '</simulations>\n' + '</project>' );

    fs.writeFileSync( HTML_SIMS_DIRECTORY + simName + '/' + version + '/' + simName + '.xml', finalXML );
    winston.log( 'info', 'wrote XML file:\n' + finalXML );
    callback();
  };

  /**
   * Write the .htaccess file to make "latest" point to the version being deployed and allow "download" links to work on Safari
   * @param callback
   */
  const writePhetHtaccess = function( callback ) {
    const contents = 'RewriteEngine on\n' +
                   'RewriteBase /sims/html/' + simName + '/\n' +
                   'RewriteRule latest(.*) ' + version + '$1\n' +
                   'Header set Access-Control-Allow-Origin "*"\n\n' +
                   'RewriteCond %{QUERY_STRING} =download\n' +
                   'RewriteRule ([^/]*)$ - [L,E=download:$1]\n' +
                   'Header onsuccess set Content-disposition "attachment; filename=%{download}e" env=download\n';
    fs.writeFileSync( HTML_SIMS_DIRECTORY + simName + '/.htaccess', contents );
    callback();
  };

  /**
   * Writes the htaccess file to password protect the exclusive content for phet-io sims
   * @param callback
   */
  const writePhetioHtaccess = function( filepath, authFilepath, callback ) {
    const contents = 'AuthType Basic\n' +
                   'AuthName "PhET-iO Password Protected Area"\n' +
                   'AuthUserFile ' + authFilepath + '\n' +
                   'Require valid-user\n';
    fs.writeFileSync( filepath, contents );
    callback();
  };

  /**
   * Copy files to spot.
   * If the brand is phet, it only copies the english sim file.
   * If the brand is phet-io, it copies the entire sim directory including the .htaccess file.
   *
   * @param brand:String
   * @param callback
   */
  const spotScp = function( brand, callback ) {
    const userAtServer = BUILD_SERVER_CONFIG.devUsername + '@' + BUILD_SERVER_CONFIG.devDeployServer;
    const simVersionDirectory = BUILD_SERVER_CONFIG.devDeployPath + simName + '/' + version;

    // mkdir first in case it doesn't exist already
    const mkdirCommand = 'ssh ' + userAtServer + ' \'mkdir -p ' + simVersionDirectory + '\'';
    exec( mkdirCommand, buildDir, function() {

      const buildDir = simDir + '/build';

      // after finishing copying the files, chmod to make sure we preserve group write on spot
      // const finished = _.after( files.length, function() {
      const finished = function() {
        const chmodCommand = 'ssh ' + userAtServer + ' \'chmod -R g+w ' + simVersionDirectory + '\'';
        exec( chmodCommand, buildDir, callback );
      };

      const scpTarget = userAtServer + ':' + simVersionDirectory;

      // copy the files
      if ( brand !== 'phet-io' ) {
        // only copy english html
        exec( 'scp -r *_en*.html ' + scpTarget, buildDir, function() {
          // find non-html files and copy them to the remote server
          exec( 'find . -type f ! -iname \'*.html\' -exec scp {} ' + scpTarget + ' ;', buildDir, finished );
        } );
      }
      else {
        exec( 'scp -r * ' + scpTarget, buildDir, function() {
          exec( 'scp .htaccess ' + scpTarget + '/wrappers/', buildDir, finished );
        } );
      }
    } );
  };

  /**
   * Add an entry in for this sim in simInfoArray in rosetta, so it shows up as translatable.
   * Must be run after createTranslationsXML so that simTitle is initialized.
   * @param simTitle
   * @param callback
   */
  const addToRosetta = function( simTitle, callback ) {

    // start by pulling rosetta to make sure it is up to date and avoid merge conflicts
    exec( 'git pull', '../rosetta', function() {
      const simInfoArray = '../rosetta/data/simInfoArray.json';
      fs.readFile( simInfoArray, { encoding: 'utf8' }, function( err, simInfoArrayString ) {

        const data = JSON.parse( simInfoArrayString );

        if ( err ) {
          winston.log( 'error', 'couldn\'t read simInfoArray ' + err );
          abortBuild( 'couldn\'t read simInfoArray ' + err );
        }
        else {

          const testUrl = BUILD_SERVER_CONFIG.productionServerURL + '/sims/html/' + simName + '/latest/' + simName + '_en.html';
          let newSim = true;

          for ( let i = 0; i < data.length; i++ ) {
            const simInfoObject = data[ i ];
            if ( simInfoObject.projectName && simInfoObject.projectName === simName ) {
              simInfoObject.simTitle = simTitle;
              simInfoObject.testUrl = testUrl;
              newSim = false;
            }
          }

          if ( newSim ) {
            data.push( {
              simTitle: simTitle,
              projectName: simName,
              testUrl: testUrl
            } );
          }

          const contents = JSON.stringify( data, null, 2 );

          fs.writeFile( simInfoArray, contents, function( err ) {
            if ( err ) {
              winston.log( 'error', 'couldn\'t write simInfoArray ' + err );
              abortBuild( 'couldn\'t write simInfoArray ' + err );
            }
            else {
              if ( simInfoArrayString !== contents ) {
                exec( 'git commit -a -m "[automated commit] add ' + simTitle + ' to simInfoArray"', '../rosetta', function() {
                  execWithoutAbort( 'git push origin master', '../rosetta', function( err ) {
                    if ( err ) {
                      sendEmail( 'ROSETTA PUSH FAILED', err );
                    }
                    callback();
                  } );
                } );
              }
              else {
                callback();
              }
            }
          } );
        }
      } );
    } );
  };

  /**
   * pull master for every repo in dependencies.json (plus babel) to make sure everything is up to date
   * @param callback
   */
  const pullMaster = function( callback ) {

    // so we don't have to modify the repos object
    const reposCopy = _.clone( repos );

    if ( 'comment' in reposCopy ) {
      delete reposCopy.comment;
    }

    const errors = [];

    // Add babel to list of repos to pull
    reposCopy.babel = true;

    const finished = _.after( Object.keys( reposCopy ).length, function() {
      if ( _.any( errors ) ) {
        abortBuild( 'at least one repository failed to pull master' );
      }
      else {
        callback();
      }
    } );

    const errorCheckCallback = function( err ) {
      errors.push( err );
      finished();
    };

    _.keys( reposCopy ).forEach( function( repoName ) {
      winston.log( 'info', 'pulling from ' + repoName );
      const repoDir = '../' + repoName;
      exec( 'git checkout master', repoDir, function() {
        execWithoutAbort( 'git pull', repoDir, errorCheckCallback );
      } );
    } );
  };

  /**
   * execute mkdir for the sim version directory if it doesn't exist
   * @param targetDirectory:String
   * @param callback
   */
  const mkVersionDir = function( targetDirectory, callback ) {
    try {
      fs.mkdirpSync( targetDirectory );
      callback();
    }
    catch( e ) {
      winston.log( 'error', 'in mkVersionDir ' + e );
      winston.log( 'error', 'build failed' );
      abortBuild( e );
    }
  };

  /**
   * Notify the website that a new sim or translation has been deployed. This will cause the project to
   * synchronize and the new translation will appear on the website.
   * @param callback
   */
  const notifyServer = function( callback ) {
    const project = 'html/' + simName;
    const url = BUILD_SERVER_CONFIG.productionServerURL + '/services/synchronize-project?projectName=' + project;
    request( {
      url: url,
      auth: {
        user: 'token',
        pass: BUILD_SERVER_CONFIG.serverToken,
        sendImmediately: true
      }
    }, function( error, response, body ) {
      let errorMessage;

      if ( !error && response.statusCode === 200 ) {
        const syncResponse = JSON.parse( body );

        if ( !syncResponse.success ) {
          errorMessage = 'request to synchronize project ' + project + ' on ' + BUILD_SERVER_CONFIG.productionServerName + ' failed with message: ' + syncResponse.error;
          winston.log( 'error', errorMessage );
          sendEmail( 'SYNCHRONIZE FAILED', errorMessage );
        }
        else {
          winston.log( 'info', 'request to synchronize project ' + project + ' on ' + BUILD_SERVER_CONFIG.productionServerName + ' succeeded' );
        }
      }
      else {
        errorMessage = 'request to synchronize project errored or returned a non 200 status code';
        winston.log( 'error', errorMessage );
        sendEmail( 'SYNCHRONIZE FAILED', errorMessage );
      }

      if ( callback ) {
        callback();
      }
    } );
  };

  // define a helper function that will add the translator to the DB for translation credits
  const addTranslator = function( locale, callback ) {

    // create the URL
    const addTranslatorURL = BUILD_SERVER_CONFIG.productionServerURL + '/services/add-html-translator?simName=' + simName +
                           '&locale=' + locale + '&userId=' + userId + '&authorizationCode=' +
                           BUILD_SERVER_CONFIG.databaseAuthorizationCode;

    // log the URL
    winston.log( 'info', 'URL for adding translator to credits = ' + addTranslatorURL );

    // send the request
    request( addTranslatorURL, function( error, response ) {
      if ( error ) {
        winston.log( 'error', 'error occurred when attempting to add translator credit info to DB: ' + error );
      }
      else {
        winston.log( 'info', 'request to add translator credit info returned code: ' + response.statusCode );
      }
      callback();
    } );
  };

  /**
   * Clean up after deploy. Checkout master for every repo and remove tmp dir.
   */
  const afterDeploy = function() {
    exec( 'grunt checkout-master-all', PERENNIAL, function() {
      exec( 'rm -rf ' + buildDir, '.', function() {
        taskCallback();
      } );
    } );
  };

  /**
   * Write a dependencies.json file based on the the dependencies passed to the build server.
   * The reason to write this to a file instead of using the in memory values, is so the "grunt checkout-shas"
   * task works without much modification.
   */
  const writeDependenciesFile = function() {
    fs.writeFile( buildDir + '/dependencies.json', JSON.stringify( repos ), function( err ) {
      if ( err ) {
        winston.log( 'error', err );
        taskCallback( err );
      }
      else {
        winston.log( 'info', 'wrote file ' + buildDir + '/dependencies.json' );

        let simTitle; // initialized via simTitleCallback in createTranslationsXML() for use in addToRosetta()
        const simTitleCallback = function( title ) {
          simTitle = title;
        };

        // run every step of the build
        exec( 'git pull', PERENNIAL, function() {
          exec( 'npm prune', PERENNIAL, function() {
            exec( 'npm update', PERENNIAL, function() {
              exec( './chipper/bin/clone-missing-repos.sh', '..', function() { // clone missing repos in case any new repos exist that might be dependencies
                pullMaster( function() {
                  exec( 'grunt checkout-shas --buildServer=true --repo=' + simName, PERENNIAL, function() {
                    exec( 'git checkout ' + repos[ simName ].sha, simDir, function() { // checkout the sha for the current sim
                      exec( 'npm prune', '../chipper', function() {
                        exec( 'npm update', '../chipper', function() { // npm update in chipper in case there are new dependencies there
                          exec( 'npm prune', simDir, function() {
                            exec( 'npm update', simDir, function() {
                              getLocales( locales, function( locales ) {
                                const brandLocales = ( brand === 'phet' ) ? locales : 'en';
                                winston.log( 'info', 'building for brand: ' + brand + ' version: ' + version );
                                exec( 'grunt build-for-server --allHTML --brand=' + brand + ' --locales=' + brandLocales, simDir, function() {
                                  if ( option === 'rc' ) {
                                    if ( brand === 'phet' ) {
                                      spotScp( brand, afterDeploy );
                                    }
                                    else if ( brand === 'phet-io' ) {
                                      writePhetioHtaccess( simDir + '/build/.htaccess', '/htdocs/physics/phet-io/config/.htpasswd', function() {
                                        spotScp( brand, afterDeploy );
                                      } );
                                    }
                                  }
                                  else {
                                    let targetDir;
                                    if ( brand === 'phet' ) {
                                      targetDir = HTML_SIMS_DIRECTORY + simName + '/' + version + '/';
                                    }
                                    else if ( brand === 'phet-io' ) {
                                      targetDir = PHETIO_SIMS_DIRECTORY + simName + '/' + originalVersion + '/';
                                    }
                                    mkVersionDir( targetDir, function() {
                                      exec( 'cp -r build/* ' + targetDir, simDir, function() {
                                        if ( brand === 'phet' ) {
                                          writePhetHtaccess( function() {
                                            createTranslationsXML( simTitleCallback, function() {
                                              notifyServer( function() {
                                                addToRosetta( simTitle, function() {

                                                  // if this build request comes from rosetta it will have a userId field and only one locale
                                                  const localesArray = locales.split( ',' );
                                                  if ( userId && localesArray.length === 1 && localesArray[ 0 ] !== '*' ) {
                                                    addTranslator( localesArray[ 0 ], afterDeploy );
                                                  }
                                                  else {
                                                    afterDeploy();
                                                  }
                                                } );
                                              } );
                                            } );
                                          } );
                                        }
                                        else {
                                          writePhetioHtaccess(
                                            PHETIO_SIMS_DIRECTORY + simName + '/' + originalVersion + '/wrappers/.htaccess',
                                            '/etc/httpd/conf/phet-io_pw',
                                            afterDeploy
                                          );
                                        }
                                      } );
                                    } );
                                  }
                                } );
                              } );
                            } );
                          } );
                        } );
                      } );
                    } );
                  } );
                } );
              } );
            } );
          } );
        } );
      }
    } );
  };

  try {
    fs.mkdirSync( buildDir );
  }
  catch( e ) {
    // do nothing, most likely failed because the directory already exists, which is fine
  }
  finally {
    writeDependenciesFile();
  }

  res.send( 'build process initiated, check logs for details' );

}, 1 ); // 1 is the max number of tasks that can run concurrently

function logRequest( req, type ) {
  // log the request, which is useful for debugging
  let requestBodyString = '';
  for ( let key in req[ type ] ) {
    if ( req[ type ].hasOwnProperty( key ) ) {
      requestBodyString += key + ':' + req[ type ][ key ] + '\n';
    }
  }
  winston.log(
    'info',
    'deploy request received, original URL = ' + ( req.protocol + '://' + req.get( 'host' ) + req.originalUrl ) + '\n' + requestBodyString
  );
}

function getQueueDeploy( req, res ) {
  logRequest( req, 'query' );
  queueDeployApiVersion1( req, res, 'query' );
}

function queueDeployApiVersion1( req, res, key ) {
  const repos = req[ key ][ REPOS_KEY ];
  const simName = req[ key ][ SIM_NAME_KEY ];
  const version = req[ key ][ VERSION_KEY ];
  const brands = version.indexOf( 'phetio' ) < 0 ? [ 'phet' ] : [ 'phet-io' ];
  const locales = req[ key ][ LOCALES_KEY ];
  const option = req[ key ][ OPTION_KEY ] ? decodeURIComponent( req[ key ][ OPTION_KEY ] ) : 'default';
  const servers = ( option === 'rc' ) ? [ PRODUCTION_SERVER ] : [ DEV_SERVER ];
  const email = req[ key ][ EMAIL_KEY ];
  const translatorId = req[ key ][ USER_ID_KEY ];
  const authorizationKey = req[ key ][ AUTHORIZATION_KEY ];

  queueDeploy( repos, simName, version, locales, servers, brands, email, translatorId, authorizationKey, req, res );
}

function postQueueDeploy( req, res ) {
  logRequest( req, 'body' );

  const api = req.body[ API_KEY ]; // Used in the future
  if ( api && api.startsWith( '2.' ) ) {
    const repos = req.body[ DEPENDENCIES_KEY ].repos;
    const simName = req.body[ SIM_NAME_KEY ];
    const version = req.body[ VERSION_KEY ];
    const locales = req.body[ LOCALES_KEY ];
    const servers = req.body[ SERVERS_KEY ];
    const brands = req.body[ BRANDS_KEY ];
    const authorizationKey = req.body[ AUTHORIZATION_KEY ];
    const translatorId = req.body[ TRANSLATOR_ID_KEY ];
    const email = req.body[ EMAIL_KEY ];

    queueDeploy( repos, simName, version, locales, servers, brands, email, translatorId, authorizationKey, req, res );
  }
  else {
    queueDeployApiVersion1( req, res, 'body' );
  }
}

function queueDeploy( repos, simName, version, locales, brands, servers, email, translatorId, authorizationKey, req, res ) {


  if ( repos && simName && version && authorizationKey ) {
    if ( authorizationKey !== BUILD_SERVER_CONFIG.buildServerAuthorizationCode ) {
      const err = 'wrong authorization code';
      winston.log( 'error', err );
      res.send( err );
    }
    else {
      winston.log( 'info', 'queuing build for ' + simName + ' ' + version );
      taskQueue.push( { repos, simName, version, locales, servers, brands, email, translatorId, res }, function( err ) {
        const simInfoString = 'Sim = ' + decodeURIComponent( simName ) +
                            ' Version = ' + decodeURIComponent( version ) +
                            ' Locales = ' + ( locales ? decodeURIComponent( locales ) : 'undefined' );

        if ( err ) {
          let shas = decodeURIComponent( repos );

          // try to format the JSON nicely for the email, but don't worry if it is invalid JSON
          try {
            shas = JSON.stringify( JSON.parse( shas ), null, 2 );
          }
          catch( e ) {
            // invalid JSON
          }
          const errorMessage = 'Build failed with error: ' + err + '. ' + simInfoString + ' Shas = ' + shas;
          winston.log( 'error', errorMessage );
          sendEmail( 'BUILD ERROR', errorMessage );
        }
        else {
          winston.log( 'info', 'build for ' + simName + ' finished successfully' );
          sendEmail( 'Build Succeeded', simInfoString, true );
        }

        // reset email parameter to null after build finishes or errors, since this email address may be different on every build
        emailParameter = null;
      } );
    }
  }
  else {
    const errorString = 'missing one or more required query parameters: repos, simName, version, authorizationKey';
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
app.listen( LISTEN_PORT, function() {
  winston.log( 'info', 'Listening on port ' + LISTEN_PORT );
  winston.log( 'info', 'Verbose mode: ' + verbose );
} );
