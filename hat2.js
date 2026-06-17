// CHATGPT: Global transform from model coordinates to screen coordinates.
// CHATGPT: This is a 2D affine transform stored as [a, b, c, d, e, f],
// CHATGPT: meaning x' = a*x + b*y + c and y' = d*x + e*y + f.
let to_screen = [20, 0, 0, 0, -20, 0];

// CHATGPT: Line-width scale factor. This is adjusted during zooming so strokes
// CHATGPT: stay visually proportional.
let lw_scale = 1;

// CHATGPT: `tiles` will hold the current four metatiles [H, T, P, F].
let tiles;

// CHATGPT: Current substitution depth. Starts at 1 and increments when
// CHATGPT: "Build Supertiles" is clicked.
let level;

// CHATGPT: Variables used while scaling/zooming by mouse drag.
let scale_centre;
let scale_start;
let scale_ts;

// CHATGPT: p5.js UI elements. These become actual buttons/radio controls in setup().
let reset_button;
let subst_button;
let translate_button;
let scale_button;
let draw_hats;
let metatile_level_buttons = [];
let radio;
let start_edge_input;
let edge_parameter_input;
let angle_input;
let blue_start_edge_input;
let blue_edge_parameter_input;
let blue_angle_input;
let add_trajectory_button;
let bounce_input;
let max_expansion_input;
let patch_radius_input;
let run_button;
let load_trajectory_input;
let simulator_tiling;
let simulator_result;
let simulator_results = [];
let simulator_server_payload = null;
let simulator_patch_request_serial = 0;
let blue_trajectory_enabled = false;
let ui_elements = [];
let blue_control_elements = [];
let blue_controls_height = 0;
const metatile_outline_cache = new Map();
const simulator_base_level = 1;
const simulator_max_level = 6;

// CHATGPT: Mouse/UI state flags.
let dragging = false;
let uibox = true;

// CHATGPT: Height of the UI panel. Increased as controls are added.
let box_height = 10;

// CHATGPT: Counter used to create unique SVG IDs.
let svg_serial = 0;

// CHATGPT: p5.js color object for black. Assigned in setup().
let black;

// CHATGPT: Generate a unique SVG element id like t00000, t00001, ...
function getSVGID()
{
	const ret = 't' + String(svg_serial).padStart( 5, '0' );
	++svg_serial;
	return ret;
}

// CHATGPT: Draw a polygon to the p5.js canvas.
// CHATGPT: `shape` is an array of points.
// CHATGPT: `T` is the affine transform applied to each point before drawing.
// CHATGPT: `f` is fill color or null, `s` is stroke color or null, `w` is stroke width.
function drawPolygon( shape, T, f, s, w )
{
	if( f != null ) {
		fill( f );
	} else {
		noFill();
	}
	if( s != null ) {
		stroke( s );
		strokeWeight( w * lw_scale );
	} else {
		noStroke();
	}
	beginShape();
	for( let p of shape ) {
		// CHATGPT: transPt(T, p) applies affine transform T to point p.
		const tp = transPt( T, p );
		vertex( tp.x, tp.y );
	}
	endShape( CLOSE );
}

// CHATGPT: Convert a polygon to one SVG <polygon> line.
// CHATGPT: Used only for SVG export, not normal canvas drawing.
function polygonToSVG( shape, id, f, s, w )
{
	let verts = '';
	for( let p of shape ) {
		if( verts.length > 0 ) {
			verts = verts + ' ';
		}
		verts = verts + p.x + ',' + p.y;
	}

	let ids = '';
	if( id != null ) {
		ids = ` id="${id}"`;
	}

	let str = ' stroke="none"';
	if( s != null ) {
		// CHATGPT: red(s), green(s), blue(s) are p5.js color-component functions.
		str = ` stroke="rgb(${red(s)},${green(s)},${blue(s)})" stroke-width="${w}"`;
	}

	let fil = ' fill="none"';
	if( f != null ) {
		fil = ` fill="rgb(${red(f)},${green(f)},${blue(f)})"`;
	}

	return `    <polygon${ids} points="${verts}"${str}${fil}/>`;
}

// CHATGPT: Return an SVG <use> element that reuses an existing SVG definition.
// CHATGPT: SVG wants matrix(a d b e c f), while this code stores [a,b,c,d,e,f].
function getSVGInstance( id, T )
{
	return `    <use xlink:href="#${id}" transform="matrix(${T[0]} ${T[3]} ${T[1]} ${T[4]} ${T[2]} ${T[5]})"/>`;
}

// The base level of the scene, a single hat tile, including a label
// for colouring
// CHATGPT: A HatTile is one actual bottom-level hat tile.
// CHATGPT: It has no children; it only knows how to draw/export itself.
class HatTile
{
	constructor( label )
	{
		// CHATGPT: Inside a class method, `this` means the particular object
		// CHATGPT: being constructed or used. Here, `this.label` is the label
		// CHATGPT: stored on this specific HatTile object.
		this.label = label;
		this.svg_id = null;
	}

	// CHATGPT: Draw this individual hat tile.
	// CHATGPT: S is the accumulated transform placing the hat in the scene.
	draw( S, level )
	{
		drawPolygon( 
			hat_outline, S, null, black, 1 );
	}

	// CHATGPT: Clear cached SVG id so a future SVG export can assign a fresh one.
	resetSVG()
	{
		this.svg_id = null;
	}

	// CHATGPT: Add this hat's SVG polygon definition to `stream`, unless already added.
	buildSVGDefs( stream, sc )
	{
		if( this.svg_id != null ) {
			return;
		}

		this.svg_id = getSVGID();
		stream.push( polygonToSVG( hat_outline, this.svg_id, 
			null, black, lw_scale/sc ) );
	}

	// CHATGPT: A HatTile has no separate stroke group in SVG export.
	getSVGStrokeID()
	{
		return null;
	}

	// CHATGPT: The fill id is the SVG polygon id created in buildSVGDefs().
	getSVGFillID()
	{
		return this.svg_id;
	}

	// CHATGPT: Export this hat as a text line containing its label and transform.
	// CHATGPT: This is the important path for Save Matrices.
	getText( stream, T )
	{
		// Write out the top two rows of an affine transformation matrix
		// giving the location of this hat, together with the type of 
		// this tile.
		stream.push( `${this.label} ${T[0]} ${T[1]} ${T[2]} ${T[3]} ${T[4]} ${T[5]}` )
	}
}

// A group that collects a list of transformed children and an outline
// CHATGPT: A MetaTile is a recursive container.
// CHATGPT: It can contain HatTiles or other MetaTiles, each with a transform.
class MetaTile
{
	constructor( shape, width )
	{
		// CHATGPT: `shape` is this metatile's outline polygon in local coordinates.
		this.shape = shape;

		// CHATGPT: Width used when drawing this metatile's outline.
		this.width = width;

		// CHATGPT: Each child is stored as { T : transform, geom : geometryObject }.
		this.children = [];

		// CHATGPT: Cached SVG id for export.
		this.svg_id = null;
	}

	// CHATGPT: Add one transformed child to this metatile.
	addChild( T, geom )
	{
		this.children.push( { T : T, geom : geom } );
	}

	// CHATGPT: Return vertex i of child n after applying that child's transform.
	evalChild( n, i )
	{
		return transPt( this.children[n].T, this.children[n].geom.shape[i] );
	}

	// CHATGPT: Draw this metatile recursively.
	// CHATGPT: If level > 0, draw children. If level == 0, draw only this outline.
	draw( S, level )
	{
		if( level > 0 ) {
			for( let g of this.children ) {
				// CHATGPT: mul(S, g.T) composes transforms.
				// CHATGPT: Child-local coordinates -> this metatile -> screen/world.
				g.geom.draw( mul( S, g.T ), level - 1 );
			}
		} else {
			drawPolygon( this.shape, S, null, black, this.width );
		}
	}

	// CHATGPT: Move the metatile so the average of its outline vertices is at the origin.
	// CHATGPT: Child transforms are adjusted so the same geometry stays in place
	// CHATGPT: relative to the new local origin.
	/*recentre()
	{
		let cx = 0;
		let cy = 0;
		for( let p of this.shape ) {
			cx += p.x;
			cy += p.y;
		}
		cx /= this.shape.length;
		cy /= this.shape.length;
		const tr = pt( -cx, -cy );

		for( let idx = 0; idx < this.shape.length; ++idx ) {
			this.shape[idx] = padd( this.shape[idx], tr );
		}

		const M = ttrans( -cx, -cy );
		for( let ch of this.children ) {
			ch.T = mul( M, ch.T );
		}
	}*/

	// CHATGPT: Recursively clear SVG ids for this metatile and its descendants.
	resetSVG()
	{
		for( let ch of this.children ) {
			ch.geom.resetSVG();
		}
		this.svg_id = null;
	}

	// CHATGPT: Recursively build SVG definitions.
	// CHATGPT: Fill groups and stroke groups are separated so fills appear under outlines.
	buildSVGDefs( stream, sc )
	{
		if( this.svg_id != null ) {
			return;
		}

		this.svg_id = getSVGID();

		for( let ch of this.children ) {
			ch.geom.buildSVGDefs( stream, sc );
		}

		// Construct a fill group that must live at a logical lowest
		// layer in the draw order.

		stream.push( `  <g id="${this.getSVGFillID()}">` );
		for( let ch of this.children ) {
			const fid = ch.geom.getSVGFillID();
			if( fid != null ) {
				stream.push( getSVGInstance( fid, ch.T ) );
			}
		}
		stream.push( '  </g>' );

		// Construct a stroke group that must live above all fill groups.

		stream.push( `  <g id="${this.getSVGStrokeID()}">` );
		for( let ch of this.children ) {
			const sid = ch.geom.getSVGStrokeID();
			if( sid != null ) {
				stream.push( getSVGInstance( sid, ch.T ) );
			}
		}
		stream.push( polygonToSVG( this.shape, 
			null, null, black, this.width*lw_scale/sc ) );

		stream.push( '  </g>' );
	}

