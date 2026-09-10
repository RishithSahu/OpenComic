// Library Constellation - a force-directed map of the whole library, genre similarity setting
// distance between series. The layout is computed once (a fixed number of physics iterations,
// synchronously, not a running simulation) and rendered as a static-but-pannable/zoomable SVG -
// deliberately not a live per-frame simulation, which would cost O(n^2) every frame for no real
// benefit once the graph has settled.

const ITERATIONS = 260;
const REPULSION = 2600;
const SPRING_STRENGTH = 0.02;
const DAMPING = 0.85;
const BASE_EDGE_DISTANCE = 260;
// Plain Jaccard similarity plus a low-ish cutoff sounded reasonable in isolation, but a real
// manga library's genres skew hard toward a handful of ubiquitous tags (Action, Comedy, Fantasy,
// Shounen, Seinen, ...) - measured against a realistic genre distribution, 74% of *all possible
// pairs* in a 160-node library cleared a 0.12 threshold, average degree 118. That many springs
// pulling on every node overwhelmed repulsion entirely and collapsed the whole map into one
// dense ball, nebula labels included. Two changes fix the actual cause rather than re-tuning the
// force constants around a graph that was never supposed to be this dense: genres are now
// weighted by inverse document frequency (a shared "Action" barely counts; a shared "Cooking"
// counts for a lot) via weightedSimilarity()/genreDocumentFrequency(), and only each node's own
// top few matches become edges at all (TOP_K_PER_NODE) rather than every pair clearing one global
// threshold - bounding average degree regardless of how a particular library's genres happen to
// be distributed.
const MIN_SIMILARITY = 0.05;
const TOP_K_PER_NODE = 5;
// A single pairwise repulsion (near-zero starting distance, common with many nodes seeded into a
// fixed-size random area) or a single spring correction can otherwise hand a node a velocity far
// larger than anything the rest of the simulation was tuned for; damping alone reduces a runaway
// value over time but does not stop it compounding across 260 iterations first, which is exactly
// how a real library's worth of nodes (100+) ended up with star positions in the 1e21 range -
// large enough that JS's own Number-to-string conversion switches to scientific notation, which
// is not a valid SVG viewBox token at all ("Expected number, ...e+21"), breaking the entire page.
// Capping both the force a single pair can apply and the velocity a node carries into the next
// iteration keeps the simulation inside numbers an SVG viewBox can actually represent.
const MAX_PAIR_FORCE = 60;
const MAX_VELOCITY = 40;
const MIN_NEBULA_NODES = 3; // a genre needs at least this many nodes before it earns its own nebula
const MAX_NEBULA_FRACTION = 0.3; // ...but not more than this share of the whole library either
const MAX_NEBULAE = 8; // cap on how many labels the map tries to show at once

function hashHue(text)
{
	let hash = 0;
	const value = String(text || '');

	for(let i = 0, len = value.length; i < len; i++)
	{
		hash = (hash << 5) - hash + value.charCodeAt(i);
		hash |= 0;
	}

	return Math.abs(hash) % 360;
}

// How many of ALL nodes carry each genre - a shared genre only a handful of series have is a
// real signal; a shared genre almost everything has is not, but plain Jaccard weighs them
// identically. Smoothed log IDF (the standard TF-IDF formula): common genres get a small but
// non-zero weight, rare ones get a large one, and nothing ever divides by zero.
function genreDocumentFrequency(nodes)
{
	const frequency = new Map();

	for(let i = 0, len = nodes.length; i < len; i++)
	{
		const seen = new Set(nodes[i].genres);

		for(const genre of seen)
			frequency.set(genre, (frequency.get(genre) || 0) + 1);
	}

	const idf = new Map();
	const total = nodes.length || 1;

	for(const [genre, count] of frequency)
		idf.set(genre, Math.log((total + 1) / (count + 1)) + 1);

	return idf;
}

function weightedSimilarity(a, b, idf)
{
	if(!a.length || !b.length)
		return 0;

	const setA = new Set(a);
	const setB = new Set(b);
	const union = new Set(a.concat(b));
	let weightedIntersection = 0;
	let weightedUnion = 0;

	for(const genre of union)
	{
		const weight = idf.get(genre) || 1;
		weightedUnion += weight;

		if(setA.has(genre) && setB.has(genre))
			weightedIntersection += weight;
	}

	return weightedUnion ? (weightedIntersection / weightedUnion) : 0;
}

