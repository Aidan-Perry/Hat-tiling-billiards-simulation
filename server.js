const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const HOST = process.env.HATVIZ_HOST || '127.0.0.1';
const PORT = Number(process.env.HATVIZ_PORT || 8765);
const ROOT = __dirname;
const DIAGNOSTICS_DIR = path.join( ROOT, 'Diagnostics' );
const tilingCache = new Map();
let latestDiagnosticsPayloadValue = null;
let latestDiagnosticsJSON = '';
let latestDiagnosticsETagValue = null;
let latestDiagnosticsSourceValue = null;

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

function pointSub( a, b ) {
	return { x: a.x - b.x, y: a.y - b.y };
}

function pointAdd( a, b ) {
	return { x: a.x + b.x, y: a.y + b.y };
}

function pointScale( a, s ) {
	return { x: a.x * s, y: a.y * s };
}

function cross2( a, b ) {
	return a.x * b.y - a.y * b.x;
}

function ensureDiagnosticsDir() {
	fs.mkdirSync( DIAGNOSTICS_DIR, { recursive: true } );
}

function diagnosticsFileName( timestamp, runId ) {
	return `diagnostics-${timestamp.replace( /[:.]/g, '-' )}-${runId}.json`;
}

function fitExponentialDistance( samples ) {
	const fitted = [];
	let skipped = 0;
	for( const sample of samples ) {
		const distance = Number( sample.distance );
		if( Number.isFinite( distance ) && distance > 0 ) {
			fitted.push( { x: sample.bounce, y: Math.log( distance ) } );
		} else {
			++skipped;
		}
	}
	if( fitted.length < 2 ) {
		return {
			model: 'exponential',
			equation: 'distance ≈ A * exp(B * bounce)',
			A: null,
			B: null,
			r2: null,
			sampleCount: samples.length,
			fittedSampleCount: fitted.length,
			skippedNonPositiveOrNonFiniteCount: skipped
		};
	}
	let sumX = 0;
	let sumY = 0;
	let sumXX = 0;
	let sumXY = 0;
	for( const point of fitted ) {
		sumX += point.x;
		sumY += point.y;
		sumXX += point.x * point.x;
		sumXY += point.x * point.y;
	}
	const n = fitted.length;
	const denom = n * sumXX - sumX * sumX;
	if( Math.abs( denom ) < 1e-12 ) {
		return {
			model: 'exponential',
			equation: 'distance ≈ A * exp(B * bounce)',
			A: null,
			B: null,
			r2: null,
			sampleCount: samples.length,
			fittedSampleCount: fitted.length,
			skippedNonPositiveOrNonFiniteCount: skipped
		};
	}
	const slope = (n * sumXY - sumX * sumY) / denom;
	const intercept = (sumY - slope * sumX) / n;
	const meanY = sumY / n;
	let ssRes = 0;
	let ssTot = 0;
	for( const point of fitted ) {
		const predicted = intercept + slope * point.x;
		ssRes += (point.y - predicted) * (point.y - predicted);
		ssTot += (point.y - meanY) * (point.y - meanY);
	}
	return {
		model: 'exponential',
		equation: 'distance ≈ A * exp(B * bounce)',
		A: Math.exp( intercept ),
		B: slope,
		r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot,
		sampleCount: samples.length,
		fittedSampleCount: fitted.length,
		skippedNonPositiveOrNonFiniteCount: skipped
	};
}