	// CHATGPT: SVG id for this metatile's stroke group.
	getSVGStrokeID()
	{
		return `${this.svg_id}s`;
	}

	// CHATGPT: SVG id for this metatile's fill group.
	getSVGFillID()
	{
		return `${this.svg_id}f`;
	}

	// CHATGPT: Recursively export all bottom-level hats.
	// CHATGPT: T is the accumulated transform from the root down to this metatile.
	getText( stream, T )
	{
		for( let g of this.children ) {
			g.geom.getText( stream, mul( T, g.T ) );
		}
	}
}
// CHATGPT: These are five HatTile objects with different labels.
// CHATGPT: They all use the same geometric hat outline, but the label controls color/export type.
const H1_hat = new HatTile( 'H1' );
const H_hat = new HatTile( 'H' );
const T_hat = new HatTile( 'T' );
const P_hat = new HatTile( 'P' );
const F_hat = new HatTile( 'F' );

// CHATGPT: H_init is the initial/base H metatile.
// CHATGPT: The pattern `(function () { ... }())` defines a function and immediately runs it.
// CHATGPT: This creates local variables like H_outline and meta without leaving them global.
const H_init = (function () {
	// CHATGPT: Outline polygon of the initial H metatile.
	const H_outline = [
		pt( 0, 0 ), pt( 4, 0 ), pt( 4.5, hr3 ),
		pt( 2.5, 5 * hr3 ), pt( 1.5, 5 * hr3 ), pt( -0.5, hr3 ) ];

	// CHATGPT: Make a MetaTile with this outline and outline stroke width 2.
	const meta = new MetaTile( H_outline, 2 );

	// CHATGPT: Add an ordinary H hat into the H metatile.
	// CHATGPT: matchTwo(a,b,c,d) computes an affine transform placing edge a-b onto edge c-d.
	meta.addChild( 
		matchTwo( 
			hat_outline[5], hat_outline[7], H_outline[5], H_outline[0] ),
		H_hat );

	// CHATGPT: Add another H hat, fitted to a different edge of the H metatile outline.
	meta.addChild( 
		matchTwo( 
			hat_outline[9], hat_outline[11], H_outline[1], H_outline[2] ),
		H_hat );

	// CHATGPT: Add a third H hat.
	meta.addChild( 
		matchTwo( 
			hat_outline[5], hat_outline[7], H_outline[3], H_outline[4] ),
		H_hat );

	// CHATGPT: Add the special H1 hat using an explicit affine transform.
	// CHATGPT: mul(A,B) composes transforms. ttrans(x,y) is translation.
	meta.addChild( 
		mul( ttrans( 2.5, hr3 ), 
			mul( 
				[-0.5,-hr3,0,hr3,-0.5,0],
				[0.5,0,0,0,-0.5,0] ) ),
		H1_hat );

	return meta; }());

// CHATGPT: Initial/base T metatile.
const T_init = (function () {
	// CHATGPT: Equilateral-triangle-like outline for T.
	const T_outline = [
		pt( 0, 0 ), pt( 3, 0 ), pt( 1.5, 3 * hr3 ) ];
	const meta = new MetaTile( T_outline, 2 );

	// CHATGPT: Add one ordinary T-labeled hat inside the T metatile.
	meta.addChild( 
		[0.5, 0, 0.5, 0, 0.5, hr3],
		T_hat );

	return meta; }());

// CHATGPT: Initial/base P metatile.
const P_init = (function () {
	// CHATGPT: Parallelogram-like outline for P.
	const P_outline = [
		pt( 0, 0 ), pt( 4, 0 ), 
		pt( 3, 2 * hr3 ), pt( -1, 2 * hr3 ) ];
	const meta = new MetaTile( P_outline, 2 );

	// CHATGPT: Add first P-labeled hat.
	meta.addChild( 
		[0.5, 0, 1.5, 0, 0.5, hr3],
		P_hat );

	// CHATGPT: Add second P-labeled hat with a composed affine transform.
	meta.addChild( 
		mul( ttrans( 0, 2 * hr3 ), 
			mul( [0.5, hr3, 0, -hr3, 0.5, 0],
				 [0.5, 0.0, 0.0, 0.0, 0.5, 0.0] ) ),
		P_hat );

	return meta; }());

// CHATGPT: Initial/base F metatile.
const F_init = (function () {
	// CHATGPT: Pentagonal/triskelion-related outline for F.
	const F_outline = [
		pt( 0, 0 ), pt( 3, 0 ), 
		pt( 3.5, hr3 ), pt( 3, 2 * hr3 ), pt( -1, 2 * hr3 ) ];
	const meta = new MetaTile( F_outline, 2 );

	// CHATGPT: Add first F-labeled hat.
	meta.addChild( 
		[0.5, 0, 1.5, 0, 0.5, hr3],
		F_hat );

	// CHATGPT: Add second F-labeled hat.
	meta.addChild( 
		mul( ttrans( 0, 2 * hr3 ), 
			mul( [0.5, hr3, 0, -hr3, 0.5, 0],
				 [0.5, 0.0, 0.0, 0.0, 0.5, 0.0] ) ),
		F_hat );

	return meta; }());

// CHATGPT: Build the large intermediate substitution patch from the current H/T/P/F metatiles.
// CHATGPT: This does not directly return the next four metatiles. Instead, it creates
// CHATGPT: a larger patch that constructMetatiles(...) later regroups.
function constructPatch( H, T, P, F )
{
	// CHATGPT: These hard-coded rules describe how to place H/T/P/F metatiles.
	// CHATGPT:
	// CHATGPT: Rule format 1:
	// CHATGPT:   ['H']
	// CHATGPT: means place an H at the identity transform.
	// CHATGPT:
	// CHATGPT: Rule format 2:
	// CHATGPT:   [existingChildIndex, existingEdgeIndex, newShapeLabel, newShapeEdgeIndex]
	// CHATGPT: means attach a new shape to a specific edge of an existing child.
	// CHATGPT:
	// CHATGPT: Rule format 3:
	// CHATGPT:   [childPIndex, vertexPIndex, childQIndex, vertexQIndex, newShapeLabel, newShapeEdgeIndex]
	// CHATGPT: means place a new shape using two already-existing patch vertices.
	const rules = [
		['H'],
		[0, 0, 'P', 2],
		[1, 0, 'H', 2],
		[2, 0, 'P', 2],
		[3, 0, 'H', 2],
		[4, 4, 'P', 2],
		[0, 4, 'F', 3],
		[2, 4, 'F', 3],
		[4, 1, 3, 2, 'F', 0],
		[8, 3, 'H', 0],
		[9, 2, 'P', 0],
		[10, 2, 'H', 0],
		[11, 4, 'P', 2],
		[12, 0, 'H', 2],
		[13, 0, 'F', 3],
		[14, 2, 'F', 1],
		[15, 3, 'H', 4],
		[8, 2, 'F', 1], 
		[17, 3, 'H', 0],
		[18, 2, 'P', 0],
		[19, 2, 'H', 2],
		[20, 4, 'F', 3],
		[20, 0, 'P', 2],
		[22, 0, 'H', 2],
		[23, 4, 'F', 3],
		[23, 0, 'F', 3],
		[16, 0, 'P', 2],
		[9, 4, 0, 2, 'T', 2],
		[4, 0, 'F', 3] 
		];

	// CHATGPT: This creates the patch object that will receive all placed children.
	// CHATGPT: Notice that the original code does not write `let ret`.
	// CHATGPT: I am not changing that here, but in JavaScript it means `ret`
	// CHATGPT: becomes a global variable in non-strict mode.
	ret = new MetaTile( [], H.width );

	// CHATGPT: Dictionary from labels in the rules to actual metatile objects.
	// CHATGPT: Like `ret`, this is also undeclared in the original code.
	shapes = { 'H' : H, 'T' : T, 'P' : P, 'F' : F };

	// CHATGPT: Apply each placement rule in order.
	for( let r of rules ) {
		if( r.length == 1 ) {
			// CHATGPT: Place the first shape at the identity transform.
			ret.addChild( ident, shapes[r[0]] );
		} else if( r.length == 4 ) {
			// CHATGPT: Attach a new shape to an edge of an already-placed child.
			const poly = ret.children[r[0]].geom.shape;
			const T = ret.children[r[0]].T;

			// CHATGPT: Compute the two world/patch-space endpoints of the target edge.
			// CHATGPT: The order P,Q is intentionally reversed relative to the existing edge.
			const P = transPt( T, poly[(r[1]+1)%poly.length] );
			const Q = transPt( T, poly[r[1]] );

			// CHATGPT: Get the new shape and its outline.
			const nshp = shapes[r[2]];
			const npoly = nshp.shape;

			// CHATGPT: Place the new shape so its chosen edge matches target edge P-Q.
			ret.addChild(
				matchTwo( npoly[r[3]], npoly[(r[3]+1)%npoly.length], P, Q ),
				nshp );
		} else {
			// CHATGPT: More constrained placement: use vertices from two existing children.
			const chP = ret.children[r[0]];
			const chQ = ret.children[r[2]];

			// CHATGPT: Compute the two target points in patch coordinates.
			const P = transPt( chQ.T, chQ.geom.shape[r[3]] );
			const Q = transPt( chP.T, chP.geom.shape[r[1]] );

			// CHATGPT: Get the new shape and its outline.
			const nshp = shapes[r[4]];
			const npoly = nshp.shape;

			// CHATGPT: Place the new shape so one of its edges lands on P-Q.
			ret.addChild(
				matchTwo( npoly[r[5]], npoly[(r[5]+1)%npoly.length], P, Q ),
				nshp );
		}
	}

	return ret;
}
// CHATGPT: Given the intermediate patch from constructPatch(...), extract/regroup
// CHATGPT: selected children into the next generation of H/T/P/F metatiles.
// CHATGPT: This is the substitution step that makes the tiling grow hierarchically.
function constructMetatiles( patch )
{
	// CHATGPT: Pick specific vertices from the patch. These points are used as
	// CHATGPT: geometric anchors for the outlines of the next-level metatiles.
	const bps1 = patch.evalChild( 8, 2 );
	const bps2 = patch.evalChild( 21, 2 );

	// CHATGPT: Rotate bps2 around bps1 by -120 degrees, then use the result
	// CHATGPT: as part of a line-intersection construction below.
	const rbps = transPt( rotAbout( bps1, -2.0*PI/3.0 ), bps2 );

	const p72 = patch.evalChild( 7, 2 );
	const p252 = patch.evalChild( 25, 2 );

	// CHATGPT: Compute an intersection point used as a corner of the new H/P outlines.
	const llc = intersect( bps1, rbps,
		patch.evalChild( 6, 2 ), p72 );

	// CHATGPT: Start with a vector from llc to another patch vertex.
	let w = psub( patch.evalChild( 6, 2 ), llc );

	// CHATGPT: Build the polygon outline of the next-level H metatile.
	const new_H_outline = [llc, bps1];
	w = transPt( trot( -PI/3 ), w );
	new_H_outline.push( padd( new_H_outline[1], w ) );
	new_H_outline.push( patch.evalChild( 14, 2 ) );
	w = transPt( trot( -PI/3 ), w );
	new_H_outline.push( psub( new_H_outline[3], w ) );
	new_H_outline.push( patch.evalChild( 6, 2 ) );

	// CHATGPT: Create the next-level H metatile.
	// CHATGPT: Its outline stroke width doubles each substitution level.
	const new_H = new MetaTile( new_H_outline, patch.width * 2 );

	// CHATGPT: These selected patch children become the contents of the new H.
	for( let ch of [0, 9, 16, 27, 26, 6, 1, 8, 10, 15] ) {
		new_H.addChild( patch.children[ch].T, patch.children[ch].geom );
	}

	// CHATGPT: Build the next-level P metatile outline and contents.
	const new_P_outline = [ p72, padd( p72, psub( bps1, llc ) ), bps1, llc ];
	const new_P = new MetaTile( new_P_outline, patch.width * 2 );
	for( let ch of [7,2,3,4,28] ) {
		new_P.addChild( patch.children[ch].T, patch.children[ch].geom );
	}

	// CHATGPT: Build the next-level F metatile outline and contents.
	const new_F_outline = [ 
		bps2, patch.evalChild( 24, 2 ), patch.evalChild( 25, 0 ),
		p252, padd( p252, psub( llc, bps1 ) ) ];
	const new_F = new MetaTile( new_F_outline, patch.width * 2 );
	for( let ch of [21,20,22,23,24,25] ) {
		new_F.addChild( patch.children[ch].T, patch.children[ch].geom );
	}
	
	// CHATGPT: Build the next-level T metatile.
	const AAA = new_H_outline[2];
	const BBB = padd( new_H_outline[1], 
		psub( new_H_outline[4], new_H_outline[5] ) );
	const CCC = transPt( rotAbout( BBB, -PI/3 ), AAA );
	const new_T_outline = [BBB,CCC,AAA];
	const new_T = new MetaTile( new_T_outline, patch.width * 2 );

	// CHATGPT: The next-level T contains one selected child from the patch.
	new_T.addChild( patch.children[11].T, patch.children[11].geom );

	// CHATGPT: Recenter each new metatile so its local coordinate origin is near
	// CHATGPT: the center of its outline. This also updates child transforms.
	/*new_H.recentre();
	new_P.recentre();
	new_F.recentre();
	new_T.recentre();*/

	// CHATGPT: Return the new current set of four metatiles.
	return [new_H, new_T, new_P, new_F]
}

