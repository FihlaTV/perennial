// Copyright 2002-2015, University of Colorado Boulder

//TODO: should the parent project (the sim itself) also be checked out, ignored, or moved into its specified branch?  Right now it is ignored (i.e. left as it was when the task was started)
/**
 * This grunt task checks out the shas for a project, as specified in a dependencies.json file in its top level.
 */
/* eslint-env node */
'use strict';

var assert = require( 'assert' );
var child_process = require( 'child_process' );

/**
 * @param grunt the grunt instance
 * @param repositoryName name field from package.json
 * @param toMaster whether master should be used, or dependencies.json shas should be used
 * @param buildServer whether this build is initiated by the build server
 */
module.exports = function( grunt, repositoryName, toMaster, buildServer ) {

  var dependencies = grunt.file.readJSON( ( buildServer ) ? '../perennial/js/build-server/tmp/dependencies.json' : '../' + repositoryName + '/dependencies.json' );
  var done = grunt.task.current.async();
  var numToCheckOut = 0;
  var numCheckedOut = 0;
  for ( var property in dependencies ) {
    if ( property !== 'comment' && property !== repositoryName ) {
      numToCheckOut++;
    }
  }

  for ( property in dependencies ) {
    if ( property !== 'comment' && property !== repositoryName && dependencies.hasOwnProperty( property ) ) {

      (function( property ) {

        assert( typeof( dependencies[ property ].branch !== 'undefined' ) && typeof( dependencies[ property ].sha !== 'undefined' ) );

        grunt.log.writeln( 'Checking out dependency ' + property + ': ' + dependencies[ property ].branch + '@' + dependencies[ property ].sha );

        //To execute something from a different directory:
        //cp.exec('foocommand', { cwd: 'path/to/dir/' }, callback);
        //http://stackoverflow.com/questions/14026967/calling-child-process-exec-in-node-as-though-it-was-executed-in-a-specific-folde
        var command = 'git checkout ' + ( toMaster ? 'master' : dependencies[ property ].sha );
        child_process.exec( command, { cwd: '../' + property }, function( error1, stdout1, stderr1 ) {
          assert( !error1, 'error in ' + command + ' for repo ' + property );
          grunt.log.writeln( 'Finished checkout.' );
          grunt.log.writeln( stdout1 );
          grunt.log.writeln( stderr1 );
          numCheckedOut = numCheckedOut + 1;
          if ( numToCheckOut === numCheckedOut ) {
            done();
          }
        } );
      })( property );
    }
  }
};