function buildDistanceGraphDiagnostics( results ) {
	if( !Array.isArray( results ) || results.length !== 2 ) {
		return {
			id: 'red-blue-distance',
			type: 'red-blue-distance',
			available: false,
			reason: 'requires exactly two trajectories'
		};
	}
	const red = results.find( result => result.color === 'red' ) || results[0];
	const blue = results.find( result => result.color === 'blue' ) || results.find( result => result !== red ) || results[1];
	const redPoints = red && Array.isArray( red.points ) ? red.points : [];
	const bluePoints = blue && Array.isArray( blue.points ) ? blue.points : [];
	const sampleCount = Math.min( redPoints.length, bluePoints.length );
	const samples = [];
	for( let idx = 0; idx < sampleCount; ++idx ) {
		samples.push( {
			bounce: idx,
			distance: pointDistance( redPoints[idx], bluePoints[idx] )
		} );
	}
	return {
		id: 'red-blue-distance',
		type: 'red-blue-distance',
		available: true,
		xAxis: 'bounce index',
		yAxis: 'Euclidean distance',
		sampleCount,
		lastBounce: sampleCount > 0 ? sampleCount - 1 : null,
		redPointCount: redPoints.length,
		bluePointCount: bluePoints.length,
		redStatus: red ? red.status : null,
		blueStatus: blue ? blue.status : null,
		redSettings: red ? {
			startEdge: red.requestedStartEdge,
			edgeParameter: red.requestedEdgeParameter,
			angleDegrees: red.requestedAngleDegrees
		} : null,
		blueSettings: blue ? {
			startEdge: blue.requestedStartEdge,
			edgeParameter: blue.requestedEdgeParameter,
			angleDegrees: blue.requestedAngleDegrees
		} : null,
		samples,
		fit: fitExponentialDistance( samples )
	};
}

function buildStartDistanceGraphDiagnostics( results ) {
	if( !Array.isArray( results ) || results.length === 0 ) {
		return {
			id: 'trajectory-start-distance',
			type: 'trajectory-start-distance',
			available: false,
			reason: 'requires at least one trajectory'
		};
	}
	const series = results.map( (result, idx) => {
		const points = result && Array.isArray( result.points ) ? result.points : [];
		const start = points[0];
		return {
			id: result.color || `trajectory-${idx + 1}`,
			color: result.color || (idx === 1 ? 'blue' : 'red'),
			label: result.color || `Trajectory ${idx + 1}`,
			status: result.status,
			pointCount: points.length,
			lastBounce: points.length > 0 ? points.length - 1 : null,
			settings: {
				startEdge: result.requestedStartEdge,
				edgeParameter: result.requestedEdgeParameter,
				angleDegrees: result.requestedAngleDegrees
			},
			samples: start ? points.map( (point, bounce) => ( {
				bounce,
				distance: pointDistance( start, point )
			} ) ) : []
		};
	} );
	return {
		id: 'trajectory-start-distance',
		type: 'trajectory-start-distance',
		available: true,
		xAxis: 'bounce index',
		yAxis: 'distance from trajectory start',
		series
	};
}

function buildHatCuttingSequenceDiagnostics( results ) {
	return (results || []).map( (result, idx) => {
		const entries = (result.crossings || []).map( (crossing, crossingIdx) => ( {
			bounce: crossingIdx + 1,
			symbol: String( crossing.edgeIndex ),
			edgeIndex: crossing.edgeIndex,
			fromTileId: crossing.fromTileId,
			toTileId: crossing.toTileId == null ? null : crossing.toTileId,
			nextEdgeIndex: crossing.nextEdgeIndex == null ? null : crossing.nextEdgeIndex,
			u: crossing.u
		} ) );
		return {
			id: result.color || `trajectory-${idx + 1}`,
			color: result.color || (idx === 1 ? 'blue' : 'red'),
			label: result.color || `Trajectory ${idx + 1}`,
			type: 'hat-edge',
			count: entries.length,
			tokens: entries.map( entry => entry.symbol ),
			entries
		};
	} );
}

function inferMetatileLabel( geom ) {
	const sides = geom && geom.shape ? geom.shape.length : 0;
	if( sides === 6 ) return 'H';
	if( sides === 5 ) return 'F';
	if( sides === 4 ) return 'P';
	if( sides === 3 ) return 'T';
	return 'M';
}

function transformedShape( shape, T ) {
	return (shape || []).map( point => ctx.transPt ? ctx.transPt( T, point ) : transPt( T, point ) );
}

