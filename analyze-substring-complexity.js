#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function usage() {
	return [
		'Usage: node analyze-substring-complexity.js INPUT_FILE [options]',
		'',
		'Options:',
		'  --bounce-count N     Maximum substring length to analyze',
		'  --out-prefix PATH    Output path prefix for .tsv and .svg files',
		'  --inflection-window N  Odd smoothing window for inflection detection (default: 41)',
		'  --inflection-sustain N Number of nonnegative-curvature samples required (default: 5)',
		'  --help               Show this help'
	].join( '\n' );
}

function parseArgs( argv ) {
	const config = {
		inputFile: null,
		bounceCount: null,
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
		if( arg === '--bounce-count' ) {
			const value = Number( next() );
			if( !Number.isInteger( value ) || value < 1 ) {
				throw new Error( '--bounce-count must be a positive integer' );
			}
			config.bounceCount = value;
		} else if( arg === '--out-prefix' ) {
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
		config.outPrefix = config.inputFile.replace( /(\.[^.\/\\]+)?$/, '.substring-complexity' );
	}
	return config;
}

function parseInputFile( inputFile ) {
	const text = fs.readFileSync( inputFile, 'utf8' );
	const headers = {};
	const trajectories = [];
	for( const line of text.split( /\r?\n/ ) ) {
		if( line.length === 0 ) {
			continue;
		}
		if( line.startsWith( '#' ) ) {
			const match = /^#\s*([^:]+):\s*(.*)$/.exec( line );
			if( match ) {
				headers[match[1].trim()] = match[2].trim();
			}
			continue;
		}
		const parts = line.split( '\t' );
		if( parts.length < 4 ) {
			throw new Error( `Expected 4 tab-separated fields, got ${parts.length}: ${line.slice( 0, 120 )}` );
		}
		const sequence = parts[3].trim();
		const tokens = sequence.length > 0 ? sequence.split( /\s+/ ) : [];
		const sequenceLength = Number( parts[1] );
		if( !Number.isInteger( sequenceLength ) || sequenceLength !== tokens.length ) {
			throw new Error(
				`Sequence length mismatch at angle ${parts[0]}: field=${parts[1]}, tokens=${tokens.length}` );
		}
		trajectories.push( {
			angle: parts[0],
			sequenceLength,
			status: parts[2],
			tokens
		} );
	}
	return { headers, trajectories };
}

async function analyzeInputFile( inputFile, requestedBounceCount ) {
	const headers = {};
	let bounceCount = requestedBounceCount;
	let sums = null;
	let trajectoryCount = 0;
	let selectedCounts = null;
	let selectedTrajectory = null;
	const stream = fs.createReadStream( inputFile, { encoding: 'utf8' } );
	const rl = readline.createInterface( {
		input: stream,
		crlfDelay: Infinity
	} );
	for await( const line of rl ) {
		if( line.length === 0 ) {
			continue;
		}
		if( line.startsWith( '#' ) ) {
			const match = /^#\s*([^:]+):\s*(.*)$/.exec( line );
			if( match ) {
				headers[match[1].trim()] = match[2].trim();
			}
			continue;
		}
		const parts = line.split( '\t' );
		if( parts.length < 4 ) {
			throw new Error( `Expected 4 tab-separated fields, got ${parts.length}: ${line.slice( 0, 120 )}` );
		}
		const sequence = parts[3].trim();
		const tokens = sequence.length > 0 ? sequence.split( /\s+/ ) : [];
		const sequenceLength = Number( parts[1] );
		if( !Number.isInteger( sequenceLength ) || sequenceLength !== tokens.length ) {
			throw new Error(
				`Sequence length mismatch at angle ${parts[0]}: field=${parts[1]}, tokens=${tokens.length}` );
		}
		if( bounceCount == null ) {
			const headerValue = Number( headers.max_bounces );
			bounceCount = Number.isInteger( headerValue ) && headerValue > 0 ?
				headerValue : sequenceLength;
		}
		if( sums == null ) {
			sums = new Float64Array( bounceCount + 1 );
			console.log( `[parse] bounce_count=${bounceCount}` );
		}
		const counts = distinctSubstringCountsByLength( tokens, bounceCount );
		let trajectoryMax = -Infinity;
		let trajectoryMaxN = 1;
		for( let n = 1; n <= bounceCount; ++n ) {
			const value = counts[n];
			sums[n] += value;
			if( value > trajectoryMax ) {
				trajectoryMax = value;
				trajectoryMaxN = n;
			}
		}
		trajectoryCount += 1;
		if( selectedTrajectory == null || trajectoryMax > selectedTrajectory.peakUniqueSubstringCount ) {
			selectedCounts = Int32Array.from( counts );
			selectedTrajectory = {
				trajectoryIndex: trajectoryCount,
				angle: parts[0],
				status: parts[2],
				sequenceLength,
				peakN: trajectoryMaxN,
				peakUniqueSubstringCount: trajectoryMax
			};
		}
		if( trajectoryCount % 100 === 0 ) {
			console.log( `[analyze] ${trajectoryCount} trajectories` );
		}
	}
	if( bounceCount == null ) {
		const headerValue = Number( headers.max_bounces );
		if( Number.isInteger( headerValue ) && headerValue > 0 ) {
			bounceCount = headerValue;
			sums = new Float64Array( bounceCount + 1 );
		} else {
			throw new Error( 'Could not infer bounce count from header or data' );
		}
	}
	if( sums == null ) {
		sums = new Float64Array( bounceCount + 1 );
	}
	if( selectedCounts == null ) {
		selectedCounts = new Int32Array( bounceCount + 1 );
		selectedTrajectory = {
			trajectoryIndex: null,
			angle: null,
			status: null,
			sequenceLength: 0,
			peakN: null,
			peakUniqueSubstringCount: 0
		};
	}
	const rows = [];
	for( let n = 1; n <= bounceCount; ++n ) {
		rows.push( {
			n,
			average: trajectoryCount === 0 ? 0 : sums[n] / trajectoryCount,
			maximum: selectedCounts[n]
		} );
	}
	console.log( `[analyze] ${trajectoryCount}/${trajectoryCount} trajectories` );
	return {
		headers,
		trajectoryCount,
		bounceCount,
		rows,
		selectedTrajectory
	};
}

class SuffixAutomaton {
	constructor() {
		this.states = [
			{
				len: 0,
				link: -1,
				next: new Map()
			}
		];
		this.last = 0;
	}

	extend( token ) {
		const cur = this.states.length;
		this.states.push( {
			len: this.states[this.last].len + 1,
			link: 0,
			next: new Map()
		} );
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

function distinctSubstringCountsByLength( tokens, bounceCount ) {
	const automaton = new SuffixAutomaton();
	for( const token of tokens ) {
		automaton.extend( token );
	}
	const diff = new Int32Array( bounceCount + 2 );
	for( let idx = 1; idx < automaton.states.length; ++idx ) {
		const state = automaton.states[idx];
		const parent = automaton.states[state.link];
		const lo = parent.len + 1;
		const hi = Math.min( state.len, bounceCount );
		if( lo <= hi ) {
			diff[lo] += 1;
			diff[hi + 1] -= 1;
		}
	}
	const counts = new Int32Array( bounceCount + 1 );
	let running = 0;
	for( let n = 1; n <= bounceCount; ++n ) {
		running += diff[n];
		counts[n] = running;
	}
	return counts;
}

function analyze( trajectories, bounceCount ) {
	const sums = new Float64Array( bounceCount + 1 );
	const maxes = new Int32Array( bounceCount + 1 );
	for( let idx = 0; idx < trajectories.length; ++idx ) {
		const counts = distinctSubstringCountsByLength( trajectories[idx].tokens, bounceCount );
		for( let n = 1; n <= bounceCount; ++n ) {
			const value = counts[n];
			sums[n] += value;
			if( value > maxes[n] ) {
				maxes[n] = value;
			}
		}
		if( (idx + 1) % 100 === 0 || idx + 1 === trajectories.length ) {
			console.log( `[analyze] ${idx + 1}/${trajectories.length} trajectories` );
		}
	}
	const rows = [];
	for( let n = 1; n <= bounceCount; ++n ) {
		rows.push( {
			n,
			average: trajectories.length === 0 ? 0 : sums[n] / trajectories.length,
			maximum: maxes[n]
		} );
	}
	return rows;
}

function writeTsv( outputFile, rows ) {
	const lines = ['n\taverage_unique_substrings\tselected_trajectory_unique_substrings'];
	for( const row of rows ) {
		lines.push( `${row.n}\t${row.average.toFixed( 6 )}\t${row.maximum}` );
	}
	fs.writeFileSync( outputFile, `${lines.join( '\n' )}\n` );
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

function detectInflection( rows, key, windowSize, sustainCount ) {
	if( rows.length < 3 ) {
		return {
			key,
			n: rows.length > 0 ? rows[rows.length - 1].n : 1,
			found: false,
			threshold: 0
		};
	}
	const values = rows.map( row => row[key] );
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
				key,
				n: rows[idx + 1].n,
				found: true,
				threshold
			};
		}
	}
	return {
		key,
		n: rows[rows.length - 1].n,
		found: false,
		threshold
	};
}

function focusedRowsByInflection( rows, windowSize, sustainCount ) {
	const average = detectInflection( rows, 'average', windowSize, sustainCount );
	const selected = detectInflection( rows, 'maximum', windowSize, sustainCount );
	const cutoffN = Math.max( average.n, selected.n );
	return {
		rows: rows.filter( row => row.n <= cutoffN ),
		cutoffN,
		average,
		maximum: selected,
		windowSize,
		sustainCount
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

function polylinePoints( rows, xScale, yScale, key ) {
	return rows.map( row => `${xScale( row.n ).toFixed( 2 )},${yScale( row[key] ).toFixed( 2 )}` ).join( ' ' );
}

function writeSvg( outputFile, rows, metadata ) {
	const width = 1100;
	const height = 700;
	const margin = { left: 82, right: 32, top: 54, bottom: 72 };
	const plotW = width - margin.left - margin.right;
	const plotH = height - margin.top - margin.bottom;
	const maxX = rows.length > 0 ? rows[rows.length - 1].n : 1;
	const maxY = Math.max( 1, ...rows.map( row => Math.max( row.average, row.maximum ) ) );
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
	const escapedTitle = escapeXml( metadata.title );
	const escapedSubtitle = escapeXml( metadata.subtitle );
	const escapedSelectedLabel = escapeXml( metadata.selectedLabel || 'Selected trajectory' );
	const avgPoints = polylinePoints( rows, xScale, yScale, 'average' );
	const maxPoints = polylinePoints( rows, xScale, yScale, 'maximum' );
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
			`<text class="tick-label" x="${x.toFixed( 2 )}" y="${height - margin.bottom + 24}" text-anchor="middle">${tick}</text>`
		].join( '\n' );
	} ).join( '\n' );
	const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">${escapedTitle}</title>
<desc id="desc">${escapedSubtitle}</desc>
<style>
	text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #222; }
	.title { font-size: 22px; font-weight: 700; }
	.subtitle { font-size: 13px; fill: #555; }
	.axis-label { font-size: 14px; font-weight: 600; fill: #333; }
	.tick-label { font-size: 12px; fill: #555; }
	.axis { stroke: #333; stroke-width: 1.5; }
	.tick { stroke: #333; stroke-width: 1; }
	.grid { stroke: #ddd; stroke-width: 1; }
	.avg { fill: none; stroke: #c2272d; stroke-width: 2.5; }
	.max { fill: none; stroke: #1f6feb; stroke-width: 2.5; }
	.legend-label { font-size: 13px; font-weight: 600; }
</style>
<rect width="${width}" height="${height}" fill="#fff"/>
<text class="title" x="${margin.left}" y="28">${escapedTitle}</text>
<text class="subtitle" x="${margin.left}" y="48">${escapedSubtitle}</text>
${gridLines}
<line class="axis" x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}"/>
<line class="axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}"/>
${xLabels}
${yLabels}
<polyline class="avg" points="${avgPoints}"/>
<polyline class="max" points="${maxPoints}"/>
<line x1="${width - margin.right - 250}" y1="28" x2="${width - margin.right - 210}" y2="28" class="avg"/>
<text class="legend-label" x="${width - margin.right - 200}" y="32">Average per trajectory</text>
<line x1="${width - margin.right - 250}" y1="48" x2="${width - margin.right - 210}" y2="48" class="max"/>
<text class="legend-label" x="${width - margin.right - 200}" y="52">${escapedSelectedLabel}</text>
<text class="axis-label" x="${margin.left + plotW / 2}" y="${height - 22}" text-anchor="middle">Substring length n</text>
<text class="axis-label" transform="translate(22 ${margin.top + plotH / 2}) rotate(-90)" text-anchor="middle">Unique contiguous substrings</text>
</svg>
`;
	fs.writeFileSync( outputFile, svg );
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

function inferBounceCount( headers, trajectories, requestedBounceCount ) {
	if( requestedBounceCount != null ) {
		return requestedBounceCount;
	}
	const headerValue = Number( headers.max_bounces );
	if( Number.isInteger( headerValue ) && headerValue > 0 ) {
		return headerValue;
	}
	const maxLength = trajectories.reduce( (max, trajectory) =>
		Math.max( max, trajectory.sequenceLength ), 0 );
	if( maxLength < 1 ) {
		throw new Error( 'Could not infer bounce count from header or data' );
	}
	return maxLength;
}

async function main() {
	try {
		const config = parseArgs( process.argv.slice( 2 ) );
		const analysis = await analyzeInputFile( config.inputFile, config.bounceCount );
		const bounceCount = analysis.bounceCount;
		const rows = analysis.rows;
		console.log( `[parse] trajectories=${analysis.trajectoryCount} bounce_count=${bounceCount}` );
		const focus = focusedRowsByInflection(
			rows,
			config.inflectionWindow,
			config.inflectionSustain );
		const tsvFile = `${config.outPrefix}.tsv`;
		const svgFile = `${config.outPrefix}.svg`;
		const fullSvgFile = `${config.outPrefix}.full.svg`;
		fs.mkdirSync( path.dirname( tsvFile ), { recursive: true } );
		writeTsv( tsvFile, rows );
		const selectedLabel = analysis.selectedTrajectory.angle == null ?
			'Selected trajectory' :
			`Selected trajectory angle ${analysis.selectedTrajectory.angle}`;
		const selectedSummary = analysis.selectedTrajectory.angle == null ?
			'selected trajectory unavailable' :
			`selected_angle=${analysis.selectedTrajectory.angle}; ` +
			`selected_peak_n=${analysis.selectedTrajectory.peakN}; ` +
			`selected_peak=${analysis.selectedTrajectory.peakUniqueSubstringCount}`;
		writeSvg( fullSvgFile, rows, {
			title: 'Unique Contiguous Substring Complexity',
			subtitle:
				`${path.basename( config.inputFile )}; trajectories=${analysis.trajectoryCount}; ` +
				`bounce_count=${bounceCount}; ${selectedSummary}`,
			selectedLabel
		} );
		writeSvg( svgFile, focus.rows, {
			title: 'Unique Contiguous Substring Complexity',
			subtitle:
				`${path.basename( config.inputFile )}; focused through n=${focus.cutoffN}; ` +
				`avg_inflection=${focus.average.n}; selected_inflection=${focus.maximum.n}; ` +
				`window=${focus.windowSize}; sustain=${focus.sustainCount}; ${selectedSummary}`,
			selectedLabel
		} );
		console.log( `[write] ${tsvFile}` );
		console.log( `[write] ${svgFile}` );
		console.log( `[write] ${fullSvgFile}` );
		console.log(
			`[selected] angle=${analysis.selectedTrajectory.angle} ` +
			`peak_n=${analysis.selectedTrajectory.peakN} ` +
			`peak=${analysis.selectedTrajectory.peakUniqueSubstringCount}` );
		console.log(
			`[inflection] average_n=${focus.average.n} selected_n=${focus.maximum.n} ` +
			`cutoff_n=${focus.cutoffN} window=${focus.windowSize} sustain=${focus.sustainCount}` );
	} catch( err ) {
		console.error( err && err.stack ? err.stack : String( err ) );
		process.exitCode = 1;
	}
}

main();
