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
let latestMetatileAnalysisCache = null;

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

function dot2( a, b ) {
	return a.x * b.x + a.y * b.y;
}

function pointLerp( a, b, t ) {
	return {
		x: a.x + (b.x - a.x) * t,
		y: a.y + (b.y - a.y) * t
	};
}

function pointBounds( points, eps ) {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for( const point of points ) {
		minX = Math.min( minX, point.x );
		minY = Math.min( minY, point.y );
		maxX = Math.max( maxX, point.x );
		maxY = Math.max( maxY, point.y );
	}
	return {
		minX: minX - eps,
		minY: minY - eps,
		maxX: maxX + eps,
		maxY: maxY + eps
	};
}

function boundsOverlap( a, b ) {
	return a.minX <= b.maxX && a.maxX >= b.minX &&
		a.minY <= b.maxY && a.maxY >= b.minY;
}

function spatialCellKey( ix, iy ) {
	return `${ix}:${iy}`;
}

function addToSpatialBuckets( buckets, bounds, cellSize, value ) {
	const minCellX = Math.floor( bounds.minX / cellSize );
	const minCellY = Math.floor( bounds.minY / cellSize );
	const maxCellX = Math.floor( bounds.maxX / cellSize );
	const maxCellY = Math.floor( bounds.maxY / cellSize );
	for( let ix = minCellX; ix <= maxCellX; ++ix ) {
		for( let iy = minCellY; iy <= maxCellY; ++iy ) {
			const key = spatialCellKey( ix, iy );
			if( !buckets.has( key ) ) {
				buckets.set( key, [] );
			}
			buckets.get( key ).push( value );
		}
	}
}

function spatialCandidatesForBounds( index, bounds ) {
	if( !index || !index.buckets || !(index.cellSize > 0) ) {
		return [];
	}
	const seen = new Set();
	const result = [];
	const minCellX = Math.floor( bounds.minX / index.cellSize );
	const minCellY = Math.floor( bounds.minY / index.cellSize );
	const maxCellX = Math.floor( bounds.maxX / index.cellSize );
	const maxCellY = Math.floor( bounds.maxY / index.cellSize );
	for( let ix = minCellX; ix <= maxCellX; ++ix ) {
		for( let iy = minCellY; iy <= maxCellY; ++iy ) {
			const values = index.buckets.get( spatialCellKey( ix, iy ) ) || [];
			for( const value of values ) {
				if( seen.has( value ) ) {
					continue;
				}
				seen.add( value );
				result.push( value );
			}
		}
	}
	return result;
}

function spatialCandidatesForPoint( index, point ) {
	if( !index || !index.buckets || !(index.cellSize > 0) ) {
		return [];
	}
	return index.buckets.get(
		spatialCellKey(
			Math.floor( point.x / index.cellSize ),
			Math.floor( point.y / index.cellSize ) ) ) || [];
}

function pointInPolygon( p, poly, eps ) {
	let inside = false;
	for( let i = 0, j = poly.length - 1; i < poly.length; j = i++ ) {
		const a = poly[i];
		const b = poly[j];
		const ab = pointSub( b, a );
		const ap = pointSub( p, a );
		const onLine = Math.abs( cross2( ab, ap ) ) <= eps &&
			dot2( ap, pointSub( p, b ) ) <= eps;
		if( onLine ) {
			return true;
		}
		const intersectRay = ((a.y > p.y) !== (b.y > p.y)) &&
			(p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x);
		if( intersectRay ) {
			inside = !inside;
		}
	}
	return inside;
}

function roundedPointKey( point, eps ) {
	return `${Math.round( point.x / eps )}:${Math.round( point.y / eps )}`;
}

