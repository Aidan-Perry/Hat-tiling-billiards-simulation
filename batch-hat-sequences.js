#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;

const DEFAULTS = {
	rootType: 'H',
	level: 6,
	startTileId: 738439,
	startEdge: 0,
	edgeParameter: 0.5,
	maxBounces: 2000,
	angleStart: 0.0,
	angleEnd: 359.9,
	angleStep: 0.1,
	dropIncomplete: false,
	outputDir: path.join( ROOT, 'Experiments' ),
	outputFile: 'hat-sequences-H-L6-tile738439-edge0-t0.5-b2000.txt'
};

function usage() {
	return [
		'Usage: node --max-old-space-size=8192 batch-hat-sequences.js [options]',
		'',
		'Options:',
		'  --root-type H|T|P|F       Root supertile type (default: H)',
		'  --level N                 Supertile level (default: 6)',
		'  --start-tile-id N         Starting hat tile id (default: 738439)',
		'  --start-edge N            Starting edge index (default: 0)',
		'  --edge-parameter X        Starting point along edge (default: 0.5)',
		'  --max-bounces N           Maximum hat crossings per run (default: 2000)',
		'  --angle-start X           First angle in degrees (default: 0.0)',
		'  --angle-end X             Last angle in degrees, inclusive (default: 359.9)',
		'  --angle-step X            Angle step in degrees (default: 0.1)',
		'  --drop-incomplete         Omit non-completed or short trajectories from body rows',
		'  --output PATH             Output file path',
		'  --help                    Show this help'
	].join( '\n' );
}

function parseArgs( argv ) {
	const config = Object.assign( {}, DEFAULTS );
	for( let i = 0; i < argv.length; ++i ) {
		const arg = argv[i];
		if( arg === '--help' || arg === '-h' ) {
			console.log( usage() );
			process.exit( 0 );
		}
		const next = () => {
			if( i + 1 >= argv.length ) {
				throw new Error( `Missing value for ${arg}` );
			}
			i += 1;
			return argv[i];
		};
		if( arg === '--root-type' ) {
			config.rootType = next();
		} else if( arg === '--level' ) {
			config.level = parseIntegerOption( arg, next() );
		} else if( arg === '--start-tile-id' ) {
			config.startTileId = parseIntegerOption( arg, next() );
		} else if( arg === '--start-edge' ) {
			config.startEdge = parseIntegerOption( arg, next() );
		} else if( arg === '--edge-parameter' ) {
			config.edgeParameter = parseNumberOption( arg, next() );
		} else if( arg === '--max-bounces' ) {
			config.maxBounces = parseIntegerOption( arg, next() );
		} else if( arg === '--angle-start' ) {
			config.angleStart = parseNumberOption( arg, next() );
		} else if( arg === '--angle-end' ) {
			config.angleEnd = parseNumberOption( arg, next() );
		} else if( arg === '--angle-step' ) {
			config.angleStep = parseNumberOption( arg, next() );
		} else if( arg === '--drop-incomplete' ) {
			config.dropIncomplete = true;
		} else if( arg === '--output' ) {
			const output = path.resolve( ROOT, next() );
			config.outputDir = path.dirname( output );
			config.outputFile = path.basename( output );
		} else {
			throw new Error( `Unknown option: ${arg}` );
		}
	}
	return config;
}

function parseIntegerOption( name, value ) {
	const parsed = Number( value );
	if( !Number.isInteger( parsed ) ) {
		throw new Error( `${name} must be an integer, got "${value}"` );
	}
	return parsed;
}

function parseNumberOption( name, value ) {
	const parsed = Number( value );
	if( !Number.isFinite( parsed ) ) {
		throw new Error( `${name} must be a finite number, got "${value}"` );
	}
	return parsed;
}

