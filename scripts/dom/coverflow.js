// Cover flow view for browsing the volumes inside a series: one cover centred, the rest
// angled away to either side, navigated with the wheel, the arrow keys, or by clicking a
// cover to bring it to the front.
//
// Two things keep this cheap enough to sit alongside the reader. The covers are the same
// cached thumbnails the grid view already generates - this view never asks for an image
// the grid would not have asked for - and only the covers within WINDOW of the centre are
// in the layer tree at all, so a 200 volume series costs the same as a 20 volume one. There
// used to be a third: a mirrored reflection under each cover, removed because a `mask-image`
// on every visible item, transitioning every navigation alongside its cover's own transform,
// was real per-frame compositing cost for a purely decorative flourish.

var currentIndex = 0;
var items = [];
var inners = [];
var container = false;
var track = false;
var counterEl = false;
var titleEl = false;
var subtitleEl = false;
var backdrop = false;
var collageTiles = [];

// Bumped every time a series is entered/left, so a tile resolving after the fact for a series
// already navigated away from is discarded instead of painted onto the next one's tiles.
var collageBuildToken = 0;

var wheelAccumulator = 0;
var wheelResetST = false;
var boundKeys = false;

// The raw measured cover size (before CENTRE_SCALE), kept from the last sizeCovers() call so
// layout() can size the centred item's own bigger box without re-measuring the container.
var coverWidth = 0;
var coverHeight = 0;

// How many covers are placed either side of the centre one. Past this they are display:none,
// which takes them out of the layer tree rather than merely hiding them.
const WINDOW = 8;

// The most tiles the backdrop collage ever shows, one volume per tile (see buildSeriesCollage()
// below) - a series with fewer volumes than this shows exactly that many tiles instead, sized up
// by buildCollageGrid() to still fill the backdrop rather than leaving the rest blank. Each tile
// is its own thumbnail-generation request on the collage's own queue (resolveCollageTile(),
// 'coverflowCollage' in cache.js) - kept modest so a long series' worth of tiles never becomes
// noticeable background load.
const COLLAGE_TILES = 20;

// Geometry, all in multiples of the measured cover width so the shape holds at any size.
const SIDE_GAP = 0.62;      // centre of the first side cover, from the centre cover's centre
const SIDE_SPREAD = 0.22;   // each further cover past that one
const SIDE_ANGLE = 58;      // degrees the side covers turn away from the reader
const SIDE_DEPTH = 34;      // px each further cover recedes
// The centred cover has no z-lift at all (0, not just a small one): translateZ is a 3D
// transform, and a 3D transform only ever scales the layer Chromium already rasterised at its
// own layout size - it does not repaint at the larger on-screen size perspective would then
// produce. Any translateZ on the centre, however small, is therefore a slightly-blurrier
// upscale of the same bitmap stacked on top of the real fix below, for a depth cue that a
// higher z-index and stronger shadow already give it without that cost. Left at exactly 0 so
// the fix is unambiguous rather than "mostly" real size.
const CENTRE_LIFT = 0;

// The centred cover is drawn at its own, larger CSS box size instead: this is the real fix for
// "blurry centre, sharp sides" - giving it its own bigger --cf-cover-w/h means Chromium paints
// its <img> at that larger size directly, using the same high-resolution thumbnail everything
// else uses, rather than relying on any transform to make a smaller-painted image look bigger.
const CENTRE_SCALE = 1.3;

function isActive() {
	return !!(container && container.isConnected);
}

// Cover size is driven from the container rather than CSS so the row scales with the
// window without needing container query units, and so layout() has the exact width its
// geometry is expressed in multiples of. Returns the cover width in px.
function sizeCovers() {
	if (!container) return 0;

	const rect = container.getBoundingClientRect();

	if (!rect.height || !rect.width) return 0;

	// Leaves room under the row for the reflection and the title, and caps the cover so an
	// unusually tall window does not turn one volume into a full-screen poster. The centred
	// cover then draws itself larger again on top of this (see CENTRE_SCALE) - this is the
	// side covers' size, not the row's peak size.
	const height = Math.max(200, Math.min(rect.height * 0.66, 600));
	const width = Math.round(height * 0.68); // ~2:3, the usual manga trim

	container.style.setProperty('--cf-cover-h', Math.round(height) + 'px');
	container.style.setProperty('--cf-cover-w', width + 'px');

	coverWidth = width;
	coverHeight = height;

	return width;
}

