#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function usage() {
	return [
		'Usage: node --max-old-space-size=8192 analyze-single-trajectory-complexity.js INPUT_FILE [options]',
		'',
		'Options:',
		'  --out-prefix PATH       Output path prefix for .tsv and .svg files',
		'  --inflection-window N   Odd smoothing window for inflection detection (default: 41)',
		'  --inflection-sustain N  Number of nonnegative-curvature samples required (default: 5)',
		'  --help                  Show this help'
	].join( '\n' );
}

function parseArgs( argv ) {
	const config = {
		inputFile: null,
		outPrefix: null,
		inflectionWindow: 41,
		inflectionSustain: 5
	};
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
		if( arg === '--out-prefix' ) {
			config.outPrefix = path.resolve( next() );
		} else if( arg === '--inflection-window' ) {
			const value = Number( next() );
			if( !Number.isInteger( value ) || value < 3 || value % 2 === 0 ) {
				throw new Error( '--inflection-window must be an odd integer at least 3' );
			}
			config.inflectionWindow = value;
		} else if( arg === '--inflection-sustain' ) {
			const value = Number( next() );
			if( !Number.isInteger( value ) || value < 1 ) {
				throw new Error( '--inflection-sustain must be a positive integer' );
			}
			config.inflectionSustain = value;
		} else if( arg.startsWith( '-' ) ) {
			throw new Error( `Unknown option: ${arg}` );
		} else if( config.inputFile == null ) {
			config.inputFile = path.resolve( arg );
		} else {
			throw new Error( `Unexpected argument: ${arg}` );
		}
	}
	if( config.inputFile == null ) {
		throw new Error( 'Missing INPUT_FILE' );
	}
	if( config.outPrefix == null ) {
		config.outPrefix = config.inputFile.replace( /(\.[^.\/\\]+)?$/, '.single-trajectory-complexity' );
	}
	return config;
}

function parseTokens( inputFile ) {
	const text = fs.readFileSync( inputFile, 'utf8' ).trim();
	return text.length === 0 ? [] : text.split( /\s+/ );
}

function encodeTokens( tokens ) {
	const idsByToken = new Map();
	const labels = [];
	const encoded = new Int32Array( tokens.length );
	for( let idx = 0; idx < tokens.length; ++idx ) {
		const token = tokens[idx];
		let id = idsByToken.get( token );
		if( id == null ) {
			id = labels.length;
			idsByToken.set( token, id );
			labels.push( token );
		}
		encoded[idx] = id;
	}
	return { encoded, labels };
}

function distinctSubstringCountsByLength( encoded, alphabetSize ) {
	const tokenCount = encoded.length;
	const maxStates = Math.max( 1, tokenCount * 2 );
	const lengths = new Int32Array( maxStates );
	const links = new Int32Array( maxStates );
	links.fill( -1 );
	const transitions = new Int32Array( maxStates * alphabetSize );
	transitions.fill( -1 );
	let stateCount = 1;
	let last = 0;

	for( let idx = 0; idx < encoded.length; ++idx ) {
		const token = encoded[idx];
		const cur = stateCount++;
		lengths[cur] = lengths[last] + 1;
		let p = last;
		while( p !== -1 && transitions[p * alphabetSize + token] === -1 ) {
			transitions[p * alphabetSize + token] = cur;
			p = links[p];
		}
		if( p === -1 ) {
			links[cur] = 0;
		} else {
			const q = transitions[p * alphabetSize + token];
			if( lengths[p] + 1 === lengths[q] ) {
				links[cur] = q;
			} else {
				const clone = stateCount++;
				lengths[clone] = lengths[p] + 1;
				links[clone] = links[q];
				transitions.copyWithin(
					clone * alphabetSize,
					q * alphabetSize,
					q * alphabetSize + alphabetSize );
				while( p !== -1 && transitions[p * alphabetSize + token] === q ) {
					transitions[p * alphabetSize + token] = clone;
					p = links[p];
				}
				links[q] = clone;
				links[cur] = clone;
			}
		}
		last = cur;
	}

	const diff = new Int32Array( tokenCount + 2 );
	for( let state = 1; state < stateCount; ++state ) {
		const lo = lengths[links[state]] + 1;
		const hi = lengths[state];
		if( lo <= hi ) {
			diff[lo] += 1;
			diff[hi + 1] -= 1;
		}
	}
	const rows = [];
	let running = 0;
	let peak = {
		n: 1,
		value: 0
	};
	for( let n = 1; n <= tokenCount; ++n ) {
		running += diff[n];
		rows.push( { n, value: running } );
		if( running > peak.value ) {
			peak = { n, value: running };
		}
	}
	return { rows, stateCount, peak };
}

