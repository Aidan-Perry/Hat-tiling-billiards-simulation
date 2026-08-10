(function () {
	'use strict';

	const statusEl = document.getElementById( 'status' );
	const graphsEl = document.getElementById( 'graphs' );
	const sequencesEl = document.getElementById( 'sequences' );
	const refreshButton = document.getElementById( 'refresh' );
	const saveButton = document.getElementById( 'save' );
	const graphsTab = document.getElementById( 'graphs-tab' );
	const sequencesTab = document.getElementById( 'sequences-tab' );
	const graphsPanel = document.getElementById( 'graphs-panel' );
	const sequencesPanel = document.getElementById( 'sequences-panel' );
	const pollMs = 10000;
	let latestETag = null;
	let latestPayload = null;
	const graphVisibility = new Map();
	let languageComplexityMaxN = null;
	let metatileLanguageComplexityMaxN = null;
	let metatileSequenceRequestRunId = null;

	function fmt( value, digits ) {
		if( value == null || !Number.isFinite( Number( value ) ) ) {
			return 'n/a';
		}
		return Number( value ).toPrecision( digits || 5 );
	}

	function truncFixed( value, digits ) {
		if( value == null || !Number.isFinite( Number( value ) ) ) {
			return 'n/a';
		}
		const factor = Math.pow( 10, digits );
		return (Math.trunc( Number( value ) * factor ) / factor).toFixed( digits );
	}

	function shortStatus( value ) {
		return value == null ? 'unknown' : String( value );
	}

	function clear( node ) {
		while( node.firstChild ) {
			node.removeChild( node.firstChild );
		}
	}

	function div( className, text ) {
		const node = document.createElement( 'div' );
		if( className ) {
			node.className = className;
		}
		if( text != null ) {
			node.textContent = text;
		}
		return node;
	}

	function metaRow( label, value ) {
		const row = div( 'meta-row' );
		const labelEl = document.createElement( 'span' );
		const valueEl = document.createElement( 'span' );
		labelEl.textContent = label;
		valueEl.textContent = value == null ? 'n/a' : String( value );
		row.append( labelEl, valueEl );
		return row;
	}

	function setActiveTab( name ) {
		const showGraphs = name === 'graphs';
		graphsPanel.hidden = !showGraphs;
		sequencesPanel.hidden = showGraphs;
		graphsTab.setAttribute( 'aria-selected', showGraphs ? 'true' : 'false' );
		sequencesTab.setAttribute( 'aria-selected', showGraphs ? 'false' : 'true' );
	}

	function tokenText( tokens ) {
		return (tokens || []).join( ' ' );
	}

	function copyTextToClipboard( text ) {
		if( navigator.clipboard && navigator.clipboard.writeText ) {
			return navigator.clipboard.writeText( text );
		}
		const textarea = document.createElement( 'textarea' );
		textarea.value = text;
		textarea.setAttribute( 'readonly', '' );
		textarea.style.position = 'fixed';
		textarea.style.left = '-9999px';
		document.body.appendChild( textarea );
		textarea.select();
		try {
			document.execCommand( 'copy' );
			return Promise.resolve();
		} catch( err ) {
			return Promise.reject( err );
		} finally {
			document.body.removeChild( textarea );
		}
	}

	function copyButton( text ) {
		const button = document.createElement( 'button' );
		button.type = 'button';
		button.textContent = 'Copy word';
		button.addEventListener( 'click', async () => {
			const original = button.textContent;
			button.disabled = true;
			try {
				await copyTextToClipboard( text );
				button.textContent = 'Copied';
			} catch( err ) {
				button.textContent = 'Copy failed';
			}
			window.setTimeout( () => {
				button.textContent = original;
				button.disabled = false;
			}, 1200 );
		} );
		return button;
	}

	function sequenceCardTitle( title, count ) {
		const row = div( 'sequence-title' );
		const heading = document.createElement( 'h2' );
		heading.textContent = title;
		const countEl = document.createElement( 'span' );
		countEl.className = 'status-line';
		countEl.textContent = `${count || 0} hits`;
		row.append( heading, countEl );
		return row;
	}

	function renderTokenSequence( container, sequence ) {
		const tokens = tokenText( sequence.tokens );
		const title = sequenceCardTitle( sequence.label || sequence.id, sequence.count );
		title.appendChild( copyButton( tokens ) );
		container.appendChild( title );
		const meta = div( 'meta-grid' );
		if( sequence.type === 'hat-edge' ) {
			meta.appendChild( metaRow( 'Type', 'hat side transition' ) );
			const stats = sequence.hatVisitStats || {};
			meta.appendChild( metaRow( 'Visited hats', stats.visitedHatCount ) );
			meta.appendChild( metaRow( 'Hats / bounce', truncFixed( stats.hatsPerBounce, 4 ) ) );
		} else {
			meta.appendChild( metaRow( 'Type', sequence.type === 'metatile-boundary' ?
				'Figure 4.1 L1 cluster transition' : `metatile L${sequence.metatileLevel}` ) );
			meta.appendChild( metaRow( 'Clusters', sequence.clusterCount || sequence.outlineCount ) );
			if( sequence.ambiguousCount ) {
				meta.appendChild( metaRow( 'Ambiguous sides', sequence.ambiguousCount ) );
			}
		}
		container.appendChild( meta );
		const stream = div( 'token-stream', tokens || 'empty' );
		container.appendChild( stream );
	}

	function renderHatSequences( symbolic ) {
		const card = div( 'card' );
		const title = document.createElement( 'h2' );
		title.textContent = 'Hat Cutting Sequence';
		card.appendChild( title );
		const grid = div( 'sequence-grid' );
		for( const sequence of symbolic.hatSequences || [] ) {
			const item = div( 'sequence-item' );
			renderTokenSequence( item, sequence );
			grid.appendChild( item );
		}
		if( grid.childNodes.length === 0 ) {
			grid.appendChild( div( 'empty', 'No hat crossings in the latest run.' ) );
		}
		card.appendChild( grid );
		sequencesEl.appendChild( card );
	}

	function drawLanguageComplexityChart( canvas, sequences, maxN ) {
		const rect = canvas.getBoundingClientRect();
		if( rect.width <= 0 || rect.height <= 0 ) {
			window.requestAnimationFrame( () => drawLanguageComplexityChart( canvas, sequences, maxN ) );
			return;
		}
		const cutoff = Number.isFinite( maxN ) && maxN > 0 ? Math.floor( maxN ) : null;
		const seriesList = (sequences || []).map( sequence => {
			const complexity = sequence.languageComplexity || {};
			return {
				id: sequence.id,
				color: sequence.color,
				label: sequence.label || sequence.id,
				samples: (complexity.samples || [])
					.filter( sample => cutoff == null || sample.n <= cutoff )
					.map( sample => ( {
						bounce: sample.n,
						distance: sample.uniqueSubstringCount
					} ) )
			};
		} ).filter( series => series.samples.length > 0 );
		let maxX = cutoff || 1;
		let maxY = 1;
		for( const series of seriesList ) {
			for( const sample of series.samples ) {
				if( cutoff == null ) {
					maxX = Math.max( maxX, sample.bounce );
				}
				maxY = Math.max( maxY, sample.distance );
			}
		}
		const scale = drawChartBase(
			canvas,
			maxX,
			maxY * 1.08,
			'substring length n',
			'unique substrings'
		);
		if( !scale ) {
			window.requestAnimationFrame( () => drawLanguageComplexityChart( canvas, sequences, maxN ) );
			return;
		}
		if( seriesList.length === 0 ) {
			const ctx = scale.ctx;
			ctx.fillStyle = '#5d6673';
			ctx.font = '14px system-ui, sans-serif';
			ctx.textAlign = 'center';
			ctx.fillText(
				'No language complexity samples',
				canvas.getBoundingClientRect().width / 2,
				canvas.getBoundingClientRect().height / 2
			);
			return;
		}
		drawSeriesLines( scale.ctx, seriesList, scale, scale.plotW );
	}

	function renderLanguageComplexityGraph( symbolic, run ) {
		const sequences = (symbolic.hatSequences || []).filter( sequence =>
			sequence.languageComplexity && (sequence.languageComplexity.samples || []).length > 0 );
		const card = div( 'card' );
		const title = document.createElement( 'h2' );
		title.textContent = 'Hat Sequence Language Complexity';
		card.appendChild( title );
		if( sequences.length === 0 ) {
			card.appendChild( div( 'empty', 'No language complexity samples in the latest run.' ) );
			sequencesEl.appendChild( card );
			return;
		}

		const body = div( 'graph-card' );
		const chartWrap = document.createElement( 'div' );
		const legend = div( 'series-toggles' );
		for( const sequence of sequences ) {
			const item = div( 'series-toggle' );
			const swatch = document.createElement( 'span' );
			swatch.className = 'series-swatch';
			swatch.style.backgroundColor = cssColorForSeries( sequence.color );
			const text = document.createElement( 'span' );
			const complexity = sequence.languageComplexity || {};
			text.textContent = `${sequence.label || sequence.id} (${complexity.sampleCount || 0} n values)`;
			item.append( swatch, text );
			legend.appendChild( item );
		}
		const canvas = document.createElement( 'canvas' );
		const maxSampleN = sequences.reduce( (max, sequence) =>
			Math.max( max, (sequence.languageComplexity || {}).sampleCount || 0 ), 0 );
		if( languageComplexityMaxN == null || languageComplexityMaxN > maxSampleN ) {
			languageComplexityMaxN = maxSampleN;
		}
		const cutoffControls = div( 'level-controls' );
		const cutoffLabel = document.createElement( 'label' );
		cutoffLabel.className = 'series-toggle';
		const cutoffInput = document.createElement( 'input' );
		cutoffInput.type = 'number';
		cutoffInput.min = '1';
		cutoffInput.max = String( maxSampleN );
		cutoffInput.step = '1';
		cutoffInput.value = String( languageComplexityMaxN || maxSampleN || 1 );
		const cutoffText = document.createElement( 'span' );
		cutoffText.textContent = 'Max substring length';
		cutoffLabel.append( cutoffText, cutoffInput );
		const applyButton = document.createElement( 'button' );
		applyButton.type = 'button';
		applyButton.textContent = 'Redisplay';
		const resetButton = document.createElement( 'button' );
		resetButton.type = 'button';
		resetButton.textContent = 'Show all';
		function redrawWithInput() {
			const value = Math.max( 1, Math.min( maxSampleN, Math.floor( Number( cutoffInput.value ) || maxSampleN || 1 ) ) );
			languageComplexityMaxN = value;
			cutoffInput.value = String( value );
			window.requestAnimationFrame( () => drawLanguageComplexityChart( canvas, sequences, languageComplexityMaxN ) );
		}
		applyButton.addEventListener( 'click', redrawWithInput );
		cutoffInput.addEventListener( 'keydown', event => {
			if( event.key === 'Enter' ) {
				redrawWithInput();
			}
		} );
		resetButton.addEventListener( 'click', () => {
			languageComplexityMaxN = maxSampleN;
			cutoffInput.value = String( maxSampleN );
			window.requestAnimationFrame( () => drawLanguageComplexityChart( canvas, sequences, languageComplexityMaxN ) );
		} );
		cutoffControls.append( cutoffLabel, applyButton, resetButton );
		chartWrap.append( legend, cutoffControls, canvas );
		body.appendChild( chartWrap );

		const meta = div( 'meta-grid' );
		meta.appendChild( metaRow( 'Definition', 'number of distinct contiguous token substrings of length n' ) );
		meta.appendChild( metaRow( 'Requested bounces', run && run.requestedBounces ) );
		for( const sequence of sequences ) {
			const complexity = sequence.languageComplexity || {};
			const stats = sequence.hatVisitStats || {};
			meta.appendChild( metaRow(
				sequence.label || sequence.id,
				`${complexity.tokenCount || 0} tokens; ${truncFixed( stats.hatsPerBounce, 4 )} hats/bounce; peak ${complexity.peakValue || 0} at n=${complexity.peakN == null ? 'n/a' : complexity.peakN}`
			) );
		}
		body.appendChild( meta );
		card.appendChild( body );
		sequencesEl.appendChild( card );
		window.requestAnimationFrame( () => drawLanguageComplexityChart( canvas, sequences, languageComplexityMaxN ) );
	}

	function renderMetatileSequences( symbolic ) {
		const metatile = symbolic.metatileSequences || {};
		const levels = metatile.levels || [];
		if( levels.length === 0 ) {
			const loadingThisRun = latestPayload && metatileSequenceRequestRunId === latestPayload.runId;
			const card = div( 'card' );
			const title = document.createElement( 'h2' );
			title.textContent = 'Metatile Cutting Sequence';
			card.appendChild( title );
			const controls = div( 'level-controls' );
			const loadButton = document.createElement( 'button' );
			loadButton.type = 'button';
			loadButton.textContent = loadingThisRun ? 'Building...' : 'Load metatile sequence';
			loadButton.disabled = loadingThisRun;
			loadButton.addEventListener( 'click', loadMetatileSequencesForLatest );
			controls.appendChild( loadButton );
			card.appendChild( controls );
			card.appendChild( div( 'empty', metatile.error || 'Metatile sequence has not been loaded for the latest run.' ) );
			sequencesEl.appendChild( card );
			return;
		}
		for( const levelPayload of metatile.levels || [] ) {
			const card = div( 'card' );
			const title = document.createElement( 'h2' );
			title.textContent = 'Metatile Cutting Sequence';
			card.appendChild( title );
			const meta = div( 'meta-grid' );
			meta.appendChild( metaRow( 'Definition', levelPayload.label || 'Figure 4.1 L1 clusters' ) );
			meta.appendChild( metaRow( 'Clusters', levelPayload.clusterCount || levelPayload.outlineCount ) );
			if( levelPayload.validation ) {
				meta.appendChild( metaRow( 'Membership', levelPayload.validation.ok ? 'valid' : 'invalid' ) );
			}
			card.appendChild( meta );
			const grid = div( 'sequence-grid' );
			for( const sequence of levelPayload.sequences || [] ) {
				const item = div( 'sequence-item' );
				renderTokenSequence( item, sequence );
				grid.appendChild( item );
			}
			if( grid.childNodes.length === 0 ) {
				grid.appendChild( div( 'empty', 'No metatile sequence loaded for this level.' ) );
			}
			card.appendChild( grid );
			sequencesEl.appendChild( card );
		}
	}

	function metatileSequenceList( symbolic ) {
		const metatile = symbolic.metatileSequences || {};
		const sequences = [];
		for( const levelPayload of metatile.levels || [] ) {
			for( const sequence of levelPayload.sequences || [] ) {
				if( sequence.languageComplexity && (sequence.languageComplexity.samples || []).length > 0 ) {
					sequences.push( sequence );
				}
			}
		}
		return sequences;
	}

	function renderMetatileLanguageComplexityGraph( symbolic ) {
		const sequences = metatileSequenceList( symbolic );
		const card = div( 'card' );
		const title = document.createElement( 'h2' );
		title.textContent = 'Metatile Sequence Language Complexity';
		card.appendChild( title );
		if( sequences.length === 0 ) {
			card.appendChild( div( 'empty', 'Load a metatile sequence to show language complexity.' ) );
			sequencesEl.appendChild( card );
			return;
		}

		const body = div( 'graph-card' );
		const chartWrap = document.createElement( 'div' );
		const legend = div( 'series-toggles' );
		for( const sequence of sequences ) {
			const item = div( 'series-toggle' );
			const swatch = document.createElement( 'span' );
			swatch.className = 'series-swatch';
			swatch.style.backgroundColor = cssColorForSeries( sequence.color );
			const text = document.createElement( 'span' );
			const complexity = sequence.languageComplexity || {};
			text.textContent = `${sequence.label || sequence.id} (${complexity.sampleCount || 0} n values)`;
			item.append( swatch, text );
			legend.appendChild( item );
		}
		const canvas = document.createElement( 'canvas' );
		const maxSampleN = sequences.reduce( (max, sequence) =>
			Math.max( max, (sequence.languageComplexity || {}).sampleCount || 0 ), 0 );
		if( metatileLanguageComplexityMaxN == null || metatileLanguageComplexityMaxN > maxSampleN ) {
			metatileLanguageComplexityMaxN = maxSampleN;
		}
		const cutoffControls = div( 'level-controls' );
		const cutoffLabel = document.createElement( 'label' );
		cutoffLabel.className = 'series-toggle';
		const cutoffInput = document.createElement( 'input' );
		cutoffInput.type = 'number';
		cutoffInput.min = '1';
		cutoffInput.max = String( maxSampleN );
		cutoffInput.step = '1';
		cutoffInput.value = String( metatileLanguageComplexityMaxN || maxSampleN || 1 );
		const cutoffText = document.createElement( 'span' );
		cutoffText.textContent = 'Max substring length';
		cutoffLabel.append( cutoffText, cutoffInput );
		const applyButton = document.createElement( 'button' );
		applyButton.type = 'button';
		applyButton.textContent = 'Redisplay';
		const resetButton = document.createElement( 'button' );
		resetButton.type = 'button';
		resetButton.textContent = 'Show all';
		function redrawWithInput() {
			const value = Math.max( 1, Math.min( maxSampleN, Math.floor( Number( cutoffInput.value ) || maxSampleN || 1 ) ) );
			metatileLanguageComplexityMaxN = value;
			cutoffInput.value = String( value );
			window.requestAnimationFrame( () => drawLanguageComplexityChart( canvas, sequences, metatileLanguageComplexityMaxN ) );
		}
		applyButton.addEventListener( 'click', redrawWithInput );
		cutoffInput.addEventListener( 'keydown', event => {
			if( event.key === 'Enter' ) {
				redrawWithInput();
			}
		} );
		resetButton.addEventListener( 'click', () => {
			metatileLanguageComplexityMaxN = maxSampleN;
			cutoffInput.value = String( maxSampleN );
			window.requestAnimationFrame( () => drawLanguageComplexityChart( canvas, sequences, metatileLanguageComplexityMaxN ) );
		} );
		cutoffControls.append( cutoffLabel, applyButton, resetButton );
		chartWrap.append( legend, cutoffControls, canvas );
		body.appendChild( chartWrap );

		const meta = div( 'meta-grid' );
		meta.appendChild( metaRow( 'Definition', 'number of distinct contiguous metatile-token substrings of length n' ) );
		for( const sequence of sequences ) {
			const complexity = sequence.languageComplexity || {};
			meta.appendChild( metaRow(
				sequence.label || sequence.id,
				`${complexity.tokenCount || 0} tokens; peak ${complexity.peakValue || 0} at n=${complexity.peakN == null ? 'n/a' : complexity.peakN}`
			) );
		}
		body.appendChild( meta );
		card.appendChild( body );
		sequencesEl.appendChild( card );
		window.requestAnimationFrame( () => drawLanguageComplexityChart( canvas, sequences, metatileLanguageComplexityMaxN ) );
	}

	function renderSequences( payload ) {
		clear( sequencesEl );
		if( !payload || payload.available === false ) {
			sequencesEl.appendChild( div( 'card empty', 'Run a server-backed trajectory to create diagnostics.' ) );
			return;
		}
		const symbolic = payload.symbolic || {};
		renderHatSequences( symbolic );
		renderLanguageComplexityGraph( symbolic, payload.run || {} );
		renderMetatileSequences( symbolic );
		renderMetatileLanguageComplexityGraph( symbolic );
	}

	function hasMetatileSequences( payload ) {
		const metatile = payload && payload.symbolic && payload.symbolic.metatileSequences;
		return !!(metatile && Array.isArray( metatile.levels ) && metatile.levels.length > 0);
	}

	function niceTickStep( range, targetTicks ) {
		if( !Number.isFinite( range ) || range <= 0 ) {
			return 1;
		}
		const roughStep = range / Math.max( 1, targetTicks );
		const magnitude = Math.pow( 10, Math.floor( Math.log10( roughStep ) ) );
		const normalized = roughStep / magnitude;
		if( normalized <= 1 ) {
			return magnitude;
		}
		if( normalized <= 2 ) {
			return 2 * magnitude;
		}
		if( normalized <= 5 ) {
			return 5 * magnitude;
		}
		return 10 * magnitude;
	}

	function bounceTickValues( maxX, plotW ) {
		const targetTicks = Math.max( 2, Math.floor( plotW / 90 ) );
		const step = Math.max( 1, niceTickStep( maxX, targetTicks ) );
		const ticks = [];
		for( let value = 0; value <= maxX + step * 0.25; value += step ) {
			const tick = Math.round( value );
			if( tick <= maxX && (ticks.length === 0 || ticks[ticks.length - 1] !== tick) ) {
				ticks.push( tick );
			}
		}
		return ticks;
	}

	function cssColorForSeries( color ) {
		if( color === 'red' ) {
			return '#c2272d';
		}
		if( color === 'blue' ) {
			return '#1f6feb';
		}
		if( color === 'green' ) {
			return '#2da44e';
		}
		return '#6f42c1';
	}

	function graphVisibilityKey( graphId, seriesId ) {
		return `${graphId}:${seriesId}`;
	}

	function seriesVisible( graphId, seriesId ) {
		const key = graphVisibilityKey( graphId, seriesId );
		return graphVisibility.has( key ) ? graphVisibility.get( key ) : true;
	}

	function setSeriesVisible( graphId, seriesId, visible ) {
		graphVisibility.set( graphVisibilityKey( graphId, seriesId ), visible );
	}

	function drawSeriesLines( ctx, seriesList, scale, plotW ) {
		for( const series of seriesList ) {
			const samples = series.samples || [];
			if( samples.length === 0 ) {
				continue;
			}
			ctx.strokeStyle = cssColorForSeries( series.color );
			ctx.lineWidth = 2;
			if( samples.length <= plotW * 4 ) {
				ctx.beginPath();
				for( let i = 0; i < samples.length; ++i ) {
					const x = scale.x( samples[i].bounce );
					const y = scale.y( samples[i].distance );
					if( i === 0 ) {
						ctx.moveTo( x, y );
					} else {
						ctx.lineTo( x, y );
					}
				}
				ctx.stroke();
			} else {
				const buckets = new Map();
				for( const sample of samples ) {
					const x = Math.round( scale.x( sample.bounce ) );
					let bucket = buckets.get( x );
					if( !bucket ) {
						bucket = { min: Infinity, max: -Infinity };
						buckets.set( x, bucket );
					}
					bucket.min = Math.min( bucket.min, sample.distance );
					bucket.max = Math.max( bucket.max, sample.distance );
				}
				ctx.beginPath();
				for( const [x, bucket] of buckets ) {
					ctx.moveTo( x, scale.y( bucket.min ) );
					ctx.lineTo( x, scale.y( bucket.max ) );
				}
				ctx.stroke();
			}
			if( samples.length <= 2500 ) {
				ctx.fillStyle = cssColorForSeries( series.color );
				for( const sample of samples ) {
					const x = scale.x( sample.bounce );
					const y = scale.y( sample.distance );
					ctx.beginPath();
					ctx.arc( x, y, 2.5, 0, Math.PI * 2 );
					ctx.fill();
				}
			}
		}
	}

	function drawChartBase( canvas, maxX, maxY, xLabel, yLabel, options ) {
		options = options || {};
		const rect = canvas.getBoundingClientRect();
		if( rect.width <= 0 || rect.height <= 0 ) {
			return null;
		}
		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.max( 1, Math.round( rect.width * dpr ) );
		canvas.height = Math.max( 1, Math.round( rect.height * dpr ) );
		const ctx = canvas.getContext( '2d' );
		ctx.setTransform( dpr, 0, 0, dpr, 0, 0 );

		const width = rect.width;
		const height = rect.height;
		const pad = { left: 54, right: 22, top: 20, bottom: 44 };
		const plotW = Math.max( 1, width - pad.left - pad.right );
		const plotH = Math.max( 1, height - pad.top - pad.bottom );
		maxX = Math.max( 1, maxX || 1 );
		maxY = Number.isFinite( maxY ) && maxY > 0 ? maxY : 1;
		if( !options.exactMaxY ) {
			maxY = Math.max( 1, maxY );
		}

		function xScale( x ) {
			return pad.left + (x / maxX) * plotW;
		}
		function yScale( y ) {
			return pad.top + plotH - (y / maxY) * plotH;
		}

		ctx.clearRect( 0, 0, width, height );
		ctx.fillStyle = '#fff';
		ctx.fillRect( 0, 0, width, height );

		ctx.strokeStyle = '#d9dee7';
		ctx.lineWidth = 1;
		ctx.beginPath();
		for( let i = 0; i <= 4; ++i ) {
			const y = pad.top + (plotH * i) / 4;
			ctx.moveTo( pad.left, y );
			ctx.lineTo( pad.left + plotW, y );
		}
		ctx.stroke();

		ctx.strokeStyle = '#5d6673';
		ctx.beginPath();
		ctx.moveTo( pad.left, pad.top );
		ctx.lineTo( pad.left, pad.top + plotH );
		ctx.lineTo( pad.left + plotW, pad.top + plotH );
		ctx.stroke();

		ctx.fillStyle = '#5d6673';
		ctx.font = '12px system-ui, sans-serif';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';
		for( const tick of bounceTickValues( maxX, plotW ) ) {
			const x = xScale( tick );
			ctx.strokeStyle = '#5d6673';
			ctx.beginPath();
			ctx.moveTo( x, pad.top + plotH );
			ctx.lineTo( x, pad.top + plotH + 5 );
			ctx.stroke();
			ctx.fillText( String( tick ), x, pad.top + plotH + 8 );
		}
		ctx.textAlign = 'center';
		ctx.textBaseline = 'alphabetic';
		ctx.fillText( xLabel, pad.left + plotW / 2, height - 4 );
		ctx.save();
		ctx.translate( 14, pad.top + plotH / 2 );
		ctx.rotate( -Math.PI / 2 );
		ctx.fillText( yLabel, 0, 0 );
		ctx.restore();
		ctx.textAlign = 'right';
		ctx.textBaseline = 'alphabetic';
		ctx.fillText( '0', pad.left - 8, pad.top + plotH + 4 );
		ctx.fillText( fmt( maxY, 4 ), pad.left - 8, pad.top + 4 );

		return {
			ctx,
			plotW,
			x: xScale,
			y: yScale
		};
	}

	function drawDistanceChart( canvas, graph ) {
		const rect = canvas.getBoundingClientRect();
		if( rect.width <= 0 || rect.height <= 0 ) {
			window.requestAnimationFrame( () => drawDistanceChart( canvas, graph ) );
			return;
		}
		const samples = graph.samples || [];
		const fit = graph.fit || {};
		const maxX = Math.max( 1, graph.lastBounce == null ? samples.length - 1 : graph.lastBounce );
		const approxPlotW = Math.max( 16, rect.width - 76 );
		let maxY = 1;
		for( const sample of samples ) {
			if( Number.isFinite( sample.distance ) ) {
				maxY = Math.max( maxY, sample.distance );
			}
		}
		if( Number.isFinite( fit.A ) && Number.isFinite( fit.B ) ) {
			const fitMaxSteps = Math.min( 1000, Math.max( 16, Math.round( approxPlotW ) ) );
			for( let i = 0; i <= fitMaxSteps; ++i ) {
				const xVal = (maxX * i) / fitMaxSteps;
				maxY = Math.max( maxY, fit.A * Math.exp( fit.B * xVal ) );
			}
		}
		maxY *= 1.08;
		const scale = drawChartBase( canvas, maxX, maxY, 'bounce index', 'Euclidean distance' );
		if( !scale ) {
			window.requestAnimationFrame( () => drawDistanceChart( canvas, graph ) );
			return;
		}
		const ctx = scale.ctx;
		const plotW = scale.plotW;

		if( samples.length > 0 ) {
			drawSeriesLines( ctx, [{
				color: 'red',
				samples
			}], scale, plotW );
		}

		if( Number.isFinite( fit.A ) && Number.isFinite( fit.B ) ) {
			ctx.strokeStyle = '#1f6feb';
			ctx.lineWidth = 2;
			ctx.setLineDash( [6, 4] );
			ctx.beginPath();
			const steps = Math.min( 1000, Math.max( 16, Math.round( plotW ) ) );
			for( let i = 0; i <= steps; ++i ) {
				const xVal = (maxX * i) / steps;
				const yVal = fit.A * Math.exp( fit.B * xVal );
				const x = scale.x( xVal );
				const y = scale.y( yVal );
				if( i === 0 ) {
					ctx.moveTo( x, y );
				} else {
					ctx.lineTo( x, y );
				}
			}
			ctx.stroke();
			ctx.setLineDash( [] );
		}
	}

	function drawStartDistanceChart( canvas, graph ) {
		const rect = canvas.getBoundingClientRect();
		if( rect.width <= 0 || rect.height <= 0 ) {
			window.requestAnimationFrame( () => drawStartDistanceChart( canvas, graph ) );
			return;
		}
		const activeSeries = (graph.series || []).filter( series =>
			seriesVisible( graph.id, series.id ) );
		let maxX = 1;
		let maxY = 1;
		for( const series of activeSeries ) {
			maxX = Math.max( maxX, series.lastBounce || 0 );
			for( const sample of series.samples || [] ) {
				if( Number.isFinite( sample.distance ) ) {
					maxY = Math.max( maxY, sample.distance );
				}
			}
		}
		maxY *= 1.08;
		const scale = drawChartBase(
			canvas,
			maxX,
			maxY,
			'bounce index',
			'distance from start'
		);
		if( !scale ) {
			window.requestAnimationFrame( () => drawStartDistanceChart( canvas, graph ) );
			return;
		}
		if( activeSeries.length === 0 ) {
			const ctx = scale.ctx;
			ctx.fillStyle = '#5d6673';
			ctx.font = '14px system-ui, sans-serif';
			ctx.textAlign = 'center';
			ctx.fillText(
				'No trajectories selected',
				canvas.getBoundingClientRect().width / 2,
				canvas.getBoundingClientRect().height / 2
			);
			return;
		}
		drawSeriesLines( scale.ctx, activeSeries, scale, scale.plotW );
	}

	function drawVertexClearanceChart( canvas, graph ) {
		const rect = canvas.getBoundingClientRect();
		if( rect.width <= 0 || rect.height <= 0 ) {
			window.requestAnimationFrame( () => drawVertexClearanceChart( canvas, graph ) );
			return;
		}
		const activeSeries = (graph.series || []).filter( series =>
			seriesVisible( graph.id, series.id ) );
		let maxX = 1;
		let maxY = 0;
		for( const series of activeSeries ) {
			const lastX = graph.type === 'sorted-crossing-vertex-clearance' ?
				series.lastRank : series.lastBounce;
			maxX = Math.max( maxX, lastX || 0 );
			for( const sample of series.samples || [] ) {
				if( Number.isFinite( sample.distance ) ) {
					maxY = Math.max( maxY, sample.distance );
				}
			}
		}
		const scale = drawChartBase(
			canvas,
			maxX,
			maxY,
			graph.xAxis || 'crossing index',
			'min distance to side vertex',
			{ exactMaxY: true }
		);
		if( !scale ) {
			window.requestAnimationFrame( () => drawVertexClearanceChart( canvas, graph ) );
			return;
		}
		if( activeSeries.length === 0 ) {
			const ctx = scale.ctx;
			ctx.fillStyle = '#5d6673';
			ctx.font = '14px system-ui, sans-serif';
			ctx.textAlign = 'center';
			ctx.fillText(
				'No trajectories selected',
				canvas.getBoundingClientRect().width / 2,
				canvas.getBoundingClientRect().height / 2
			);
			return;
		}
		drawSeriesLines( scale.ctx, activeSeries, scale, scale.plotW );
	}

	function renderSeriesToggles( graph, canvas, drawChart ) {
		const toggles = div( 'series-toggles' );
		for( const series of graph.series || [] ) {
			const label = document.createElement( 'label' );
			label.className = 'series-toggle';
			const checkbox = document.createElement( 'input' );
			checkbox.type = 'checkbox';
			checkbox.checked = seriesVisible( graph.id, series.id );
			const swatch = document.createElement( 'span' );
			swatch.className = 'series-swatch';
			swatch.style.backgroundColor = cssColorForSeries( series.color );
			const text = document.createElement( 'span' );
			const count = series.pointCount == null ? series.sampleCount : series.pointCount;
			text.textContent = `${series.label} (${count} pts)`;
			checkbox.addEventListener( 'change', () => {
				setSeriesVisible( graph.id, series.id, checkbox.checked );
				window.requestAnimationFrame( () => drawChart( canvas, graph ) );
			} );
			label.append( checkbox, swatch, text );
			toggles.appendChild( label );
		}
		return toggles;
	}

	function renderVertexClearanceMeta( body, graphData, payload ) {
		const meta = div( 'meta-grid' );
		const run = payload.run || {};
		const series = graphData.series || [];
		const sampleTotal = series.reduce( (sum, item) =>
			sum + ((item.samples || []).length), 0 );
		const skippedTotal = series.reduce( (sum, item) =>
			sum + (item.skippedMissingEdgeCount || 0), 0 );
		const longest = series.reduce( (max, item) =>
			Math.max( max, item.sampleCount || 0 ), 0 );
		meta.appendChild( metaRow( 'Root type', run.rootType ) );
		meta.appendChild( metaRow( 'Level', run.level ) );
		meta.appendChild( metaRow( 'Requested bounces', run.requestedBounces ) );
		meta.appendChild( metaRow( 'Trajectories', series.length ) );
		meta.appendChild( metaRow( 'Longest series', longest ) );
		meta.appendChild( metaRow( 'Total samples', sampleTotal ) );
		meta.appendChild( metaRow( 'Skipped crossings', skippedTotal ) );
		for( const item of series ) {
			const settings = item.settings || {};
			meta.appendChild( metaRow(
				item.label,
				`${shortStatus( item.status )}, ${item.sampleCount} crossings, edge ${settings.startEdge}, t ${fmt( settings.edgeParameter )}, angle ${fmt( settings.angleDegrees )}`
			) );
		}
		meta.appendChild( metaRow( 'Draw mode', sampleTotal > 2500 ? 'decimated' : 'full' ) );
		body.appendChild( meta );
	}

	const graphRegistry = [
		{
			id: 'red-blue-distance',
			title: 'Red/Blue Distance by Bounce',
			applicability: function (payload) {
				return payload && payload.graphs &&
					payload.graphs.find( graph => graph.id === 'red-blue-distance' );
			},
			render: function (container, graphData, payload) {
				const title = document.createElement( 'h2' );
				title.textContent = this.title;
				container.appendChild( title );

				if( !graphData.available ) {
					container.appendChild( div( 'empty', graphData.reason || 'requires double trajectory' ) );
					return;
				}

				const body = div( 'graph-card' );
				const chartWrap = document.createElement( 'div' );
				const canvas = document.createElement( 'canvas' );
				chartWrap.appendChild( canvas );
				body.appendChild( chartWrap );

				const meta = div( 'meta-grid' );
				const run = payload.run || {};
				const fit = graphData.fit || {};
				const red = (run.trajectories || []).find( item => item.color === 'red' ) || {};
				const blue = (run.trajectories || []).find( item => item.color === 'blue' ) || {};
				meta.appendChild( metaRow( 'Root type', run.rootType ) );
				meta.appendChild( metaRow( 'Level', run.level ) );
				meta.appendChild( metaRow( 'Requested bounces', run.requestedBounces ) );
				meta.appendChild( metaRow( 'Red points', graphData.redPointCount ) );
				meta.appendChild( metaRow( 'Blue points', graphData.bluePointCount ) );
				meta.appendChild( metaRow( 'Displayed samples', graphData.sampleCount ) );
				meta.appendChild( metaRow( 'Last bounce shown', graphData.lastBounce ) );
				meta.appendChild( metaRow( 'Red status', shortStatus( graphData.redStatus ) ) );
				meta.appendChild( metaRow( 'Blue status', shortStatus( graphData.blueStatus ) ) );
				meta.appendChild( metaRow( 'Red start', `edge ${red.startEdge}, t ${fmt( red.edgeParameter )}, angle ${fmt( red.angleDegrees )}` ) );
				meta.appendChild( metaRow( 'Blue start', `edge ${blue.startEdge}, t ${fmt( blue.edgeParameter )}, angle ${fmt( blue.angleDegrees )}` ) );
				meta.appendChild( metaRow( 'File', payload.fileName ) );
				meta.appendChild( metaRow( 'Fit', `distance ≈ ${fmt( fit.A )} * exp(${fmt( fit.B )} * bounce)` ) );
				meta.appendChild( metaRow( 'r2', fmt( fit.r2, 6 ) ) );
				meta.appendChild( metaRow( 'Fit samples', fit.fittedSampleCount ) );
				meta.appendChild( metaRow( 'Skipped', fit.skippedNonPositiveOrNonFiniteCount ) );
				meta.appendChild( metaRow( 'Draw mode', (graphData.samples || []).length > 2500 ? 'decimated' : 'full' ) );
				body.appendChild( meta );
				container.appendChild( body );
				window.requestAnimationFrame( () => drawDistanceChart( canvas, graphData ) );
			}
		},
		{
			id: 'trajectory-start-distance',
			title: 'Distance from Start by Bounce',
			applicability: function (payload) {
				return payload && payload.graphs &&
					payload.graphs.find( graph => graph.id === 'trajectory-start-distance' );
			},
			render: function (container, graphData, payload) {
				const title = document.createElement( 'h2' );
				title.textContent = this.title;
				container.appendChild( title );

				if( !graphData.available ) {
					container.appendChild( div( 'empty', graphData.reason || 'requires at least one trajectory' ) );
					return;
				}

				const body = div( 'graph-card' );
				const chartWrap = document.createElement( 'div' );
				const canvas = document.createElement( 'canvas' );
				chartWrap.appendChild( renderSeriesToggles( graphData, canvas, drawStartDistanceChart ) );
				chartWrap.appendChild( canvas );
				body.appendChild( chartWrap );

				const meta = div( 'meta-grid' );
				const run = payload.run || {};
				const series = graphData.series || [];
				const sampleTotal = series.reduce( (sum, item) =>
					sum + ((item.samples || []).length), 0 );
				const longest = series.reduce( (max, item) =>
					Math.max( max, item.pointCount || 0 ), 0 );
				meta.appendChild( metaRow( 'Root type', run.rootType ) );
				meta.appendChild( metaRow( 'Level', run.level ) );
				meta.appendChild( metaRow( 'Requested bounces', run.requestedBounces ) );
				meta.appendChild( metaRow( 'Trajectories', series.length ) );
				meta.appendChild( metaRow( 'Longest series', longest ) );
				meta.appendChild( metaRow( 'Total samples', sampleTotal ) );
				for( const item of series ) {
					const settings = item.settings || {};
					meta.appendChild( metaRow(
						item.label,
						`${shortStatus( item.status )}, ${item.pointCount} pts, edge ${settings.startEdge}, t ${fmt( settings.edgeParameter )}, angle ${fmt( settings.angleDegrees )}`
					) );
				}
				meta.appendChild( metaRow( 'Draw mode', sampleTotal > 2500 ? 'decimated' : 'full' ) );
				body.appendChild( meta );
				container.appendChild( body );
				window.requestAnimationFrame( () => drawStartDistanceChart( canvas, graphData ) );
			}
		},
		{
			id: 'crossing-vertex-clearance',
			title: 'Crossing Distance to Nearest Side Vertex by Bounce',
			applicability: function (payload) {
				return payload && payload.graphs &&
					payload.graphs.find( graph => graph.id === 'crossing-vertex-clearance' );
			},
			render: function (container, graphData, payload) {
				const title = document.createElement( 'h2' );
				title.textContent = this.title;
				container.appendChild( title );

				if( !graphData.available ) {
					container.appendChild( div( 'empty', graphData.reason || 'requires at least one trajectory' ) );
					return;
				}

				const body = div( 'graph-card' );
				const chartWrap = document.createElement( 'div' );
				const canvas = document.createElement( 'canvas' );
				chartWrap.appendChild( renderSeriesToggles( graphData, canvas, drawVertexClearanceChart ) );
				chartWrap.appendChild( canvas );
				body.appendChild( chartWrap );

				renderVertexClearanceMeta( body, graphData, payload );
				container.appendChild( body );
				window.requestAnimationFrame( () => drawVertexClearanceChart( canvas, graphData ) );
			}
		},
		{
			id: 'sorted-crossing-vertex-clearance',
			title: 'Sorted Crossing Distance to Nearest Side Vertex',
			applicability: function (payload) {
				return payload && payload.graphs &&
					payload.graphs.find( graph => graph.id === 'sorted-crossing-vertex-clearance' );
			},
			render: function (container, graphData, payload) {
				const title = document.createElement( 'h2' );
				title.textContent = this.title;
				container.appendChild( title );

				if( !graphData.available ) {
					container.appendChild( div( 'empty', graphData.reason || 'requires at least one trajectory' ) );
					return;
				}

				const body = div( 'graph-card' );
				const chartWrap = document.createElement( 'div' );
				const canvas = document.createElement( 'canvas' );
				chartWrap.appendChild( renderSeriesToggles( graphData, canvas, drawVertexClearanceChart ) );
				chartWrap.appendChild( canvas );
				body.appendChild( chartWrap );

				renderVertexClearanceMeta( body, graphData, payload );
				container.appendChild( body );
				window.requestAnimationFrame( () => drawVertexClearanceChart( canvas, graphData ) );
			}
		}
	];

	function renderPayload( payload ) {
		clear( graphsEl );
		statusEl.classList.remove( 'error' );
		if( !payload || payload.available === false ) {
			statusEl.textContent = 'No diagnostics are available yet.';
			saveButton.disabled = true;
			graphsEl.appendChild( div( 'card empty', 'Run a server-backed trajectory to create diagnostics.' ) );
			renderSequences( payload );
			return;
		}
		statusEl.textContent = payload.saved ?
			`Latest run ${payload.runId} at ${payload.timestamp}; saved as ${payload.fileName}` :
			`Latest run ${payload.runId} at ${payload.timestamp}`;
		saveButton.disabled = false;
		for( const graphDef of graphRegistry ) {
			const graphData = graphDef.applicability( payload );
			const card = div( 'card' );
			graphsEl.appendChild( card );
			if( graphData ) {
				graphDef.render( card, graphData, payload );
			} else {
				const title = document.createElement( 'h2' );
				title.textContent = graphDef.title;
				card.appendChild( title );
				card.appendChild( div( 'empty', 'No data for this graph in the latest run.' ) );
			}
		}
		renderSequences( payload );
	}

	async function loadLatest( options ) {
		options = options || {};
		try {
			const headers = {};
			if( latestETag && !options.force ) {
				headers['If-None-Match'] = latestETag;
			}
			const response = await fetch( '/api/diagnostics/latest', {
				cache: 'no-cache',
				headers
			} );
			if( response.status === 304 ) {
				return;
			}
			if( !response.ok ) {
				throw new Error( `HTTP ${response.status}` );
			}
			latestETag = response.headers.get( 'ETag' );
			latestPayload = await response.json();
			renderPayload( latestPayload );
		} catch( err ) {
			statusEl.textContent = 'Could not load diagnostics.';
			statusEl.classList.add( 'error' );
			saveButton.disabled = true;
			clear( graphsEl );
			graphsEl.appendChild( div( 'card empty', err.message || String( err ) ) );
		}
	}

	async function loadMetatileSequencesForLatest() {
		if( !latestPayload || latestPayload.available === false || hasMetatileSequences( latestPayload ) ) {
			return;
		}
		const runId = latestPayload.runId || 'latest';
		if( metatileSequenceRequestRunId === runId ) {
			return;
		}
		metatileSequenceRequestRunId = runId;
		renderSequences( latestPayload );
		statusEl.classList.remove( 'error' );
		statusEl.textContent = `Latest run ${latestPayload.runId} at ${latestPayload.timestamp}; building metatile sequence`;
		try {
			const response = await fetch( '/api/diagnostics/metatile-sequence', {
				method: 'POST',
				cache: 'no-store',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify( {} )
			} );
			if( !response.ok ) {
				throw new Error( `HTTP ${response.status}` );
			}
			const result = await response.json();
			if( result.available === false ) {
				throw new Error( result.error || 'Metatile sequences are unavailable.' );
			}
			if( latestPayload && latestPayload.runId === runId ) {
				latestPayload.symbolic = latestPayload.symbolic || {};
				latestPayload.symbolic.metatileSequences = result;
				latestETag = null;
				metatileSequenceRequestRunId = null;
				renderPayload( latestPayload );
			}
		} catch( err ) {
			statusEl.textContent = `Could not build metatile sequence: ${err.message || String( err )}`;
			statusEl.classList.add( 'error' );
			metatileSequenceRequestRunId = null;
		}
	}

	async function saveLatestDiagnostics() {
		if( !latestPayload || latestPayload.available === false ) {
			return;
		}
		saveButton.disabled = true;
		try {
			const response = await fetch( '/api/diagnostics/save-latest', {
				method: 'POST',
				cache: 'no-store'
			} );
			if( !response.ok ) {
				throw new Error( `HTTP ${response.status}` );
			}
			const result = await response.json();
			if( !result.saved ) {
				throw new Error( result.error || 'No diagnostics were saved.' );
			}
			statusEl.classList.remove( 'error' );
			statusEl.textContent = `Saved ${result.fileName}`;
			latestETag = null;
			await loadLatest( { force: true } );
		} catch( err ) {
			statusEl.textContent = `Could not save diagnostics: ${err.message || String( err )}`;
			statusEl.classList.add( 'error' );
		} finally {
			saveButton.disabled = !(latestPayload && latestPayload.available !== false);
		}
	}

	refreshButton.addEventListener( 'click', () => loadLatest( { force: true } ) );
	saveButton.addEventListener( 'click', saveLatestDiagnostics );
	graphsTab.addEventListener( 'click', () => setActiveTab( 'graphs' ) );
	sequencesTab.addEventListener( 'click', () => setActiveTab( 'sequences' ) );
	window.addEventListener( 'resize', () => {
		if( latestPayload ) {
			renderPayload( latestPayload );
		}
	} );
	loadLatest();
	setInterval( loadLatest, pollMs );
}());