function flattenMetatileOutlinesAtDepth( geom, T, depth, out ) {
	if( !geom || !geom.children ) {
		return;
	}
	if( depth > 0 ) {
		for( const child of geom.children ) {
			flattenMetatileOutlinesAtDepth( child.geom, ctx.mul( T, child.T ), depth - 1, out );
		}
		return;
	}
	const polygon = geom.shape.map( point => ctx.transPt( T, point ) );
	out.push( {
		id: out.length,
		label: inferMetatileLabel( geom ),
		polygon,
		edges: polygon.map( (point, idx) => ( {
			index: idx,
			a: point,
			b: polygon[(idx + 1) % polygon.length]
		} ) )
	} );
}

function metatileOutlinesForLevel( tiling, metatileLevel ) {
	const generatedLevel = Math.max( 1, Math.floor( tiling.level || 1 ) );
	const level = Math.max( 1, Math.min( generatedLevel, Math.floor( metatileLevel ) ) );
	const depth = generatedLevel - level + 1;
	const outlines = [];
	flattenMetatileOutlinesAtDepth( tiling.root, tiling.rootTransform || ctx.ident, depth, outlines );
	return outlines;
}

function segmentIntersection( p, q, a, b, eps ) {
	const r = pointSub( q, p );
	const s = pointSub( b, a );
	const denom = cross2( r, s );
	if( Math.abs( denom ) <= eps ) {
		return null;
	}
	const ap = pointSub( a, p );
	const t = cross2( ap, s ) / denom;
	const u = cross2( ap, r ) / denom;
	if( t < eps || t > 1 - eps || u < -eps || u > 1 + eps ) {
		return null;
	}
	return {
		t,
		u,
		point: pointAdd( p, pointScale( r, t ) )
	};
}

function buildMetatileSequenceForResult( result, outlines, metatileLevel ) {
	const points = result.points || [];
	const eps = result.tiling && result.tiling.tolerances ?
		result.tiling.tolerances.EPS * 1000 : 1e-7;
	const entries = [];
	for( let idx = 1; idx < points.length; ++idx ) {
		const p = points[idx - 1];
		const q = points[idx];
		const hits = [];
		for( const outline of outlines ) {
			for( const edge of outline.edges ) {
				const hit = segmentIntersection( p, q, edge.a, edge.b, eps );
				if( hit ) {
					hits.push( {
						segmentIndex: idx,
						t: hit.t,
						point: hit.point,
						metatileId: outline.id,
						metatileLabel: outline.label,
						sideIndex: edge.index,
						symbol: `${outline.label}${edge.index}`
					} );
				}
			}
		}
		hits.sort( (a, b) => a.t - b.t || a.metatileId - b.metatileId || a.sideIndex - b.sideIndex );
		for( const hit of hits ) {
			const last = entries[entries.length - 1];
			if( last && last.segmentIndex === hit.segmentIndex && Math.abs( last.t - hit.t ) <= eps * 10 ) {
				const symbols = new Set( last.symbol.split( '|' ) );
				symbols.add( hit.symbol );
				last.symbol = [...symbols].sort().join( '|' );
				last.candidates.push( {
					metatileId: hit.metatileId,
					metatileLabel: hit.metatileLabel,
					sideIndex: hit.sideIndex
				} );
				continue;
			}
			entries.push( {
				bounce: idx,
				segmentIndex: hit.segmentIndex,
				t: hit.t,
				symbol: hit.symbol,
				point: clonePoint( hit.point ),
				candidates: [{
					metatileId: hit.metatileId,
					metatileLabel: hit.metatileLabel,
					sideIndex: hit.sideIndex
				}]
			} );
		}
	}
	return {
		id: result.color || 'trajectory',
		color: result.color || 'red',
		label: result.color || 'trajectory',
		type: 'metatile-boundary',
		metatileLevel,
		outlineCount: outlines.length,
		count: entries.length,
		tokens: entries.map( entry => entry.symbol ),
		entries
	};
}

