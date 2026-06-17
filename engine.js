(function(global) {
	'use strict';

	const ROOT_INDEX = { H: 0, T: 1, P: 2, F: 3 };
	const ROOT_TYPES = Object.keys( ROOT_INDEX );
	const DEFAULT_MAX_EXPANSION_LEVEL = 6;

	function dot( a, b ) { return a.x*b.x + a.y*b.y; }
	function cross( a, b ) { return a.x*b.y - a.y*b.x; }
	function sub( a, b ) { return { x: a.x - b.x, y: a.y - b.y }; }
	function add( a, b ) { return { x: a.x + b.x, y: a.y + b.y }; }
	function scale( a, s ) { return { x: a.x * s, y: a.y * s }; }
	function len( a ) { return Math.hypot( a.x, a.y ); }
	function normalize( a ) {
		const n = len( a );
		if( n === 0 || !Number.isFinite( n ) ) {
			return null;
		}
		return { x: a.x / n, y: a.y / n };
	}
	function distance( a, b ) { return len( sub( a, b ) ); }
	function centroid( poly ) {
		let x = 0;
		let y = 0;
		for( const p of poly ) {
			x += p.x;
			y += p.y;
		}
		return { x: x / poly.length, y: y / poly.length };
	}
	function canonicalEdgeLength() {
		let total = 0;
		for( let i = 0; i < hat_outline.length; ++i ) {
			total += distance( hat_outline[i], hat_outline[(i+1)%hat_outline.length] );
		}
		return total / hat_outline.length;
	}
	function tolerances() {
		const edgeLength = canonicalEdgeLength();
		return {
			edgeLength,
			EPS: 1e-9 * edgeLength,
			VERTEX_EPS: 1e-7 * edgeLength,
			NUDGE_EPS: 1e-8 * edgeLength
		};
	}

	function buildMetatiles( level ) {
		let metatiles = [H_init, T_init, P_init, F_init];
		for( let lev = 1; lev < level; ++lev ) {
			const patch = constructPatch( ...metatiles );
			metatiles = constructMetatiles( patch );
		}
		return metatiles;
	}

	function transformedCentroid( T, poly ) {
		return transPt( T, centroid( poly ) );
	}

	function centeredPatchTransform( patch, rootGeom ) {
		const patchCentroid = centroid( patch.children.map( child =>
			transformedCentroid( child.T, child.geom.shape ) ) );
		let anchor = null;
		let best = Infinity;
		for( const child of patch.children ) {
			if( child.geom !== rootGeom ) {
				continue;
			}
			const d = distance( transformedCentroid( child.T, child.geom.shape ), patchCentroid );
			if( d < best ) {
				best = d;
				anchor = child;
			}
		}
		return anchor ? inv( anchor.T ) : ident;
	}

	function flattenHats( geom, T, out ) {
		if( geom instanceof HatTile ) {
			const polygon = hat_outline.map( p => transPt( T, p ) );
			const tile = {
				id: out.length,
				label: geom.label,
				transform: T.slice(),
				inverseTransform: inv( T ),
				polygon,
				centroid: centroid( polygon ),
				edges: [],
				adjacent: new Array( hat_outline.length ).fill( null )
			};
			for( let i = 0; i < polygon.length; ++i ) {
				tile.edges.push( {
					index: i,
					a: polygon[i],
					b: polygon[(i+1)%polygon.length]
				} );
			}
			out.push( tile );
			return;
		}

		for( const child of geom.children ) {
			flattenHats( child.geom, mul( T, child.T ), out );
		}
	}

	function edgeKey( p, q, eps ) {
		const sx = Math.round( (p.x + q.x) / eps );
		const sy = Math.round( (p.y + q.y) / eps );
		const dx = Math.round( Math.abs( p.x - q.x ) / eps );
		const dy = Math.round( Math.abs( p.y - q.y ) / eps );
		return `${sx}:${sy}:${dx}:${dy}`;
	}

	function sameUndirectedEdge( e1, e2, eps ) {
		return (distance( e1.a, e2.b ) <= eps && distance( e1.b, e2.a ) <= eps) ||
			(distance( e1.a, e2.a ) <= eps && distance( e1.b, e2.b ) <= eps);
	}

	function buildAdjacency( tiles, eps ) {
		const buckets = new Map();
		for( const tile of tiles ) {
			for( const edge of tile.edges ) {
				const key = edgeKey( edge.a, edge.b, eps );
				if( !buckets.has( key ) ) {
					buckets.set( key, [] );
				}
				buckets.get( key ).push( { tile, edge } );
			}
		}

		for( const bucket of buckets.values() ) {
			for( let i = 0; i < bucket.length; ++i ) {
				for( let j = i + 1; j < bucket.length; ++j ) {
					const a = bucket[i];
					const b = bucket[j];
					if( a.tile.id !== b.tile.id && sameUndirectedEdge( a.edge, b.edge, eps ) ) {
						a.tile.adjacent[a.edge.index] = { tileId: b.tile.id, edgeIndex: b.edge.index };
						b.tile.adjacent[b.edge.index] = { tileId: a.tile.id, edgeIndex: a.edge.index };
					}
				}
			}
		}
	}

	function boundaryDepths( tiles ) {
		const depths = new Array( tiles.length ).fill( Infinity );
		let frontier = [];
		for( const tile of tiles ) {
			if( tile.adjacent.some( link => link == null ) ) {
				depths[tile.id] = 0;
				frontier.push( tile.id );
			}
		}
		while( frontier.length > 0 ) {
			const next = [];
			for( const id of frontier ) {
				const depth = depths[id];
				for( const link of tiles[id].adjacent ) {
					if( link && depths[link.tileId] === Infinity ) {
						depths[link.tileId] = depth + 1;
						next.push( link.tileId );
					}
				}
			}
			frontier = next;
		}
		return depths;
	}

	function pointInPolygon( p, poly, eps ) {
		let inside = false;
		for( let i = 0, j = poly.length - 1; i < poly.length; j = i++ ) {
			const a = poly[i];
			const b = poly[j];
			const ab = sub( b, a );
			const ap = sub( p, a );
			const onLine = Math.abs( cross( ab, ap ) ) <= eps && dot( ap, sub( p, b ) ) <= eps;
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

	function buildTiling( config ) {
		const rootType = (config && config.rootType) || 'H';
		const level = Math.max( 1, Math.floor( (config && config.level) || 1 ) );
		if( !ROOT_TYPES.includes( rootType ) ) {
			throw new Error( `Unsupported rootType "${rootType}"` );
		}
		const metatiles = buildMetatiles( level );
		const root = metatiles[ROOT_INDEX[rootType]];
		const useCenteredPatch = !config || config.centeredPatch !== false;
		const geom = useCenteredPatch ? constructPatch( ...metatiles ) : root;
		const rootTransform = useCenteredPatch ? centeredPatchTransform( geom, root ) : ident;
		const tiles = [];
		flattenHats( geom, rootTransform, tiles );
		const tol = tolerances();
		buildAdjacency( tiles, tol.EPS * 100 );
		const rootCentroid = transPt( rootTransform, centroid( root.shape ) );
		const depths = boundaryDepths( tiles );
		let centralTileId = 0;
		let bestDepth = -1;
		let bestDistance = Infinity;
		let rootTileId = 0;
		let rootTileDistance = Infinity;
		for( const tile of tiles ) {
			const d = distance( tile.centroid, rootCentroid );
			if( d < rootTileDistance ) {
				rootTileDistance = d;
				rootTileId = tile.id;
			}
			const depth = depths[tile.id];
			if( depth > bestDepth || (depth === bestDepth && d < bestDistance) ) {
				bestDepth = depth;
				bestDistance = d;
				centralTileId = tile.id;
			}
		}
		return {
			rootType,
			level,
			metatiles,
			root: geom,
			rootTransform,
			centeredPatch: useCenteredPatch,
			tiles,
			centralTileId,
			rootTileId,
			boundaryDepths: depths,
			tolerances: tol,
			config: { rootType, level }
		};
	}

	function makeStartState( tiling, spec ) {
		const t = tiling.tolerances;
		const tileId = spec.startTileId == null ? tiling.centralTileId : spec.startTileId;
		const tile = tiling.tiles[tileId];
		if( !tile ) {
			throw new Error( `Unknown startTileId "${tileId}"` );
		}
		const edgeIndex = Math.max( 0, Math.min( hat_outline.length - 1, Math.floor( spec.startEdge || 0 ) ) );
		const edgeParameter = Math.max( 0, Math.min( 1, spec.edgeParameter == null ? 0.5 : spec.edgeParameter ) );
		const inwardOffset = spec.inwardOffset == null ? 0.05 * t.edgeLength : spec.inwardOffset;
		const angleDegrees = spec.angleDegrees == null ? 30 : spec.angleDegrees;

		const a = hat_outline[edgeIndex];
		const b = hat_outline[(edgeIndex+1)%hat_outline.length];
		const localEdgePoint = add( a, scale( sub( b, a ), edgeParameter ) );
		const localCentroid = centroid( hat_outline );
		const inward = normalize( sub( localCentroid, localEdgePoint ) );
		const localOrigin = add( localEdgePoint, scale( inward, Math.max( inwardOffset, t.NUDGE_EPS ) ) );
		const angle = angleDegrees * Math.PI / 180;
		const worldDir = normalize( { x: Math.cos( angle ), y: Math.sin( angle ) } );
		const worldOrigin = transPt( tile.transform, localOrigin );

		return {
			tileId,
			origin: worldOrigin,
			direction: worldDir,
			startTileId: tileId,
			entryEdgeIndex: null,
			trajectory: [worldOrigin],
			crossings: []
		};
	}

	function nearestEdgeHit( tiling, tile, origin, direction, skipEdgeIndex ) {
		let best = null;
		const eps = tiling.tolerances.EPS;
		for( const edge of tile.edges ) {
			if( edge.index === skipEdgeIndex ) {
				continue;
			}
			const s = sub( edge.b, edge.a );
			const denom = cross( direction, s );
			if( Math.abs( denom ) <= eps ) {
				continue;
			}
			const ao = sub( edge.a, origin );
			const rayT = cross( ao, s ) / denom;
			const u = cross( ao, direction ) / denom;
			if( rayT <= eps || u < -eps || u > 1 + eps ) {
				continue;
			}
			if( best == null || rayT < best.rayT ) {
				best = {
					edgeIndex: edge.index,
					rayT,
					u,
					point: add( origin, scale( direction, rayT ) ),
					edge
				};
			}
		}
		return best;
	}

	function reflectAcrossEdge( direction, edge ) {
		const tangent = normalize( sub( edge.b, edge.a ) );
		const parallel = scale( tangent, dot( direction, tangent ) );
		const perpendicular = sub( direction, parallel );
		// Tiling billiards cross into the neighboring tile. In world coordinates
		// that keeps the normal component and reverses the tangential component.
		return normalize( sub( perpendicular, parallel ) );
	}

	function reflectedAcrossEdgeLine( direction, edge ) {
		const tangent = normalize( sub( edge.b, edge.a ) );
		const parallel = scale( tangent, dot( direction, tangent ) );
		const perpendicular = sub( direction, parallel );
		return normalize( sub( parallel, perpendicular ) );
	}

	function directionEntersTile( tiling, tile, point, direction ) {
		const probeDistance = tiling.tolerances.edgeLength * 1e-6;
		const probe = add( point, scale( direction, probeDistance ) );
		return pointInPolygon( probe, tile.polygon, tiling.tolerances.EPS * 100 );
	}

	function transportDirectionAcrossEdge( tiling, tile, nextTile, hit ) {
		const candidates = [
			reflectAcrossEdge( hit.direction, hit.edge ),
			reflectedAcrossEdgeLine( hit.direction, hit.edge ),
			hit.direction
		].filter( Boolean );
		for( const candidate of candidates ) {
			if( directionEntersTile( tiling, nextTile, hit.point, candidate ) ) {
				return candidate;
			}
		}
		return null;
	}

	function locateTileContaining( tiling, point, preferredId ) {
		const preferred = tiling.tiles[preferredId];
		if( preferred && pointInPolygon( point, preferred.polygon, tiling.tolerances.EPS * 100 ) ) {
			return preferred.id;
		}
		for( const tile of tiling.tiles ) {
			if( pointInPolygon( point, tile.polygon, tiling.tolerances.EPS * 100 ) ) {
				return tile.id;
			}
		}
		return null;
	}

	function nearestEdgeIndexToPoint( tile, point ) {
		let bestIndex = null;
		let bestDistance = Infinity;
		for( const edge of tile.edges ) {
			const ab = sub( edge.b, edge.a );
			const ap = sub( point, edge.a );
			const denom = dot( ab, ab );
			const u = denom === 0 ? 0 : Math.max( 0, Math.min( 1, dot( ap, ab ) / denom ) );
			const q = add( edge.a, scale( ab, u ) );
			const d = distance( point, q );
			if( d < bestDistance ) {
				bestDistance = d;
				bestIndex = edge.index;
			}
		}
		return bestIndex;
	}

	function recoverNeighborAcrossHit( state, tile, hit ) {
		const candidates = [
			reflectAcrossEdge( state.direction, hit.edge ),
			reflectedAcrossEdgeLine( state.direction, hit.edge ),
			state.direction
		].filter( Boolean );
		const probeDistance = state.tiling.tolerances.edgeLength * 1e-6;
		for( const candidate of candidates ) {
			const probe = add( hit.point, scale( candidate, probeDistance ) );
			const tileId = locateTileContaining( state.tiling, probe, null );
			if( tileId != null && tileId !== tile.id ) {
				return {
					tileId,
					edgeIndex: nearestEdgeIndexToPoint( state.tiling.tiles[tileId], hit.point )
				};
			}
		}
		return null;
	}

	function ensureTilingContainsStep( state ) {
		const maxExpansionLevel = state.maxExpansionLevel == null ?
			DEFAULT_MAX_EXPANSION_LEVEL : state.maxExpansionLevel;
		if( state.tiling.level >= maxExpansionLevel ) {
			state.status = 'max-expansion-reached';
			return false;
		}
		const expanded = buildTiling( {
			rootType: state.tiling.rootType,
			level: state.tiling.level + 1
		} );
		const tileId = locateTileContaining( expanded, state.origin, state.tileId );
		if( tileId == null ) {
			state.status = 'escaped-generated-supertile';
			return false;
		}
		state.tiling = expanded;
		state.tileId = tileId;
		state.expansions += 1;
		return true;
	}

	function stepTrajectory( state ) {
		const tile = state.tiling.tiles[state.tileId];
		if( !tile ) {
			state.status = 'numeric-error';
			return false;
		}
		const hit = nearestEdgeHit( state.tiling, tile, state.origin, state.direction, state.entryEdgeIndex );
		if( hit == null || !Number.isFinite( hit.rayT ) ) {
			state.status = 'numeric-error';
			return false;
		}
		hit.direction = state.direction;
		if( hit.u <= state.tiling.tolerances.VERTEX_EPS || 1 - hit.u <= state.tiling.tolerances.VERTEX_EPS ) {
			state.trajectory.push( hit.point );
			state.crossings.push( { fromTileId: tile.id, edgeIndex: hit.edgeIndex, point: hit.point, u: hit.u } );
			state.status = 'vertex-hit';
			return false;
		}
		let link = tile.adjacent[hit.edgeIndex];
		if( link == null ) {
			link = recoverNeighborAcrossHit( state, tile, hit );
			if( link == null ) {
				if( ensureTilingContainsStep( state ) ) {
					return stepTrajectory( state );
				}
				return false;
			}
		}
		const nextTile = state.tiling.tiles[link.tileId];
		const newDir = transportDirectionAcrossEdge( state.tiling, tile, nextTile, hit );
		if( newDir == null ) {
			state.status = 'numeric-error';
			return false;
		}
		state.crossings.push( {
			fromTileId: tile.id,
			toTileId: nextTile.id,
			edgeIndex: hit.edgeIndex,
			nextEdgeIndex: link.edgeIndex,
			point: hit.point,
			u: hit.u
		} );
		state.trajectory.push( hit.point );
		state.origin = hit.point;
		state.direction = newDir;
		state.tileId = nextTile.id;
		state.entryEdgeIndex = link.edgeIndex;
		return true;
	}

	function runTrajectory( tiling, trajectorySpec ) {
		const spec = trajectorySpec || {};
		const maxBounces = Math.max( 0, Math.floor( spec.maxBounces == null ? 100 : spec.maxBounces ) );
		const state = Object.assign( makeStartState( tiling, spec ), {
			tiling,
			status: 'completed',
			maxExpansionLevel: spec.maxExpansionLevel == null ?
				DEFAULT_MAX_EXPANSION_LEVEL : spec.maxExpansionLevel,
			expansions: 0
		} );
		const initialDirection = {
			x: state.direction.x,
			y: state.direction.y
		};
		while( state.crossings.length < maxBounces ) {
			if( !stepTrajectory( state ) ) {
				break;
			}
		}
		if( state.status === 'completed' && state.crossings.length >= maxBounces ) {
			state.status = 'completed';
		}
		return {
			status: state.status,
			rootType: state.tiling.rootType,
			level: state.tiling.level,
			startTileId: state.startTileId,
			currentTileId: state.tileId,
			initialDirection,
			crossings: state.crossings,
			points: state.trajectory,
			expansions: state.expansions,
			tiling: state.tiling
		};
	}

	function runTrajectoryBatch( tilingConfig, trajectorySpecs ) {
		const base = buildTiling( tilingConfig || {} );
		return (trajectorySpecs || []).map( spec => runTrajectory( base, spec ) );
	}

	function bfsPatch( tiling, startTileId, radius ) {
		const seen = new Set( [startTileId] );
		let frontier = [startTileId];
		for( let r = 0; r < radius; ++r ) {
			const next = [];
			for( const id of frontier ) {
				const tile = tiling.tiles[id];
				if( !tile ) {
					continue;
				}
				for( const link of tile.adjacent ) {
					if( link && !seen.has( link.tileId ) ) {
						seen.add( link.tileId );
						next.push( link.tileId );
					}
				}
			}
			frontier = next;
		}
		return [...seen].map( id => tiling.tiles[id] ).filter( Boolean );
	}

	global.HatBilliards = {
		buildTiling,
		runTrajectory,
		runTrajectoryBatch,
		ensureTilingContainsStep,
		bfsPatch,
		locateTileContaining,
		nearestEdgeHit,
		reflectAcrossEdge,
		pointInPolygon,
		tolerances
	};
}( typeof window !== 'undefined' ? window : globalThis ));