function validateConfig( config ) {
	if( !['H', 'T', 'P', 'F'].includes( config.rootType ) ) {
		throw new Error( `Unsupported root type "${config.rootType}"` );
	}
	if( config.level < 1 ) {
		throw new Error( '--level must be at least 1' );
	}
	if( config.startTileId < 0 ) {
		throw new Error( '--start-tile-id must be non-negative' );
	}
	if( config.startEdge < 0 ) {
		throw new Error( '--start-edge must be non-negative' );
	}
	if( config.edgeParameter < 0 || config.edgeParameter > 1 ) {
		throw new Error( '--edge-parameter must be between 0 and 1' );
	}
	if( config.maxBounces < 0 ) {
		throw new Error( '--max-bounces must be non-negative' );
	}
	if( !(config.angleStep > 0) ) {
		throw new Error( '--angle-step must be greater than 0' );
	}
	if( config.angleEnd < config.angleStart ) {
		throw new Error( '--angle-end must be greater than or equal to --angle-start' );
	}
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
	for( const file of ['geometry.js', 'hat2.js', 'engine.js'] ) {
		const code = fs.readFileSync( path.join( ROOT, file ), 'utf8' );
		vm.runInContext( code, context, { filename: file } );
	}
	return context;
}

function angleDecimals( config ) {
	const values = [config.angleStart, config.angleEnd, config.angleStep];
	return Math.max( 1, ...values.map( decimalPlaces ) );
}

function decimalPlaces( value ) {
	const text = String( value );
	if( text.includes( 'e-' ) ) {
		return Number( text.split( 'e-' )[1] );
	}
	const dot = text.indexOf( '.' );
	return dot < 0 ? 0 : text.length - dot - 1;
}

function generateAngles( config ) {
	const decimals = angleDecimals( config );
	const scale = Math.pow( 10, decimals );
	const start = Math.round( config.angleStart * scale );
	const end = Math.round( config.angleEnd * scale );
	const step = Math.round( config.angleStep * scale );
	const angles = [];
	if( step <= 0 ) {
		throw new Error( 'Angle step is too small after decimal scaling' );
	}
	for( let value = start; value <= end; value += step ) {
		angles.push( {
			value: value / scale,
			label: (value / scale).toFixed( decimals )
		} );
	}
	return { angles, decimals };
}

function crossingToken( crossing ) {
	const next = crossing.nextEdgeIndex == null ? '?' : crossing.nextEdgeIndex;
	return `${crossing.edgeIndex}->${next}`;
}

function copyFileIntoOpenFd( inputPath, outputFd ) {
	const inputFd = fs.openSync( inputPath, 'r' );
	const buffer = Buffer.allocUnsafe( 8 * 1024 * 1024 );
	try {
		while( true ) {
			const bytesRead = fs.readSync( inputFd, buffer, 0, buffer.length, null );
			if( bytesRead === 0 ) {
				break;
			}
			fs.writeSync( outputFd, buffer, 0, bytesRead );
		}
	} finally {
		fs.closeSync( inputFd );
	}
}

function runExperiment( config ) {
	validateConfig( config );
	const outputPath = path.join( config.outputDir, config.outputFile );
	fs.mkdirSync( config.outputDir, { recursive: true } );
	const dataPath = `${outputPath}.data.tmp`;
	const dataFd = fs.openSync( dataPath, 'w' );
	const { angles, decimals } = generateAngles( config );
	const context = loadEngineContext();
	const startBuild = Date.now();
	console.log( `[tiling] building ${config.rootType}:${config.level}` );
	const tiling = context.HatBilliards.buildTiling( {
		rootType: config.rootType,
		level: config.level
	} );
	console.log(
		`[tiling] built ${tiling.tiles.length} hats in ${((Date.now() - startBuild) / 1000).toFixed( 2 )}s` );
	const startTile = tiling.tiles[config.startTileId];
	if( !startTile ) {
		throw new Error(
			`startTileId ${config.startTileId} is not present in ${config.rootType} level ${config.level}` );
	}
	if( !startTile.edges[config.startEdge] ) {
		throw new Error( `startEdge ${config.startEdge} is not present on startTileId ${config.startTileId}` );
	}

	const problemRuns = [];
	let removedRunCount = 0;
	let writtenRunCount = 0;
	let shortestLength = Infinity;
	let shortestKeptLength = Infinity;
	const runStart = Date.now();
	try {
		for( let idx = 0; idx < angles.length; ++idx ) {
			const angle = angles[idx];
			const result = context.HatBilliards.runTrajectory( tiling, {
				startTileId: config.startTileId,
				startEdge: config.startEdge,
				edgeParameter: config.edgeParameter,
				angleDegrees: angle.value,
				maxBounces: config.maxBounces,
				maxExpansionLevel: config.level
			} );
			const tokens = (result.crossings || []).map( crossingToken );
			const length = tokens.length;
			shortestLength = Math.min( shortestLength, length );
			const incomplete = result.status !== 'completed' || length < config.maxBounces;
			if( incomplete ) {
				problemRuns.push( {
					angle: angle.label,
					status: result.status,
					length
				} );
			}
			if( config.dropIncomplete && incomplete ) {
				removedRunCount += 1;
			} else {
				shortestKeptLength = Math.min( shortestKeptLength, length );
				fs.writeSync( dataFd, `${angle.label}\t${length}\t${result.status}\t${tokens.join( ' ' )}\n` );
				writtenRunCount += 1;
			}
			if( (idx + 1) % 100 === 0 || idx + 1 === angles.length ) {
				const elapsed = ((Date.now() - runStart) / 1000).toFixed( 1 );
				console.log( `[run] ${idx + 1}/${angles.length} angles complete (${elapsed}s)` );
			}
		}
	} finally {
		fs.closeSync( dataFd );
	}

	const header = buildHeader(
		config,
		angles,
		decimals,
		shortestLength,
		shortestKeptLength,
		problemRuns,
		removedRunCount,
		writtenRunCount,
		tiling );
	const outputFd = fs.openSync( outputPath, 'w' );
	try {
		fs.writeSync( outputFd, `${header}\n` );
		copyFileIntoOpenFd( dataPath, outputFd );
	} finally {
		fs.closeSync( outputFd );
	}
	fs.unlinkSync( dataPath );
	return {
		outputPath,
		totalRuns: angles.length,
		writtenRuns: writtenRunCount,
		removedRunCount,
		shortestLength,
		shortestKeptLength,
		problemRuns
	};
}