function canonicalUndirectedEdgeKey( a, b, eps ) {
	const ak = roundedPointKey( a, eps );
	const bk = roundedPointKey( b, eps );
	return ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`;
}

function sameUndirectedEdge( e1, e2, eps ) {
	return (pointDistance( e1.a, e2.a ) <= eps && pointDistance( e1.b, e2.b ) <= eps) ||
		(pointDistance( e1.a, e2.b ) <= eps && pointDistance( e1.b, e2.a ) <= eps);
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

function buildVertexClearanceSeries( results, options ) {
	options = options || {};
	const sorted = options.sorted === true;
	return results.map( (result, idx) => {
		const crossings = result && Array.isArray( result.crossings ) ? result.crossings : [];
		const values = [];
		let skippedMissingEdgeCount = 0;
		for( let crossingIdx = 0; crossingIdx < crossings.length; ++crossingIdx ) {
			const crossing = crossings[crossingIdx];
			const tile = result.tiling && crossing ? result.tiling.tiles[crossing.fromTileId] : null;
			const edge = tile && crossing.edgeIndex != null ? tile.edges[crossing.edgeIndex] : null;
			if( !edge || !edge.a || !edge.b || !crossing.point ) {
				skippedMissingEdgeCount += 1;
				continue;
			}
			const distance = Math.min(
				pointDistance( crossing.point, edge.a ),
				pointDistance( crossing.point, edge.b )
			);
			if( Number.isFinite( distance ) ) {
				values.push( {
					bounce: crossingIdx + 1,
					distance
				} );
			} else {
				skippedMissingEdgeCount += 1;
			}
		}
		const samples = sorted ?
			values
				.map( item => item.distance )
				.sort( (a, b) => b - a )
				.map( (distance, rank) => ( {
					bounce: rank,
					distance
				} ) ) :
			values;
		return {
			id: result.color || `trajectory-${idx + 1}`,
			color: result.color || (idx === 1 ? 'blue' : 'red'),
			label: result.color || `Trajectory ${idx + 1}`,
			status: result.status,
			crossingCount: crossings.length,
			sampleCount: samples.length,
			skippedMissingEdgeCount,
			lastBounce: samples.length > 0 ? samples[samples.length - 1].bounce : null,
			lastRank: samples.length > 0 ? samples.length - 1 : null,
			settings: {
				startEdge: result.requestedStartEdge,
				edgeParameter: result.requestedEdgeParameter,
				angleDegrees: result.requestedAngleDegrees
			},
			samples
		};
	} );
}

function buildSortedVertexClearanceGraphDiagnostics( results ) {
	if( !Array.isArray( results ) || results.length === 0 ) {
		return {
			id: 'sorted-crossing-vertex-clearance',
			type: 'sorted-crossing-vertex-clearance',
			available: false,
			reason: 'requires at least one trajectory'
		};
	}
	return {
		id: 'sorted-crossing-vertex-clearance',
		type: 'sorted-crossing-vertex-clearance',
		available: true,
		xAxis: 'sorted crossing rank',
		yAxis: 'minimum distance to side vertex',
		series: buildVertexClearanceSeries( results, { sorted: true } )
	};
}

function buildUnsortedVertexClearanceGraphDiagnostics( results ) {
	if( !Array.isArray( results ) || results.length === 0 ) {
		return {
			id: 'crossing-vertex-clearance',
			type: 'crossing-vertex-clearance',
			available: false,
			reason: 'requires at least one trajectory'
		};
	}
	return {
		id: 'crossing-vertex-clearance',
		type: 'crossing-vertex-clearance',
		available: true,
		xAxis: 'bounce index',
		yAxis: 'minimum distance to side vertex',
		series: buildVertexClearanceSeries( results, { sorted: false } )
	};
}

class SuffixAutomaton {
	constructor() {
		this.states = [{ len: 0, link: -1, next: new Map() }];
		this.last = 0;
	}

	extend( token ) {
		const cur = this.states.length;
		this.states.push( { len: this.states[this.last].len + 1, link: 0, next: new Map() } );
		let p = this.last;
		while( p !== -1 && !this.states[p].next.has( token ) ) {
			this.states[p].next.set( token, cur );
			p = this.states[p].link;
		}
		if( p === -1 ) {
			this.states[cur].link = 0;
		} else {
			const q = this.states[p].next.get( token );
			if( this.states[p].len + 1 === this.states[q].len ) {
				this.states[cur].link = q;
			} else {
				const clone = this.states.length;
				this.states.push( {
					len: this.states[p].len + 1,
					link: this.states[q].link,
					next: new Map( this.states[q].next )
				} );
				while( p !== -1 && this.states[p].next.get( token ) === q ) {
					this.states[p].next.set( token, clone );
					p = this.states[p].link;
				}
				this.states[q].link = clone;
				this.states[cur].link = clone;
			}
		}
		this.last = cur;
	}
}

function languageComplexityDiagnostics( tokens, bounceCount ) {
	const maxN = Math.max( 0, Math.floor( bounceCount == null ? tokens.length : bounceCount ) );
	const automaton = new SuffixAutomaton();
	for( const token of tokens ) {
		automaton.extend( token );
	}
	const diff = new Int32Array( maxN + 2 );
	for( let idx = 1; idx < automaton.states.length; ++idx ) {
		const state = automaton.states[idx];
		const parent = automaton.states[state.link];
		const lo = parent.len + 1;
		const hi = Math.min( state.len, maxN );
		if( lo <= hi ) {
			diff[lo] += 1;
			diff[hi + 1] -= 1;
		}
	}
	const samples = [];
	let running = 0;
	let peakN = null;
	let peakValue = 0;
	for( let n = 1; n <= maxN; ++n ) {
		running += diff[n];
		samples.push( { n, uniqueSubstringCount: running } );
		if( running > peakValue ) {
			peakN = n;
			peakValue = running;
		}
	}
	return {
		bounceCount: maxN,
		tokenCount: tokens.length,
		sampleCount: samples.length,
		peakN,
		peakValue,
		samples
	};
}

function hatVisitStats( result ) {
	const visitedHatCount = Array.isArray( result.focusTileIds ) ?
		new Set( result.focusTileIds.filter( id => id != null ) ).size : 0;
	const bounceCount = result.crossings && Array.isArray( result.crossings ) ?
		result.crossings.length : 0;
	return {
		visitedHatCount,
		bounceCount,
		hatsPerBounce: bounceCount > 0 ? visitedHatCount / bounceCount : null
	};
}

function buildHatCuttingSequenceDiagnostics( results ) {
	return (results || []).map( (result, idx) => {
		const entries = (result.crossings || []).map( (crossing, crossingIdx) => ( {
			bounce: crossingIdx + 1,
			symbol: `${crossing.edgeIndex}->${crossing.nextEdgeIndex == null ? '?' : crossing.nextEdgeIndex}`,
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
			hatVisitStats: hatVisitStats( result ),
			languageComplexity: languageComplexityDiagnostics(
				entries.map( entry => entry.symbol ),
				entries.length ),
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

function buildMetatileAnalysisForLevel( tiling, metatileLevel ) {
	const outlines = metatileOutlinesForLevel( tiling, metatileLevel );
	const tol = tiling && tiling.tolerances ? tiling.tolerances : ctx.HatBilliards.tolerances();
	const eps = tol.EPS * 1000;
	const keyEps = tol.EPS * 100;
	const cellSize = Math.max( tol.edgeLength || 1, eps * 100 );
	const boundaryEdges = [];
	const edgeBuckets = new Map();
	const polygonBuckets = new Map();
	const sharedEdgeBuckets = new Map();

	for( const outline of outlines ) {
		outline.bounds = pointBounds( outline.polygon, eps );
		addToSpatialBuckets( polygonBuckets, outline.bounds, cellSize, outline.id );
		for( const edge of outline.edges ) {
			const record = {
				id: boundaryEdges.length,
				metatileId: outline.id,
				label: outline.label,
				sideIndex: edge.index,
				a: edge.a,
				b: edge.b,
				bounds: pointBounds( [edge.a, edge.b], eps )
			};
			boundaryEdges.push( record );
			addToSpatialBuckets( edgeBuckets, record.bounds, cellSize, record.id );
			const key = canonicalUndirectedEdgeKey( record.a, record.b, keyEps );
			if( !sharedEdgeBuckets.has( key ) ) {
				sharedEdgeBuckets.set( key, [] );
			}
			sharedEdgeBuckets.get( key ).push( record.id );
		}
	}

	const adjacency = new Map();
	for( const bucket of sharedEdgeBuckets.values() ) {
		for( let i = 0; i < bucket.length; ++i ) {
			const a = boundaryEdges[bucket[i]];
			for( let j = i + 1; j < bucket.length; ++j ) {
				const b = boundaryEdges[bucket[j]];
				if( a.metatileId === b.metatileId || !sameUndirectedEdge( a, b, keyEps ) ) {
					continue;
				}
				adjacency.set( `${a.metatileId}:${a.sideIndex}`, {
					metatileId: b.metatileId,
					sideIndex: b.sideIndex
				} );
				adjacency.set( `${b.metatileId}:${b.sideIndex}`, {
					metatileId: a.metatileId,
					sideIndex: a.sideIndex
				} );
			}
		}
	}

	for( const ids of edgeBuckets.values() ) {
		ids.sort( (a, b) => a - b );
	}
	for( const ids of polygonBuckets.values() ) {
		ids.sort( (a, b) => a - b );
	}

	return {
		metatileLevel,
		outlines,
		boundaryEdges,
		adjacency,
		eps,
		cellSize,
		edgeIndex: { cellSize, buckets: edgeBuckets },
		polygonIndex: { cellSize, buckets: polygonBuckets }
	};
}

function latestMetatileCacheForSource() {
	if( !latestDiagnosticsSourceValue ) {
		return null;
	}
	if( !latestMetatileAnalysisCache ||
		latestMetatileAnalysisCache.source !== latestDiagnosticsSourceValue ) {
		latestMetatileAnalysisCache = {
			source: latestDiagnosticsSourceValue,
			levels: new Map(),
			sequences: new Map()
		};
	}
	return latestMetatileAnalysisCache;
}

function metatileAnalysisForLevel( level ) {
	const cache = latestMetatileCacheForSource();
	if( !cache ) {
		return null;
	}
	if( !cache.levels.has( level ) ) {
		const tiling = latestDiagnosticsSourceValue.results[0].tiling;
		cache.levels.set( level, buildMetatileAnalysisForLevel( tiling, level ) );
	}
	return cache.levels.get( level );
}

const FIGURE_4_1_EXPECTED_CLUSTER_HATS = { T: 1, H: 4, P: 2, F: 2 };

function vCoord( x, y ) {
	return { x: Math.sqrt( 0.75 ) * x, y: 0.5 * x + y };
}

function labelledSegment( label, ax, ay, bx, by ) {
	return { label, a: vCoord( ax, ay ), b: vCoord( bx, by ) };
}

const FIGURE_4_1_CANONICAL_OUTLINES = {
	T: [[0, 0], [3, 0], [0, 3]].map( point => vCoord( point[0], point[1] ) ),
	H: [[0, 0], [1, -1], [5, -1], [5, 0], [1, 4], [0, 4]]
		.map( point => vCoord( point[0], point[1] ) ),
	P: [[0, 0], [2, -2], [6, -2], [4, 0]].map( point => vCoord( point[0], point[1] ) ),
	F: [[0, 0], [2, -2], [5, -2], [5, -1], [4, 0]].map( point => vCoord( point[0], point[1] ) )
};

const FIGURE_4_1_LABELLED_SEGMENTS = {
	T: [
		labelledSegment( 'A-', 0, 0, 3, 0 ),
		labelledSegment( 'A-', 3, 0, 0, 3 ),
		labelledSegment( 'B+', 0, 3, 0, 0 )
	],
	H: [
		labelledSegment( 'X+', 0, 0, 1, -1 ),
		labelledSegment( 'B-', 1, -1, 4, -1 ),
		labelledSegment( 'X-', 4, -1, 5, -1 ),
		labelledSegment( 'X+', 5, -1, 5, 0 ),
		labelledSegment( 'B-', 5, 0, 2, 3 ),
		labelledSegment( 'X-', 2, 3, 1, 4 ),
		labelledSegment( 'X+', 1, 4, 0, 4 ),
		labelledSegment( 'A+', 0, 4, 0, 1 ),
		labelledSegment( 'X-', 0, 1, 0, 0 )
	],
	P: [
		labelledSegment( 'L', 0, 0, 1, -1 ),
		labelledSegment( 'X-', 1, -1, 2, -2 ),
		labelledSegment( 'X+', 2, -2, 3, -2 ),
		labelledSegment( 'A-', 3, -2, 6, -2 ),
		labelledSegment( 'L', 6, -2, 5, -1 ),
		labelledSegment( 'X-', 5, -1, 4, 0 ),
		labelledSegment( 'X+', 4, 0, 3, 0 ),
		labelledSegment( 'B+', 3, 0, 0, 0 )
	],
	F: [
		labelledSegment( 'L', 0, 0, 1, -1 ),
		labelledSegment( 'X-', 1, -1, 2, -2 ),
		labelledSegment( 'X+', 2, -2, 3, -2 ),
		labelledSegment( 'L', 3, -2, 4, -2 ),
		labelledSegment( 'X-', 4, -2, 5, -2 ),
		labelledSegment( 'F+', 5, -2, 5, -1 ),
		labelledSegment( 'F-', 5, -1, 4, 0 ),
		labelledSegment( 'X+', 4, 0, 3, 0 ),
		labelledSegment( 'B+', 3, 0, 0, 0 )
	]
};

const FIGURE_4_1_PREFERRED_ALIGNMENT = {
	T: { reversed: false, offset: 0 },
	H: { reversed: false, offset: 3 },
	P: { reversed: false, offset: 1 },
	F: { reversed: false, offset: 1 }
};

function isLeafHat( geom ) {
	return !geom || !geom.children;
}

function isL1ClusterGeom( geom ) {
	return !!(geom && geom.children && geom.children.length > 0 &&
		geom.children.every( child => isLeafHat( child.geom ) ));
}

function affineFromThreePoints( from, to ) {
	const p0 = from[0];
	const p1 = from[1];
	const p2 = from[2];
	const q0 = to[0];
	const q1 = to[1];
	const q2 = to[2];
	const ux = p1.x - p0.x;
	const uy = p1.y - p0.y;
	const vx = p2.x - p0.x;
	const vy = p2.y - p0.y;
	const Ux = q1.x - q0.x;
	const Uy = q1.y - q0.y;
	const Vx = q2.x - q0.x;
	const Vy = q2.y - q0.y;
	const det = ux * vy - vx * uy;
	if( Math.abs( det ) <= 1e-12 ) {
		return null;
	}
	const a = (Ux * vy - Vx * uy) / det;
	const b = (Vx * ux - Ux * vx) / det;
	const d = (Uy * vy - Vy * uy) / det;
	const e = (Vy * ux - Uy * vx) / det;
	const c = q0.x - a * p0.x - b * p0.y;
	const f = q0.y - d * p0.x - e * p0.y;
	return [a, b, c, d, e, f];
}

function affineError( T, from, to ) {
	let error = 0;
	for( let idx = 0; idx < from.length; ++idx ) {
		error = Math.max( error, pointDistance( ctx.transPt( T, from[idx] ), to[idx] ) );
	}
	return error;
}

function canonicalToWorldTransform( clusterLabel, polygon ) {
	const canonical = FIGURE_4_1_CANONICAL_OUTLINES[clusterLabel];
	if( !canonical || canonical.length !== polygon.length ) {
		return null;
	}
	const candidates = [];
	for( const reversed of [false, true] ) {
		for( let offset = 0; offset < canonical.length; ++offset ) {
			const ordered = canonical.map( (_, idx) => {
				const sourceIdx = reversed ?
					(offset - idx + canonical.length) % canonical.length :
					(offset + idx) % canonical.length;
				return canonical[sourceIdx];
			} );
			const T = affineFromThreePoints( ordered.slice( 0, 3 ), polygon.slice( 0, 3 ) );
			if( T ) {
				candidates.push( {
					T,
					reversed,
					offset,
					error: affineError( T, ordered, polygon )
				} );
			}
		}
	}
	const preferred = FIGURE_4_1_PREFERRED_ALIGNMENT[clusterLabel];
	if( preferred ) {
		const candidate = candidates.find( item =>
			item.error <= 1e-8 &&
			item.reversed === preferred.reversed &&
			item.offset === preferred.offset );
		if( candidate ) {
			return candidate.T;
		}
	}
	candidates.sort( (a, b) => a.error - b.error );
	return candidates.length > 0 ? candidates[0].T : null;
}

function nearestLabelledSegment( clusterLabel, canonicalEdge, eps ) {
	let best = null;
	const edgeVector = pointSub( canonicalEdge.b, canonicalEdge.a );
	const edgeLength = pointDistance( canonicalEdge.a, canonicalEdge.b );
	const midpoint = pointScale( pointAdd( canonicalEdge.a, canonicalEdge.b ), 0.5 );
	for( const segment of FIGURE_4_1_LABELLED_SEGMENTS[clusterLabel] || [] ) {
		const sideVector = pointSub( segment.b, segment.a );
		const sideLength = pointDistance( segment.a, segment.b );
		if( !(sideLength > 0) || !(edgeLength > 0) ) {
			continue;
		}
		const sideDot = Math.abs( dot2( sideVector, edgeVector ) / (sideLength * edgeLength) );
		if( sideDot <= eps ) {
			continue;
		}
		const offset = pointSub( midpoint, segment.a );
		const distance = Math.abs( cross2( sideVector, offset ) ) / sideLength;
		const t = dot2( offset, sideVector ) / (sideLength * sideLength);
		const score = distance + Math.max( 0, -t, t - 1 ) * sideLength;
		if( !best || score < best.score ) {
			best = {
				label: segment.label,
				t,
				distance,
				score
			};
		}
	}
	return best;
}

function extractL1Clusters( tiling ) {
	const clusters = [];
	const clusterOfHat = new Map();
	let nextHatId = 0;

	function traverse( geom, T, activeCluster ) {
		if( isLeafHat( geom ) ) {
			const tileId = nextHatId++;
			if( activeCluster ) {
				activeCluster.hatIds.push( tileId );
				clusterOfHat.set( tileId, activeCluster.id );
			}
			return;
		}
		if( isL1ClusterGeom( geom ) ) {
			const cluster = {
				id: clusters.length,
				label: inferMetatileLabel( geom ),
				hatIds: [],
				polygon: transformedShape( geom.shape, T )
			};
			clusters.push( cluster );
			for( const child of geom.children ) {
				traverse( child.geom, ctx.mul( T, child.T ), cluster );
			}
			return;
		}
		for( const child of geom.children || [] ) {
			traverse( child.geom, ctx.mul( T, child.T ), activeCluster );
		}
	}

	traverse( tiling.root, tiling.rootTransform || ctx.ident, null );
	const validation = {
		ok: true,
		hatCount: tiling.tiles.length,
		assignedHatCount: clusterOfHat.size,
		clusterCount: clusters.length,
		errors: []
	};
	if( nextHatId !== tiling.tiles.length || clusterOfHat.size !== tiling.tiles.length ) {
		validation.ok = false;
		validation.errors.push(
			`assigned ${clusterOfHat.size} of ${tiling.tiles.length} hats while traversing ${nextHatId}` );
	}
	for( const cluster of clusters ) {
		const expected = FIGURE_4_1_EXPECTED_CLUSTER_HATS[cluster.label];
		if( expected != null && cluster.hatIds.length !== expected ) {
			validation.ok = false;
			validation.errors.push(
				`cluster ${cluster.id} ${cluster.label} has ${cluster.hatIds.length} hats; expected ${expected}` );
		}
	}
	return { clusters, clusterOfHat, validation };
}

function buildL1ClusterAnalysis( tiling ) {
	const extracted = extractL1Clusters( tiling );
	const tol = tiling && tiling.tolerances ? tiling.tolerances : ctx.HatBilliards.tolerances();
	const eps = tol.EPS * 1000;
	const sideByHatEdge = new Map();
	const validation = Object.assign( { sideMappedEdgeCount: 0 }, extracted.validation );

	for( const cluster of extracted.clusters ) {
		const members = new Set( cluster.hatIds );
		const canonicalToWorld = canonicalToWorldTransform( cluster.label, cluster.polygon );
		const worldToCanonical = canonicalToWorld ? ctx.inv( canonicalToWorld ) : null;
		if( !worldToCanonical ) {
			validation.ok = false;
			validation.errors.push( `could not align cluster ${cluster.id} ${cluster.label} to Figure 4.1 coordinates` );
			continue;
		}
		for( const tileId of cluster.hatIds ) {
			const tile = tiling.tiles[tileId];
			if( !tile ) {
				validation.ok = false;
				validation.errors.push( `cluster ${cluster.id} references missing hat ${tileId}` );
				continue;
			}
			for( const edge of tile.edges ) {
				const link = tile.adjacent[edge.index];
				if( link && members.has( link.tileId ) ) {
					continue;
				}
				const canonicalEdge = {
					a: ctx.transPt( worldToCanonical, edge.a ),
					b: ctx.transPt( worldToCanonical, edge.b )
				};
				const side = nearestLabelledSegment( cluster.label, canonicalEdge, 1e-6 );
				if( !side || !side.label ) {
					validation.ok = false;
					validation.errors.push(
						`unmapped boundary edge ${tileId}:${edge.index} in cluster ${cluster.id} ${cluster.label}` );
					continue;
				}
				sideByHatEdge.set( `${tileId}:${edge.index}`, {
					clusterId: cluster.id,
					clusterLabel: cluster.label,
					sideLabel: side.label,
					t: side.t
				} );
				validation.sideMappedEdgeCount += 1;
			}
		}
	}

	return {
		type: 'figure-4-1-l1-clusters',
		metatileLevel: 1,
		clusters: extracted.clusters,
		clusterOfHat: extracted.clusterOfHat,
		sideByHatEdge,
		validation
	};
}

function l1ClusterAnalysis() {
	const cache = latestMetatileCacheForSource();
	if( !cache ) {
		return null;
	}
	if( !cache.l1ClusterAnalysis ) {
		const tiling = latestDiagnosticsSourceValue.results[0].tiling;
		cache.l1ClusterAnalysis = buildL1ClusterAnalysis( tiling );
	}
	return cache.l1ClusterAnalysis;
}

function segmentIntersection( p, q, a, b, eps, tEps ) {
	const r = pointSub( q, p );
	const s = pointSub( b, a );
	const denom = cross2( r, s );
	if( Math.abs( denom ) <= eps ) {
		return null;
	}
	const ap = pointSub( a, p );
	const t = cross2( ap, s ) / denom;
	const u = cross2( ap, r ) / denom;
	const paramEps = tEps == null ? eps : tEps;
	if( t < -paramEps || t > 1 + paramEps || u < -paramEps || u > 1 + paramEps ) {
		return null;
	}
	const clampedT = Math.max( 0, Math.min( 1, t ) );
	const clampedU = Math.max( 0, Math.min( 1, u ) );
	return {
		t: clampedT,
		u: clampedU,
		point: pointAdd( p, pointScale( r, clampedT ) )
	};
}

function candidateFromBoundaryEdge( edge ) {
	return {
		metatileId: edge.metatileId,
		metatileLabel: edge.label,
		label: edge.label,
		sideIndex: edge.sideIndex
	};
}

function sortCandidates( candidates ) {
	candidates.sort( (a, b) =>
		a.metatileId - b.metatileId ||
		a.sideIndex - b.sideIndex ||
		String( a.label || a.metatileLabel ).localeCompare( String( b.label || b.metatileLabel ) ) );
	return candidates;
}

function uniqueCandidates( candidates ) {
	const seen = new Set();
	const result = [];
	for( const candidate of sortCandidates( candidates ) ) {
		const key = `${candidate.metatileId}:${candidate.sideIndex}`;
		if( seen.has( key ) ) {
			continue;
		}
		seen.add( key );
		result.push( candidate );
	}
	return result;
}

function locateMetatileContaining( analysis, point, preferredId ) {
	const eps = analysis.eps;
	const preferred = analysis.outlines[preferredId];
	if( preferred && boundsOverlap( preferred.bounds, pointBounds( [point], eps ) ) &&
		pointInPolygon( point, preferred.polygon, eps ) ) {
		return preferred;
	}
	const candidates = spatialCandidatesForPoint( analysis.polygonIndex, point );
	for( const id of candidates ) {
		const outline = analysis.outlines[id];
		if( outline && pointInPolygon( point, outline.polygon, eps ) ) {
			return outline;
		}
	}
	for( const outline of analysis.outlines ) {
		if( pointInPolygon( point, outline.polygon, eps ) ) {
			return outline;
		}
	}
	return null;
}

function sideIndexForTransition( candidates, metatileId ) {
	const candidate = candidates.find( item => item.metatileId === metatileId );
	return candidate ? candidate.sideIndex : null;
}

function transitionToken( entry ) {
	if( entry.kind === 'continuity-gap' ) {
		const from = entry.fromExpectedLabel || '?';
		const to = entry.toObservedLabel || '?';
		return `!gap:${from}->${to}`;
	}
	const from = entry.fromMetatileId == null || entry.fromSideIndex == null ?
		'?' : `${entry.fromLabel}${entry.fromSideIndex}`;
	const to = entry.toMetatileId == null || entry.toSideIndex == null ?
		'?' : `${entry.toLabel}${entry.toSideIndex}`;
	return `${from}->${to}`;
}

function buildPathSegments( points, eps ) {
	const segments = [];
	let pathStart = 0;
	for( let idx = 1; idx < points.length; ++idx ) {
		const p = points[idx - 1];
		const q = points[idx];
		const length = pointDistance( p, q );
		if( !(length > eps) ) {
			continue;
		}
		segments.push( {
			segmentIndex: idx,
			p,
			q,
			length,
			pathStart,
			pathEnd: pathStart + length
		} );
		pathStart += length;
	}
	return segments;
}

function pointAtPathDistance( segments, distance, preferredSegmentIndex ) {
	if( segments.length === 0 ) {
		return null;
	}
	const totalLength = segments[segments.length - 1].pathEnd;
	const target = Math.max( 0, Math.min( totalLength, distance ) );
	let segment = null;
	if( preferredSegmentIndex != null ) {
		segment = segments.find( item =>
			item.segmentIndex === preferredSegmentIndex &&
			target >= item.pathStart &&
			target <= item.pathEnd );
	}
	if( !segment ) {
		segment = segments.find( item =>
			target >= item.pathStart && target <= item.pathEnd );
	}
	if( !segment ) {
		segment = target <= 0 ? segments[0] : segments[segments.length - 1];
	}
	const t = segment.length > 0 ?
		(target - segment.pathStart) / segment.length : 0;
	return pointLerp( segment.p, segment.q, Math.max( 0, Math.min( 1, t ) ) );
}

function groupPathHits( hits, epsDistance ) {
	const groups = [];
	for( const hit of hits ) {
		const group = groups.length > 0 &&
			Math.abs( groups[groups.length - 1].pathOrder - hit.pathOrder ) <= epsDistance ?
			groups[groups.length - 1] : null;
		if( group ) {
			group.hits.push( hit );
			group.pathOrder = group.hits.reduce( (sum, item) => sum + item.pathOrder, 0 ) / group.hits.length;
			group.segmentIndex = Math.min( group.segmentIndex, hit.segmentIndex );
			const representativeHits = group.hits.filter( item => item.segmentIndex === group.segmentIndex );
			group.t = representativeHits.reduce( (sum, item) => sum + item.t, 0 ) / representativeHits.length;
			continue;
		}
		groups.push( {
			t: hit.t,
			pathOrder: hit.pathOrder,
			segmentIndex: hit.segmentIndex,
			point: clonePoint( hit.point ),
			hits: [hit]
		} );
	}
	return groups;
}

function sampleMetatileAroundPathEvent( analysis, segments, group, prevGroup, nextGroup, preferredBeforeId ) {
	if( segments.length === 0 ) {
		return { before: null, after: null };
	}
	const totalLength = segments[segments.length - 1].pathEnd;
	const baseDelta = Math.max( analysis.eps * 20, totalLength * 1e-10, 1e-10 );
	const beforeGap = prevGroup ? group.pathOrder - prevGroup.pathOrder : group.pathOrder;
	const afterGap = nextGroup ? nextGroup.pathOrder - group.pathOrder : totalLength - group.pathOrder;
	const beforeDelta = Math.min( baseDelta, Math.max( 0, beforeGap / 3 ) );
	const afterDelta = Math.min( baseDelta, Math.max( 0, afterGap / 3 ) );
	let before = null;
	let after = null;
	if( group.pathOrder > 0 && beforeDelta > 0 ) {
		const point = pointAtPathDistance( segments, group.pathOrder - beforeDelta, group.segmentIndex );
		before = point ? locateMetatileContaining( analysis, point, preferredBeforeId ) : null;
	}
	if( group.pathOrder < totalLength && afterDelta > 0 ) {
		const point = pointAtPathDistance( segments, group.pathOrder + afterDelta, group.segmentIndex );
		after = point ? locateMetatileContaining( analysis, point, before ? before.id : preferredBeforeId ) : null;
	}
	return { before, after };
}

function continuityGapEntry( expectedId, expectedLabel, observedId, observedLabel, nextEntry ) {
	const entry = {
		kind: 'continuity-gap',
		ambiguous: true,
		bounce: nextEntry.bounce,
		segmentIndex: nextEntry.segmentIndex,
		t: nextEntry.t,
		pathOrder: nextEntry.pathOrder,
		point: clonePoint( nextEntry.point ),
		fromExpectedMetatileId: expectedId,
		fromExpectedLabel: expectedLabel,
		toObservedMetatileId: observedId,
		toObservedLabel: observedLabel
	};
	entry.symbol = transitionToken( entry );
	return entry;
}

function enforceMetatileContinuity( transitions, analysis ) {
	const entries = [];
	let expectedId = null;
	let expectedLabel = null;
	for( const entry of transitions ) {
		if( expectedId != null && entry.fromMetatileId != null && entry.fromMetatileId !== expectedId ) {
			entries.push( continuityGapEntry(
				expectedId,
				expectedLabel || (analysis.outlines[expectedId] && analysis.outlines[expectedId].label) || null,
				entry.fromMetatileId,
				entry.fromLabel,
				entry ) );
		}
		entries.push( entry );
		if( entry.toMetatileId != null ) {
			expectedId = entry.toMetatileId;
			expectedLabel = entry.toLabel;
		}
	}
	return entries;
}

function buildLegacyMetatileSequenceForResult( result, analysis, metatileLevel ) {
	const points = result.points || [];
	const eps = result.tiling && result.tiling.tolerances ?
		result.tiling.tolerances.EPS * 1000 : 1e-7;
	const segments = buildPathSegments( points, eps );
	const allHits = [];
	for( const segment of segments ) {
		const epsT = Math.max( eps / segment.length * 100, 1e-10 );
		const segmentBounds = pointBounds( [segment.p, segment.q], eps );
		const hits = [];
		const edgeIds = spatialCandidatesForBounds( analysis.edgeIndex, segmentBounds );
		for( const edgeId of edgeIds ) {
			const edge = analysis.boundaryEdges[edgeId];
			if( !edge || !boundsOverlap( segmentBounds, edge.bounds ) ) {
				continue;
			}
			const hit = segmentIntersection( segment.p, segment.q, edge.a, edge.b, eps, epsT );
			if( hit ) {
				hits.push( {
					segmentIndex: segment.segmentIndex,
					t: hit.t,
					pathOrder: segment.pathStart + hit.t * segment.length,
					point: hit.point,
					edge
				} );
			}
		}
		hits.sort( (a, b) =>
			a.t - b.t ||
			a.edge.metatileId - b.edge.metatileId ||
			a.edge.sideIndex - b.edge.sideIndex );
		allHits.push( ...hits );
	}
	allHits.sort( (a, b) =>
		a.pathOrder - b.pathOrder ||
		a.segmentIndex - b.segmentIndex ||
		a.t - b.t ||
		a.edge.metatileId - b.edge.metatileId ||
		a.edge.sideIndex - b.edge.sideIndex );
	const groups = groupPathHits( allHits, Math.max( analysis.eps * 20, eps * 20 ) );
	const transitions = [];
	for( let groupIdx = 0; groupIdx < groups.length; ++groupIdx ) {
		const group = groups[groupIdx];
		const prevGroup = groupIdx > 0 ? groups[groupIdx - 1] : null;
		const nextGroup = groupIdx + 1 < groups.length ? groups[groupIdx + 1] : null;
		const samples = sampleMetatileAroundPathEvent(
			analysis,
			segments,
			group,
			prevGroup,
			nextGroup,
			transitions.length > 0 ? transitions[transitions.length - 1].toMetatileId : null );
		const candidates = uniqueCandidates(
			group.hits.map( hit => candidateFromBoundaryEdge( hit.edge ) ) );
		if( samples.before && samples.after && samples.before.id === samples.after.id ) {
			continue;
		}
		const fromSideIndex = samples.before ?
			sideIndexForTransition( candidates, samples.before.id ) : null;
		const toSideIndex = samples.after ?
			sideIndexForTransition( candidates, samples.after.id ) : null;
		transitions.push( {
			kind: 'transition',
			bounce: group.segmentIndex,
			segmentIndex: group.segmentIndex,
			t: group.t,
			pathOrder: group.pathOrder,
			point: clonePoint( group.point ),
			fromMetatileId: samples.before ? samples.before.id : null,
			fromLabel: samples.before ? samples.before.label : null,
			fromSideIndex,
			toMetatileId: samples.after ? samples.after.id : null,
			toLabel: samples.after ? samples.after.label : null,
			toSideIndex,
			candidates,
			ambiguous: !samples.before || !samples.after || fromSideIndex == null || toSideIndex == null
		} );
	}
	for( const entry of transitions ) {
		entry.symbol = transitionToken( entry );
	}
	const entries = enforceMetatileContinuity( transitions, analysis );
	const gapCount = entries.filter( entry => entry.kind === 'continuity-gap' ).length;
	const transitionCount = entries.length - gapCount;
	return {
		id: result.color || 'trajectory',
		color: result.color || 'red',
		label: result.color || 'trajectory',
		type: 'metatile-boundary',
		metatileLevel,
		outlineCount: analysis.outlines.length,
		count: entries.length,
		transitionCount,
		gapCount,
		tokens: entries.map( entry => entry.symbol ),
		entries
	};
}

function clusterTransitionToken( entry ) {
	const from = entry.fromClusterId == null || !entry.fromSideLabel ?
		'?' : `${entry.fromClusterLabel}:${entry.fromSideLabel}`;
	const to = entry.toClusterId == null || !entry.toSideLabel ?
		'?' : `${entry.toClusterLabel}:${entry.toSideLabel}`;
	return `${from}->${to}`;
}

function buildMetatileSequenceForResult( result, analysis ) {
	const entries = [];
	for( const [crossingIdx, crossing] of (result.crossings || []).entries() ) {
		const fromClusterId = analysis.clusterOfHat.get( crossing.fromTileId );
		const toClusterId = crossing.toTileId == null ? null :
			analysis.clusterOfHat.get( crossing.toTileId );
		if( fromClusterId == null || toClusterId == null || fromClusterId === toClusterId ) {
			continue;
		}
		const fromCluster = analysis.clusters[fromClusterId] || null;
		const toCluster = analysis.clusters[toClusterId] || null;
		const fromSide = analysis.sideByHatEdge.get( `${crossing.fromTileId}:${crossing.edgeIndex}` ) || null;
		const toSide = crossing.nextEdgeIndex == null ? null :
			analysis.sideByHatEdge.get( `${crossing.toTileId}:${crossing.nextEdgeIndex}` ) || null;
		const entry = {
			kind: 'cluster-transition',
			bounce: crossingIdx + 1,
			fromTileId: crossing.fromTileId,
			toTileId: crossing.toTileId,
			edgeIndex: crossing.edgeIndex,
			nextEdgeIndex: crossing.nextEdgeIndex == null ? null : crossing.nextEdgeIndex,
			fromClusterId,
			toClusterId,
			fromClusterLabel: fromCluster ? fromCluster.label : null,
			toClusterLabel: toCluster ? toCluster.label : null,
			fromSideLabel: fromSide ? fromSide.sideLabel : null,
			toSideLabel: toSide ? toSide.sideLabel : null,
			point: clonePoint( crossing.point ),
			u: crossing.u,
			ambiguous: !fromSide || !toSide
		};
		entry.symbol = clusterTransitionToken( entry );
		entries.push( entry );
	}
	const ambiguousCount = entries.filter( entry => entry.ambiguous ).length;
	return {
		id: result.color || 'trajectory',
		color: result.color || 'red',
		label: result.color || 'trajectory',
		type: 'metatile-boundary',
		metatileLevel: 1,
		outlineCount: analysis.clusters.length,
		clusterCount: analysis.clusters.length,
		count: entries.length,
		transitionCount: entries.length,
		gapCount: 0,
		ambiguousCount,
		tokens: entries.map( entry => entry.symbol ),
		entries,
		languageComplexity: languageComplexityDiagnostics(
			entries.map( entry => entry.symbol ),
			entries.length )
	};
}

function buildL1MetatileCuttingSequenceDiagnostics() {
	if( !latestDiagnosticsSourceValue || !latestDiagnosticsSourceValue.results || latestDiagnosticsSourceValue.results.length === 0 ) {
		return { available: false, levels: [], error: 'No trajectory diagnostics are available.' };
	}
	const analysis = l1ClusterAnalysis();
	const results = latestDiagnosticsSourceValue.results;
	const payload = {
		level: 1,
		label: 'Figure 4.1 L1 clusters',
		outlineCount: analysis.clusters.length,
		clusterCount: analysis.clusters.length,
		validation: analysis.validation,
		sequences: results.map( result => buildMetatileSequenceForResult( result, analysis ) )
	};
	return {
		available: true,
		maxLevel: 1,
		mode: 'figure-4-1-l1-clusters',
		levels: [payload],
		validation: analysis.validation
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
	const cache = latestMetatileCacheForSource();
	const levelPayloads = requestedLevels.map( level => {
		const sequenceKey = `${level}`;
		if( cache && cache.sequences.has( sequenceKey ) ) {
			return cache.sequences.get( sequenceKey );
		}
		const analysis = metatileAnalysisForLevel( level );
		const payload = {
			level,
			outlineCount: analysis.outlines.length,
			sequences: results.map( result =>
				buildLegacyMetatileSequenceForResult( result, analysis, level ) )
		};
		if( cache ) {
			cache.sequences.set( sequenceKey, payload );
		}
		return {
			level: payload.level,
			outlineCount: payload.outlineCount,
			sequences: payload.sequences
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
				hatVisitStats: hatVisitStats( result ),
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
				maxLevel: 1,
				mode: 'figure-4-1-l1-clusters',
				levels: []
			}
		},
		graphs: [
			buildDistanceGraphDiagnostics( publicResults ),
			buildStartDistanceGraphDiagnostics( publicResults ),
			buildUnsortedVertexClearanceGraphDiagnostics( results ),
			buildSortedVertexClearanceGraphDiagnostics( results )
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
	latestMetatileAnalysisCache = null;
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
	const metatileSequences = buildL1MetatileCuttingSequenceDiagnostics();
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
	const startTileSelection = tilingConfig.startTileId == null ? 'centralTileId' : 'tileId';
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
			startTileSelection,
			startTileId: results[0].startTileId,
			startEdge: specs[0].startEdge,
			edgeParameter: specs[0].edgeParameter,
			angleDegrees: specs[0].angleDegrees,
			maxBounces: specs[0].maxBounces,
			maxExpansionLevel: results[0].level
		},
		trajectories: specs.map( (entry, idx) => ( {
			color: entry.color || (idx === 1 ? 'blue' : 'red'),
			startTileSelection,
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
	const rawStartTileId = body.startTileId == null || body.startTileId === '' ?
		null : Number( body.startTileId );
	const startTileId = Number.isInteger( rawStartTileId ) && rawStartTileId >= 0 ?
		rawStartTileId : null;
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
	return { rootType, level, patchRadius, startTileId, startEdge, edgeParameter, angleDegrees, maxBounces, trajectories };
}

function handleRun( body ) {
	const req = sanitizeRunRequest( body || {} );
	const initialPatchRadius = 0;
	const start = Date.now();
	console.log(
		`[run] ${req.rootType}:${req.level}, bounces=${req.maxBounces}, ` +
		`requestedPatchRadius=${req.patchRadius}, initialPatchRadius=${initialPatchRadius}` );
	const tiling = getTiling( req.rootType, req.level );
	const requestedStartTileIsValid = req.startTileId != null && tiling.tiles[req.startTileId];
	const startTileId = requestedStartTileIsValid ? req.startTileId : tiling.centralTileId;
	req.startTileId = requestedStartTileIsValid ? startTileId : null;
	const trajectoryStart = Date.now();
	const specs = req.trajectories.map( entry => ( {
		color: entry.color,
		startTileId,
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
