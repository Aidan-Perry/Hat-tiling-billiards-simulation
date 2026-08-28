#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const legalHatCrossings = require('./legal-hat-crossings');

const ROOT = __dirname;

const DEFAULTS = {
	rootType: 'H',
	level: 6,
	trajectoryCount: 300,
	maxBounces: 1000,
	maxN: 15,
	seed: 'hat-billiards-global-language-2026-08-10',
	interiorMinFraction: 0.1,
	interiorMaxFraction: 0.6,
	maxAttempts: 3000,
	output: path.join( ROOT, 'Experiments', 'global-language-complexity-H-L6-s300-b1000-n15.tsv' )
};

function parseArgs( argv ) {
	const config = Object.assign( {}, DEFAULTS );
	for( let i = 0; i < argv.length; ++i ) {
		const arg = argv[i];
		const next = () => {
			if( i + 1 >= argv.length ) {
				throw new Error( `Missing value for ${arg}` );
			}
			i += 1;
			return argv[i];
		};
		if( arg === '--trajectories' ) {
			config.trajectoryCount = parseIntOption( arg, next() );
		} else if( arg === '--bounces' ) {
			config.maxBounces = parseIntOption( arg, next() );
		} else if( arg === '--max-n' ) {
			config.maxN = parseIntOption( arg, next() );
		} else if( arg === '--max-attempts' ) {
			config.maxAttempts = parseIntOption( arg, next() );
		} else if( arg === '--seed' ) {
			config.seed = next();
		} else if( arg === '--output' ) {
			config.output = path.resolve( ROOT, next() );
		} else if( arg === '--help' || arg === '-h' ) {
			console.log(
				'Usage: node --max-old-space-size=12288 run-global-language-complexity-estimate.js ' +
				'[--trajectories 300] [--bounces 1000] [--max-n 15] ' +
				'[--max-attempts 3000] [--output PATH]' );
			process.exit( 0 );
		} else {
			throw new Error( `Unknown option: ${arg}` );
		}
	}
	return config;
}

function parseIntOption( name, value ) {
	const parsed = Number( value );
	if( !Number.isInteger( parsed ) || parsed < 1 ) {
		throw new Error( `${name} must be a positive integer` );
	}
	return parsed;
}

function hashSeed( seed ) {
	let h = 2166136261;
	for( const ch of String( seed ) ) {
		h ^= ch.charCodeAt( 0 );
		h = Math.imul( h, 16777619 );
	}
	return h >>> 0;
}