function writeTsv( outputFile, rows ) {
	const fd = fs.openSync( outputFile, 'w' );
	try {
		fs.writeSync( fd, 'n\tunique_substrings\n' );
		for( const row of rows ) {
			fs.writeSync( fd, `${row.n}\t${row.value}\n` );
		}
	} finally {
		fs.closeSync( fd );
	}
}

function movingAverage( values, windowSize ) {
	const half = Math.floor( windowSize / 2 );
	const prefix = new Float64Array( values.length + 1 );
	for( let idx = 0; idx < values.length; ++idx ) {
		prefix[idx + 1] = prefix[idx] + values[idx];
	}
	const smoothed = new Float64Array( values.length );
	for( let idx = 0; idx < values.length; ++idx ) {
		const lo = Math.max( 0, idx - half );
		const hi = Math.min( values.length, idx + half + 1 );
		smoothed[idx] = (prefix[hi] - prefix[lo]) / (hi - lo);
	}
	return smoothed;
}

function detectInflection( rows, windowSize, sustainCount ) {
	if( rows.length < 3 ) {
		return {
			n: rows.length > 0 ? rows[rows.length - 1].n : 1,
			found: false,
			threshold: 0
		};
	}
	const values = rows.map( row => row.value );
	const smoothed = movingAverage( values, Math.min( windowSize, values.length | 1 ) );
	const secondDiffs = [];
	let maxAbs = 0;
	for( let idx = 1; idx + 1 < smoothed.length; ++idx ) {
		const value = smoothed[idx + 1] - 2 * smoothed[idx] + smoothed[idx - 1];
		secondDiffs.push( value );
		maxAbs = Math.max( maxAbs, Math.abs( value ) );
	}
	const threshold = Math.max( 1e-6, maxAbs * 1e-4 );
	for( let idx = 1; idx + sustainCount <= secondDiffs.length; ++idx ) {
		if( secondDiffs[idx - 1] >= -threshold ) {
			continue;
		}
		let sustained = true;
		for( let lookahead = 0; lookahead < sustainCount; ++lookahead ) {
			if( secondDiffs[idx + lookahead] < -threshold ) {
				sustained = false;
				break;
			}
		}
		if( sustained ) {
			return {
				n: rows[idx + 1].n,
				found: true,
				threshold
			};
		}
	}
	return {
		n: rows[rows.length - 1].n,
		found: false,
		threshold
	};
}

function niceTickStep( range, targetTicks ) {
	if( !(range > 0) ) {
		return 1;
	}
	const rough = range / Math.max( 1, targetTicks );
	const magnitude = Math.pow( 10, Math.floor( Math.log10( rough ) ) );
	const normalized = rough / magnitude;
	if( normalized <= 1 ) return magnitude;
	if( normalized <= 2 ) return 2 * magnitude;
	if( normalized <= 5 ) return 5 * magnitude;
	return 10 * magnitude;
}

function formatTick( value ) {
	if( Math.abs( value ) >= 1000 ) {
		return Math.round( value ).toLocaleString( 'en-US' );
	}
	return Number.isInteger( value ) ? String( value ) : value.toFixed( 1 );
}