// Returns false if the container had no measurable size yet, so the caller can retry.
// `measure` re-runs sizeCovers() - a getBoundingClientRect() plus two container style writes,
// forcing a reflow - which only ever needs to happen on the first placement and on an actual
// resize (see place()/onResize() below); the far more frequent case, one cover moving to the
// front on every wheel tick or arrow key, reuses the last measured coverWidth/coverHeight
// instead of paying that reflow again for a size that has not changed.
function layout(animate = true, measure = true) {
	if (!isActive() || !items.length) return;

	const width = measure ? sizeCovers() : coverWidth;
	if (!width) return false;

	// The first paint places every cover at once; suppressing the transition for it stops
	// the whole row visibly flying in from the middle when the view opens.
	if (!animate) container.style.setProperty('--cf-duration', '1ms');

	for (let i = 0, len = items.length; i < len; i++) {
		const item = items[i];
		const distance = i - currentIndex;
		const away = Math.abs(distance);

		if (away > WINDOW) {
			if (!item.classList.contains('coverflow-hidden')) {
				item.classList.add('coverflow-hidden');
				item.style.removeProperty('will-change');
			}

			continue;
		}

		item.classList.remove('coverflow-hidden');

		let transform;

		if (distance === 0) {
			// No transform at all here, not even the identity translate3d(0,0,0) this used to
			// carry (CENTRE_LIFT is 0) - a 3D transform value, numerically a no-op or not, is
			// still what makes an element a compositing candidate in the first place, and once
			// promoted, a later *size* change (the --cf-cover-w/h bump below) does not
			// necessarily force that layer to re-rasterise at the new size the way a plain,
			// uncomposited element's paint would - the same class of "layer rasterised once,
			// then just scaled to fit" softness CENTRE_LIFT was already written to avoid for
			// perspective's own z-scaling, just reachable through the transform's mere presence
			// instead of through its value. The centre item never actually needs a transform -
			// zero offset is already exactly where its plain box-model position (the negative
			// margin above) puts it - so there is nothing to lose by leaving the property unset.
			transform = '';
			item.style.setProperty('--cf-cover-w', Math.round(coverWidth * CENTRE_SCALE) + 'px');
			item.style.setProperty('--cf-cover-h', Math.round(coverHeight * CENTRE_SCALE) + 'px');
		}
		else {
			item.style.removeProperty('--cf-cover-w');
			item.style.removeProperty('--cf-cover-h');

			const side = distance < 0 ? -1 : 1;
			const x = side * width * (SIDE_GAP + SIDE_SPREAD * (away - 1));
			const z = -(SIDE_DEPTH * away);

			transform = 'translate3d(' + x.toFixed(1) + 'px, 0px, ' + z + 'px) rotateY(' + (-side * SIDE_ANGLE) + 'deg)';
		}

		item.style.transform = transform;
		item.style.zIndex = String(1000 - away);

		// Dimming goes on the inner wrapper, not the cover itself: a `filter` on an element
		// that is part of a 3D rendering context flattens it, and this one is carrying the
		// rotateY that makes the whole effect.
		if (inners[i])
			inners[i].style.filter = away ? 'brightness(' + Math.max(0.35, 1 - away * 0.14).toFixed(2) + ')' : '';

		// Fade the last cover of the window out rather than letting it pop when it crosses
		// the boundary into display:none.
		item.style.opacity = away >= WINDOW ? '0' : '1';

		// Only the covers that actually animate their own transform get promoted - the centre
		// item is excluded too (away === 0 no longer passes, now that it carries no transform
		// at all to begin with): promoting a static element buys it nothing, and leaving
		// will-change on all of them regardless would keep layers alive for covers sitting
		// still at the edge of the window besides.
		item.style.willChange = (away >= 1 && away <= 2) ? 'transform' : '';
	}

	if (!animate) {
		// Flush the un-transitioned placement before handing the transition back, so the
		// next navigation animates from where the covers actually are.
		void container.offsetWidth;
		container.style.removeProperty('--cf-duration');
	}

	updateChrome();
}

// === Collage (ambient backdrop) ===
//
// One fixed mosaic per series, chosen once and cached to disk - not reshuffled or reassigned
// as the row moves, and never rebuilt on a later visit unless a volume was actually added or
// removed. One tile per volume - its own centre page, not one of the ends (a cover-like opening
// page and a blank/credits-like closing one are what a "what does this series look like" mosaic
// is least served by) - from a bounded, randomly ordered sample of up to COLLAGE_TILES volumes
// spread across the whole series, each resolved to an already-generated thumbnail the moment it
// is cached - so only the very first time a series is opened in this view costs anything, and
// even that opens volumes one at a time rather than all at once. A series with fewer volumes
// than COLLAGE_TILES simply gets fewer, larger tiles (buildCollageGrid() below) rather than
// repeating a volume for a second tile. A volume that is itself a PDF, or whose only pages are
// inside one, is skipped entirely: extracting even one PDF page means opening the whole document
// through pdf.js exactly like actually reading it would, which is a real cost worth paying for a
// page you asked to read, not for a background tile you will never look at directly.

