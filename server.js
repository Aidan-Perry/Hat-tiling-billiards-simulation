const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');

const HOST = process.env.HATVIZ_HOST || '127.0.0.1';
const PORT = Number(process.env.HATVIZ_PORT || 8765);
const ROOT = __dirname;
const tilingCache = new Map();

function logTiming( label, startTime ) {
	const elapsed = ((Date.now() - startTime) / 1000).toFixed( 2 );
	console.log( `${label} in ${elapsed}s` );
}

function formatBytes( bytes ) {
	if( bytes < 1024 ) {
		return `${bytes} B`;
	}
	if( bytes < 1024 * 1024 ) {
		return `${(bytes / 1024).toFixed( 1 )} KiB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed( 1 )} MiB`;
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

const ctx = loadEngineContext();

function cacheKey( rootType, level ) {
	return `${rootType}:${level}`;
}

function getTiling( rootType, level ) {
	const key = cacheKey( rootType, level );
	if( !tilingCache.has( key ) ) {
		const start = Date.now();
		console.log( `[tiling] building ${key}` );
		const tiling = ctx.HatBilliards.buildTiling( { rootType, level } );
		tilingCache.set( key, tiling );
		logTiming( `[tiling] built ${key} with ${tiling.tiles.length} hats`, start );
	} else {
		console.log( `[tiling] cache hit ${key}` );
	}
	return tilingCache.get( key );
}

function clonePoint( p ) {
	return p ? { x: p.x, y: p.y } : null;
}

function cloneEdge( edge ) {
	return edge ? {
		tileId: edge.tileId,
		edgeIndex: edge.edgeIndex,
		a: clonePoint( edge.a ),
		b: clonePoint( edge.b )
	} : null;
}

function cloneCrossing( crossing ) {
	return {
		fromTileId: crossing.fromTileId,
		toTileId: crossing.toTileId == null ? null : crossing.toTileId,
		edgeIndex: crossing.edgeIndex,
		nextEdgeIndex: crossing.nextEdgeIndex == null ? null : crossing.nextEdgeIndex,
		point: clonePoint( crossing.point ),
		u: crossing.u
	};
}

function serializeTileForJSON( tile ) {
	return {
		id: tile.id,
		label: tile.label,
		transform: tile.transform ? tile.transform.slice() : null,
		inverseTransform: tile.inverseTransform ? tile.inverseTransform.slice() : null,
		polygon: tile.polygon.map( clonePoint ),
		centroid: clonePoint( tile.centroid ),
		edges: tile.edges.map( edge => ( {
			index: edge.index,
			a: clonePoint( edge.a ),
			b: clonePoint( edge.b )
		} ) ),
		adjacent: tile.adjacent.map( link => link ? {
			tileId: link.tileId,
			edgeIndex: link.edgeIndex
		} : null )
	};
}

function focusTileIdsForResult( result ) {
	const focusIds = new Set( [result.startTileId, result.currentTileId] );
	for( const crossing of result.crossings || [] ) {
		focusIds.add( crossing.fromTileId );
		if( crossing.toTileId != null ) {
			focusIds.add( crossing.toTileId );
		}
	}
	return [...focusIds].filter( id => id != null );
}

function cacheTrajectoryMetadata( result ) {
	result.focusTileIds = focusTileIdsForResult( result );
	const startPoint = result.points[0];
	const startTileId = startPoint ?
		ctx.HatBilliards.locateTileContaining( result.tiling, startPoint, result.startTileId ) :
		result.startTileId;
	result.startTileIdInFinalTiling = startTileId;
	const startTile = result.tiling.tiles[startTileId];
	const startEdge = startTile ? startTile.edges[result.requestedStartEdge] : null;
	result.startEdge = startEdge ? {
		tileId: startTile.id,
		edgeIndex: startEdge.index,
		a: startEdge.a,
		b: startEdge.b
	} : null;
	const lastCrossing = result.crossings[result.crossings.length - 1];
	if( lastCrossing ) {
		const tile = result.tiling.tiles[lastCrossing.fromTileId];
		const edge = tile ? tile.edges[lastCrossing.edgeIndex] : null;
		result.finalEdge = edge ? {
			tileId: tile.id,
			edgeIndex: edge.index,
			a: edge.a,
			b: edge.b
		} : null;
	} else {
		result.finalEdge = null;
	}
}

function pointDistance( a, b ) {
	return Math.hypot( a.x - b.x, a.y - b.y );
}

function checkTrajectoryPeriodicity( result ) {
	if( !result || !result.points || result.points.length < 2 ) {
		result.periodicity = null;
		return;
	}
	const start = result.points[0];
	const tol = result.tiling && result.tiling.tolerances ?
		result.tiling.tolerances.VERTEX_EPS : 1e-7;
	let bestDistance = Infinity;
	let bestSegmentIndex = null;
	let bestSegmentT = null;
	for( let idx = 2; idx < result.points.length; ++idx ) {
		const a = result.points[idx - 1];
		const b = result.points[idx];
		const ab = { x: b.x - a.x, y: b.y - a.y };
		const as = { x: start.x - a.x, y: start.y - a.y };
		const len2 = ab.x*ab.x + ab.y*ab.y;
		const t = len2 === 0 ? 0 :
			Math.max( 0, Math.min( 1, (as.x*ab.x + as.y*ab.y) / len2 ) );
		const closest = { x: a.x + t*ab.x, y: a.y + t*ab.y };
		const d = pointDistance( start, closest );
		if( d < bestDistance ) {
			bestDistance = d;
			bestSegmentIndex = idx - 1;
			bestSegmentT = t;
		}
		if( d <= tol ) {
			result.periodicity = {
				detected: true,
				tolerance: tol,
				segmentIndex: idx - 1,
				segmentT: t,
				bounce: idx - 1,
				distance: d
			};
			return;
		}
	}
	result.periodicity = {
		detected: false,
		tolerance: tol,
		nearestSegmentIndex: bestSegmentIndex,
		nearestSegmentT: bestSegmentT,
		nearestBounce: bestSegmentIndex,
		nearestDistance: bestDistance
	};
}

function buildLocalPatch( tiling, resultOrResults, radius ) {
	const results = Array.isArray( resultOrResults ) ? resultOrResults :
		(resultOrResults ? [resultOrResults] : []);
	const focusIds = new Set();
	for( const result of results ) {
		for( const id of result && result.focusTileIds ? result.focusTileIds : [] ) {
			focusIds.add( id );
		}
		if( result ) {
			focusIds.add( result.startTileIdInFinalTiling );
			focusIds.add( result.currentTileId );
		}
	}
	const firstResult = results[0];
	const focusId = firstResult && firstResult.currentTileId != null ?
		firstResult.currentTileId :
		(tiling.rootTileId == null ? tiling.centralTileId : tiling.rootTileId);
	focusIds.add( focusId );
	const patchById = new Map();
	for( const id of focusIds ) {
		if( id == null ) {
			continue;
		}
		for( const tile of ctx.HatBilliards.bfsPatch( tiling, id, radius ) ) {
			patchById.set( tile.id, tile );
		}
	}
	const patch = [...patchById.values()];
	const startId = firstResult && firstResult.startTileIdInFinalTiling != null ?
		firstResult.startTileIdInFinalTiling :
		(tiling.rootTileId == null ? tiling.centralTileId : tiling.rootTileId);
	return {
		startTileId: startId,
		tileIds: patch.map( tile => tile.id ),
		tiles: patch.map( serializeTileForJSON )
	};
}

function publicResult( result ) {
	return {
		color: result.color || 'red',
		status: result.status,
		rootType: result.rootType,
		level: result.level,
		startTileId: result.startTileId,
		startTileIdInFinalTiling: result.startTileIdInFinalTiling,
		currentTileId: result.currentTileId,
		requestedBounces: result.requestedBounces,
		requestedStartEdge: result.requestedStartEdge,
		requestedEdgeParameter: result.requestedEdgeParameter,
		requestedAngleDegrees: result.requestedAngleDegrees,
		expansions: result.expansions,
		periodicity: result.periodicity || null,
		initialDirection: clonePoint( result.initialDirection ),
		focusTileIds: (result.focusTileIds || []).slice(),
		startEdge: cloneEdge( result.startEdge ),
		finalEdge: cloneEdge( result.finalEdge ),
		points: result.points.map( clonePoint ),
		crossings: result.crossings.map( cloneCrossing )
	};
}

function trajectoryPayload( tilingConfig, spec, result, patchRadius ) {
	const results = Array.isArray( result ) ? result : [result];
	const specs = Array.isArray( spec ) ? spec : [spec];
	const publicResults = results.map( publicResult );
	return {
		format: 'hatviz-billiards-trajectory',
		version: 1,
		serverBacked: true,
		tilingConfig: {
			rootType: tilingConfig.rootType,
			level: results[0].level,
			patchRadius
		},
		trajectorySpec: {
			startTileSelection: 'centralTileId',
			startTileId: results[0].startTileId,
			startEdge: specs[0].startEdge,
			edgeParameter: specs[0].edgeParameter,
			angleDegrees: specs[0].angleDegrees,
			maxBounces: specs[0].maxBounces,
			maxExpansionLevel: results[0].level
		},
		trajectories: specs.map( (entry, idx) => ( {
			color: entry.color || (idx === 1 ? 'blue' : 'red'),
			startTileSelection: 'centralTileId',
			startTileId: results[idx] ? results[idx].startTileId : null,
			startEdge: entry.startEdge,
			edgeParameter: entry.edgeParameter,
			angleDegrees: entry.angleDegrees,
			maxBounces: entry.maxBounces,
			maxExpansionLevel: results[idx] ? results[idx].level : tilingConfig.level
		} ) ),
		result: publicResults[0],
		results: publicResults,
		localHatConfiguration: buildLocalPatch( results[0].tiling, results, patchRadius )
	};
}

function sanitizeRunRequest( body ) {
	const rootType = ['H', 'T', 'P', 'F'].includes( body.rootType ) ? body.rootType : 'H';
	const level = Math.max( 1, Math.min( 6, Math.floor( body.level == null ? 1 : body.level ) ) );
	const patchRadius = Math.max( 0, Math.floor( body.patchRadius == null ? 1 : body.patchRadius ) );
	const startEdge = Math.max( 0, Math.min( 12, Math.floor( body.startEdge == null ? 0 : body.startEdge ) ) );
	const edgeParameter = Math.max( 0, Math.min( 1, Number( body.edgeParameter == null ? 0.5 : body.edgeParameter ) ) );
	const angleDegrees = Number.isFinite( Number( body.angleDegrees ) ) ? Number( body.angleDegrees ) : 60;
	const maxBounces = Math.max( 0, Math.floor( body.maxBounces == null ? 40 : body.maxBounces ) );
	const rawTrajectories = Array.isArray( body.trajectories ) && body.trajectories.length > 0 ?
		body.trajectories : [{ startEdge, edgeParameter, angleDegrees }];
	const trajectories = rawTrajectories.slice( 0, 2 ).map( (entry, idx) => ( {
		color: entry.color || (idx === 1 ? 'blue' : 'red'),
		startEdge: Math.max( 0, Math.min( 12, Math.floor( entry.startEdge == null ? startEdge : entry.startEdge ) ) ),
		edgeParameter: Math.max( 0, Math.min( 1, Number( entry.edgeParameter == null ? edgeParameter : entry.edgeParameter ) ) ),
		angleDegrees: Number.isFinite( Number( entry.angleDegrees ) ) ? Number( entry.angleDegrees ) : angleDegrees
	} ) );
	return { rootType, level, patchRadius, startEdge, edgeParameter, angleDegrees, maxBounces, trajectories };
}

function handleRun( body ) {
	const req = sanitizeRunRequest( body || {} );
	const initialPatchRadius = 0;
	const start = Date.now();
	console.log(
		`[run] ${req.rootType}:${req.level}, bounces=${req.maxBounces}, ` +
		`requestedPatchRadius=${req.patchRadius}, initialPatchRadius=${initialPatchRadius}` );
	const tiling = getTiling( req.rootType, req.level );
	const trajectoryStart = Date.now();
	const specs = req.trajectories.map( entry => ( {
		color: entry.color,
		startTileId: tiling.centralTileId,
		startEdge: entry.startEdge,
		edgeParameter: entry.edgeParameter,
		angleDegrees: entry.angleDegrees,
		maxBounces: req.maxBounces,
		maxExpansionLevel: req.level
	} ) );
	const results = specs.map( spec => {
		const result = ctx.HatBilliards.runTrajectory( tiling, spec );
		result.color = spec.color;
		result.requestedBounces = req.maxBounces;
		result.requestedStartEdge = spec.startEdge;
		result.requestedEdgeParameter = spec.edgeParameter;
		result.requestedAngleDegrees = spec.angleDegrees;
		cacheTrajectoryMetadata( result );
		checkTrajectoryPeriodicity( result );
		return result;
	} );
	logTiming( `[run] trajectories ${req.rootType}:${req.level} produced ${results.map( r => r.points.length ).join( '/' )} points`, trajectoryStart );
	for( const result of results ) {
		console.log(
			`[run] ${result.color || 'red'} status=${result.status} ` +
			`bounces=${result.crossings.length}/${result.requestedBounces} ` +
			`points=${result.points.length} focus=${(result.focusTileIds || []).length} ` +
			`level=${result.level}` );
	}
	const payloadStart = Date.now();
	const payload = trajectoryPayload( req, specs, results, initialPatchRadius );
	const payloadJSON = JSON.stringify( payload );
	logTiming(
		`[run] payload built ${req.rootType}:${req.level} ` +
		`patchTiles=${payload.localHatConfiguration.tiles.length} ` +
		`jsonBytes=${Buffer.byteLength( payloadJSON, 'utf8' )}`,
		payloadStart );
	logTiming( `[run] complete ${req.rootType}:${req.level}`, start );
	return payload;
}

function handlePatch( body ) {
	const start = Date.now();
	const config = body && body.tilingConfig ? body.tilingConfig : {};
	const resultBody = body && body.result ? body.result : {};
	const resultBodies = body && Array.isArray( body.results ) && body.results.length > 0 ?
		body.results : [resultBody];
	const rootType = ['H', 'T', 'P', 'F'].includes( config.rootType || resultBody.rootType ) ?
		(config.rootType || resultBody.rootType) : 'H';
	const level = Math.max( 1, Math.min( 6, Math.floor( config.level || resultBody.level || 1 ) ) );
	const patchRadius = Math.max( 0, Math.floor(
		body && body.patchRadius != null ? body.patchRadius :
			(config.patchRadius == null ? 1 : config.patchRadius) ) );
	const tiling = getTiling( rootType, level );
	const results = resultBodies.map( item => Object.assign( {}, item, {
		rootType,
		level,
		focusTileIds: item.focusTileIds && item.focusTileIds.length > 0 ?
			item.focusTileIds : focusTileIdsForResult( item )
	} ) );
	const patch = {
		format: 'hatviz-billiards-trajectory-patch',
		version: 1,
		rootType,
		level,
		patchRadius,
		localHatConfiguration: buildLocalPatch( tiling, results, patchRadius )
	};
	logTiming( `[patch] ${rootType}:${level} radius=${patchRadius} tiles=${patch.localHatConfiguration.tiles.length}`, start );
	return patch;
}

function readBody( req ) {
	return new Promise( (resolve, reject) => {
		let data = '';
		req.on( 'data', chunk => {
			data += chunk;
			if( data.length > 20 * 1024 * 1024 ) {
				req.destroy();
				reject( new Error( 'Request body too large' ) );
			}
		} );
		req.on( 'end', () => {
			try {
				resolve( data.length ? JSON.parse( data ) : {} );
			} catch( err ) {
				reject( err );
			}
		} );
		req.on( 'error', reject );
	} );
}

function sendJSON( res, status, value ) {
	const start = Date.now();
	const json = JSON.stringify( value );
	const bytes = Buffer.byteLength( json );
	logTiming( `[http] JSON ${status} ${formatBytes( bytes )}`, start );
	res.writeHead( status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': bytes,
		'Cache-Control': 'no-store',
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Headers': 'Content-Type',
		'Access-Control-Allow-Methods': 'POST, OPTIONS'
	} );
	res.end( json );
}

function sendOptions( res ) {
	res.writeHead( 204, {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Headers': 'Content-Type',
		'Access-Control-Allow-Methods': 'POST, OPTIONS'
	} );
	res.end();
}

function contentType( file ) {
	const ext = path.extname( file ).toLowerCase();
	if( ext === '.html' ) return 'text/html; charset=utf-8';
	if( ext === '.js' ) return 'text/javascript; charset=utf-8';
	if( ext === '.css' ) return 'text/css; charset=utf-8';
	if( ext === '.json' ) return 'application/json; charset=utf-8';
	if( ext === '.svg' ) return 'image/svg+xml';
	if( ext === '.png' ) return 'image/png';
	return 'application/octet-stream';
}

function serveStatic( req, res ) {
	const url = new URL( req.url, `http://${HOST}:${PORT}` );
	const requested = url.pathname === '/' ? '/app.html' : url.pathname;
	const filePath = path.normalize( path.join( ROOT, requested ) );
	if( !filePath.startsWith( ROOT ) ) {
		res.writeHead( 403 );
		res.end( 'Forbidden' );
		return;
	}
	fs.readFile( filePath, (err, data) => {
		if( err ) {
			res.writeHead( 404 );
			res.end( 'Not found' );
			return;
		}
		res.writeHead( 200, {
			'Content-Type': contentType( filePath ),
			'Content-Length': data.length
		} );
		res.end( data );
	} );
}

const server = http.createServer( async (req, res) => {
	try {
		if( req.method === 'OPTIONS' ) {
			sendOptions( res );
			return;
		}
		if( req.method === 'POST' && req.url === '/api/trajectory/run' ) {
			console.log( `[http] POST ${req.url}` );
			sendJSON( res, 200, handleRun( await readBody( req ) ) );
			return;
		}
		if( req.method === 'POST' && req.url === '/api/trajectory/patch' ) {
			console.log( `[http] POST ${req.url}` );
			sendJSON( res, 200, handlePatch( await readBody( req ) ) );
			return;
		}
		if( req.method === 'GET' || req.method === 'HEAD' ) {
			serveStatic( req, res );
			return;
		}
		res.writeHead( 405 );
		res.end( 'Method not allowed' );
	} catch( err ) {
		sendJSON( res, 500, { error: err.message || String( err ) } );
	}
} );

server.listen( PORT, HOST, () => {
	console.log( `Hatviz server listening at http://${HOST}:${PORT}/app.html` );
} );