// CHATGPT: A button is considered active if its CSS border string is nonempty.
// CHATGPT: This code uses the presence of a border as a simple on/off state.
function isButtonActive( but )
{
	return but.elt.style.border.length > 0;
}

// CHATGPT: Set a button's active state by changing its border style.
function setButtonActive( but, b )
{
	but.elt.style.border = (b ? "3px solid black" : "");
}

// CHATGPT: Convenience helper for creating a UI button in the left panel.
// CHATGPT: `name` is the button text; `f` is the function called when clicked.
function addButton( name, f )
{
	const ret = createButton( name );
	ret.position( 10, box_height );
	ret.size( 125, 25 );
	ret.mousePressed( f );
	ui_elements.push( ret );
	box_height += 30;

	return ret;
}

function currentRootType()
{
	return radio ? radio.value() : 'H';
}

function rebuildSimulatorTiling()
{
	simulator_tiling = HatBilliards.buildTiling( {
		rootType: currentRootType(),
		level: simulator_base_level
	} );
	setResultCollection( [] );
	simulator_server_payload = null;
}

function numericInput( label, value, width, attrs )
{
	const span = createSpan( label );
	span.position( 10, box_height );
	ui_elements.push( span );
	const input = createInput( String( value ), 'number' );
	input.position( 92, box_height - 2 );
	input.size( width || 44, 20 );
	ui_elements.push( input );
	if( attrs ) {
		for( const [key, attrValue] of Object.entries( attrs ) ) {
			input.attribute( key, String( attrValue ) );
		}
	}
	input.input( function() { loop(); } );
	box_height += 26;
	input.labelSpan = span;
	return input;
}

function readNumber( input, fallback )
{
	const value = Number( input.value() );
	return Number.isFinite( value ) ? value : fallback;
}

function clampNumber( value, lo, hi )
{
	return Math.max( lo, Math.min( hi, value ) );
}

function trajectoryControlsForColor( colorName )
{
	if( colorName === 'blue' ) {
		return {
			startEdgeInput: blue_start_edge_input,
			edgeParameterInput: blue_edge_parameter_input,
			angleInput: blue_angle_input
		};
	}
	return {
		startEdgeInput: start_edge_input,
		edgeParameterInput: edge_parameter_input,
		angleInput: angle_input
	};
}

function readTrajectoryControls( colorName )
{
	const controls = trajectoryControlsForColor( colorName );
	const startEdge = clampNumber(
		Math.floor( readNumber( controls.startEdgeInput, 0 ) ), 0, hat_outline.length - 1 );
	const edgeParameter = clampNumber( readNumber( controls.edgeParameterInput, 0.5 ), 0, 1 );
	const angleDegrees = readNumber( controls.angleInput, 60 );
	controls.startEdgeInput.value( String( startEdge ) );
	controls.edgeParameterInput.value( String( edgeParameter ) );
	return {
		color: colorName,
		startEdge,
		edgeParameter,
		angleDegrees
	};
}

function activeTrajectorySpecs()
{
	const specs = [readTrajectoryControls( 'red' )];
	if( blue_trajectory_enabled ) {
		specs.push( readTrajectoryControls( 'blue' ) );
	}
	return specs;
}

function setResultCollection( results )
{
	simulator_results = (results || []).filter( Boolean );
	simulator_result = simulator_results.length > 0 ? simulator_results[0] : null;
}

function activeTrajectoryResults()
{
	if( simulator_results && simulator_results.length > 0 ) {
		return simulator_results;
	}
	return simulator_result ? [simulator_result] : [];
}

function clearSimulatorResults()
{
	setResultCollection( [] );
	simulator_server_payload = null;
}

function currentGeneratedLevel()
{
	if( simulator_result ) {
		return simulator_result.level;
	}
	if( simulator_tiling ) {
		return simulator_tiling.level;
	}
	return simulator_base_level;
}

function activeMetatileLevels()
{
	const generatedLevel = currentGeneratedLevel();
	const levels = [];
	for( let idx = 0; idx < metatile_level_buttons.length; ++idx ) {
		const levelNumber = idx + 1;
		if( levelNumber <= generatedLevel &&
				isButtonActive( metatile_level_buttons[idx] ) ) {
			levels.push( levelNumber );
		}
	}
	return levels;
}

function setAllMetatileLevelsActive( active )
{
	for( const button of metatile_level_buttons ) {
		setButtonActive( button, active );
	}
}

function anyMetatileLevelActive()
{
	return activeMetatileLevels().length > 0;
}

function elementTop( element )
{
	return Number( (element.elt.style.top || '0').replace( 'px', '' ) );
}

function elementLeft( element )
{
	return Number( (element.elt.style.left || '0').replace( 'px', '' ) );
}

function shiftControlsBelowBlueBlock( delta )
{
	if( !blue_start_edge_input || delta === 0 ) {
		return;
	}
	const blueTop = Math.min(
		elementTop( blue_start_edge_input.labelSpan ),
		elementTop( blue_start_edge_input ) );
	for( const element of ui_elements ) {
		if( blue_control_elements.includes( element ) || element === add_trajectory_button ) {
			continue;
		}
		if( elementTop( element ) >= blueTop ) {
			element.position( elementLeft( element ), elementTop( element ) + delta );
		}
	}
	box_height += delta;
}

function showBlueTrajectoryControls( show )
{
	if( !blue_start_edge_input ) {
		return;
	}
	const action = show ? 'show' : 'hide';
	blue_start_edge_input.labelSpan[action]();
	blue_edge_parameter_input.labelSpan[action]();
	blue_angle_input.labelSpan[action]();
	blue_start_edge_input[action]();
	blue_edge_parameter_input[action]();
	blue_angle_input[action]();
}