function isPdfPath(path) {
	return compatible.compressed.pdf ? compatible.compressed.pdf(path) : /\.pdf$/i.test(path || '');
}

// Deterministic (not Math.random) so a given series samples the same spread of volumes, and a
// given volume the same spread of pages, every time this actually has to run - reproducible
// rather than reshuffling for no reason on every rebuild.
function seededShuffle(list, seed) {
	const result = list.slice();
	let state = parseInt(sha1(seed).slice(0, 8), 16) || 1;

	const next = function () {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state;
	};

	for (let i = result.length - 1; i > 0; i--) {
		const j = next() % (i + 1);
		const tmp = result[i];
		result[i] = result[j];
		result[j] = tmp;
	}

	return result;
}

function pickStableIndex(count, seed) {
	return parseInt(sha1(seed).slice(0, 8), 16) % count;
}

// Depth-limited walk into a folder's own listing, separating actual page images from
// compressed entries (a chapter packaged as its own .cbz/.cbr, sitting directly inside the
// volume - the common shape for a series with no chapter subfolders) rather than discarding
// them: a volume organised that way has no image directly inside it at all, only archives.
// A PDF anywhere in the walk is skipped rather than collected, archive or image both - see the
// note above. Bounded to 2 folder levels so an omnibus/scanlation release that wraps its pages
// in one extra folder is still found, without an unbounded directory walk.
function collectPageCandidates(entries, images, archives, depth) {
	for (let i = 0, len = entries.length; i < len; i++) {
		const item = entries[i];

		if (isPdfPath(item.path)) continue;

		if (item.folder) {
			if (depth < 2) collectPageCandidates(item.files || [], images, archives, depth + 1);
			continue;
		}

		if (item.compressed) { archives.push(item); continue; }

		if (compatible.image(item.path)) images.push(item);
	}
}

// Every usable page for one volume, tagged with which file actually needs to be opened to
// extract it (`container`: the volume itself for a loose page, or the one chapter archive
// picked below for a page inside it) - the full remaining list rather than a single page here,
// so the caller picks the centre of it once trimmed (see trimEnds()) rather than this function
// guessing at "the" page. A margin off both ends is left out: a title/cover-like opening and a
// blank/credits/donation-ad-like closing run are what a mosaic of "what this series looks like"
// is least well served by.
async function collectVolumePages(volumePath) {
	let file;

	try {
		file = fileManager.file(volumePath, { fromThumbnailsGeneration: true, subtask: true, log: false, sort: { extraKey: 'Reading' } });

		const entries = await file.read({ cacheServer: true, filtered: false });
		const images = [];
		const archives = [];

		collectPageCandidates(fileManager.filtered(entries), images, archives, 0);

		if (images.length) {
			file.afterDestroy();
			return trimEnds(images).map(function (image) { return { path: image.path, container: volumePath, fileSize: image.fileSize || 0 }; });
		}

		if (!archives.length) { file.afterDestroy(); return []; }

		// One representative chapter, not every chapter - the same one extra archive-open the
		// grid's own cover lookup already accepts as normal, not a multiple of it.
		const archive = archives[pickStableIndex(archives.length, volumePath)];
		file.afterDestroy();

		const archiveFile = fileManager.file(archive.path, { fromThumbnailsGeneration: true, subtask: true, log: false, sort: { extraKey: 'Reading' } });
		const archiveEntries = await archiveFile.read({ cacheServer: true, filtered: false });
		const archiveImages = [];

		// Nested archives inside this one are not opened again - two lookups deep is already
		// more than the grid's own cover lookup does.
		collectPageCandidates(fileManager.filtered(archiveEntries), archiveImages, [], 0);
		archiveFile.afterDestroy();

		return trimEnds(archiveImages).map(function (image) { return { path: image.path, container: archive.path, fileSize: image.fileSize || 0 }; });
	}
	catch (error) {
		if (file) file.afterDestroy();
		return [];
	}
}