// Only a series with a *confirmed* match - the same test scrapeFolderMetadata() itself uses for
// "hasConfirmedMatch" elsewhere. Without this, every folder that ever went through a scrape
// attempt has a trackingFolderMetadata entry regardless of outcome (needsMetadataScrape()'s own
// durable no-match record, metadata.lastAttemptAt) - which meant a category folder like
// "1. Completed Series" or "5. Time Pass Series" showed up as its own star, indistinguishable
// from a real series, the moment it had ever been attempted and failed to match (exactly the
// folders the generic-name filter in folder-title.js keeps out of being search candidates at all,
// but that filter has no bearing on whether an old record still sits in storage from before it
// existed, or from a folder shaped some other way this filter doesn't happen to catch).
function hasConfirmedMatch(metadata)
{
	return !!((metadata.source === 'anilist' && metadata.anilistId)
		|| (metadata.source === 'myanimelist' && metadata.malId)
		|| metadata.source === 'manual'
		|| metadata.source === 'import');
}

function collectNodes()
{
	const trackingFolderMetadata = relative.get('trackingFolderMetadata') || {};
	const nodes = [];

	for(const path in trackingFolderMetadata)
	{
		const metadata = trackingFolderMetadata[path];
		if(!metadata || !hasConfirmedMatch(metadata)) continue;

		const genres = Array.isArray(metadata.genres) ? metadata.genres.filter(Boolean) : [];

		nodes.push({
			path: path,
			title: metadata.title || p.basename(path),
			genres: genres,
			seriesType: metadata.seriesType || '',
			hue: hashHue(genres[0] || metadata.seriesType || metadata.title || path),
			x: 0, y: 0, vx: 0, vy: 0,
		});
	}

	// Initial placement scales with node count - seeding a few hundred nodes into the same fixed
	// 800x800 square used for a handful of them starts the simulation far denser than it was
	// tuned for, which is exactly the condition that produced the runaway forces above.
	const spread = Math.max(700, Math.sqrt(nodes.length) * 190);

	for(let i = 0, len = nodes.length; i < len; i++)
	{
		nodes[i].x = (Math.random() - 0.5) * spread;
		nodes[i].y = (Math.random() - 0.5) * spread;
	}

	return nodes;
}

function buildEdges(nodes)
{
	const idf = genreDocumentFrequency(nodes);
	const candidatesPerNode = nodes.map(function() { return []; });

	for(let i = 0, len = nodes.length; i < len; i++)
	{
		for(let j = i + 1; j < len; j++)
		{
			const similarity = weightedSimilarity(nodes[i].genres, nodes[j].genres, idf);
			if(similarity < MIN_SIMILARITY) continue;

			candidatesPerNode[i].push({ other: j, similarity: similarity });
			candidatesPerNode[j].push({ other: i, similarity: similarity });
		}
	}

	// Each node keeps only its own strongest few matches - this is what actually bounds average
	// degree (and so how tightly the whole thing can collapse), not the similarity cutoff alone,
	// since no fixed cutoff behaves the same across every library's own genre distribution.
	const edgeMap = new Map();

	for(let i = 0, len = nodes.length; i < len; i++)
	{
		candidatesPerNode[i].sort(function(x, y) { return y.similarity - x.similarity; });
		const top = candidatesPerNode[i].slice(0, TOP_K_PER_NODE);

		for(let k = 0, klen = top.length; k < klen; k++)
		{
			const candidate = top[k];
			const a = Math.min(i, candidate.other), b = Math.max(i, candidate.other);
			const key = a + '-' + b;
			const existing = edgeMap.get(key);

			if(!existing || existing < candidate.similarity)
				edgeMap.set(key, candidate.similarity);
		}
	}

	const edges = [];

	for(const [key, similarity] of edgeMap)
	{
		const parts = key.split('-');
		edges.push({ a: +parts[0], b: +parts[1], similarity: similarity });
	}

	return edges;
}