function setBlueTrajectoryControlsEnabled( enabled, copyRedValues )
{
	if( blue_trajectory_enabled === enabled ) {
		return;
	}
	blue_trajectory_enabled = enabled;
	if( copyRedValues && blue_start_edge_input ) {
		blue_start_edge_input.value( start_edge_input.value() );
		blue_edge_parameter_input.value( edge_parameter_input.value() );
		blue_angle_input.value( angle_input.value() );
	}
	if( enabled ) {
		shiftControlsBelowBlueBlock( blue_controls_height );
		showBlueTrajectoryControls( true );
		if( add_trajectory_button ) {
			add_trajectory_button.hide();
		}
	} else {
		showBlueTrajectoryControls( false );
		shiftControlsBelowBlueBlock( -blue_controls_height );
		if( add_trajectory_button ) {
			add_trajectory_button.show();
		}
	}
}

function enableBlueTrajectoryControls()
{
	if( blue_trajectory_enabled ) {
		return;
	}
	setBlueTrajectoryControlsEnabled( true, true );
	clearSimulatorResults();
	loop();
}

function centreViewOnPoint( p )
{
	const screenPoint = transPt( to_screen, p );
	to_screen = mul( ttrans( -screenPoint.x, -screenPoint.y ), to_screen );
}

async function postTrajectoryJSON( url, payload )
{
	const apiURL = window.location && window.location.protocol === 'file:' ?
		`http://127.0.0.1:8765${url}` : url;
	const response = await fetch( apiURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify( payload )
	} );
	if( !response.ok ) {
		throw new Error( `HTTP ${response.status}` );
	}
	return await response.json();
}

async function runSimulatorTrajectory()
{
	const requestedMaxLevel = clampNumber(
		Math.floor( readNumber( max_expansion_input, simulator_max_level ) ),
		simulator_base_level, simulator_max_level );
	const trajectorySpecs = activeTrajectorySpecs();
	const requestedBounces = Math.max( 0, Math.floor( readNumber( bounce_input, 40 ) ) );
	const patchRadius = Math.max( 0, Math.floor( readNumber( patch_radius_input, 1 ) ) );
	bounce_input.value( String( requestedBounces ) );
	max_expansion_input.value( String( requestedMaxLevel ) );
	patch_radius_input.value( String( patchRadius ) );

	try {
		const payload = await postTrajectoryJSON( '/api/trajectory/run', {
			rootType: currentRootType(),
			level: requestedMaxLevel,
			startEdge: trajectorySpecs[0].startEdge,
			edgeParameter: trajectorySpecs[0].edgeParameter,
			angleDegrees: trajectorySpecs[0].angleDegrees,
			maxBounces: requestedBounces,
			patchRadius,
			trajectories: trajectorySpecs.map( spec => ( {
				color: spec.color,
				startEdge: spec.startEdge,
				edgeParameter: spec.edgeParameter,
				angleDegrees: spec.angleDegrees
			} ) )
		} );
		applyTrajectoryJSONPayload( payload, { skipServerPatch: true } );
		setAllMetatileLevelsActive( false );
		loop();
		return;
	} catch( err ) {
		console.warn( 'Local trajectory server unavailable; running in browser.', err );
	}

	const runTiling = HatBilliards.buildTiling( {
		rootType: currentRootType(),
		level: requestedMaxLevel
	} );
	const localResults = [];
	for( const spec of trajectorySpecs ) {
		const result = HatBilliards.runTrajectory( runTiling, {
			startTileId: runTiling.centralTileId,
			startEdge: spec.startEdge,
			edgeParameter: spec.edgeParameter,
			angleDegrees: spec.angleDegrees,
			maxBounces: requestedBounces,
			maxExpansionLevel: requestedMaxLevel
		} );
		result.color = spec.color;
		result.requestedBounces = requestedBounces;
		result.requestedStartEdge = spec.startEdge;
		result.requestedEdgeParameter = spec.edgeParameter;
		result.requestedAngleDegrees = spec.angleDegrees;
		result.tiling = result.tiling || runTiling;
		localResults.push( result );
	}
	simulator_server_payload = null;
	setResultCollection( localResults );
	simulator_tiling = simulator_result.tiling;
	for( const result of activeTrajectoryResults() ) {
		cacheTrajectoryFocusTiles( result );
		checkTrajectoryPeriodicity( result );
	}
	if( simulator_tiling.tiles[simulator_result.startTileId] ) {
		centreViewOnPoint( simulator_tiling.tiles[simulator_result.startTileId].centroid );
	}
	setAllMetatileLevelsActive( false );
	loop();
}