// A scanlation release commonly opens (and closes) with several boilerplate pages, not just one -
// a title card, a "we need donation"/credits page, sometimes more than one of either - and a
// single-page trim left those in reach of the centre-page pick below often enough that a handful
// of chapters sharing the same group's boilerplate collapsed onto visibly the same tile. Trimming
// a proportion of the page count off both ends instead catches this regardless of how many
// boilerplate pages a given release happens to use, at the cost of a short chapter contributing
// nothing (collectVolumePages()'s caller already falls back to that volume's own cover for those -
// see resolveVolumeFallbackEntry() in coverflow.js).
function trimEnds(images) {
	const margin = Math.max(1, Math.round(images.length * 0.15));

	if (images.length <= margin * 2) return [];

	return images.slice(margin, -margin);
}

// The exact geometric middle is not a safe pick on its own - some groups repeat their donation/
// credits page at a consistent position *through* a chapter (a "part" break), not only at its
// edges, which trimEnds() above cannot see coming since it only ever looks at the two ends. A
// real content page (line art, halftone) compresses to visibly more bytes than a mostly-flat
// text/logo graphic at a similar resolution - cheap to compare since every candidate already
// carries its own archive-reported fileSize, no page ever opened just to check. Widening the
// search to a small window around the middle instead of trusting one exact index, and taking
// whichever candidate in it has the most bytes, keeps the pick centred on the volume the way a
// single middle index was meant to, while not landing on a boilerplate insert that happens to
// sit there. Falls back to the exact middle if nothing in the window reports a size at all (an
// archive format that never exposed one).
function pickCentrePage(pages) {
	const middle = Math.floor(pages.length / 2);

	if (pages.length <= 2) return pages[middle];

	const radius = Math.max(1, Math.min(5, Math.floor(pages.length * 0.2)));
	const start = Math.max(0, middle - radius);
	const end = Math.min(pages.length - 1, middle + radius);

	let best = pages[middle];
	let bestSize = best.fileSize || 0;

	for (let i = start; i <= end; i++) {
		const size = pages[i].fileSize || 0;

		if (size > bestSize) {
			best = pages[i];
			bestSize = size;
		}
	}

	return best;
}

function applyCollageTile(tileIndex, src, token) {
	if (token !== collageBuildToken || !isActive() || !collageTiles[tileIndex]) return;

	collageTiles[tileIndex].style.backgroundImage = 'url("' + src + '")';

	if (backdrop) backdrop.classList.add('active');
}

// Resolves one tile's chosen page to an actual thumbnail - the same cost the grid already pays
// to build a folder's own cover, for one page. If that page's thumbnail already exists on disk
// (any tile whose series-wide choice was cached from an earlier visit) this needs no I/O beyond
// the exists check `cache.returnThumbnailsImages()` itself already does - the volume backing it
// is never reopened.
// Its own queue key (not 'cacheMakeAvailable'), so a series' worth of collage tiles can never
// delay or starve the grid/row's own thumbnail generation, which shares that key across every
// other caller - threads.js keys queues/threadsList by this string, so the two never compete
// for the same slot. Tuned lighter still than the shared queue's own throttle, since this work
// is purely decorative and the grid should never feel this running behind it.
function resolveCollageTile(tileIndex, entry, token) {
	if (token !== collageBuildToken) return;

	const sha = sha1(entry.pagePath + '?coverflowCollage');
	const file = fileManager.file(entry.container, { fromThumbnailsGeneration: true, subtask: true, log: false, sort: { extraKey: 'Reading' } });

	const result = cache.returnThumbnailsImages({ path: entry.pagePath, sha: sha, forceSize: 300 }, function (data) {

		applyCollageTile(tileIndex, data.path, token);
		file.afterDestroy();

	}, file, 'coverflowCollage', { useThreads: 0.05, delay: 60 });

	if (result && result.path) {
		applyCollageTile(tileIndex, result.path, token);
		file.afterDestroy();
	}
}

// Fallback for a volume collectVolumePages() found no usable interior page for - a volume that is
// itself a PDF, or a folder whose only chapters are PDFs (both deliberately skipped above, see
// isPdfPath()), or a genuinely tiny volume trimEnds() empties out entirely. Rather than re-solving
// "what is this volume's cover" here - real logic, with its own wrapper-folder and .tbn handling -
// this reuses dom.js's own selectFolderThumbnailSource(), the exact function that already resolves
// this same volume's own row cover elsewhere in this view. Whatever it picks is exactly as valid a
// collage tile as any interior page, and guarantees every sampled volume yields exactly one tile,
// so the grid built for it (buildCollageGrid()) never ends up with an empty cell.
async function resolveVolumeFallbackEntry(volumePath) {
	const file = fileManager.file(volumePath, { fromThumbnailsGeneration: true, subtask: true, log: false, sort: { extraKey: 'Reading' } });

	try {
		const source = await dom._selectFolderThumbnailSource(file, volumePath);

		if (!source || !source.path) return false;

		return { pagePath: source.path, container: volumePath };
	}
	catch (error) {
		return false;
	}
	finally {
		file.afterDestroy();
	}
}