function escapeXml( text ) {
	return String( text )
		.replace( /&/g, '&amp;' )
		.replace( /</g, '&lt;' )
		.replace( />/g, '&gt;' )
		.replace( /"/g, '&quot;' )
		.replace( /'/g, '&apos;' );
}

function polylinePoints( rows, xScale, yScale ) {
	return rows.map( row => `${xScale( row.n ).toFixed( 2 )},${yScale( row.value ).toFixed( 2 )}` ).join( ' ' );
}

function writeSvg( outputFile, rows, metadata ) {
	const width = 1100;
	const height = 700;
	const margin = { left: 88, right: 34, top: 54, bottom: 72 };
	const plotW = width - margin.left - margin.right;
	const plotH = height - margin.top - margin.bottom;
	const maxX = rows.length > 0 ? rows[rows.length - 1].n : 1;
	let maxY = 1;
	for( const row of rows ) {
		if( row.value > maxY ) {
			maxY = row.value;
		}
	}
	const xScale = n => margin.left + (maxX === 1 ? 0 : (n - 1) / (maxX - 1)) * plotW;
	const yScale = value => margin.top + plotH - (value / maxY) * plotH;
	const xTickStep = niceTickStep( maxX, 10 );
	const yTickStep = niceTickStep( maxY, 8 );
	const xTicks = [];
	for( let value = 1; value <= maxX; value += xTickStep ) {
		xTicks.push( Math.round( value ) );
	}
	if( xTicks[xTicks.length - 1] !== maxX ) {
		xTicks.push( maxX );
	}
	const yTicks = [];
	for( let value = 0; value <= maxY + yTickStep * 0.5; value += yTickStep ) {
		yTicks.push( Math.min( maxY, value ) );
		if( value >= maxY ) {
			break;
		}
	}
	const gridLines = yTicks.map( tick => {
		const y = yScale( tick );
		return `<line class="grid" x1="${margin.left}" y1="${y.toFixed( 2 )}" x2="${width - margin.right}" y2="${y.toFixed( 2 )}"/>`;
	} ).join( '\n' );
	const yLabels = yTicks.map( tick => {
		const y = yScale( tick );
		return `<text class="tick-label" x="${margin.left - 10}" y="${(y + 4).toFixed( 2 )}" text-anchor="end">${formatTick( tick )}</text>`;
	} ).join( '\n' );
	const xLabels = xTicks.map( tick => {
		const x = xScale( tick );
		return [
			`<line class="tick" x1="${x.toFixed( 2 )}" y1="${height - margin.bottom}" x2="${x.toFixed( 2 )}" y2="${height - margin.bottom + 6}"/>`,
			`<text class="tick-label" x="${x.toFixed( 2 )}" y="${height - margin.bottom + 24}" text-anchor="middle">${formatTick( tick )}</text>`
		].join( '\n' );
	} ).join( '\n' );
	const points = polylinePoints( rows, xScale, yScale );
	const title = escapeXml( metadata.title );
	const subtitle = escapeXml( metadata.subtitle );
	const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">${title}</title>
<desc id="desc">${subtitle}</desc>
<style>
	text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #222; }
	.title { font-size: 22px; font-weight: 700; }
	.subtitle { font-size: 13px; fill: #555; }
	.axis-label { font-size: 14px; font-weight: 600; fill: #333; }
	.tick-label { font-size: 12px; fill: #555; }
	.axis { stroke: #333; stroke-width: 1.5; }
	.tick { stroke: #333; stroke-width: 1; }
	.grid { stroke: #ddd; stroke-width: 1; }
	.curve { fill: none; stroke: #1f6feb; stroke-width: 2.5; }
</style>
<rect width="${width}" height="${height}" fill="#fff"/>
<text class="title" x="${margin.left}" y="28">${title}</text>
<text class="subtitle" x="${margin.left}" y="48">${subtitle}</text>
${gridLines}
<line class="axis" x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}"/>
<line class="axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}"/>
${xLabels}
${yLabels}
<polyline class="curve" points="${points}"/>
<text class="axis-label" x="${margin.left + plotW / 2}" y="${height - 22}" text-anchor="middle">Substring length n</text>
<text class="axis-label" transform="translate(22 ${margin.top + plotH / 2}) rotate(-90)" text-anchor="middle">Unique contiguous substrings</text>
</svg>
`;
	fs.writeFileSync( outputFile, svg );
}

function main() {
	try {
		const config = parseArgs( process.argv.slice( 2 ) );
		const tokens = parseTokens( config.inputFile );
		console.log( `[parse] tokens=${tokens.length}` );
		const { encoded, labels } = encodeTokens( tokens );
		console.log( `[parse] alphabet=${labels.length}` );
		const start = Date.now();
		const result = distinctSubstringCountsByLength( encoded, labels.length );
		const elapsed = ((Date.now() - start) / 1000).toFixed( 2 );
		console.log( `[analyze] states=${result.stateCount} peak_n=${result.peak.n} peak=${result.peak.value} elapsed=${elapsed}s` );

		const inflection = detectInflection( result.rows, config.inflectionWindow, config.inflectionSustain );
		const focusedRows = result.rows.filter( row => row.n <= inflection.n );
		const tsvFile = `${config.outPrefix}.tsv`;
		const svgFile = `${config.outPrefix}.svg`;
		const fullSvgFile = `${config.outPrefix}.full.svg`;
		fs.mkdirSync( path.dirname( tsvFile ), { recursive: true } );
		writeTsv( tsvFile, result.rows );
		const summary =
			`${path.basename( config.inputFile )}; tokens=${tokens.length}; alphabet=${labels.length}; ` +
			`peak_n=${result.peak.n}; peak=${result.peak.value}`;
		writeSvg( fullSvgFile, result.rows, {
			title: 'Single Trajectory Language Complexity',
			subtitle: summary
		} );
		writeSvg( svgFile, focusedRows, {
			title: 'Single Trajectory Language Complexity',
			subtitle:
				`${path.basename( config.inputFile )}; focused through n=${inflection.n}; ` +
				`inflection=${inflection.n}; window=${config.inflectionWindow}; sustain=${config.inflectionSustain}; ` +
				`peak_n=${result.peak.n}; peak=${result.peak.value}`
		} );
		console.log( `[write] ${tsvFile}` );
		console.log( `[write] ${svgFile}` );
		console.log( `[write] ${fullSvgFile}` );
		console.log( `[inflection] n=${inflection.n} window=${config.inflectionWindow} sustain=${config.inflectionSustain}` );
	} catch( err ) {
		console.error( err && err.stack ? err.stack : String( err ) );
		process.exitCode = 1;
	}
}

main();