function cacheTrajectoryFocusTiles( result )
{
	result = result || simulator_result;
	if( !result ) {
		return;
	}
	const focusIds = new Set( [result.startTileId, result.currentTileId] );
	for( const crossing of result.crossings ) {
		focusIds.add( crossing.fromTileId );
		if( crossing.toTileId != null ) {
			focusIds.add( crossing.toTileId );
		}
	}
	result.focusTileIds = [...focusIds];
	const startPoint = result.points[0];
	const startTileId = startPoint ?
		HatBilliards.locateTileContaining(
			result.tiling, startPoint, result.startTileId ) :
		result.startTileId;
	result.startTileIdInFinalTiling = startTileId;
	const startTile = result.tiling.tiles[startTileId];
	const startEdge = startTile ?
		startTile.edges[result.requestedStartEdge] : null;
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

function pointDistance( a, b )
{
	return Math.hypot( a.x - b.x, a.y - b.y );
}

function normalizeVector( v )
{
	const n = Math.hypot( v.x, v.y );
	if( n === 0 || !Number.isFinite( n ) ) {
		return null;
	}
	return { x: v.x / n, y: v.y / n };
}

function unitDirectionFromPoints( points )
{
	if( !points || points.length < 2 ) {
		return null;
	}
	const dx = points[1].x - points[0].x;
	const dy = points[1].y - points[0].y;
	const n = Math.hypot( dx, dy );
	if( n === 0 || !Number.isFinite( n ) ) {
		return null;
	}
	return { x: dx / n, y: dy / n };
}

function angleDegreesFromPoints( points )
{
	const direction = unitDirectionFromPoints( points );
	if( !direction ) {
		return null;
	}
	let angle = Math.atan2( direction.y, direction.x ) * 180 / Math.PI;
	if( angle < 0 ) {
		angle += 360;
	}
	return angle;
}

function angleDegreesForLoadedTrajectory( spec, result, fallback )
{
	if( result && result.requestedAngleDegrees != null ) {
		return result.requestedAngleDegrees;
	}
	if( result && !result.initialDirection ) {
		const inferred = angleDegreesFromPoints( result.points );
		if( inferred != null ) {
			return inferred;
		}
	}
	if( spec && spec.angleDegrees != null ) {
		return spec.angleDegrees;
	}
	return fallback;
}

function startPreviewState( colorName )
{
	if( !simulator_tiling || simulator_tiling.rootType !== currentRootType() ) {
		rebuildSimulatorTiling();
	}
	if( !simulator_tiling ) {
		return null;
	}
	const tileId = simulator_tiling.centralTileId;
	const tile = simulator_tiling.tiles[tileId];
	if( !tile ) {
		return null;
	}
	const controls = trajectoryControlsForColor( colorName || 'red' );
	const edgeIndex = clampNumber(
		Math.floor( readNumber( controls.startEdgeInput, 0 ) ), 0, hat_outline.length - 1 );
	const edgeParameter = clampNumber( readNumber( controls.edgeParameterInput, 0.5 ), 0, 1 );
	const angleDegrees = readNumber( controls.angleInput, 60 );
	const localA = hat_outline[edgeIndex];
	const localB = hat_outline[(edgeIndex + 1) % hat_outline.length];
	const localEdgePoint = {
		x: localA.x + (localB.x - localA.x) * edgeParameter,
		y: localA.y + (localB.y - localA.y) * edgeParameter
	};
	const angle = angleDegrees * Math.PI / 180;
	const direction = normalizeVector( {
		x: Math.cos( angle ),
		y: Math.sin( angle )
	} );
	if( !direction ) {
		return null;
	}
	return {
		tile,
		edge: tile.edges[edgeIndex],
		origin: transPt( tile.transform, localEdgePoint ),
		direction
	};
}

function checkTrajectoryPeriodicity( result )
{
	result = result || simulator_result;
	if( !result || !result.points || result.points.length < 2 ) {
		return;
	}
	const start = result.points[0];
	const tol = result.tiling && result.tiling.tolerances ?
		result.tiling.tolerances.VERTEX_EPS :
		1e-7;
	let bestDistance = Infinity;
	let bestSegmentIndex = null;
	let bestSegmentT = null;
	for( let idx = 2; idx < result.points.length; ++idx ) {
		const a = result.points[idx - 1];
		const b = result.points[idx];
		const ab = { x: b.x - a.x, y: b.y - a.y };
		const as = { x: start.x - a.x, y: start.y - a.y };
		const len2 = ab.x*ab.x + ab.y*ab.y;
		const t = len2 === 0 ? 0 : clampNumber( (as.x*ab.x + as.y*ab.y) / len2, 0, 1 );
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

function clonePoint( p )
{
	return p ? { x: p.x, y: p.y } : null;
}

function cloneEdge( edge )
{
	return edge ? {
		tileId: edge.tileId,
		edgeIndex: edge.edgeIndex,
		a: clonePoint( edge.a ),
		b: clonePoint( edge.b )
	} : null;
}

function cloneCrossing( crossing )
{
	return {
		fromTileId: crossing.fromTileId,
		toTileId: crossing.toTileId == null ? null : crossing.toTileId,
		edgeIndex: crossing.edgeIndex,
		nextEdgeIndex: crossing.nextEdgeIndex == null ? null : crossing.nextEdgeIndex,
		point: clonePoint( crossing.point ),
		u: crossing.u
	};
}

function serializeTileForJSON( tile )
{
	return {
		id: tile.id,
		label: tile.label,
		transform: tile.transform ? tile.transform.slice() : null,
		inverseTransform: tile.inverseTransform ? tile.inverseTransform.slice() : null,
		polygon: tile.polygon.map( clonePoint ),
		centroid: clonePoint( tile.centroid ),
		edges: (tile.edges || []).map( edge => ( {
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

function buildTrajectoryJSONPayload()
{
	if( !simulator_result ) {
		return null;
	}
	const display = getSimulatorDisplayPatch();
	const results = activeTrajectoryResults();
	const serializedResults = results.map( serializeResultForJSON );
	const trajectorySpecs = results.map( result => ( {
		color: result.color || 'red',
		startTileSelection: 'centralTileId',
		startTileId: result.startTileId,
		startEdge: result.requestedStartEdge,
		edgeParameter: result.requestedEdgeParameter == null ?
			readNumber( result.color === 'blue' ? blue_edge_parameter_input : edge_parameter_input, 0.5 ) :
			result.requestedEdgeParameter,
		angleDegrees: result.requestedAngleDegrees == null ?
			readNumber( result.color === 'blue' ? blue_angle_input : angle_input, 60 ) :
			result.requestedAngleDegrees,
		maxBounces: result.requestedBounces,
		maxExpansionLevel: result.level
	} ) );
	return {
		format: 'hatviz-billiards-trajectory',
		version: 1,
		tilingConfig: {
			rootType: simulator_result.rootType,
			level: simulator_result.level,
			patchRadius: Math.max( 0, Math.floor( readNumber( patch_radius_input, 1 ) ) )
		},
		trajectorySpec: {
			startTileSelection: 'centralTileId',
			startTileId: simulator_result.startTileId,
			startEdge: simulator_result.requestedStartEdge,
			edgeParameter: trajectorySpecs[0].edgeParameter,
			angleDegrees: trajectorySpecs[0].angleDegrees,
			maxBounces: simulator_result.requestedBounces,
			maxExpansionLevel: simulator_result.level
		},
		trajectories: trajectorySpecs,
		result: serializedResults[0],
		results: serializedResults,
		localHatConfiguration: {
			startTileId: display.startId,
			tileIds: display.patch.map( tile => tile.id ),
			tiles: display.patch.map( serializeTileForJSON )
		}
	};
}

function serializeResultForJSON( result )
{
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

function saveTrajectoryJSON()
{
	const payload = buildTrajectoryJSONPayload();
	if( !payload ) {
		return;
	}
	const stamp = new Date().toISOString().replace( /[:.]/g, '-' );
	saveStrings(
		[JSON.stringify( payload, null, 2 )],
		`hatviz-trajectory-${stamp}`,
		'json' );
}

function normalizeSerializedTile( tile )
{
	const polygon = (tile.polygon || []).map( clonePoint );
	const edges = tile.edges && tile.edges.length > 0 ?
		tile.edges.map( edge => ( {
			index: edge.index,
			a: clonePoint( edge.a ),
			b: clonePoint( edge.b )
		} ) ) :
		polygon.map( (p, idx) => ( {
			index: idx,
			a: clonePoint( p ),
			b: clonePoint( polygon[(idx + 1) % polygon.length] )
		} ) );
	return {
		id: tile.id,
		label: tile.label,
		transform: tile.transform ? tile.transform.slice() : null,
		inverseTransform: tile.inverseTransform ? tile.inverseTransform.slice() : null,
		polygon,
		centroid: clonePoint( tile.centroid ),
		edges,
		adjacent: (tile.adjacent || []).map( link => link ? {
			tileId: link.tileId,
			edgeIndex: link.edgeIndex
		} : null )
	};
}

function polygonCentroid( poly )
{
	let x = 0;
	let y = 0;
	for( const p of poly ) {
		x += p.x;
		y += p.y;
	}
	return { x: x / poly.length, y: y / poly.length };
}

function transformedPolygonCentroid( T, poly )
{
	return transPt( T, polygonCentroid( poly ) );
}

function centeredOutlinePatchTransform( patch, rootGeom )
{
	const patchCentroid = polygonCentroid( patch.children.map( child =>
		transformedPolygonCentroid( child.T, child.geom.shape ) ) );
	let anchor = null;
	let best = Infinity;
	for( const child of patch.children ) {
		if( child.geom !== rootGeom ) {
			continue;
		}
		const d = pointDistance(
			transformedPolygonCentroid( child.T, child.geom.shape ), patchCentroid );
		if( d < best ) {
			best = d;
			anchor = child;
		}
	}
	return anchor ? inv( anchor.T ) : ident;
}

function buildOutlineRootGeometry( rootType, level )
{
	const rootIndex = {'H':0, 'T':1, 'P':2, 'F':3}[rootType];
	let metatiles = [H_init, T_init, P_init, F_init];
	for( let lev = 1; lev < level; ++lev ) {
		const patch = constructPatch( ...metatiles );
		metatiles = constructMetatiles( patch );
	}
	const root = metatiles[rootIndex];
	const geom = constructPatch( ...metatiles );
	return {
		root: geom,
		rootTransform: centeredOutlinePatchTransform( geom, root )
	};
}

function getOutlineRootGeometry( rootType, level )
{
	const key = `${rootType}:${level}`;
	if( !metatile_outline_cache.has( key ) ) {
		metatile_outline_cache.set( key, buildOutlineRootGeometry( rootType, level ) );
	}
	return metatile_outline_cache.get( key );
}

function createLocalPatchTilingFacade( rootType, level, localHatConfiguration )
{
	const localTiles = (localHatConfiguration && localHatConfiguration.tiles ?
		localHatConfiguration.tiles : []).map( normalizeSerializedTile );
	const tilesById = new Map();
	const tiles = [];
	for( const tile of localTiles ) {
		tiles[tile.id] = tile;
		tilesById.set( tile.id, tile );
	}
	const facade = {
		rootType,
		level,
		centeredPatch: true,
		tiles,
		tilesById,
		centralTileId: localHatConfiguration ? localHatConfiguration.startTileId : null,
		rootTileId: localHatConfiguration ? localHatConfiguration.startTileId : null,
		tolerances: HatBilliards.tolerances(),
		root: null,
		rootTransform: ident,
		metatileOutlineDepth: level,
		localHatConfiguration: {
			startTileId: localHatConfiguration ? localHatConfiguration.startTileId : null,
			tileIds: localTiles.map( tile => tile.id ),
			tiles: localTiles
		}
	};
	return facade;
}

function canBuildLoadedTilingInBrowser( level )
{
	return level <= 5;
}

function applyLocalHatConfiguration( rootType, level, localHatConfiguration )
{
	simulator_tiling = createLocalPatchTilingFacade( rootType, level, localHatConfiguration );
}

async function refreshServerDisplayPatch()
{
	if( !simulator_server_payload || !simulator_result ) {
		return;
	}
	const serial = ++simulator_patch_request_serial;
	const patchRadius = Math.max( 0, Math.floor( readNumber( patch_radius_input, 1 ) ) );
	try {
		const response = await postTrajectoryJSON( '/api/trajectory/patch', {
			tilingConfig: Object.assign( {}, simulator_server_payload.tilingConfig, { patchRadius } ),
			result: buildTrajectoryJSONPayload().result,
			results: buildTrajectoryJSONPayload().results,
			patchRadius
		} );
		if( serial !== simulator_patch_request_serial || !response.localHatConfiguration ) {
			return;
		}
		simulator_server_payload.localHatConfiguration = response.localHatConfiguration;
		simulator_server_payload.tilingConfig.patchRadius = patchRadius;
		applyLocalHatConfiguration(
			response.rootType || simulator_result.rootType,
			response.level || simulator_result.level,
			response.localHatConfiguration );
		for( const result of activeTrajectoryResults() ) {
			result.tiling = simulator_tiling;
		}
		loop();
	} catch( err ) {
		console.warn( 'Could not refresh trajectory patch from local server.', err );
	}
}

function applyTrajectoryJSONPayload( payload, options )
{
	if( !payload || payload.format !== 'hatviz-billiards-trajectory' ) {
		return;
	}
	options = options || {};
	const config = payload.tilingConfig || {};
	const result = payload.result || {};
	const spec = payload.trajectorySpec || {};
	const specs = payload.trajectories && payload.trajectories.length > 0 ?
		payload.trajectories : [spec];
	const rawResults = payload.results && payload.results.length > 0 ?
		payload.results : [result];
	const rootType = config.rootType || result.rootType || 'H';
	const generatedLevel = Math.max( simulator_base_level,
		Math.floor( config.level || result.level || simulator_base_level ) );
	const patchRadius = Math.max( 0, Math.floor(
		config.patchRadius == null ? readNumber( patch_radius_input, 1 ) : config.patchRadius ) );

	radio.selected( rootType );
	start_edge_input.value( String( specs[0].startEdge == null ? result.requestedStartEdge || 0 : specs[0].startEdge ) );
	edge_parameter_input.value( String( specs[0].edgeParameter == null ? 0.5 : specs[0].edgeParameter ) );
	angle_input.value( String( angleDegreesForLoadedTrajectory( specs[0], result, 60 ) ) );
	if( specs.length > 1 || rawResults.length > 1 ) {
		setBlueTrajectoryControlsEnabled( true, false );
		const blueSpec = specs[1] || {};
		const blueResult = rawResults[1] || {};
		blue_start_edge_input.value( String(
			blueSpec.startEdge == null ? blueResult.requestedStartEdge || 0 : blueSpec.startEdge ) );
		blue_edge_parameter_input.value( String(
			blueSpec.edgeParameter == null ? 0.5 : blueSpec.edgeParameter ) );
		blue_angle_input.value( String(
			angleDegreesForLoadedTrajectory( blueSpec, blueResult, 60 ) ) );
	} else {
		setBlueTrajectoryControlsEnabled( false, false );
	}
	bounce_input.value( String( spec.maxBounces == null ? result.requestedBounces || 0 : spec.maxBounces ) );
	max_expansion_input.value( String( generatedLevel ) );
	patch_radius_input.value( String( patchRadius ) );

	simulator_server_payload = payload.serverBacked || payload.localHatConfiguration ? payload : null;
	if( payload.localHatConfiguration ) {
		applyLocalHatConfiguration( rootType, generatedLevel, payload.localHatConfiguration );
	} else if( canBuildLoadedTilingInBrowser( generatedLevel ) ) {
		simulator_tiling = HatBilliards.buildTiling( {
			rootType,
			level: generatedLevel
		} );
	} else {
		applyLocalHatConfiguration( rootType, generatedLevel, {
			startTileId: result.startTileIdInFinalTiling || result.currentTileId || result.startTileId,
			tileIds: [],
			tiles: []
		} );
	}
	setResultCollection( rawResults.map( (raw, idx) =>
		deserializeTrajectoryResult( raw, rootType, generatedLevel, simulator_tiling, idx ) ) );
	for( const loadedResult of activeTrajectoryResults() ) {
		if( loadedResult.startTileIdInFinalTiling == null && !payload.localHatConfiguration ) {
			cacheTrajectoryFocusTiles( loadedResult );
		}
		if( !loadedResult.periodicity ) {
			checkTrajectoryPeriodicity( loadedResult );
		}
	}
	if( simulator_result.points[0] ) {
		centreViewOnPoint( simulator_result.points[0] );
	}
	loop();
	if( !options.skipServerPatch && simulator_server_payload ) {
		refreshServerDisplayPatch();
	}
}

function deserializeTrajectoryResult( result, rootType, generatedLevel, tiling, idx )
{
	result = result || {};
	const inferredAngle = angleDegreesForLoadedTrajectory( null, result, null );
	return {
		color: result.color || (idx === 1 ? 'blue' : 'red'),
		status: result.status || 'loaded',
		rootType,
		level: generatedLevel,
		startTileId: result.startTileId,
		startTileIdInFinalTiling: result.startTileIdInFinalTiling,
		currentTileId: result.currentTileId,
		requestedBounces: result.requestedBounces,
		requestedStartEdge: result.requestedStartEdge,
		requestedEdgeParameter: result.requestedEdgeParameter,
		requestedAngleDegrees: inferredAngle,
		expansions: result.expansions || 0,
		periodicity: result.periodicity || null,
		initialDirection: clonePoint( result.initialDirection ) ||
			unitDirectionFromPoints( result.points ),
		focusTileIds: result.focusTileIds || [],
		startEdge: cloneEdge( result.startEdge ),
		finalEdge: cloneEdge( result.finalEdge ),
		points: (result.points || []).map( clonePoint ),
		crossings: (result.crossings || []).map( cloneCrossing ),
		tiling
	};
}

function loadTrajectoryJSONFile( file )
{
	if( !file ) {
		return;
	}
	let data = file.data;
	if( typeof data === 'string' ) {
		try {
			data = JSON.parse( data );
		} catch( err ) {
			console.error( 'Could not parse trajectory JSON', err );
			return;
		}
	}
	applyTrajectoryJSONPayload( data );
}

function pointSegmentDistance( p, a, b )
{
	const vx = b.x - a.x;
	const vy = b.y - a.y;
	const wx = p.x - a.x;
	const wy = p.y - a.y;
	const len2 = vx*vx + vy*vy;
	const t = len2 === 0 ? 0 : clampNumber( (wx*vx + wy*vy) / len2, 0, 1 );
	const q = { x: a.x + t*vx, y: a.y + t*vy };
	return Math.hypot( p.x - q.x, p.y - q.y );
}

function findEdgeAtPoint( tiling, point )
{
	if( !tiling || !point ) {
		return null;
	}
	let best = null;
	let bestDistance = Infinity;
	const maxDistance = tiling.tolerances.edgeLength * 1e-5;
	for( const tile of tiling.tiles ) {
		for( const edge of tile.edges ) {
			const d = pointSegmentDistance( point, edge.a, edge.b );
			if( d < bestDistance ) {
				bestDistance = d;
				best = { tileId: tile.id, edgeIndex: edge.index, a: edge.a, b: edge.b };
			}
		}
	}
	return bestDistance <= maxDistance ? best : null;
}

function trajectoryStopReason( result )
{
	result = result || simulator_result;
	if( !result ) {
		return 'not run yet';
	}
	const actual = result.crossings.length;
	const requested = result.requestedBounces == null ?
		readNumber( bounce_input, 40 ) : result.requestedBounces;
	if( result.status === 'completed' ) {
		return `completed ${actual}/${requested} bounces`;
	}
	if( result.status === 'vertex-hit' ) {
		return `vertex hit after ${actual}/${requested}`;
	}
	if( result.status === 'escaped-generated-supertile' ) {
		return `left generated patch after ${actual}/${requested}`;
	}
	if( result.status === 'max-expansion-reached' ) {
		return `max level reached after ${actual}/${requested}`;
	}
	if( result.status === 'numeric-error' ) {
		return `numeric error after ${actual}/${requested}`;
	}
	return `${result.status} after ${actual}/${requested}`;
}

function trajectoryStatusText()
{
	const results = activeTrajectoryResults();
	if( results.length === 0 ) {
		return 'not run yet';
	}
	return results.map( result =>
		`${result.color || 'red'}: ${trajectoryStopReason( result )}` ).join( ' | ' );
}

function periodicityStatusText()
{
	const results = activeTrajectoryResults();
	if( results.length === 0 ) {
		return 'cycle not detected';
	}
	return results.map( result => {
		if( result.periodicity && result.periodicity.detected ) {
			return `${result.color || 'red'} cycle at ${result.periodicity.bounce}`;
		}
		return `${result.color || 'red'} no cycle`;
	} ).join( ' | ' );
}

function trajectoryVisitedText()
{
	const visited = new Set();
	let segments = 0;
	for( const result of activeTrajectoryResults() ) {
		for( const id of result.focusTileIds || [] ) {
			visited.add( id );
		}
		segments += Math.max( 0, (result.points || []).length - 1 );
	}
	return `visited ${visited.size} hats, ${segments} segments`;
}

function drawWorldPolygon( polygon, f, s, w )
{
	drawPolygon( polygon, to_screen, f, s, w );
}

function drawSelectedMetatilePreview()
{
	const idx = {'H':0, 'T':1, 'P':2, 'F':3}[currentRootType()];
	if( isButtonActive( draw_hats ) ) {
		tiles[idx].draw( to_screen, level );
	}
}

function drawSelectedMetatiles()
{
	const idx = {'H':0, 'T':1, 'P':2, 'F':3}[currentRootType()];
	tiles[idx].draw( to_screen, Math.max( 0, level - 1 ) );
}

function getSimulatorDisplayPatch()
{
	if( !simulator_tiling || simulator_tiling.rootType !== currentRootType() ) {
		rebuildSimulatorTiling();
	}
	const results = activeTrajectoryResults();
	const focusId = simulator_result ? simulator_result.currentTileId :
		(simulator_tiling.rootTileId == null ? simulator_tiling.centralTileId : simulator_tiling.rootTileId);
	const radius = Math.max( 0, Math.floor( readNumber( patch_radius_input, 1 ) ) );
	const focusIds = new Set( [focusId] );
	for( const result of results ) {
		const ids = result.focusTileIds || [];
		for( const id of ids ) {
			focusIds.add( id );
		}
		focusIds.add( result.startTileIdInFinalTiling );
		focusIds.add( result.currentTileId );
	}
	const patchById = new Map();
	for( const id of focusIds ) {
		if( id == null ) {
			continue;
		}
		for( const tile of HatBilliards.bfsPatch( simulator_tiling, id, radius ) ) {
			patchById.set( tile.id, tile );
		}
	}
	const patch = [...patchById.values()];
	const startId = simulator_result ?
		simulator_result.startTileIdInFinalTiling :
		(simulator_tiling.rootTileId == null ? simulator_tiling.centralTileId : simulator_tiling.rootTileId);
	return { patch, startId };
}

function drawSimulatorPatch()
{
	if( !simulator_result ) {
		if( isButtonActive( draw_hats ) ) {
			drawSelectedMetatilePreview();
		}
		const preview = startPreviewState();
		if( preview ) {
			drawWorldPolygon( preview.tile.polygon, color( 255, 226, 130 ), black, 0.75 );
		}
		return;
	}
	const display = getSimulatorDisplayPatch();
	const showHats = isButtonActive( draw_hats );
	for( const tile of display.patch ) {
		const isStartTile = tile.id === display.startId;
		if( !showHats && !isStartTile ) {
			continue;
		}
		const fillColor = isStartTile ? color( 255, 226, 130 ) : null;
		const strokeColor = showHats ? black : null;
		drawWorldPolygon( tile.polygon, fillColor, strokeColor, 0.75 );
	}
}

function boundsForTransformedShape( shape, T )
{
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for( const p of shape ) {
		const q = transPt( T, p );
		minX = Math.min( minX, q.x );
		minY = Math.min( minY, q.y );
		maxX = Math.max( maxX, q.x );
		maxY = Math.max( maxY, q.y );
	}
	return { minX, minY, maxX, maxY };
}

function boundsForDisplayPatch( patch )
{
	let bounds = {
		minX: Infinity,
		minY: Infinity,
		maxX: -Infinity,
		maxY: -Infinity
	};
	for( const tile of patch ) {
		const tb = boundsForTransformedShape( tile.polygon, to_screen );
		bounds.minX = Math.min( bounds.minX, tb.minX );
		bounds.minY = Math.min( bounds.minY, tb.minY );
		bounds.maxX = Math.max( bounds.maxX, tb.maxX );
		bounds.maxY = Math.max( bounds.maxY, tb.maxY );
	}
	const pad = 4 * lw_scale;
	bounds.minX -= pad;
	bounds.minY -= pad;
	bounds.maxX += pad;
	bounds.maxY += pad;
	return bounds;
}

function boundsIntersect( a, b )
{
	return a.minX <= b.maxX && a.maxX >= b.minX &&
		a.minY <= b.maxY && a.maxY >= b.minY;
}

function drawVisibleMetatileOutlines( geom, T, level, visibleBounds )
{
	const shape = geom instanceof HatTile ? hat_outline : geom.shape;
	const bounds = shape.length > 0 ? boundsForTransformedShape( shape, T ) : null;
	if( bounds && !boundsIntersect( bounds, visibleBounds ) ) {
		return;
	}
	if( geom instanceof HatTile ) {
		return;
	}
	if( level > 0 ) {
		for( const child of geom.children ) {
			drawVisibleMetatileOutlines(
				child.geom, mul( T, child.T ), level - 1, visibleBounds );
		}
	} else {
		drawPolygon( geom.shape, T, null, black, geom.width );
	}
}

function appendMetatileOutlineSVG( stream, geom, T, level )
{
	if( geom instanceof HatTile ) {
		return;
	}
	if( level > 0 ) {
		for( const child of geom.children ) {
			appendMetatileOutlineSVG( stream, child.geom, mul( T, child.T ), level - 1 );
		}
		return;
	}
	const shape = geom.shape.map( p => transPt( T, p ) );
	stream.push( polygonToSVG( shape, null, null, black, geom.width * lw_scale ) );
}

function drawSimulatorMetatiles()
{
	const levels = activeMetatileLevels();
	if( levels.length === 0 ) {
		return;
	}
	const generatedLevel = currentGeneratedLevel();
	let outlineRoot = null;
	try {
		outlineRoot = getOutlineRootGeometry( currentRootType(), generatedLevel );
	} catch( err ) {
		console.warn( 'Could not build metatile outline geometry.', err );
		return;
	}
	if( !outlineRoot || !outlineRoot.root ) {
		return;
	}
	let visibleBounds = {
		minX: -width / 2,
		minY: -height / 2,
		maxX: width / 2,
		maxY: height / 2
	};
	if( simulator_result ) {
		const display = getSimulatorDisplayPatch();
		if( display.patch.length === 0 ) {
			return;
		}
		visibleBounds = boundsForDisplayPatch( display.patch );
	}
	const S = mul( to_screen, outlineRoot.rootTransform );
	for( const metatileLevel of levels ) {
		const depth = generatedLevel - metatileLevel + 1;
		drawVisibleMetatileOutlines(
			outlineRoot.root, S, depth, visibleBounds );
	}
}

function drawSimulatorTrajectory()
{
	const results = activeTrajectoryResults().slice().sort( function( a, b ) {
		if( a.color === 'blue' && b.color !== 'blue' ) {
			return -1;
		}
		if( b.color === 'blue' && a.color !== 'blue' ) {
			return 1;
		}
		return 0;
	} );
	if( results.length === 0 ) {
		return;
	}
	for( const result of results ) {
		if( !result.points || result.points.length < 2 ) {
			continue;
		}
		if( result.color === 'blue' ) {
			stroke( 0, 80, 210 );
		} else {
			stroke( 210, 0, 0 );
		}
		strokeWeight( 0.45 * lw_scale );
		noFill();
		beginShape();
		for( let idx = 0; idx < result.points.length; ++idx ) {
			const p = result.points[idx];
			const tp = transPt( to_screen, p );
			vertex( tp.x, tp.y );
		}
		endShape();
	}
}

function drawUnitVectorArrow( start, direction, strokeColor )
{
	if( !start || !direction ) {
		return;
	}
	const unitDirection = normalizeVector( direction );
	if( !unitDirection ) {
		return;
	}
	const end = {
		x: start.x + unitDirection.x,
		y: start.y + unitDirection.y
	};
	const a = transPt( to_screen, start );
	const b = transPt( to_screen, end );
	const angle = Math.atan2( b.y - a.y, b.x - a.x );
	const headLength = 10;
	const headAngle = Math.PI / 7;

	if( strokeColor ) {
		stroke( strokeColor );
	} else {
		stroke( 0, 80, 210 );
	}
	strokeWeight( 1.25 * lw_scale );
	noFill();
	line( a.x, a.y, b.x, b.y );
	line(
		b.x, b.y,
		b.x - headLength * Math.cos( angle - headAngle ),
		b.y - headLength * Math.sin( angle - headAngle ) );
	line(
		b.x, b.y,
		b.x - headLength * Math.cos( angle + headAngle ),
		b.y - headLength * Math.sin( angle + headAngle ) );
}

function drawStartPreviewMarkers()
{
	if( simulator_result ) {
		return;
	}
	const redPreview = startPreviewState( 'red' );
	if( !redPreview ) {
		return;
	}
	drawHighlightedEdge( redPreview.edge, color( 210, 0, 0 ) );
	drawUnitVectorArrow( redPreview.origin, { x: 1, y: 0 }, color( 70 ) );
	drawUnitVectorArrow( redPreview.origin, redPreview.direction, color( 210, 0, 0 ) );
	if( blue_trajectory_enabled ) {
		const bluePreview = startPreviewState( 'blue' );
		if( bluePreview ) {
			drawHighlightedEdge( bluePreview.edge, color( 0, 80, 210 ) );
			drawUnitVectorArrow( bluePreview.origin, bluePreview.direction, color( 0, 80, 210 ) );
		}
	}
}

function drawHighlightedEdge( edge, strokeColor )
{
	if( !edge ) {
		return;
	}
	const a = transPt( to_screen, edge.a );
	const b = transPt( to_screen, edge.b );
	if( strokeColor ) {
		stroke( strokeColor );
	} else {
		stroke( 0, 160, 70 );
	}
	strokeWeight( 3 * lw_scale );
	line( a.x, a.y, b.x, b.y );
}

function drawTrajectoryEndpointEdges()
{
	if( !simulator_result ) {
		return;
	}
	for( const result of activeTrajectoryResults() ) {
		const edgeColor = result.color === 'blue' ? color( 0, 80, 210 ) : color( 210, 0, 0 );
		drawHighlightedEdge( result.startEdge, edgeColor );
		drawHighlightedEdge( result.finalEdge, edgeColor );
	}
}

function buildExportTiles()
{
	const patch = constructPatch( ...tiles );
	tiles = constructMetatiles( patch );
	++level;
	loop();
}

function saveCurrentSVG()
{
	// CHATGPT: Reset SVG id counter and cached SVG ids.
	svg_serial = 0;
	for( let t of tiles ) {
		t.resetSVG();
	}

	// CHATGPT: SVG is built as an array of strings, then saved.
	const stream = [];
	stream.push( `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">` );
	stream.push( '<defs>' );

	// CHATGPT: Build reusable SVG definitions for all current metatiles.
	for( let t of tiles ) {
		t.buildSVGDefs( stream, mag( to_screen[0], to_screen[1] ) );
	}
	stream.push( '</defs>' );

	// CHATGPT: Choose H/T/P/F based on the radio button.
	const idx = {'H':0, 'T':1, 'P':2, 'F':3}[radio.value()];

	// CHATGPT: Compose a screen-centering translation with the current transform.
	const S = mul( ttrans( width/2, height/2 ), to_screen );

	// CHATGPT: Add filled hats if visible.
	if( isButtonActive( draw_hats ) ) {
		stream.push( getSVGInstance( tiles[idx].getSVGFillID(), S ) );
	}

	// CHATGPT: Add the current metatile outline layer if visible.
	if( anyMetatileLevelActive() ) {
		const generatedLevel = currentGeneratedLevel();
		const outlineRoot = getOutlineRootGeometry( radio.value(), generatedLevel );
		const outlineS = mul( ttrans( width/2, height/2 ),
			mul( to_screen, outlineRoot.rootTransform ) );
		for( const metatileLevel of activeMetatileLevels() ) {
			appendMetatileOutlineSVG(
				stream, outlineRoot.root, outlineS, generatedLevel - metatileLevel + 1 );
		}
	}
	stream.push( '</svg>' );

	saveStrings( stream, 'output', 'svg' );
}

function saveCurrentMatrices()
{
	const stream = [];

	// CHATGPT: Pick current root metatile H/T/P/F.
	const idx = {'H':0, 'T':1, 'P':2, 'F':3}[radio.value()];

	// CHATGPT: Recursively descend to bottom-level HatTiles and export transforms.
	tiles[idx].getText( stream, ident );

	saveStrings( stream, 'output', 'txt' );
}

// CHATGPT: p5.js calls setup() once when the sketch starts.
// CHATGPT: This creates the canvas, initializes tiles, and builds the UI.
function setup() {
	createCanvas( windowWidth, windowHeight );

	// CHATGPT: Start with the four initial metatiles.
	tiles = [H_init, T_init, P_init, F_init];
	level = 1;

	// CHATGPT: Make a p5 color object for black.
	black = color( 'black' );

	// CHATGPT: Reset the whole scene to the starting substitution level and viewport.
	reset_button = addButton( "Reset", function() {
		tiles = [H_init, T_init, P_init, F_init];
		level = 1;
		radio.selected( 'H' );
		to_screen = [20, 0, 0, 0, -20, 0];
		lw_scale = 1;
		setButtonActive( draw_hats, true );
		setAllMetatileLevelsActive( false );
		rebuildSimulatorTiling();
		setBlueTrajectoryControlsEnabled( false, false );
		loop();
	} );

	// CHATGPT: Advance one substitution level.
	// CHATGPT: `...tiles` spreads [H,T,P,F] into four separate arguments.
	// subst_button = addButton( "Build Export Tiles", buildExportTiles );
	box_height += 10;

	// CHATGPT: Radio buttons let the user choose which root metatile to display.
	radio = createRadio();
	radio.mousePressed( function() {
		setTimeout( function() {
			clearSimulatorResults();
			loop();
		}, 0 );
	} );
	radio.position( 10, box_height );
	for( let s of ['H', 'T', 'P', 'F'] ) {
		let o = radio.option( s );
		o.onclick = function() {
			setTimeout( function() {
				clearSimulatorResults();
				loop();
			}, 0 );
		};
	}
	radio.selected( 'H' );
	box_height += 40;

    	// CHATGPT: Create Translate and Scale mode buttons.
	// CHATGPT: These modes determine how mouse dragging affects the view.
	translate_button = addButton( "Translate", function() {
		setButtonActive( translate_button, true );
		setButtonActive( scale_button, false );
		loop();
	} );
	scale_button = addButton( "Scale", function() {
		setButtonActive( translate_button, false );
		setButtonActive( scale_button, true );
		loop();
	} );

	// CHATGPT: Start in Translate mode.
	setButtonActive( translate_button, true );
	box_height += 10;
	
	// CHATGPT: Toggle whether individual bottom-level hats are drawn.
	draw_hats = addButton( "Draw Hats", function() {
		setButtonActive( draw_hats, !isButtonActive( draw_hats ) );
		loop();
	} );
	for( let metatileLevel = 1; metatileLevel <= simulator_max_level; ++metatileLevel ) {
		let levelButton = null;
		levelButton = addButton( `Meta L${metatileLevel}`, function() {
			setButtonActive( levelButton, !isButtonActive( levelButton ) );
			loop();
		} );
		metatile_level_buttons.push( levelButton );
		setButtonActive( levelButton, false );
	}

	// CHATGPT: Start with hats visible and metatile outlines off.
	setButtonActive( draw_hats, true );
	box_height += 10;

	start_edge_input = numericInput( "Start edge", 0, 44, {
		min: 0, max: 12, step: 1
	} );
	edge_parameter_input = numericInput( "Edge t", 0.5, 44, {
		min: 0, max: 1, step: 0.01
	} );
	angle_input = numericInput( "Angle", 60, 44, {
		step: 1
	} );
	add_trajectory_button = addButton( "Add Trajectory", enableBlueTrajectoryControls );
	blue_start_edge_input = numericInput( "Blue edge", 0, 44, {
		min: 0, max: 12, step: 1
	} );
	blue_edge_parameter_input = numericInput( "Blue t", 0.5, 44, {
		min: 0, max: 1, step: 0.01
	} );
	blue_angle_input = numericInput( "Blue angle", 60, 44, {
		step: 1
	} );
	blue_control_elements = [
		blue_start_edge_input.labelSpan,
		blue_start_edge_input,
		blue_edge_parameter_input.labelSpan,
		blue_edge_parameter_input,
		blue_angle_input.labelSpan,
		blue_angle_input
	];
	blue_controls_height = box_height - elementTop( blue_start_edge_input.labelSpan );
	showBlueTrajectoryControls( false );
	box_height -= blue_controls_height;
	bounce_input = numericInput( "Bounces", 40, 44, {
		min: 0, step: 1
	} );
	max_expansion_input = numericInput( "Max level", simulator_max_level, 44, {
		min: 1, max: simulator_max_level, step: 1
	} );
	patch_radius_input = numericInput( "BFS radius", 1, 44, {
		min: 0, step: 1
	} );
	patch_radius_input.input( function() {
		refreshServerDisplayPatch();
		loop();
	} );
	run_button = addButton( "Run Trajectory", runSimulatorTrajectory );
	addButton( "Save Traj JSON", saveTrajectoryJSON );
	load_trajectory_input = createFileInput( loadTrajectoryJSONFile );
	load_trajectory_input.hide();
	addButton( "Load Traj JSON", function() {
		load_trajectory_input.elt.value = '';
		load_trajectory_input.elt.click();
	} );
	box_height += 10;

	// CHATGPT: Save the current canvas as a PNG image.
	// CHATGPT: The UI box is temporarily hidden so it is not included.
	addButton( "Save PNG", function () {
		uibox = false;
		draw();
		save( "output.png" );
		uibox = true;
		draw();
	} );

	// CHATGPT: Save the current view as an SVG vector file.
	// addButton( "Save SVG", saveCurrentSVG );

	// CHATGPT: Save one text line per bottom-level hat tile.
	// CHATGPT: This is probably the most useful export for your billiards simulator.
	// addButton( "Save Matrices", saveCurrentMatrices );

	box_height -= 5; // remove half the padding
	rebuildSimulatorTiling();
}

// CHATGPT: p5.js calls draw() whenever the sketch redraws.
// CHATGPT: This program calls noLoop() at the end, so drawing pauses until loop()
// CHATGPT: is called by UI/mouse events.
function draw()
{
	background( 255 );

	// CHATGPT: Save p5 drawing state, then translate origin to canvas center.
	push();
	translate( width/2, height/2 );

	// CHATGPT: Draw the engine-owned local patch around the current trajectory tile.
	drawSimulatorPatch();
	drawSimulatorMetatiles();

	drawStartPreviewMarkers();
	drawSimulatorTrajectory();
	drawTrajectoryEndpointEdges();
	pop();

	// CHATGPT: Draw translucent UI panel over the canvas.
		if( uibox ) {
			stroke( 0 );
			strokeWeight( 0.5 );
			fill( 255, 220 );
			rect( 5, 5, 185, box_height + 64);
			noStroke();
			fill( 0 );
			textSize( 11 );
		const generatedLevel = simulator_result ? simulator_result.level :
			(simulator_tiling ? simulator_tiling.level : simulator_base_level);
		text( `root ${radio.value()}  generated level ${generatedLevel}`, 12, box_height + 18 );
		text( trajectoryStatusText(), 12, box_height + 34 );
			if( simulator_result ) {
				text( trajectoryVisitedText(), 12, box_height + 50 );
				text( periodicityStatusText(), 12, box_height + 66 );
			}
		}

	// CHATGPT: Pause continuous drawing until something calls loop().
	noLoop();
}

// CHATGPT: p5.js calls this when the browser window changes size.
function windowResized() 
{
	resizeCanvas( windowWidth, windowHeight );
}
// CHATGPT: p5.js calls this when the mouse is pressed.
// CHATGPT: It starts a drag operation. If Scale mode is active, it records
// CHATGPT: enough information to compute zoom during mouseDragged().
function mousePressed()
{
	dragging = true;
	if( isButtonActive( scale_button ) ) {
		// CHATGPT: Convert the screen center back into model coordinates.
		// CHATGPT: This point acts as the center of scaling.
		scale_centre = transPt( inv( to_screen ), pt( width/2, height/2 ) );

		// CHATGPT: Store the initial mouse point.
		scale_start = pt( mouseX, mouseY );

		// CHATGPT: Copy current transform. The spread syntax makes a shallow copy
		// CHATGPT: of the six-number array so later changes do not mutate scale_ts.
		scale_ts = [...to_screen];
	}
	loop();
}

// CHATGPT: p5.js calls this repeatedly while the mouse is dragged.
// CHATGPT: Depending on active mode, dragging either translates or scales the view.
function mouseDragged()
{
	if( dragging ) {
		if( isButtonActive( translate_button ) ) {
			// CHATGPT: Translate/pan by the mouse movement since the previous frame.
			// CHATGPT: pmouseX and pmouseY are p5.js variables for previous mouse position.
			to_screen = mul( ttrans( mouseX - pmouseX, mouseY - pmouseY ), 
				to_screen );
		} else if( isButtonActive( scale_button ) ) {
			// CHATGPT: Scaling factor is based on how far the mouse is from canvas center
			// CHATGPT: compared with the distance at the start of the drag.
			let sc = dist( mouseX, mouseY, width/2, height/2 ) / 
				dist( scale_start.x, scale_start.y, width/2, height/2 );

			// CHATGPT: Build a transform that scales about scale_centre:
			// CHATGPT: translate to center, scale, translate back, then apply original transform.
			to_screen = mul( 
				mul( ttrans( scale_centre.x, scale_centre.y ),
					mul( [sc, 0, 0, 0, sc, 0],
						ttrans( -scale_centre.x, -scale_centre.y ) ) ),
				scale_ts );

			// CHATGPT: Update line-width scaling so strokes change sensibly with zoom.
			lw_scale = mag( to_screen[0], to_screen[1] ) / 20.0;
		}
		loop();

		// CHATGPT: Returning false tells p5/the browser not to perform default
		// CHATGPT: drag behavior, such as selecting text or dragging the page.
		return false;
	} 
}

// CHATGPT: p5.js calls this when the mouse button is released.
// CHATGPT: It ends the drag operation.
function mouseReleased()
{
	dragging = false;
	loop();
}