// Chooses this series' tiles - one centre page from each of a bounded, randomly ordered sample
// of up to COLLAGE_TILES volumes, opened one at a time. `onTileChosen` fires as each tile is
// decided (rather than only once the whole set is settled), so a first-time build paints in
// progressively instead of leaving the backdrop blank for however long the whole series takes.
// A volume never contributes more than one tile - a smaller series just ends up with fewer,
// larger tiles (see buildCollageGrid()) rather than a volume's pages being reused to pad the
// grid out to COLLAGE_TILES.
async function buildSeriesCollage(seriesPath, volumePaths, onTileChosen) {
	const token = collageBuildToken;
	const sample = seededShuffle(volumePaths, seriesPath).slice(0, COLLAGE_TILES);
	const tiles = [];

	// token is re-checked after every await (the only place this loop actually yields, via
	// collectVolumePages/resolveVolumeFallbackEntry opening a volume) - reset() bumps
	// collageBuildToken the moment the user leaves this series, and there is no point opening yet
	// another volume's archive for a backdrop nothing is showing anymore.
	for (let i = 0, len = sample.length; i < len; i++) {
		const volumePath = sample[i];
		const pages = await collectVolumePages(volumePath);

		if (token !== collageBuildToken) { tiles.aborted = true; return tiles; }

		let entry;

		if (pages.length) {
			const centre = pickCentrePage(pages);
			entry = { pagePath: centre.path, container: centre.container };
		}
		else {
			entry = await resolveVolumeFallbackEntry(volumePath);

			if (token !== collageBuildToken) { tiles.aborted = true; return tiles; }

			if (!entry) continue; // Genuinely nothing found for this volume (empty/broken).
		}

		const tileIndex = tiles.length;

		tiles.push(entry);

		if (onTileChosen) onTileChosen(tileIndex, entry);
	}

	return tiles;
}

// A grid sized to exactly however many tiles this series actually has (at most COLLAGE_TILES),
// rather than a fixed layout with blank cells for a series short of that count - a 3-volume series
// gets 3 large tiles filling the backdrop, not 3 small ones lost in a grid built for 20. Always an
// exact divisor of the tile count (columns * rows === count, never more) - any row count that does
// not divide evenly would leave an empty cell in the last row, which is what previously showed up
// as a blank gap in one corner of the backdrop whenever the tile count did not happen to fill a
// fixed 8x2/10x2 grid exactly. Capped so rows never exceeds columns, matching the backdrop's own
// wide, landscape shape; a single row (an exact divisor of anything) is the fallback for a tile
// count with no divisor at or under that cap (a prime above 4, say).
function collageGridDims(count) {
	count = Math.max(1, count);

	const maxRows = Math.floor(Math.sqrt(count));

	for (let rows = maxRows; rows >= 1; rows--) {
		if (count % rows === 0) return { columns: count / rows, rows: rows };
	}

	return { columns: count, rows: 1 };
}

// Builds (and replaces) the collage container's own tile elements - not rendered by the template,
// since the right count is only known once the series' volumes are, one call before the actual
// tile images resolve (see loadSeriesCollage()) so they can still be filled in progressively.
function buildCollageGrid(container, count) {
	container.innerHTML = '';

	const dims = collageGridDims(count);

	container.style.gridTemplateColumns = 'repeat(' + dims.columns + ', 1fr)';
	container.style.gridTemplateRows = 'repeat(' + dims.rows + ', 1fr)';

	const tiles = [];

	for (let i = 0; i < count; i++) {
		const tile = document.createElement('div');
		tile.className = 'coverflow-collage-tile';
		container.appendChild(tile);
		tiles.push(tile);
	}

	return tiles;
}

// Versioned so a series already visited under an earlier build of this feature - a different
// tile-picking scheme, a different tile cap, PDF volumes silently producing no tile at all - gets
// rebuilt instead of serving whatever it cached back then forever. Bump this whenever
// buildSeriesCollage()'s own selection logic changes in a way that should invalidate what is
// already on disk.
const COLLAGE_CACHE_VERSION = 4;