function createRng( seed ) {
	let state = hashSeed( seed ) || 0x9e3779b9;
	return function rng() {
		state += 0x6D2B79F5;
		let t = state;
		t = Math.imul( t ^ (t >>> 15), t | 1 );
		t ^= t + Math.imul( t ^ (t >>> 7), t | 61 );
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function randomInt( rng, maxExclusive ) {
	return Math.floor( rng() * maxExclusive );
}

function loadEngineContext() {
	const context = {
		console,
		Math,
		globalThis: null,
		window: undefined,
		PI: Math.PI,
		cos: Math.cos,
		sin: Math.sin,
		mag: Math.hypot
	};
	context.globalThis = context;
	vm.createContext( context );
	for( const file of ['geometry.js', 'tiling.js', 'engine.js'] ) {
		const code = fs.readFileSync( path.join( ROOT, file ), 'utf8' );
		vm.runInContext( code, context, { filename: file } );
	}
	return context;
}

function distance( a, b ) {
	return Math.hypot( a.x - b.x, a.y - b.y );
}

function interiorCandidates( tiling, config ) {
	const center = tiling.tiles[tiling.centralTileId] || tiling.tiles[tiling.rootTileId] || tiling.tiles[0];
	const distances = tiling.tiles.map( tile => distance( tile.centroid, center.centroid ) );
	const maxDistance = distances.reduce( ( max, value ) => Math.max( max, value ), 0 );
	const min = config.interiorMinFraction * maxDistance;
	const max = config.interiorMaxFraction * maxDistance;
	return tiling.tiles
		.filter( tile => distances[tile.id] >= min && distances[tile.id] <= max )
		.map( tile => tile.id );
}

function tokenForCrossing( crossing ) {
	return legalHatCrossings.tokenForCrossing( crossing );
}

function addSubstrings( tokens, sets ) {
	for( let n = 1; n < sets.length; ++n ) {
		if( tokens.length < n ) {
			continue;
		}
		for( let i = 0; i <= tokens.length - n; ++i ) {
			sets[n].add( tokens.slice( i, i + n ).join( ' ' ) );
		}
	}
}

function fitPowerLaw( rows, minN ) {
	const points = rows.filter( row => row.n >= minN && row.count > 0 );
	const m = points.length;
	let sx = 0;
	let sy = 0;
	let sxx = 0;
	let sxy = 0;
	for( const row of points ) {
		const x = Math.log( row.n );
		const y = Math.log( row.count );
		sx += x;
		sy += y;
		sxx += x * x;
		sxy += x * y;
	}
	const denom = m * sxx - sx * sx;
	const exponent = denom === 0 ? NaN : (m * sxy - sx * sy) / denom;
	const intercept = (sy - exponent * sx) / m;
	return { exponent, coefficient: Math.exp( intercept ), pointCount: m };
}

function run( config ) {
	fs.mkdirSync( path.dirname( config.output ), { recursive: true } );
	const context = loadEngineContext();
	console.log( `[tiling] building ${config.rootType}:${config.level}` );
	const tilingStart = Date.now();
	const tiling = context.HatBilliards.buildTiling( {
		rootType: config.rootType,
		level: config.level
	} );
	console.log( `[tiling] built ${tiling.tiles.length} hats in ${((Date.now() - tilingStart) / 1000).toFixed( 2 )}s` );
	const rng = createRng( config.seed );
	const candidates = interiorCandidates( tiling, config );
	if( candidates.length === 0 ) {
		throw new Error( 'No interior candidates found' );
	}

	const sets = Array.from( { length: config.maxN + 1 }, () => new Set() );
	let completed = 0;
	let attempts = 0;
	const statuses = new Map();
	const start = Date.now();
	while( completed < config.trajectoryCount && attempts < config.maxAttempts ) {
		attempts += 1;
		const startTileId = candidates[randomInt( rng, candidates.length )];
		const tile = tiling.tiles[startTileId];
		const spec = {
			startTileId,
			startEdge: randomInt( rng, tile.edges.length ),
			edgeParameter: 0.05 + rng() * 0.9,
			angleDegrees: rng() * 360,
			maxBounces: config.maxBounces,
			maxExpansionLevel: config.level
		};
		const result = context.HatBilliards.runTrajectory( tiling, spec );
		const bounceCount = Array.isArray( result.crossings ) ? result.crossings.length : 0;
		const symbolicValidity = legalHatCrossings.validateCrossings( result.crossings || [] );
		if( result.status === 'completed' && bounceCount >= config.maxBounces && symbolicValidity.valid ) {
			addSubstrings( result.crossings.map( tokenForCrossing ), sets );
			completed += 1;
			if( completed % 25 === 0 || completed === config.trajectoryCount ) {
				const elapsed = ((Date.now() - start) / 1000).toFixed( 1 );
				console.log( `[sample] completed ${completed}/${config.trajectoryCount} after ${attempts} attempts (${elapsed}s)` );
			}
		} else {
			const status = symbolicValidity.valid ? result.status : 'invalid-symbolic-sequence';
			statuses.set( status, (statuses.get( status ) || 0) + 1 );
		}
	}
	if( completed < config.trajectoryCount ) {
		throw new Error( `Only completed ${completed}/${config.trajectoryCount} trajectories after ${attempts} attempts` );
	}

	const rows = [];
	for( let n = 1; n <= config.maxN; ++n ) {
		rows.push( { n, count: sets[n].size } );
	}
	const fit3 = fitPowerLaw( rows, 3 );
	const fit5 = fitPowerLaw( rows, 5 );
	const lines = [
		'# format: hat-billiards-global-language-complexity-tsv',
		'# version: 1',
		`# root_type: ${config.rootType}`,
		`# level: ${config.level}`,
		`# completed_trajectories: ${completed}`,
		`# attempts: ${attempts}`,
		`# bounces_per_trajectory: ${config.maxBounces}`,
		`# max_n: ${config.maxN}`,
		`# seed: ${config.seed}`,
		`# failed_statuses: ${[...statuses.entries()].map( entry => entry.join( ':' ) ).join( ', ') || 'none'}`,
		`# power_fit_n_3_to_${config.maxN}: count ~= ${fit3.coefficient} * n^${fit3.exponent}`,
		`# power_fit_n_5_to_${config.maxN}: count ~= ${fit5.coefficient} * n^${fit5.exponent}`,
		'n\tglobal_unique_substrings'
	];
	for( const row of rows ) {
		lines.push( `${row.n}\t${row.count}` );
	}
	fs.writeFileSync( config.output, `${lines.join( '\n' )}\n` );
	return { output: config.output, rows, completed, attempts, fit3, fit5, statuses };
}

function main() {
	try {
		const result = run( parseArgs( process.argv.slice( 2 ) ) );
		console.log( `[write] ${result.output}` );
		console.log( `[fit] n>=3 exponent=${result.fit3.exponent.toFixed( 3 )}` );
		console.log( `[fit] n>=5 exponent=${result.fit5.exponent.toFixed( 3 )}` );
	} catch( err ) {
		console.error( err && err.stack ? err.stack : String( err ) );
		process.exitCode = 1;
	}
}

main();
