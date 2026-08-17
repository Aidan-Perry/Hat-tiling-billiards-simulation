#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;

const DEFAULTS = {
	rootType: 'H',
	level: 6,
	tileCount: 3,
	maxBounces: 3000,
	angleStart: 0.0,
	angleEnd: 359.9,
	angleStep: 0.1,
	seed: 'hat-billiards-hpb-2026-08-10',
	minEdgeParameter: 0.05,
	maxEdgeParameter: 0.95,
	depthSlack: 2,
	selectionMode: 'spread-interior',
	interiorMinFraction: 0.12,
	interiorMaxFraction: 0.58,
	prescreenAngleStep: 15,
	minPrescreenSurvival: 0.7,
	maxPrescreenCandidates: 250,
	progressEvery: 100,
	selectionOnly: false,
	format: 'list',
	incompleteValue: null,
	outputDir: path.join( ROOT, 'Experiments' ),
	outputFile: 'hats-per-bounce-H-L6-3tiles-b3000-step0.1.txt'
};

function usage() {
	return [
		'Usage: node --max-old-space-size=12288 run-hats-per-bounce-experiment.js [options]',
		'',
		'Options:',
		'  --root-type H|T|P|F       Root supertile type (default: H)',
		'  --level N                 Supertile level (default: 6)',
		'  --tile-count N            Number of start tiles to sample (default: 3)',
		'  --max-bounces N           Required completed bounces per trajectory (default: 3000)',
		'  --angle-start X           First angle in degrees (default: 0.0)',
		'  --angle-end X             Last angle in degrees, inclusive (default: 359.9)',
		'  --angle-step X            Angle step in degrees (default: 0.1)',
		'  --seed TEXT               Deterministic random seed',
		'  --depth-slack N           Sample from tiles with depth >= maxDepth - N (default: 2)',
		'  --selection MODE          center|spread-interior|boundary-depth (default: spread-interior)',
		'  --interior-min-fraction X Minimum center-distance fraction for spread selection (default: 0.12)',
		'  --interior-max-fraction X Maximum center-distance fraction for spread selection (default: 0.58)',
		'  --prescreen-angle-step X  Coarse angle step for candidate survival screening (default: 15)',
		'  --min-prescreen-survival X Minimum coarse completion fraction for a start tile (default: 0.7)',
		'  --max-prescreen-candidates N Maximum sampled candidates checked per radial band (default: 250)',
		'  --min-edge-parameter X    Minimum random t value (default: 0.05)',
		'  --max-edge-parameter X    Maximum random t value (default: 0.95)',
		'  --progress-every N        Log after this many angles per tile (default: 100)',
		'  --selection-only          Build tiling and print selected starts without sweeping angles',
		'  --format list|tsv         Output format for completed data (default: list)',
		'  --incomplete-value X      Keep incomplete trajectories in main output with this value',
		'  --output PATH             Main output TSV path',
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
		} else if( arg === '--tile-count' ) {
			config.tileCount = parseIntegerOption( arg, next() );
		} else if( arg === '--max-bounces' ) {
			config.maxBounces = parseIntegerOption( arg, next() );
		} else if( arg === '--angle-start' ) {
			config.angleStart = parseNumberOption( arg, next() );
		} else if( arg === '--angle-end' ) {
			config.angleEnd = parseNumberOption( arg, next() );
		} else if( arg === '--angle-step' ) {
			config.angleStep = parseNumberOption( arg, next() );
		} else if( arg === '--seed' ) {
			config.seed = next();
		} else if( arg === '--depth-slack' ) {
			config.depthSlack = parseIntegerOption( arg, next() );
		} else if( arg === '--selection' ) {
			config.selectionMode = next();
		} else if( arg === '--interior-min-fraction' ) {
			config.interiorMinFraction = parseNumberOption( arg, next() );
		} else if( arg === '--interior-max-fraction' ) {
			config.interiorMaxFraction = parseNumberOption( arg, next() );
		} else if( arg === '--prescreen-angle-step' ) {
			config.prescreenAngleStep = parseNumberOption( arg, next() );
		} else if( arg === '--min-prescreen-survival' ) {
			config.minPrescreenSurvival = parseNumberOption( arg, next() );
		} else if( arg === '--max-prescreen-candidates' ) {
			config.maxPrescreenCandidates = parseIntegerOption( arg, next() );
		} else if( arg === '--min-edge-parameter' ) {
			config.minEdgeParameter = parseNumberOption( arg, next() );
		} else if( arg === '--max-edge-parameter' ) {
			config.maxEdgeParameter = parseNumberOption( arg, next() );
		} else if( arg === '--progress-every' ) {
			config.progressEvery = parseIntegerOption( arg, next() );
		} else if( arg === '--selection-only' ) {
			config.selectionOnly = true;
		} else if( arg === '--format' ) {
			config.format = next();
		} else if( arg === '--incomplete-value' ) {
			config.incompleteValue = parseNumberOption( arg, next() );
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
	if( config.tileCount < 1 ) {
		throw new Error( '--tile-count must be at least 1' );
	}
	if( config.maxBounces < 1 ) {
		throw new Error( '--max-bounces must be at least 1' );
	}
	if( !(config.angleStep > 0) ) {
		throw new Error( '--angle-step must be greater than 0' );
	}
	if( config.angleEnd < config.angleStart ) {
		throw new Error( '--angle-end must be greater than or equal to --angle-start' );
	}
	if( config.depthSlack < 0 ) {
		throw new Error( '--depth-slack must be non-negative' );
	}
	if( !['center', 'spread-interior', 'boundary-depth'].includes( config.selectionMode ) ) {
		throw new Error( '--selection must be one of: center, spread-interior, boundary-depth' );
	}
	if( config.interiorMinFraction < 0 || config.interiorMaxFraction > 1 ||
		config.interiorMinFraction >= config.interiorMaxFraction ) {
		throw new Error( '--interior-min-fraction and --interior-max-fraction must satisfy 0 <= min < max <= 1' );
	}
	if( !(config.prescreenAngleStep > 0) ) {
		throw new Error( '--prescreen-angle-step must be greater than 0' );
	}
	if( config.minPrescreenSurvival < 0 || config.minPrescreenSurvival > 1 ) {
		throw new Error( '--min-prescreen-survival must be between 0 and 1' );
	}
	if( config.maxPrescreenCandidates < 1 ) {
		throw new Error( '--max-prescreen-candidates must be at least 1' );
	}
	if( config.minEdgeParameter <= 0 || config.maxEdgeParameter >= 1 ||
		config.minEdgeParameter >= config.maxEdgeParameter ) {
		throw new Error( '--min-edge-parameter and --max-edge-parameter must satisfy 0 < min < max < 1' );
	}
	if( !['list', 'tsv'].includes( config.format ) ) {
		throw new Error( '--format must be either list or tsv' );
	}
	if( config.progressEvery < 1 ) {
		throw new Error( '--progress-every must be at least 1' );
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
	for( const file of ['geometry.js', 'tiling.js', 'engine.js'] ) {
		const code = fs.readFileSync( path.join( ROOT, file ), 'utf8' );
		vm.runInContext( code, context, { filename: file } );
	}
	return context;
}

function decimalPlaces( value ) {
	const text = String( value );
	if( text.includes( 'e-' ) ) {
		return Number( text.split( 'e-' )[1] );
	}
	const dot = text.indexOf( '.' );
	return dot < 0 ? 0 : text.length - dot - 1;
}

function angleDecimals( config ) {
	const values = [config.angleStart, config.angleEnd, config.angleStep];
	return Math.max( 1, ...values.map( decimalPlaces ) );
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

function hashSeed( seed ) {
	let h = 2166136261;
	const text = String( seed );
	for( let i = 0; i < text.length; ++i ) {
		h ^= text.charCodeAt( i );
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

function shuffleInPlace( values, rng ) {
	for( let i = values.length - 1; i > 0; --i ) {
		const j = randomInt( rng, i + 1 );
		const tmp = values[i];
		values[i] = values[j];
		values[j] = tmp;
	}
	return values;
}

function pointDistance( a, b ) {
	return Math.hypot( a.x - b.x, a.y - b.y );
}

function tileCenterReference( tiling ) {
	return tiling.tiles[tiling.centralTileId] || tiling.tiles[tiling.rootTileId] || tiling.tiles[0];
}

function makeStartForTile( tiling, config, rng, tileId, idx ) {
	const tile = tiling.tiles[tileId];
	const centerTile = tileCenterReference( tiling ) || tile;
	const startEdge = randomInt( rng, tile.edges.length );
	const edgeParameter = config.minEdgeParameter +
		rng() * (config.maxEdgeParameter - config.minEdgeParameter);
	return {
		label: `tile_${idx + 1}`,
		startTileId: tileId,
		boundaryDepth: tiling.boundaryDepths[tileId],
		centerDistance: pointDistance( tile.centroid, centerTile.centroid ),
		startEdge,
		edgeParameter,
		prescreenSurvival: null
	};
}

function prescreenStart( context, tiling, config, start ) {
	const { angles } = generateAngles( {
		angleStart: 0,
		angleEnd: 359.999,
		angleStep: config.prescreenAngleStep
	} );
	let completed = 0;
	for( const angle of angles ) {
		const result = context.HatBilliards.runTrajectory( tiling, {
			startTileId: start.startTileId,
			startEdge: start.startEdge,
			edgeParameter: start.edgeParameter,
			angleDegrees: angle.value,
			maxBounces: config.maxBounces,
			maxExpansionLevel: config.level
		} );
		const bounceCount = Array.isArray( result.crossings ) ? result.crossings.length : 0;
		if( result.status === 'completed' && bounceCount >= config.maxBounces ) {
			completed += 1;
		}
	}
	return completed / angles.length;
}

function selectBoundaryDepthTiles( tiling, config, rng ) {
	const finiteDepths = tiling.boundaryDepths.filter( Number.isFinite );
	if( finiteDepths.length < config.tileCount ) {
		throw new Error( `Only found ${finiteDepths.length} finite-depth tiles` );
	}
	const maxDepth = finiteDepths.reduce( ( max, depth ) => Math.max( max, depth ), -Infinity );
	let candidates = [];
	let slack = config.depthSlack;
	while( candidates.length < config.tileCount ) {
		const minDepth = maxDepth - slack;
		candidates = tiling.tiles
			.filter( tile => Number.isFinite( tiling.boundaryDepths[tile.id] ) &&
				tiling.boundaryDepths[tile.id] >= minDepth )
			.map( tile => tile.id );
		if( minDepth <= 0 ) {
			break;
		}
		slack += 1;
	}
	if( candidates.length < config.tileCount ) {
		throw new Error( `Could not find ${config.tileCount} deep tile candidates` );
	}
	shuffleInPlace( candidates, rng );
	const starts = candidates
		.slice( 0, config.tileCount )
		.map( ( tileId, idx ) => makeStartForTile( tiling, config, rng, tileId, idx ) );
	starts.selectionDescription = `boundaryDepth >= maxDepth - ${config.depthSlack}, relaxed only if needed`;
	return starts;
}

function selectCenterTiles( tiling, config, rng ) {
	const centralTile = tileCenterReference( tiling );
	if( !centralTile ) {
		throw new Error( 'Could not locate a central tile for geometric center selection' );
	}
	const centralCandidateCount = Math.max(
		config.tileCount,
		config.tileCount * 20,
		Math.ceil( tiling.tiles.length * 0.0001 ) );
	const candidates = tiling.tiles
		.map( tile => ( {
			id: tile.id,
			centerDistance: pointDistance( tile.centroid, centralTile.centroid )
		} ) )
		.sort( ( a, b ) => a.centerDistance - b.centerDistance || a.id - b.id )
		.slice( 0, centralCandidateCount )
		.map( item => item.id );
	shuffleInPlace( candidates, rng );
	const starts = candidates
		.slice( 0, config.tileCount )
		.map( ( tileId, idx ) => makeStartForTile( tiling, config, rng, tileId, idx ) );
	starts.selectionDescription =
		`geometric center: sampled from ${candidates.length} tiles closest to centralTileId ${centralTile.id}`;
	return starts;
}

function selectSpreadInteriorTiles( context, tiling, config, rng ) {
	const centralTile = tileCenterReference( tiling );
	if( !centralTile ) {
		throw new Error( 'Could not locate a central tile for spread-interior selection' );
	}
	const distances = tiling.tiles.map( tile => pointDistance( tile.centroid, centralTile.centroid ) );
	const maxDistance = distances.reduce( ( max, value ) => Math.max( max, value ), 0 );
	const minDistance = config.interiorMinFraction * maxDistance;
	const maxInteriorDistance = config.interiorMaxFraction * maxDistance;
	const bandWidth = (maxInteriorDistance - minDistance) / config.tileCount;
	const selected = [];
	for( let band = 0; band < config.tileCount; ++band ) {
		const low = minDistance + band * bandWidth;
		const high = band === config.tileCount - 1 ? maxInteriorDistance : low + bandWidth;
		const candidates = tiling.tiles
			.filter( tile => distances[tile.id] >= low && distances[tile.id] < high )
			.map( tile => tile.id );
		shuffleInPlace( candidates, rng );
		const limit = Math.min( candidates.length, config.maxPrescreenCandidates );
		let best = null;
		for( let i = 0; i < limit; ++i ) {
			const start = makeStartForTile( tiling, config, rng, candidates[i], band );
			start.prescreenSurvival = prescreenStart( context, tiling, config, start );
			if( best == null || start.prescreenSurvival > best.prescreenSurvival ) {
				best = start;
			}
			if( start.prescreenSurvival >= config.minPrescreenSurvival ) {
				best = start;
				break;
			}
		}
		if( best == null ) {
			throw new Error( `No candidate tiles found for radial band ${band + 1}` );
		}
		selected.push( best );
	}
	selected.selectionDescription =
		`spread-interior: ${config.tileCount} radial bands from ` +
		`${config.interiorMinFraction} to ${config.interiorMaxFraction} of max center distance; ` +
		`coarse survival screened every ${config.prescreenAngleStep} deg with target >= ${config.minPrescreenSurvival}`;
	return selected;
}

function selectStartTiles( context, tiling, config, rng ) {
	let starts = null;
	if( config.selectionMode === 'boundary-depth' ) {
		starts = selectBoundaryDepthTiles( tiling, config, rng );
	} else if( config.selectionMode === 'center' ) {
		starts = selectCenterTiles( tiling, config, rng );
	} else {
		starts = selectSpreadInteriorTiles( context, tiling, config, rng );
	}
	return starts;
}

function visitedHatCount( result ) {
	const ids = new Set();
	if( result.startTileId != null ) {
		ids.add( result.startTileId );
	}
	for( const crossing of result.crossings || [] ) {
		if( crossing.fromTileId != null ) {
			ids.add( crossing.fromTileId );
		}
		if( crossing.toTileId != null ) {
			ids.add( crossing.toTileId );
		}
	}
	return ids.size;
}

function buildMainHeader( config, angles, decimals, starts, summary, tiling ) {
	if( config.format === 'list' ) {
		return '';
	}
	const firstAngle = angles.length > 0 ? angles[0].label : 'n/a';
	const lastAngle = angles.length > 0 ? angles[angles.length - 1].label : 'n/a';
	const startLines = [];
	for( const start of starts ) {
		startLines.push(
			`# ${start.label}_start_tile_id: ${start.startTileId}`,
			`# ${start.label}_boundary_depth: ${start.boundaryDepth}`,
			`# ${start.label}_center_distance: ${start.centerDistance}`,
			`# ${start.label}_start_edge: ${start.startEdge}`,
			`# ${start.label}_edge_parameter: ${start.edgeParameter}`,
			`# ${start.label}_prescreen_survival: ${start.prescreenSurvival == null ? 'n/a' : start.prescreenSurvival}`
		);
	}
	return [
		'# format: hat-billiards-hats-per-bounce-tsv',
		'# version: 1',
		`# root_type: ${config.rootType}`,
		`# level: ${config.level}`,
		`# max_bounces: ${config.maxBounces}`,
		`# angle_start_deg: ${firstAngle}`,
		`# angle_end_deg: ${lastAngle}`,
		`# angle_step_deg: ${config.angleStep.toFixed( decimals )}`,
		`# total_angle_count_per_tile: ${angles.length}`,
		`# tile_count: ${starts.length}`,
		`# total_run_count: ${summary.totalRuns}`,
		`# completed_run_count: ${summary.completedRuns}`,
		`# discarded_run_count: ${summary.discardedRuns}`,
		`# random_seed: ${config.seed}`,
		`# tile_selection: ${starts.selectionDescription}`,
		`# tiling_tile_count: ${tiling.tiles.length}`,
		...startLines,
		'# columns: tile_label<TAB>start_tile_id<TAB>start_edge<TAB>edge_parameter<TAB>boundary_depth<TAB>center_distance<TAB>angle_deg<TAB>hats_per_bounce<TAB>visited_hat_count<TAB>bounce_count'
	].join( '\n' );
}

function listStartHeader( start ) {
	return [
		`${start.label}: start_tile_id=${start.startTileId}, start_edge=${start.startEdge}, ` +
			`t=${start.edgeParameter}, center_distance=${start.centerDistance}, ` +
			`prescreen_survival=${start.prescreenSurvival == null ? 'n/a' : start.prescreenSurvival}`
	].join( '\n' );
}

function buildDiscardedHeader( config, angles, decimals, starts, summary ) {
	const firstAngle = angles.length > 0 ? angles[0].label : 'n/a';
	const lastAngle = angles.length > 0 ? angles[angles.length - 1].label : 'n/a';
	return [
		'# format: hat-billiards-hats-per-bounce-discarded-tsv',
		'# version: 1',
		`# root_type: ${config.rootType}`,
		`# level: ${config.level}`,
		`# max_bounces: ${config.maxBounces}`,
		`# angle_start_deg: ${firstAngle}`,
		`# angle_end_deg: ${lastAngle}`,
		`# angle_step_deg: ${config.angleStep.toFixed( decimals )}`,
		`# tile_count: ${starts.length}`,
		`# total_run_count: ${summary.totalRuns}`,
		`# completed_run_count: ${summary.completedRuns}`,
		`# discarded_run_count: ${summary.discardedRuns}`,
		`# random_seed: ${config.seed}`,
		`# tile_selection: ${starts.selectionDescription}`,
		'# columns: tile_label<TAB>start_tile_id<TAB>start_edge<TAB>edge_parameter<TAB>boundary_depth<TAB>center_distance<TAB>angle_deg<TAB>status<TAB>bounce_count'
	].join( '\n' );
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

function writeWithHeader( outputPath, header, dataPath ) {
	const outputFd = fs.openSync( outputPath, 'w' );
	try {
		if( header ) {
			fs.writeSync( outputFd, `${header}\n` );
		}
		copyFileIntoOpenFd( dataPath, outputFd );
	} finally {
		fs.closeSync( outputFd );
	}
}

function runExperiment( config ) {
	validateConfig( config );
	const outputPath = path.join( config.outputDir, config.outputFile );
	const discardedPath = outputPath.replace( /\.tsv$/i, '' ) + '.discarded.tsv';
	const mainDataPath = `${outputPath}.data.tmp`;
	const discardedDataPath = `${discardedPath}.data.tmp`;
	fs.mkdirSync( config.outputDir, { recursive: true } );

	const { angles, decimals } = generateAngles( config );
	const rng = createRng( config.seed );
	const context = loadEngineContext();
	const startBuild = Date.now();
	console.log( `[tiling] building ${config.rootType}:${config.level}` );
	const tiling = context.HatBilliards.buildTiling( {
		rootType: config.rootType,
		level: config.level
	} );
	console.log(
		`[tiling] built ${tiling.tiles.length} hats in ${((Date.now() - startBuild) / 1000).toFixed( 2 )}s` );

	const starts = selectStartTiles( context, tiling, config, rng );
		console.log( '[selection]' );
	for( const start of starts ) {
		console.log(
			`  ${start.label}: tile=${start.startTileId} depth=${start.boundaryDepth} ` +
			`centerDistance=${start.centerDistance} edge=${start.startEdge} t=${start.edgeParameter} ` +
			`prescreen=${start.prescreenSurvival == null ? 'n/a' : start.prescreenSurvival}` );
	}
	if( config.selectionOnly ) {
		return {
			outputPath: null,
			discardedPath: null,
			starts,
			totalRuns: 0,
			completedRuns: 0,
			discardedRuns: 0
		};
	}

	const mainDataFd = fs.openSync( mainDataPath, 'w' );
	const discardedDataFd = fs.openSync( discardedDataPath, 'w' );
	const summary = {
		totalRuns: starts.length * angles.length,
		completedRuns: 0,
		discardedRuns: 0
	};
	const runStart = Date.now();
	try {
		for( const start of starts ) {
			if( config.format === 'list' ) {
				fs.writeSync( mainDataFd, `${summary.completedRuns === 0 ? '' : '\n'}${listStartHeader( start )}\n` );
			} else {
				fs.writeSync( mainDataFd, `# --- ${start.label} ---\n` );
			}
			for( let idx = 0; idx < angles.length; ++idx ) {
				const angle = angles[idx];
				const result = context.HatBilliards.runTrajectory( tiling, {
					startTileId: start.startTileId,
					startEdge: start.startEdge,
					edgeParameter: start.edgeParameter,
					angleDegrees: angle.value,
					maxBounces: config.maxBounces,
					maxExpansionLevel: config.level
				} );
				const bounceCount = Array.isArray( result.crossings ) ? result.crossings.length : 0;
				const completed = result.status === 'completed' && bounceCount >= config.maxBounces;
				if( completed ) {
					const hatCount = visitedHatCount( result );
					const hatsPerBounce = hatCount / config.maxBounces;
					if( config.format === 'list' ) {
						fs.writeSync( mainDataFd, `${hatsPerBounce}\n` );
					} else {
						fs.writeSync(
							mainDataFd,
							`${start.label}\t${start.startTileId}\t${start.startEdge}\t` +
							`${start.edgeParameter}\t${start.boundaryDepth}\t${start.centerDistance}\t${angle.label}\t` +
							`${hatsPerBounce}\t${hatCount}\t${config.maxBounces}\n` );
					}
					summary.completedRuns += 1;
				} else {
					if( config.incompleteValue != null ) {
						if( config.format === 'list' ) {
							fs.writeSync( mainDataFd, `${config.incompleteValue}\n` );
						} else {
							fs.writeSync(
								mainDataFd,
								`${start.label}\t${start.startTileId}\t${start.startEdge}\t` +
								`${start.edgeParameter}\t${start.boundaryDepth}\t${start.centerDistance}\t${angle.label}\t` +
								`${config.incompleteValue}\t0\t${bounceCount}\n` );
						}
					}
					fs.writeSync(
						discardedDataFd,
						`${start.label}\t${start.startTileId}\t${start.startEdge}\t` +
						`${start.edgeParameter}\t${start.boundaryDepth}\t${start.centerDistance}\t${angle.label}\t` +
						`${result.status}\t${bounceCount}\n` );
					summary.discardedRuns += 1;
				}
				if( (idx + 1) % config.progressEvery === 0 || idx + 1 === angles.length ) {
					const elapsed = ((Date.now() - runStart) / 1000).toFixed( 1 );
					console.log(
						`[run] ${start.label} ${idx + 1}/${angles.length} angles ` +
						`complete (${elapsed}s total)` );
				}
			}
		}
	} finally {
		fs.closeSync( mainDataFd );
		fs.closeSync( discardedDataFd );
	}

	writeWithHeader(
		outputPath,
		buildMainHeader( config, angles, decimals, starts, summary, tiling ),
		mainDataPath );
	writeWithHeader(
		discardedPath,
		buildDiscardedHeader( config, angles, decimals, starts, summary ),
		discardedDataPath );
	fs.unlinkSync( mainDataPath );
	fs.unlinkSync( discardedDataPath );

	return Object.assign( {
		outputPath,
		discardedPath,
		starts
	}, summary );
}

function main() {
	try {
		const config = parseArgs( process.argv.slice( 2 ) );
		const result = runExperiment( config );
		if( result.outputPath ) {
			console.log( `[write] ${result.outputPath}` );
			console.log( `[write] ${result.discardedPath}` );
		}
		console.log(
			`[summary] runs=${result.totalRuns} completed=${result.completedRuns} ` +
			`discarded=${result.discardedRuns}` );
	} catch( err ) {
		console.error( err && err.stack ? err.stack : String( err ) );
		process.exitCode = 1;
	}
}

main();