function collageCacheName(seriesPath) {
	return 'coverflow-collage-v' + COLLAGE_CACHE_VERSION + '-' + sha1(seriesPath);
}

// A volume added or removed changes this signature, which is the only thing that invalidates
// the cache - editing which page a still-present volume happens to show is not worth chasing,
// and would mean re-listing the whole series just to notice nothing relevant changed.
function collageSignature(volumePaths) {
	return volumePaths.length + ':' + sha1(volumePaths.join('|'));
}

async function ensureSeriesCollage(seriesPath, volumePaths, onTileChosen) {
	const cacheName = collageCacheName(seriesPath);
	const signature = collageSignature(volumePaths);
	const cached = cache.readJson(cacheName);

	if (cached && cached.signature === signature && Array.isArray(cached.tiles)) {
		if (onTileChosen) {
			for (let i = 0, len = cached.tiles.length; i < len; i++)
				onTileChosen(i, cached.tiles[i]);
		}

		return cached.tiles;
	}

	const tiles = await buildSeriesCollage(seriesPath, volumePaths, onTileChosen);

	// A build abandoned partway through (the user navigated away - see the token checks inside
	// buildSeriesCollage) is never written to disk: caching it would permanently lock this series'
	// signature to whatever incomplete set had been chosen so far, since nothing about the
	// series itself changed to ever invalidate it again.
	if (!tiles.aborted) cache.writeJson(cacheName, { signature: signature, tiles: tiles });

	return tiles;
}

// Entry point, called once from init() - not from layout()/goTo(), since the whole point is
// that this collage does not change as the row moves. seriesPath is coerced/validated rather
// than trusted as already being a proper non-empty string - it ultimately comes from
// handlebarsContext.headerTitlePath, set well outside this file's control, and sha1() (used
// throughout below) throws outright on anything that is not a string.
async function loadSeriesCollage(seriesPath, volumePaths) {
	const token = collageBuildToken;

	seriesPath = typeof seriesPath === 'string' ? seriesPath : '';

	if (!collageTiles.length || !seriesPath || !volumePaths.length) return;

	await ensureSeriesCollage(seriesPath, volumePaths, function (tileIndex, entry) {
		if (token === collageBuildToken && tileIndex < collageTiles.length)
			resolveCollageTile(tileIndex, entry, token);
	});
}

function updateChrome() {
	const item = items[currentIndex];

	if (counterEl)
		counterEl.textContent = items.length ? (currentIndex + 1) + '/' + items.length : '';

	if (titleEl)
		titleEl.textContent = item ? (item.dataset.name || '') : '';

	if (subtitleEl) {
		const subname = item ? (item.dataset.subname || '') : '';
		subtitleEl.textContent = subname;
	}
}

function goTo(index, animate = true) {
	if (!isActive() || !items.length) return;

	const next = Math.max(0, Math.min(items.length - 1, index));

	if (next === currentIndex) return;

	currentIndex = next;
	// false: the container's own size cannot have changed just from moving to a different
	// cover, so this reuses the last measured coverWidth/coverHeight instead of re-forcing a
	// reflow on every single navigation - see the note on layout() above.
	layout(animate, false);

	// Covers that have just come into the window may not have had their thumbnail
	// generated yet - this is the same call the grid view makes when it scrolls, and it
	// picks up the new window from calculateVisibleItems() in dom.js.
	if (dom.scroll && dom.scroll.check)
		app.setThrottle('coverflow-thumbnails', dom.scroll.check, 120, 260);
}

function go(delta) {
	goTo(currentIndex + delta);
}

// Clicking the centred cover opens it; clicking any other brings it to the front first,
// so a single click never both moves the row and opens something.
function select(index) {
	if (!isActive()) return;

	if (index !== currentIndex) {
		goTo(index);
		return;
	}

	open();
}

function open() {
	const item = items[currentIndex];
	if (!item) return;

	const path = item.dataset.path;
	const mainPath = item.dataset.mainPath;

	if (!path) return;

	// Same branch the grid view's own onclick uses, rather than a second guess at which
	// entries are readable - an archive is flagged as a folder here too, and the app's
	// answer for what that means lives in loadIndexPage().
	if (item.dataset.folder === 'true')
		dom.loadIndexPage(true, path, false, false, mainPath);
	else
		dom.openComic(true, path, mainPath);
}

