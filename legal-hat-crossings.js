(function( root ) {
	const tokens = [
		'0->4',
		'0->5',
		'0->8',
		'0->9',
		'1->2',
		'1->3',
		'1->7',
		'1->10',
		'1->11',
		'2->1',
		'2->2',
		'2->6',
		'2->10',
		'2->11',
		'3->1',
		'3->6',
		'3->10',
		'3->11',
		'4->0',
		'4->5',
		'4->9',
		'4->12',
		'5->0',
		'5->4',
		'5->8',
		'5->12',
		'6->2',
		'6->3',
		'6->7',
		'6->10',
		'6->11',
		'7->1',
		'7->6',
		'7->10',
		'7->11',
		'8->0',
		'8->5',
		'8->9',
		'8->12',
		'9->0',
		'9->4',
		'9->8',
		'9->12',
		'10->1',
		'10->2',
		'10->3',
		'10->6',
		'10->7',
		'11->1',
		'11->2',
		'11->3',
		'11->6',
		'11->7',
		'12->4',
		'12->5',
		'12->8',
		'12->9'
	];
	const tokenSet = new Set( tokens );

	function tokenForCrossing( crossing ) {
		return `${crossing.edgeIndex}->${crossing.nextEdgeIndex == null ? '?' : crossing.nextEdgeIndex}`;
	}

	function validateCrossings( crossings ) {
		const invalid = [];
		for( let idx = 0; idx < (crossings || []).length; ++idx ) {
			const token = tokenForCrossing( crossings[idx] );
			if( !tokenSet.has( token ) ) {
				invalid.push( {
					index: idx,
					bounce: idx + 1,
					token
				} );
			}
		}
		return {
			valid: invalid.length === 0,
			legalTokenCount: tokens.length,
			invalidCount: invalid.length,
			firstInvalid: invalid.length > 0 ? invalid[0] : null,
			invalid
		};
	}

	const api = {
		tokens: tokens.slice(),
		tokenSet,
		tokenForCrossing,
		validateCrossings
	};

	if( typeof module !== 'undefined' && module.exports ) {
		module.exports = api;
	}
	root.HatBilliardsLegalCrossings = api;
})( typeof globalThis !== 'undefined' ? globalThis : this );