function runLayout(nodes, edges)
{
	for(let iteration = 0; iteration < ITERATIONS; iteration++)
	{
		// Repulsion - every node pushes every other node away, so unrelated series (with no
		// edge pulling them together at all) still spread out into a legible layout instead of
		// piling up at the origin.
		for(let i = 0, len = nodes.length; i < len; i++)
		{
			for(let j = i + 1; j < len; j++)
			{
				const dx = nodes[j].x - nodes[i].x;
				const dy = nodes[j].y - nodes[i].y;
				const distSq = Math.max(dx * dx + dy * dy, 1);
				const dist = Math.sqrt(distSq);
				const force = Math.min(REPULSION / distSq, MAX_PAIR_FORCE);
				const fx = (dx / dist) * force;
				const fy = (dy / dist) * force;

				nodes[i].vx -= fx;
				nodes[i].vy -= fy;
				nodes[j].vx += fx;
				nodes[j].vy += fy;
			}
		}

		// Attraction - similar series pull toward each other, more similar pulling to a shorter
		// resting distance than a merely related one.
		for(let i = 0, len = edges.length; i < len; i++)
		{
			const edge = edges[i];
			const nodeA = nodes[edge.a];
			const nodeB = nodes[edge.b];
			const dx = nodeB.x - nodeA.x;
			const dy = nodeB.y - nodeA.y;
			const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
			const idealDistance = BASE_EDGE_DISTANCE * (1 - edge.similarity * 0.75);
			const rawForce = (dist - idealDistance) * SPRING_STRENGTH;
			const force = Math.max(Math.min(rawForce, MAX_PAIR_FORCE), -MAX_PAIR_FORCE);
			const fx = (dx / dist) * force;
			const fy = (dy / dist) * force;

			nodeA.vx += fx;
			nodeA.vy += fy;
			nodeB.vx -= fx;
			nodeB.vy -= fy;
		}

		for(let i = 0, len = nodes.length; i < len; i++)
		{
			const node = nodes[i];
			node.vx *= DAMPING;
			node.vy *= DAMPING;

			const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
			if(speed > MAX_VELOCITY)
			{
				const scale = MAX_VELOCITY / speed;
				node.vx *= scale;
				node.vy *= scale;
			}

			node.x += node.vx;
			node.y += node.vy;
		}
	}

	// Last-resort safety net: even with the caps above, fall back to a plain grid position for
	// any node that still isn't a finite number (a NaN from two nodes seeded at the exact same
	// point, say) rather than ever handing renderSvg() something it can't turn into a valid
	// viewBox.
	for(let i = 0, len = nodes.length; i < len; i++)
	{
		const node = nodes[i];

		if(!Number.isFinite(node.x) || !Number.isFinite(node.y))
		{
			const col = i % 12, row = Math.floor(i / 12);
			node.x = (col - 6) * 120;
			node.y = (row - 6) * 120;
		}
	}
}

// One soft, genre-tinted glow per genre with enough nodes to be a real cluster rather than a
// coincidence - positioned at that genre's own centroid so it reads as "this region is where the
// Fantasy titles are" rather than a decoration with no relationship to what's actually nearby.
function computeNebulae(nodes)
{
	const byGenre = new Map();

	for(let i = 0, len = nodes.length; i < len; i++)
	{
		const node = nodes[i];

		for(let g = 0, glen = node.genres.length; g < glen; g++)
		{
			const genre = node.genres[g];
			if(!byGenre.has(genre)) byGenre.set(genre, []);
			byGenre.get(genre).push(node);
		}
	}

	const nebulae = [];
	// A genre carried by too large a slice of the whole library isn't a cluster, it's just
	// describing the map in general - "Action" covering 60% of the library would otherwise paint
	// a nebula spanning almost the entire canvas, with a label competing with every other one
	// drawn near the middle for the same space. Skipped the same way an overly rare one already
	// is (MIN_NEBULA_NODES), just at the opposite end.
	const maxNebulaNodes = Math.max(MIN_NEBULA_NODES, nodes.length * MAX_NEBULA_FRACTION);

	for(const [genre, genreNodes] of byGenre)
	{
		if(genreNodes.length < MIN_NEBULA_NODES || genreNodes.length > maxNebulaNodes) continue;

		let sumX = 0, sumY = 0;

		for(let i = 0, len = genreNodes.length; i < len; i++)
		{
			sumX += genreNodes[i].x;
			sumY += genreNodes[i].y;
		}

		const centerX = sumX / genreNodes.length;
		const centerY = sumY / genreNodes.length;

		let maxDist = 0;

		for(let i = 0, len = genreNodes.length; i < len; i++)
		{
			const dx = genreNodes[i].x - centerX;
			const dy = genreNodes[i].y - centerY;
			const dist = Math.sqrt(dx * dx + dy * dy);
			if(dist > maxDist) maxDist = dist;
		}

		nebulae.push({
			genre: genre,
			x: centerX,
			y: centerY,
			radius: Math.max(140, maxDist * 0.9),
			hue: hashHue(genre),
			count: genreNodes.length,
		});
	}

	// Keep only the tightest (most spatially distinctive) clusters if there are more qualifying
	// genres than the map has room to label legibly - a sprawling, loosely-scattered genre is a
	// weaker signal than a small, tight one even when both clear the node-count thresholds above.
	nebulae.sort(function(a, b) { return (a.radius / a.count) - (b.radius / b.count); });
	const kept = nebulae.slice(0, MAX_NEBULAE);

	// Then largest first for paint order, so a big nebula never covers a smaller, tighter one
	// nested near its edge.
	kept.sort(function(a, b) { return b.radius - a.radius; });

	return kept;
}