function contextMenu(event) {
	if (!isActive() || !event) return;

	// Prefer the cover actually under the pointer, but fall back to the centred one - the
	// side covers are rotated well past 45 degrees, so their hit area is a sliver and
	// right-clicking "next to" one should still act on something sensible.
	const hit = event.target && event.target.closest ? event.target.closest('.coverflow-item') : false;
	const item = hit || items[currentIndex];

	if (!item) return;

	dom.comicContextMenu.call(item, item.dataset.path, item.dataset.mainPath, false, false, item.dataset.folder === 'true', false);
}

function onWheel(event) {
	if (!isActive()) return;

	event.preventDefault();

	// A trackpad reports many small deltas where a mouse wheel reports one large one;
	// accumulating to a threshold makes both advance one cover per gesture rather than
	// letting a trackpad flick tear through the whole series.
	wheelAccumulator += Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;

	clearTimeout(wheelResetST);
	wheelResetST = setTimeout(function () { wheelAccumulator = 0; }, 140);

	if (Math.abs(wheelAccumulator) < 40) return;

	go(wheelAccumulator > 0 ? 1 : -1);
	wheelAccumulator = 0;
}

function onKeyDown(event) {
	if (!isActive()) return;

	// This listener stays on the document for the life of the app (rebinding it per view
	// swap would be churn for no gain), so it has to stand down whenever something is
	// layered over the view - otherwise it would eat the arrow keys of any open menu.
	if (events.dialogOrMenuActive && events.dialogOrMenuActive()) return;

	switch (event.key) {
		case 'ArrowRight':
		case 'ArrowDown':
			event.preventDefault();
			go(1);
			break;

		case 'ArrowLeft':
		case 'ArrowUp':
			event.preventDefault();
			go(-1);
			break;

		case 'Home':
			event.preventDefault();
			goTo(0);
			break;

		case 'End':
			event.preventDefault();
			goTo(items.length - 1);
			break;

		case 'Enter':
			event.preventDefault();
			open();
			break;
	}
}

function onResize() {
	if (!isActive()) return;

	// Geometry is measured from the cover's rendered width, so a resize has to re-place
	// the row - without the transition, since nothing conceptually moved.
	app.setThrottle('coverflow-resize', function () { layout(false); }, 60, 160);
}

// Called after every content-right change, regardless of which view actually rendered (see
// template.js's changeContentRight) - not just once the coverflow template is confirmed to be
// what is now showing. Checking the page's own recorded view here, rather than only querying
// the DOM for '.content-view-coverflow', matters because that query can still find the
// *previous* page's coverflow container if this fires while that content is mid-transition out
// - reset() below already clears this module's own state either way, but going on to query and
// act on a stale element belonging to a page already navigated away from is what let this
// build a collage keyed to the wrong (or, worse, no longer well-formed) series path.
function init() {
	reset();

	if (handlebarsContext.page?.view !== 'coverflow')
		return;

	container = document.querySelector('.content-view-coverflow');

	if (!container) return;

	track = container.querySelector('.coverflow-track');
	counterEl = container.querySelector('.coverflow-counter');
	titleEl = container.querySelector('.coverflow-title');
	subtitleEl = container.querySelector('.coverflow-subtitle');
	backdrop = container.querySelector('.coverflow-backdrop');

	items = track ? Array.prototype.slice.call(track.querySelectorAll('.coverflow-item')) : [];
	inners = items.map(function (item) { return item.querySelector('.coverflow-item-inner'); });

	if (!items.length) {
		updateChrome();
		return;
	}

	// One fixed collage for the whole series, not reassigned as the row moves - see
	// loadSeriesCollage() above. dom.currentPath() is the folder this listing actually is (set by
	// setCurrentPathScrollTop() during loadIndexPage, the same string config.folderView is keyed
	// by), which is what identifies "this series" for the cache - not any one volume's own
	// mainPath, which for a library organised deeper than category/series does not reliably land
	// on the series folder, and not handlebarsContext.headerTitlePath, which despite the name is
	// the breadcrumb array built for the header UI, not a path at all - passing that here (an
	// earlier version of this did) meant every call fell through the defensive string check
	// below and the collage silently never built.
	// The grid is sized here, before anything about its tiles is known, from the collage
	// container queried fresh off this render - not the template, which no longer emits any
	// tile divs of its own (see buildCollageGrid()) since the right count depends on how many
	// volumes this series actually has, capped at COLLAGE_TILES.
	const collageContainer = container.querySelector('.coverflow-collage');
	collageTiles = collageContainer ? buildCollageGrid(collageContainer, Math.min(items.length, COLLAGE_TILES)) : [];

	loadSeriesCollage(dom.currentPath() || '', items.map(function (item) { return item.dataset.path; }).filter(Boolean));

	// The volume badge is filled here rather than in the template so it does not need a
	// Handlebars helper just to add one to the loop index.
	for (let i = 0, len = items.length; i < len; i++) {
		const number = items[i].querySelector('.coverflow-item-number');
		if (number) number.textContent = String(i + 1);
	}

	// Open on the volume that was last read, if there is one, rather than always on the
	// first - the point of this view is getting to the next volume quickly.
	currentIndex = Math.max(0, Math.min(items.length - 1, startIndex()));

	container.addEventListener('wheel', onWheel, { passive: false });

	if (!boundKeys) {
		document.addEventListener('keydown', onKeyDown);
		window.addEventListener('resize', onResize);
		boundKeys = true;
	}

	updateChrome();
	markLoadedImages();

	// The view is inserted mid-transition, so it can still measure zero on the first frame.
	// Placing the row needs a real height (that is what the geometry is scaled from), so
	// retry a few frames rather than laying out against a zero-size container.
	let attempts = 0;

	const place = function () {
		if (!isActive()) return;

		if (layout(false) === false && ++attempts < 20) {
			requestAnimationFrame(place);
			return;
		}
	};

	requestAnimationFrame(place);
}

