// Copyright 2017, University of Colorado Boulder

/**
 * Unit tests, run with `qunit` at the top-level of perennial. May need `npm install -g qunit` beforehand, if it hasn't been run yet.
 *
 * @author Jonathan Olson <jonathan.olson@colorado.edu>
 */
/* eslint-env node */
'use strict';

const execute = require( '../js/common/execute' );
const getBranches = require( '../js/common/getBranches' );
const gruntCommand = require( '../js/common/gruntCommand' );
const qunit = require( 'qunit' );

qunit.module( 'Perennial grunt tasks' );

async function getLikelyNextBranch( repo, incrementMajor, incrementMinor ) {
  let currentMajor = 0;
  let currentMinor = 0;
  ( await getBranches( repo ) ).filter( branch => /^\d+\.\d+$/.test( branch ) ).forEach( branch => {
    const [ major, minor ] = branch.split( '.' ).map( str => parseInt( str, 10 ) );
    if ( major > currentMajor || ( major === currentMajor && minor > currentMinor ) ) {
      currentMajor = major;
      currentMinor = minor;
    }
  } );
  if ( incrementMajor ) {
    currentMajor++;
  }
  if ( incrementMinor ) {
    currentMinor++;
  }
  return `${currentMajor}.${currentMinor}`;
}

qunit.test( 'Checkout target', async ( assert ) => {
  assert.timeout( 120000 );
  await execute( gruntCommand, [ 'checkout-target', '--repo=chains', '--target=1.9' ], '.' );
  await execute( gruntCommand, [ 'checkout-master', '--repo=chains' ], '.' );
  assert.expect( 0 );
} );

qunit.test( 'NPM update', async ( assert ) => {
  assert.timeout( 120000 );
  await execute( gruntCommand, [ 'npm-update', '--repo=chains' ], '.' );
  assert.expect( 0 );
} );

qunit.test( 'Bumper dev phet,phet-io', async ( assert ) => {
  assert.timeout( 600000 );
  // TODO: Remove these once it goes to master
  await execute( 'git', [ 'checkout', '2.0'], '../chipper' );
  await execute( 'git', [ 'checkout', 'chipper2.0'], '../phet-io-wrappers' );
  await execute( gruntCommand, [ 'dev', '--repo=bumper', '--brands=phet,phet-io', '--noninteractive' ], '.' );
  assert.expect( 0 );
} );

qunit.test( 'Bumper dev phet', async ( assert ) => {
  assert.timeout( 600000 );
  // TODO: Remove these once it goes to master
  await execute( 'git', [ 'checkout', '2.0'], '../chipper' );
  await execute( 'git', [ 'checkout', 'chipper2.0'], '../phet-io-wrappers' );
  await execute( gruntCommand, [ 'dev', '--repo=bumper', '--brands=phet', '--noninteractive' ], '.' );
  assert.expect( 0 );
} );

qunit.test( 'Bumper dev phet-io', async ( assert ) => {
  assert.timeout( 600000 );
  // TODO: Remove these once it goes to master
  await execute( 'git', [ 'checkout', '2.0'], '../chipper' );
  await execute( 'git', [ 'checkout', 'chipper2.0'], '../phet-io-wrappers' );
  await execute( gruntCommand, [ 'dev', '--repo=bumper', '--brands=phet-io', '--noninteractive' ], '.' );
  assert.expect( 0 );
} );

qunit.test( 'Major bump, RC/Production', async( assert ) => {
  assert.timeout( 3000000 );
  // TODO: Remove these once it goes to master
  await execute( 'git', [ 'checkout', '2.0'], '../chipper' );
  await execute( 'git', [ 'checkout', 'chipper2.0'], '../phet-io-wrappers' );
  const branch = await getLikelyNextBranch( 'bumper', true, false );

  // We can't create the branch interactively (for maintenance releases), so we do so here
  await execute( gruntCommand, [ 'create-release', '--repo=bumper', `--branch=${branch}` ], '.' );

  // should be rc.1 and maintenance:0 (phet,phet-io)
  await execute( gruntCommand, [ 'rc', '--repo=bumper', '--brands=phet,phet-io', `--branch=${branch}`, '--noninteractive' ], '.' );
  await execute( gruntCommand, [ 'production', '--repo=bumper', '--brands=phet,phet-io', `--branch=${branch}`, '--noninteractive' ], '.' );

  // same thing, but maintenance:1 (phet brand only)
  await execute( gruntCommand, [ 'rc', '--repo=bumper', '--brands=phet', `--branch=${branch}`, '--noninteractive' ], '.' );
  await execute( gruntCommand, [ 'production', '--repo=bumper', '--brands=phet', `--branch=${branch}`, '--noninteractive' ], '.' );

  // same thing, but maintenance:1 (phet-io brand only)
  await execute( gruntCommand, [ 'rc', '--repo=bumper', '--brands=phet-io', `--branch=${branch}`, '--noninteractive' ], '.' );
  await execute( gruntCommand, [ 'production', '--repo=bumper', '--brands=phet-io', `--branch=${branch}`, '--noninteractive' ], '.' );
  assert.expect( 0 );
} );