function buildHeader(
	config,
	angles,
	decimals,
	shortestLength,
	shortestKeptLength,
	problemRuns,
	removedRunCount,
	writtenRunCount,
	tiling ) {
	const firstAngle = angles.length > 0 ? angles[0].label : 'n/a';
	const lastAngle = angles.length > 0 ? angles[angles.length - 1].label : 'n/a';
	const problemList = problemRuns.length === 0 ? 'none' :
		problemRuns.map( run => `${run.angle}:${run.length}:${run.status}` ).join( ', ' );
	return [
		'# format: hatviz-hat-sequences-tsv',
		'# version: 1',
		`# root_type: ${config.rootType}`,
		`# level: ${config.level}`,
		`# start_tile_id: ${config.startTileId}`,
		`# start_edge: ${config.startEdge}`,
		`# edge_parameter: ${config.edgeParameter}`,
		`# max_bounces: ${config.maxBounces}`,
		`# angle_start_deg: ${firstAngle}`,
		`# angle_end_deg: ${lastAngle}`,
		`# angle_step_deg: ${config.angleStep.toFixed( decimals )}`,
		`# total_run_count: ${angles.length}`,
		`# written_run_count: ${writtenRunCount}`,
		`# incomplete_removed: ${removedRunCount}`,
		`# drop_incomplete: ${config.dropIncomplete ? 'true' : 'false'}`,
		`# tiling_tile_count: ${tiling.tiles.length}`,
		`# shortest_sequence_length: ${Number.isFinite( shortestLength ) ? shortestLength : 0}`,
		`# shortest_written_sequence_length: ${Number.isFinite( shortestKeptLength ) ? shortestKeptLength : 0}`,
		`# non_completed_or_short_count: ${problemRuns.length}`,
		`# non_completed_or_short_runs: ${problemList}`,
		'# columns: angle_deg<TAB>sequence_length<TAB>status<TAB>sequence_tokens'
	].join( '\n' );
}

function main() {
	try {
		const config = parseArgs( process.argv.slice( 2 ) );
		const result = runExperiment( config );
		console.log( `[write] ${result.outputPath}` );
		console.log(
			`[summary] runs=${result.totalRuns} written=${result.writtenRuns} ` +
			`removed=${result.removedRunCount} shortest=${result.shortestLength} ` +
			`shortest_written=${result.shortestKeptLength} problem_runs=${result.problemRuns.length}` );
	} catch( err ) {
		console.error( err && err.stack ? err.stack : String( err ) );
		process.exitCode = 1;
	}
}

main();