// Where to open the row. The point of this view is reaching the volume you are on, so it
// starts there rather than at volume one: the most recently opened entry if the list
// carries that (the library index does), otherwise the first volume that is started but
// not finished (which is what a series folder carries), otherwise the beginning.
function startIndex() {
	const comics = handlebarsContext.comics;

	if (!comics || !comics.length) return 0;

	let lastTouched = -1;
	let newest = 0;
	let firstUnfinished = -1;

	for (let i = 0, len = comics.length; i < len; i++) {
		const comic = comics[i];

		const lastReading = comic.readingProgress ? comic.readingProgress.lastReading : 0;

		if (lastReading && lastReading > newest) {
			newest = lastReading;
			lastTouched = i;
		}

		const progress = comic.progress;

		if (firstUnfinished === -1 && progress && progress.read > 0 && progress.read < progress.total)
			firstUnfinished = i;
	}

	if (lastTouched !== -1) return lastTouched;
	if (firstUnfinished !== -1) return firstUnfinished;

	return 0;
}

// The template marks images that already had a src; images filled in later by
// addImageToDom() get `active` from that path, and this keeps the placeholder in step.
function markLoadedImages() {
	for (let i = 0, len = items.length; i < len; i++) {
		const img = items[i].querySelector('img');

		if (img && img.getAttribute('src'))
			items[i].classList.add('coverflow-has-image');
	}
}

// dom.js calls this after a thumbnail lands so the placeholder can step aside. The collage does
// not show the row's own covers at all (see loadSeriesCollage()), so this only needs to update
// that placeholder now.
function imageLoaded(sha) {
	if (!isActive() || !sha) return;

	const img = container.querySelector('img.sha-image-' + sha);

	if (img) {
		const item = img.closest('.coverflow-item');
		if (item) item.classList.add('coverflow-has-image');
	}
}

function reset() {
	if (container) {
		container.removeEventListener('wheel', onWheel);
		container.removeEventListener('resize', onResize);
	}

	container = false;
	track = false;
	counterEl = false;
	titleEl = false;
	subtitleEl = false;
	backdrop = false;
	collageTiles = [];
	items = [];
	inners = [];
	currentIndex = 0;
	wheelAccumulator = 0;

	// Discards any collage build/resolve still in flight for whatever series this is leaving -
	// see the token checks in loadSeriesCollage()/applyCollageTile(). The token alone only stops
	// this module from *acting* on a result that still comes in - collectVolumePages()'s own
	// await, and any tile already dequeued into resolveCollageTile()'s threads.job('coverflowCollage'),
	// keep running to actually completion regardless, silently spending CPU/IO on a folder nobody
	// is looking at anymore. What clean() below can do something about is everything that has not
	// started yet - normally most of a series' up-to-20 tiles at any given moment, given the
	// queue's own deliberately light throttle (resolveCollageTile()) - which now gets dropped the
	// instant this series is left instead of trickling out one by one after the fact. Safe to wipe
	// unconditionally: this key exists solely for collage tiles (cache.js), so nothing outside
	// this feature is sharing it or could be cancelled by mistake here.
	collageBuildToken++;
	threads.clean('coverflowCollage');

	clearTimeout(wheelResetST);
}

module.exports = {
	init,
	reset,
	select,
	go,
	goTo,
	open,
	contextMenu,
	imageLoaded,
	get index() { return currentIndex },
	get length() { return items.length },
};