function buildMetatileCuttingSequenceDiagnostics( levels ) {
	if( !latestDiagnosticsSourceValue || !latestDiagnosticsSourceValue.results || latestDiagnosticsSourceValue.results.length === 0 ) {
		return { available: false, levels: [], error: 'No trajectory diagnostics are available.' };
	}
	const results = latestDiagnosticsSourceValue.results;
	const tiling = results[0].tiling;
	const maxLevel = Math.max( 1, Math.floor( tiling.level || 1 ) );
	const requestedLevels = [...new Set( (levels || []).map( level =>
		Math.max( 1, Math.min( maxLevel, Math.floor( level ) ) ) ) )]
		.filter( Number.isFinite )
		.sort( (a, b) => a - b );
	const levelPayloads = requestedLevels.map( level => {
		const outlines = metatileOutlinesForLevel( tiling, level );
		return {
			level,
			outlineCount: outlines.length,
			sequences: results.map( result =>
				buildMetatileSequenceForResult( result, outlines, level ) )
		};
	} );
	return {
		available: true,
		maxLevel,
		levels: levelPayloads
	};
}

function buildDiagnosticsPayload( req, specs, results ) {
	const timestamp = new Date().toISOString();
	const runId = crypto.randomBytes( 4 ).toString( 'hex' );
	const fileName = diagnosticsFileName( timestamp, runId );
	const publicResults = results.map( publicResult );
	return {
		format: 'hatviz-diagnostics',
		version: 1,
		available: true,
		runId,
		timestamp,
		fileName,
		saved: false,
		run: {
			rootType: req.rootType,
			level: req.level,
			requestedBounces: req.maxBounces,
			trajectoryCount: publicResults.length,
			trajectories: publicResults.map( (result, idx) => ( {
				color: result.color || (idx === 1 ? 'blue' : 'red'),
				status: result.status,
				pointCount: result.points.length,
				crossingCount: result.crossings.length,
				startEdge: specs[idx] ? specs[idx].startEdge : result.requestedStartEdge,
				edgeParameter: specs[idx] ? specs[idx].edgeParameter : result.requestedEdgeParameter,
				angleDegrees: specs[idx] ? specs[idx].angleDegrees : result.requestedAngleDegrees,
				startTileId: result.startTileId,
				currentTileId: result.currentTileId
			} ) )
		},
		symbolic: {
			hatSequences: buildHatCuttingSequenceDiagnostics( publicResults ),
			metatileSequences: {
				available: true,
				maxLevel: req.level,
				levels: []
			}
		},
		graphs: [
			buildDistanceGraphDiagnostics( publicResults ),
			buildStartDistanceGraphDiagnostics( publicResults )
		]
	};
}

function saveDiagnosticsPayload( payload ) {
	ensureDiagnosticsDir();
	const json = JSON.stringify( payload, null, 2 );
	fs.writeFileSync( path.join( DIAGNOSTICS_DIR, payload.fileName ), json );
	console.log( `[diagnostics] wrote ${payload.fileName}` );
	return payload.fileName;
}

function setLatestDiagnosticsPayload( payload, source ) {
	latestDiagnosticsPayloadValue = payload;
	latestDiagnosticsSourceValue = source || null;
	latestDiagnosticsJSON = JSON.stringify( payload );
	latestDiagnosticsETagValue = `"${payload.runId}-${Buffer.byteLength( latestDiagnosticsJSON )}"`;
}

function updateLatestDiagnosticsJSON() {
	if( !latestDiagnosticsPayloadValue ) {
		latestDiagnosticsJSON = '';
		latestDiagnosticsETagValue = null;
		return;
	}
	latestDiagnosticsJSON = JSON.stringify( latestDiagnosticsPayloadValue );
	latestDiagnosticsETagValue = `"${latestDiagnosticsPayloadValue.runId}-${Buffer.byteLength( latestDiagnosticsJSON )}-${Date.now()}"`;
}