function escapeXml(value)
{
	return String(value || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function n(value)
{
	// Fixed decimal notation, never scientific - see the comment on MAX_PAIR_FORCE/MAX_VELOCITY
	// for why a coordinate could otherwise reach a magnitude where toString() stops being valid
	// SVG. Rounding to one decimal place is also just plainly enough precision for anything drawn
	// on screen.
	return Number.isFinite(value) ? value.toFixed(1) : '0';
}

function renderSvg(nodes, edges)
{
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

	for(let i = 0, len = nodes.length; i < len; i++)
	{
		const node = nodes[i];
		if(node.x < minX) minX = node.x;
		if(node.x > maxX) maxX = node.x;
		if(node.y < minY) minY = node.y;
		if(node.y > maxY) maxY = node.y;
	}

	if(!isFinite(minX)) { minX = minY = -200; maxX = maxY = 200; }

	const padding = 140;
	const viewX = minX - padding;
	const viewY = minY - padding;
	const viewWidth = (maxX - minX) + padding * 2;
	const viewHeight = (maxY - minY) + padding * 2;

	let nebulaeDefsSvg = '';
	let nebulaeSvg = '';
	const nebulae = computeNebulae(nodes);

	for(let i = 0, len = nebulae.length; i < len; i++)
	{
		const nebula = nebulae[i];
		const gradientId = 'constellation-nebula-gradient-' + i;

		// A real radial falloff (a gradient, not a flat translucent disc with a hard-edged
		// boundary) - a nebula thins out into the surrounding sky, it doesn't have an edge.
		nebulaeDefsSvg += ''
			+ '<radialGradient id="' + gradientId + '">'
			+ '<stop offset="0%" stop-color="hsl(' + nebula.hue + ', 80%, 62%)" stop-opacity="0.38"></stop>'
			+ '<stop offset="55%" stop-color="hsl(' + nebula.hue + ', 80%, 55%)" stop-opacity="0.16"></stop>'
			+ '<stop offset="100%" stop-color="hsl(' + nebula.hue + ', 80%, 50%)" stop-opacity="0"></stop>'
			+ '</radialGradient>';

		nebulaeSvg += ''
			+ '<circle class="constellation-nebula" cx="' + n(nebula.x) + '" cy="' + n(nebula.y) + '" r="' + n(nebula.radius) + '" fill="url(#' + gradientId + ')"></circle>'
			+ '<text x="' + n(nebula.x) + '" y="' + n(nebula.y) + '" text-anchor="middle" class="constellation-nebula-label">' + escapeXml(nebula.genre) + '</text>';
	}

	let edgesSvg = '';

	for(let i = 0, len = edges.length; i < len; i++)
	{
		const edge = edges[i];
		const nodeA = nodes[edge.a];
		const nodeB = nodes[edge.b];

		edgesSvg += '<line class="constellation-edge" x1="' + n(nodeA.x) + '" y1="' + n(nodeA.y) + '" x2="' + n(nodeB.x) + '" y2="' + n(nodeB.y) + '" stroke-opacity="' + Math.min(0.5, edge.similarity) + '"></line>';
	}

	let nodesSvg = '';

	for(let i = 0, len = nodes.length; i < len; i++)
	{
		const node = nodes[i];
		// A star, not a flat dot: a small near-white core (real starlight reads as white
		// regardless of the star's actual colour by the time it reaches your eye) sitting inside
		// a soft, larger halo tinted by the node's own hue - the halo carries the genre colour,
		// the core just needs to look bright.
		const coreRadius = 3.5 + Math.min(node.genres.length, 6) * 0.6;
		const glowRadius = coreRadius * 3.2;

		nodesSvg += ''
			+ '<g class="constellation-node gamepad-item" data-path="' + escapeXml(node.path) + '" tabindex="0">'
			+ '<circle class="constellation-node-glow" cx="' + n(node.x) + '" cy="' + n(node.y) + '" r="' + n(glowRadius) + '" fill="hsl(' + node.hue + ', 85%, 65%)" opacity="0.28"></circle>'
			+ '<circle class="constellation-node-core" cx="' + n(node.x) + '" cy="' + n(node.y) + '" r="' + n(coreRadius) + '" fill="hsl(' + node.hue + ', 45%, 92%)"></circle>'
			+ '<text x="' + n(node.x) + '" y="' + n(node.y + glowRadius + 14) + '" text-anchor="middle" class="constellation-node-label">' + escapeXml(node.title.length > 22 ? (node.title.slice(0, 21) + '…') : node.title) + '</text>'
			+ '<title>' + escapeXml(node.title) + (node.genres.length ? ('\n' + node.genres.join(', ')) : '') + '</title>'
			+ '</g>';
	}

	return ''
		+ '<svg class="constellation-svg" viewBox="' + n(viewX) + ' ' + n(viewY) + ' ' + n(viewWidth) + ' ' + n(viewHeight) + '" xmlns="http://www.w3.org/2000/svg">'
		+ (nebulaeDefsSvg ? ('<defs>' + nebulaeDefsSvg + '</defs>') : '')
		+ '<g class="constellation-viewport">'
		+ nebulaeSvg
		+ edgesSvg
		+ nodesSvg
		+ '</g>'
		+ '</svg>';
}

var panZoomState = false;

function attachPanZoom(container)
{
	const svg = container.querySelector('.constellation-svg');
	const viewport = container.querySelector('.constellation-viewport');
	if(!svg || !viewport) return;

	const originalViewBox = svg.getAttribute('viewBox').split(' ').map(Number);
	let scale = 1, translateX = 0, translateY = 0;
	let isDragging = false, dragStartX = 0, dragStartY = 0;

	function applyTransform()
	{
		viewport.setAttribute('transform', 'translate(' + translateX + ' ' + translateY + ') scale(' + scale + ')');
		container.classList.toggle('constellation-zoomed-in', scale >= 1.6);
	}

	// translateX/Y and the wheel/drag deltas below have to live in the SVG's own viewBox units,
	// not raw screen pixels - the viewBox is typically thousands of units across while the element
	// on screen is a few hundred CSS pixels wide, so a 1:1 pixel-to-unit mapping (what this used to
	// do) put the cursor and the point it was supposedly zooming/panning around wildly out of sync.
	// getScreenCTM() is the browser's own screen-pixel -> SVG-user-unit conversion for this exact
	// situation.
	function toSvgPoint(clientX, clientY)
	{
		const ctm = svg.getScreenCTM();
		if(!ctm) return { x: clientX, y: clientY };

		const point = svg.createSVGPoint();
		point.x = clientX;
		point.y = clientY;

		const transformed = point.matrixTransform(ctm.inverse());
		return { x: transformed.x, y: transformed.y };
	}

	svg.addEventListener('wheel', function(event) {
		event.preventDefault();

		const cursor = toSvgPoint(event.clientX, event.clientY);
		// The point under the cursor, in pre-transform "world" space - what has to stay fixed on
		// screen across the scale change for the zoom to feel anchored to the cursor instead of the
		// viewport's origin.
		const worldX = (cursor.x - translateX) / scale;
		const worldY = (cursor.y - translateY) / scale;

		const delta = event.deltaY > 0 ? 0.9 : 1.1;
		scale = Math.min(Math.max(scale * delta, 0.3), 6);

		translateX = cursor.x - worldX * scale;
		translateY = cursor.y - worldY * scale;

		applyTransform();
	}, { passive: false });

	svg.addEventListener('mousedown', function(event) {
		isDragging = true;

		const cursor = toSvgPoint(event.clientX, event.clientY);
		dragStartX = cursor.x - translateX;
		dragStartY = cursor.y - translateY;
	});

	window.addEventListener('mousemove', function(event) {
		if(!isDragging) return;

		const cursor = toSvgPoint(event.clientX, event.clientY);
		translateX = cursor.x - dragStartX;
		translateY = cursor.y - dragStartY;

		applyTransform();
	});

	window.addEventListener('mouseup', function() {
		isDragging = false;
	});

	container.querySelectorAll('.constellation-node').forEach(function(node) {
		node.addEventListener('click', function() {
			const path = node.getAttribute('data-path');
			if(path)
				dom.loadIndexPage(true, path, false, false, path);
		});
	});

	panZoomState = { originalViewBox: originalViewBox };
}

function start()
{
	const nodes = collectNodes();
	const edges = buildEdges(nodes);

	runLayout(nodes, edges);

	handlebarsContext.constellationSvg = renderSvg(nodes, edges);
	handlebarsContext.constellationEmpty = !nodes.length;

	template.loadContentRight('constellation.content.right.html', true);

	const container = template._contentRight();
	if(container)
		attachPanZoom(container);

	events.events();
}

module.exports = {
	start: start,
};