function attachMetatileCuttingSequences( levels ) {
	if( !latestDiagnosticsPayloadValue || latestDiagnosticsPayloadValue.available === false ) {
		return { available: false, error: 'No diagnostics are available.' };
	}
	const metatileSequences = buildMetatileCuttingSequenceDiagnostics( levels );
	latestDiagnosticsPayloadValue.symbolic = latestDiagnosticsPayloadValue.symbolic || {};
	latestDiagnosticsPayloadValue.symbolic.metatileSequences = metatileSequences;
	updateLatestDiagnosticsJSON();
	return metatileSequences;
}

function saveLatestDiagnosticsToFolder() {
	if( !latestDiagnosticsPayloadValue || latestDiagnosticsPayloadValue.available === false ) {
		return { available: false, saved: false, error: 'No diagnostics are available to save.' };
	}
	const savedPayload = Object.assign( {}, latestDiagnosticsPayloadValue, { saved: true } );
	const fileName = saveDiagnosticsPayload( savedPayload );
	latestDiagnosticsPayloadValue = savedPayload;
	latestDiagnosticsJSON = JSON.stringify( savedPayload );
	latestDiagnosticsETagValue = `"${savedPayload.runId}-${Buffer.byteLength( latestDiagnosticsJSON )}-saved"`;
	return {
		available: true,
		saved: true,
		fileName,
		runId: savedPayload.runId
	};
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
	setLatestDiagnosticsPayload( buildDiagnosticsPayload( req, specs, results ), { req, specs, results } );
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

function sendJSON( res, status, value, options ) {
	options = options || {};
	const start = Date.now();
	const json = JSON.stringify( value );
	const bytes = Buffer.byteLength( json );
	if( !options.quiet ) {
		logTiming( `[http] JSON ${status} ${formatBytes( bytes )}`, start );
	}
	res.writeHead( status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': bytes,
		'Cache-Control': options.cacheControl || 'no-store',
		...(options.etag ? { 'ETag': options.etag } : {}),
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
	} );
	res.end( json );
}

function sendOptions( res ) {
	res.writeHead( 204, {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
	} );
	res.end();
}

function sendLatestDiagnostics( req, res ) {
	if( latestDiagnosticsETagValue && req.headers['if-none-match'] === latestDiagnosticsETagValue ) {
		res.writeHead( 304, {
			'Cache-Control': 'no-cache',
			'ETag': latestDiagnosticsETagValue,
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
		} );
		res.end();
		return;
	}
	if( !latestDiagnosticsPayloadValue ) {
		sendJSON( res, 200, { available: false }, { quiet: true, cacheControl: 'no-cache' } );
		return;
	}
	const start = Date.now();
	const data = Buffer.from( latestDiagnosticsJSON, 'utf8' );
	logTiming( `[http] diagnostics latest 200 ${formatBytes( data.length )}`, start );
	res.writeHead( 200, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': data.length,
		'Cache-Control': 'no-cache',
		'ETag': latestDiagnosticsETagValue,
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
	} );
	res.end( data );
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
		const url = new URL( req.url, `http://${HOST}:${PORT}` );
		if( req.method === 'OPTIONS' ) {
			sendOptions( res );
			return;
		}
		if( req.method === 'GET' && url.pathname === '/api/diagnostics/latest' ) {
			sendLatestDiagnostics( req, res );
			return;
		}
		if( req.method === 'POST' && url.pathname === '/api/diagnostics/save-latest' ) {
			console.log( `[http] POST ${url.pathname}` );
			sendJSON( res, 200, saveLatestDiagnosticsToFolder() );
			return;
		}
		if( req.method === 'POST' && url.pathname === '/api/diagnostics/metatile-sequence' ) {
			console.log( `[http] POST ${url.pathname}` );
			const body = await readBody( req );
			sendJSON( res, 200, attachMetatileCuttingSequences( body.levels || [] ) );
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
