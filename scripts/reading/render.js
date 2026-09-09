const ai = require(p.join(appDir, '.dist/reading/render/ai.js'));

var file = false,
	ebook = false,
	ebookConfigChanged = false,
	renderType = 'canvas',
	renderImages = false,
	renderCanvas = false,
	renderEbook = false,
	imagesData = {},
	rendering = {},
	rendered = {},
	renderedMagnifyingGlass = {},
	renderedQuality = {},
	renderedMagnifyingGlassQuality = {},
	renderedObjectsURL = [],
	renderedObjectsURLCache = {},
	maxNext = 10,
	maxPrev = 10,
	currentIndex = 0,
	scale = 1,
	scaleMagnifyingGlass = false,
	globalZoom = false,
	doublePage = false,
	onRender = false;

let syncRenderedPdfDimensionsST = false;

function fitEbookIframeContent(iframe)
{
	if(!iframe) return;

	iframe.addEventListener('load', async function(){

		const applyFit = function() {

			try
			{
				const doc = iframe.contentDocument;
				if(!doc) return;

				const root = doc.documentElement;
				const body = doc.body || doc.querySelector('body');
				if(!root || !body) return;

				// Measure natural layout first; transforms/hidden overflow can under-report scroll sizes and cause clipping.
				body.style.transform = '';
				body.style.width = '';
				body.style.height = '';
				root.style.overflow = '';
				body.style.overflow = '';

				const contentWidth = Math.max(root.scrollWidth, body.scrollWidth, body.offsetWidth, 1);
				const contentHeight = Math.max(root.scrollHeight, body.scrollHeight, body.offsetHeight, 1);

				const viewportWidth = iframe.clientWidth || parseFloat(iframe.style.width) || contentWidth;
				const viewportHeight = iframe.clientHeight || parseFloat(iframe.style.height) || contentHeight;

				if(!viewportWidth || !viewportHeight) return;

				// Keep a small safety margin to avoid edge clipping caused by subpixel rounding.
				const safeViewportWidth = Math.max(1, viewportWidth - 8);
				const safeViewportHeight = Math.max(1, viewportHeight - 6);
				const scaleToFit = Math.min(safeViewportWidth / contentWidth, safeViewportHeight / contentHeight, 1);

				if(scaleToFit < 0.999)
				{
					body.style.transformOrigin = 'top left';
					body.style.transform = 'scale('+scaleToFit+')';
					body.style.width = contentWidth+'px';
					body.style.height = contentHeight+'px';
					body.style.paddingRight = '2px';
				}
				else
				{
					body.style.transform = '';
					body.style.width = '';
					body.style.height = '';
					body.style.paddingRight = '';
				}

				// Keep internal scrollbars disabled after sizing.
				root.style.overflow = 'hidden';
				body.style.overflow = 'hidden';
			}
			catch(error) {}

		}

		applyFit();

		try
		{
			const doc = iframe.contentDocument;
			if(doc?.fonts?.ready)
				await doc.fonts.ready;
		}
		catch(error) {}

		await new Promise(function(resolve){ requestAnimationFrame(resolve); });
		await new Promise(function(resolve){ requestAnimationFrame(resolve); });
		applyFit();

		setTimeout(applyFit, 120);
		setTimeout(applyFit, 350);

	}, {once: true});
}

async function setFile(_file, _scaleMagnifyingGlass = false, _renderType = 'canvas')
{
	if(file) file.destroy();

	renderType = _renderType;

	renderImages = (renderType == 'images') ? true : false;
	renderCanvas = (renderType == 'canvas') ? true : false;
	renderEbook = (renderType == 'ebook') ? true : false;

	file = _file;
	if(file && !renderEbook) await file.read(); // Try make this from cache

	ebook = renderEbook ? await file.ebook() : false;
	ebookConfigChanged = false;

	rendered = {};
	renderedMagnifyingGlass = {};
	renderedQuality = {};
	renderedMagnifyingGlassQuality = {};
	rendering = {};
	scale = 1;
	scaleMagnifyingGlass = _scaleMagnifyingGlass;
	globalZoom = false;
	ai.clean(true);

	if(renderImages)
		revokeAllObjectURL();

	createObserver();

	return;
}

async function reset(_scaleMagnifyingGlass = false)
{
	ebook = renderEbook ? await file.ebook() : false;

	rendered = {};
	renderedMagnifyingGlass = {};
	renderedQuality = {};
	renderedMagnifyingGlassQuality = {};
	rendering = {};
	scale = 1;
	scaleMagnifyingGlass = _scaleMagnifyingGlass;
	globalZoom = false;
	ai.clean(true);

	if(renderImages)
		revokeAllObjectURL();

	return;
}

function setImagesData(_imagesData)
{
	imagesData = _imagesData;
}

function setMagnifyingGlassStatus(active = false, doublePage = false)
{
	scaleMagnifyingGlass = active;

	if(active)
		setRenderQueue(doublePage ? 3 : 2, doublePage ? 4 : 2, false, true);
}

var sendToQueueST = false;
var aiSettleST = false;

// AI reprocessing (extracting a full-resolution copy of the page and running a native model on
// it) is real, uncached work paid again on every page it runs for - too slow to also gate by the
// same 180ms used to widen the prefetch window below. That 180ms only means "not turning pages
// back to back"; it does not mean "stopped to read this one". Momentum/inertial scrolling and
// even plain wheel input both coast through gaps well past 180ms while still genuinely
// scrolling, and re-running AI on whichever page a scroll happened to be crossing during one of
// those gaps is what turned "scroll smoothly" into "smooth, then stutter, then smooth again".
const AI_SETTLE_DELAY_MS = 600;

// Rasterising a page costs, in both time and memory, the square of this number - and so does
// every bitmap decoded from the result and held in the blob cache. 2600 still covers a
// full-height page on a 4K display at the capped pixel ratio above; past it the reader was
// paying for detail no window was showing.
const PDF_RENDER_MAX_WIDTH = 2600;

function isPdfCanvasMode()
{
	if(!renderCanvas || !file || !file.getFeatures)
		return false;

	try
	{
		const features = file.getFeatures();
		return !!(features && features.pdf);
	}
	catch(error)
	{
		return false;
	}
}

function getQueueLimits()
{
	// PDF pages are rasterised one by one, so this window has to stay well inside what
	// renderedBlobLimit() will keep alive - otherwise pages are evicted before they are ever
	// shown and the reader spends its time re-rendering what it already rendered. A page now
	// costs roughly a fifth of what it used to (native image decoding, JPEG instead of PNG),
	// but widening it was measured and made things worse: what a cached page really costs is
	// not its blob but the bitmap Chromium decodes from it, and that is unchanged.
	if(isPdfCanvasMode())
		return { prev: 3, next: 6 };

	if(reading.readingViewIs('scroll'))
		return { prev: Math.max(maxPrev, 10), next: Math.max(maxNext, 10) };

	return { prev: maxPrev, next: maxNext };
}

function getPrioritizeNextWindow(doublePage = false)
{
	if(reading.readingViewIs('scroll'))
	{
		const limits = getQueueLimits();
		return Math.min(Math.max(4, limits.prev), Math.max(0, limits.next - 1));
	}

	return doublePage ? 2 : false;
}

function shouldUseProcessedImageRender(index, magnifyingGlass = false)
{
	if(renderCanvas || renderEbook || magnifyingGlass || !renderImages)
		return true;

	if(reading.readingViewIs('scroll'))
		return index === currentIndex;

	const spreadWindow = doublePage ? 1 : 0;

	return Math.abs(index - currentIndex) <= spreadWindow;
}

function shouldQueueRender(index, renderedState, renderedStateQuality, scale = false, magnifyingGlass = false)
{
	if(!renderedState[index])
		return true;

	if(scale !== false && renderedState[index] !== scale)
		return true;

	if(shouldUseProcessedImageRender(index, magnifyingGlass) && renderedStateQuality[index] !== 'processed')
		return true;

	return false;
}

async function ensureDirectImageSource(src, img)
{
	if(!img)
		return false;

	// Note the absence of a `blobRendered` check. Re-pointing an element that is already
	// showing a rendered blob of this same page back at the raw file downgrades it for a frame
	// before the blob is reapplied — which is exactly the flicker seen on every page turn, and
	// primeImageSource() runs this over the whole visible window on each focus change.
	// dataset.baseSrc is now set on the blob paths too, so it alone identifies what is shown.
	if(!img.getAttribute('src') || img.dataset.baseSrc !== src)
		await srcToImage(src, img);

	return true;
}

async function primeImageSource(index)
{
	if(renderCanvas || renderEbook || !imagesData[index])
		return false;

	const contentRight = template._contentRight();
	const img = contentRight.querySelector('.reading-body > div > div.r-flex .r-img-i'+index+' oc-img img');
	if(!img)
		return false;

	const src = img.dataset.src;
	const path = img.dataset.path;

	if(!src || compatible.image.convert(path))
		return false;

	img.loading = 'eager';
	img.fetchPriority = index === currentIndex ? 'high' : 'low';

	await ensureDirectImageSource(src, img);

	try
	{
		img.decode().catch(function(){});
	}
	catch(error) {}

	return true;
}

function primeImmediateSourceWindow(prev = 10, next = 10)
{
	if(renderCanvas || renderEbook)
		return;

	const seen = {};
	const maxDistance = Math.max(prev, next);

	for(let distance = 0; distance <= maxDistance; distance++)
	{
		if(distance <= next)
		{
			const forwardIndex = currentIndex + distance;
			if(!seen[forwardIndex])
			{
				seen[forwardIndex] = true;
				primeImageSource(forwardIndex);
			}
		}

		if(distance > 0 && distance <= prev)
		{
			const backwardIndex = currentIndex - distance;
			if(!seen[backwardIndex])
			{
				seen[backwardIndex] = true;
				primeImageSource(backwardIndex);
			}
		}
	}
}

function getVisbleImages(doublePage = false)
{
	const isScroll = reading.readingViewIs('scroll');

	let images = doublePage ? 2 : 0;
	if(isScroll) images += 2;

	let prev = images;
	let next = images;

	if(next == 0)
		next = 1;

	return {prev: prev, next: next};
}

function renderingKey(index, magnifyingGlass = false)
{
	return (magnifyingGlass ? 'mg:' : 'base:') + index;
}

function isRendering(index, magnifyingGlass = false)
{
	return !!rendering[renderingKey(index, magnifyingGlass)];
}

function setRendering(index, magnifyingGlass = false, active = true)
{
	const key = renderingKey(index, magnifyingGlass);

	if(active)
		rendering[key] = true;
	else
		delete rendering[key];
}

function setScale(_scale = 1, _globalZoom = false, _doublePage = false)
{
	if(!file && !renderImages) return;
	if(renderEbook) return;

	clearTimeout(sendToQueueST);

	queue.clean('readingRender');
	ai.clean();
	rendering = {};

	scale = _scale;
	globalZoom = _globalZoom;
	doublePage = _doublePage;

	const visbleImages = getVisbleImages(doublePage);

	if(globalZoom)
	{
		rendered = {};
		renderedMagnifyingGlass = {};
		renderedQuality = {};
		renderedMagnifyingGlassQuality = {};

		setRenderQueue(visbleImages.prev, visbleImages.next);

		sendToQueueST = setTimeout(function(){
			const limits = getQueueLimits();

			if(scaleMagnifyingGlass) setRenderQueue(doublePage ? 3 : 2, doublePage ? 4 : 2, _scale * scaleMagnifyingGlass, true);
			setRenderQueue(limits.prev, limits.next);

		}, 1000);
	}
	else
	{
		setRenderQueue(visbleImages.prev, visbleImages.next, _scale);

		sendToQueueST = setTimeout(function(){

			if(scaleMagnifyingGlass) setRenderQueue(doublePage ? 3 : 2, doublePage ? 4 : 2, _scale * scaleMagnifyingGlass, true);

		}, 500);
	}
}

function setScaleMagnifyingGlass(_scale = 1, doublePage = false)
{
	if(!file || !scaleMagnifyingGlass) return;
	if(renderEbook) return;

	clearTimeout(sendToQueueST);

	queue.clean('readingRender');
	ai.clean();
	rendering = {};

	renderedMagnifyingGlass = {};
	scaleMagnifyingGlass = _scale;

	sendToQueueST = setTimeout(function(){

		if(scaleMagnifyingGlass) setRenderQueue(doublePage ? 3 : 2, doublePage ? 4 : 2, scale * scaleMagnifyingGlass, true);

	}, 500);
}

function resized(doublePage = false)
{
	if(!file && !renderImages) return;
	if(renderEbook) return; // Reset function is used

	let readingBody = template._contentRight().querySelector('.reading-body');
	if(readingBody) readingBody.classList.add('resizing');

	clearTimeout(sendToQueueST);

	queue.clean('readingRender');
	ai.clean();
	rendering = {};

	if(renderImages)
		revokeAllObjectURL();

	rendered = {};
	renderedMagnifyingGlass = {};
	renderedQuality = {};
	renderedMagnifyingGlassQuality = {};

	if(readingBody) readingBody.classList.remove('resizing');

	const visbleImages = getVisbleImages(doublePage);
	setRenderQueue(visbleImages.prev, visbleImages.next);

	sendToQueueST = setTimeout(function(){
		const limits = getQueueLimits();

		if(scaleMagnifyingGlass) setRenderQueue(doublePage ? 3 : 2, doublePage ? 4 : 2, false, true);
		setRenderQueue(limits.prev, limits.next);

	}, 400);
}

async function setEbookConfigChanged(ebookConfig)
{
	ebookConfigChanged = true;

	if(renderEbook && ebook)
		ebook.updateConfig(ebookConfig);
}

async function focusIndex(index, _doublePage = false, runAi = true)
{
	if(!file && !renderImages) return;

	clearTimeout(sendToQueueST);
	clearTimeout(aiSettleST);

	currentIndex = index;
	doublePage = !!_doublePage;
	const isScrollView = reading.readingViewIs('scroll');

	if(!isScrollView)
	{
		// Drop stale queued renders from previous turns so the current page does not wait behind old work.
		queue.clean('readingRender');
		ai.clean();
		rendering = {};
	}

	// Priming is asymmetric on purpose: pages ahead are what the reader is about to need.
	// The old symmetric 10/10 window meant up to 21 querySelector + decode() calls on every
	// single page turn, most of them for pages behind the reader that were already decoded.
	if(isScrollView)
		primeImmediateSourceWindow(4, 8);
	else
		primeImmediateSourceWindow(_doublePage ? 2 : 1, _doublePage ? 5 : 4);

	pruneRenderedObjectURL();

	const immediateQueue = isScrollView ? getVisbleImages(_doublePage) : {
		prev: _doublePage ? 2 : 1,
		next: _doublePage ? 3 : 2,
	};
	const limits = getQueueLimits();
	const prioritizeNext = getPrioritizeNextWindow(_doublePage);

	// `runAi` is false for a rapid run of page turns and for any scroll-driven index update, fast
	// or slow (see the caller in reading.js) - i.e. whenever this call cannot be trusted to mean
	// "the reader wants this specific page now". For a PDF page that matters far more than for
	// any other format: unlike a CBZ image, which already sits decoded on disk, an AI step here
	// first has to rasterise the PDF page to a JPEG (see extractPdf()) before the AI model ever
	// sees it - a second full render on top of the one already needed just to show the page.
	// Skipping it here does not lose the AI pass permanently: aiSettleST below applies it once
	// the page has actually been the target for a while, not just whenever the queue widens.
	setRenderQueue(immediateQueue.prev, immediateQueue.next, false, false, prioritizeNext, runAi);

	sendToQueueST = setTimeout(function(){

		// AI stays off here even though this already fires well after the immediate call above -
		// see AI_SETTLE_DELAY_MS and aiSettleST below for why 180ms is not long enough to mean
		// AI should run. This only widens which pages get prefetched.
		setRenderQueue(limits.prev, limits.next, false, false, prioritizeNext, false);

		if(scaleMagnifyingGlass) setRenderQueue(doublePage ? 3 : 2, doublePage ? 4 : 2, false, true);

	}, 180);

	if(!runAi)
	{
		aiSettleST = setTimeout(function(){

			setRenderQueue(immediateQueue.prev, immediateQueue.next, false, false, prioritizeNext, true);

		}, AI_SETTLE_DELAY_MS);
	}
}

function revokeAllObjectURL()
{
	// const total = renderedObjectsURL.reduce((acc, o) => acc + o.data.size, 0);
	// console.log(`Total blob payload megabytes: ${(total / (1024 * 1024)).toFixed(2)} MB in ${renderedObjectsURL.length} images`);

	for(let i = 0, len = renderedObjectsURL.length; i < len; i++)
	{
		renderedObjectsURL[i].img.classList.remove('blobRendered');
		URL.revokeObjectURL(renderedObjectsURL[i].data.blob);
	}

	renderedObjectsURL = [];
	renderedObjectsURLCache = {};
}

// Grace period before a blob may be evicted. It only has to outlast a page transition plus
// the decode that follows it; the "is it still in an <img>" check below is the real guard.
// The previous 30s value meant nothing could ever be evicted during fast scrolling, so the
// blob list grew without bound even though renderedBlobLimit() is as low as 3 for PDFs.
const RENDERED_BLOB_MIN_AGE_MS = 4000;

function revokeObjectURL(key, force = false)
{
	const index = renderedObjectsURL.findIndex(o => o.key === key);

	if(index !== -1)
	{
		const entry = renderedObjectsURL[index];
		const blob = entry?.data?.blob;

		if(!force)
		{
			if(entry?.createdAt && (Date.now() - entry.createdAt) < RENDERED_BLOB_MIN_AGE_MS)
				return false;

			const images = document.querySelectorAll('img');
			for(let i = 0, len = images.length; i < len; i++)
			{
				if(images[i].src === blob)
					return false;
			}
		}

		// renderedObjectsURL[index].img.classList.remove('blobRendered');
		URL.revokeObjectURL(blob);

		renderedObjectsURL.splice(index, 1);
		delete renderedObjectsURLCache[key];

		return true;
	}

	return false;
}

function renderedBlobLimit()
{
	if(!renderCanvas || !file || !file.getFeatures)
		return reading.readingViewIs('scroll') ? 48 : 32;

	try
	{
		const features = file.getFeatures();

		// Must stay comfortably above getQueueLimits() for PDFs (3 + 6 + the current page),
		// otherwise freshly rendered pages are evicted before they are displayed and the
		// reader thrashes, re-rendering the same pages on every turn.
		//
		// Do not raise this because the blobs themselves got smaller. Measured on a 164MB
		// file, going from 12/16 to 28/40 took the app from 1.2GB to 2.2GB: an entry in this
		// list keeps an <img> alive, and what that costs is the bitmap Chromium decodes from
		// the blob - width x height x 4, tens of megabytes - not the encoded bytes.
		if(features && features.pdf)
			return file?.pdfFastRead ? 12 : 16;
	}
	catch(e){}

	if(reading.readingViewIs('scroll'))
		return 48;

	return 24;
}

// A page count is the wrong unit to budget this cache in.
//
// Rendered pages are PNG at compressionLevel 0, which is essentially raw — a 1280px page
// measures 6.6MB. The rendered width is originalWidth * scale * devicePixelRatio capped by
// config.renderMaxWidth, whose default is 12000, so the same "one page" is 6.6MB at a normal
// window size, ~26MB on a HiDPI display, and far more again when zoomed in. Keeping "48 pages"
// therefore meant anywhere from 320MB to several gigabytes depending on the display, the window
// and the zoom level, with nothing in the reader aware of the difference.
//
// The budget below is deliberately set above what the count limits allow at normal page sizes,
// so it changes nothing in the common case and only binds when pages are genuinely large —
// which is precisely the case the count could not see.
function renderedBlobByteBudget()
{
	return (reading.readingViewIs('scroll') ? 384 : 256) * 1024 * 1024;
}

function renderedBlobBytes()
{
	let bytes = 0;

	for(let i = 0, len = renderedObjectsURL.length; i < len; i++)
	{
		bytes += renderedObjectsURL[i]?.data?.size || 0;
	}

	return bytes;
}

function scheduleRenderedPdfDimensionsSync()
{
	clearTimeout(syncRenderedPdfDimensionsST);
	syncRenderedPdfDimensionsST = setTimeout(function() {

		syncRenderedPdfDimensionsST = false;

		try
		{
			reading.disposeImages();
			reading.calculateView();
			reading.stayInLine();
		}
		catch(error) {}

	}, 40);
}

function syncRenderedPdfDimensions(index, imageData, data = false)
{
	if(!isPdfCanvasMode() || !data || !imagesData[index])
		return;

	const originalWidth = Math.max(1, Math.round(data.originalWidth || 0));
	const originalHeight = Math.max(1, Math.round(data.originalHeight || 0));

	if(!originalWidth || !originalHeight)
		return;

	const rotated90 = (imageData?.rotated == 1 || imageData?.rotated == 2) ? true : false;
	const nextWidth = rotated90 ? originalHeight : originalWidth;
	const nextHeight = rotated90 ? originalWidth : originalHeight;
	const current = imagesData[index];

	if(current.width === nextWidth && current.height === nextHeight)
		return;

	current.width = nextWidth;
	current.height = nextHeight;
	current.aspectRatio = nextWidth / nextHeight;

	scheduleRenderedPdfDimensionsSync();
}

// Whether index is still inside the window setRenderQueue() actively keeps prefetched
// (getQueueLimits() - a handful of pages either side of currentIndex, not the whole
// renderedBlobLimit() budget). pruneRenderedObjectURL() below only ever considers eviction
// once that larger budget is already exceeded, so using the tight window as the "never evict"
// floor here does not reintroduce the thrashing renderedBlobLimit() being wider than it was
// written to avoid - a page just past the hot window stays cached for free until the budget
// itself is actually exceeded; only once it is does the oldest surplus get reclaimed.
function isWithinRenderWindow(index)
{
	const limits = getQueueLimits();
	const distance = index - currentIndex;

	return distance >= -limits.prev && distance <= limits.next;
}

// Reverses exactly what the render path (further down this file) does to show a page: drops
// the blob src, the classes/dataset it stamped on for that render, and the render-cache state
// that would otherwise make shouldQueueRender() believe this index is still showing something.
// Does not touch img.dataset.width/height - nothing reads those for an index outside the
// render window, and a revisit re-renders and overwrites them anyway.
function unrenderImage(entry)
{
	if(entry.img)
	{
		entry.img.removeAttribute('src');
		delete entry.img.dataset.baseSrc;
		entry.img.classList.remove('blobRendered', 'blobRender');
	}

	delete rendered[entry.index];
	delete renderedQuality[entry.index];
	delete renderedMagnifyingGlass[entry.index];
	delete renderedMagnifyingGlassQuality[entry.index];
}

function pruneRenderedObjectURL()
{
	const limit = renderedBlobLimit();
	const byteBudget = renderedBlobByteBudget();

	let count = renderedObjectsURL.length;
	let bytes = renderedBlobBytes();

	if(count <= limit && bytes <= byteBudget) return;

	// Oldest first (renderedObjectsURL is already append-ordered), skipping anything still
	// inside the grace period, so nothing that is on screen can be pulled out from under it.
	const now = Date.now();
	const candidates = renderedObjectsURL
		.filter(o => !o.pinned && o.createdAt && (now - o.createdAt) > RENDERED_BLOB_MIN_AGE_MS);

	if(!candidates.length) return;

	// Keep going until both budgets are satisfied rather than evicting a fixed number: one
	// oversized page can put the cache over its byte budget on its own, and a fixed slice
	// sized from the count would never reclaim it.
	for(let i = 0; i < candidates.length && (count > limit || bytes > byteBudget); i++)
	{
		const entry = candidates[i];

		// Not "is some <img> still pointing at this blob" - every page gets one <img> for the
		// life of the book/chapter (reading.js's addHtmlImages()) and nothing else ever clears
		// its src as the page scrolls away, so that check was true for every page ever rendered
		// this session and nothing downstream of it was ever actually reachable. Distance from
		// the current page is what should decide this instead - see isWithinRenderWindow().
		if(isWithinRenderWindow(entry.index))
			continue;

		unrenderImage(entry);

		if(revokeObjectURL(entry.key, true))
		{
			count--;
			bytes -= entry?.data?.size || 0;
		}
	}
}

function reRenderImage(index, runAi = false)
{
	const image = imagesData[index] || false;
	if(!image) return;

	const contentRight = template._contentRight();

	const img = contentRight.querySelector('.reading-body > div > div.r-flex .r-img-i'+index+' oc-img img');
	if(!img) return;

	const src = img.dataset.src;

	const toRevoke = renderedObjectsURL.filter(o => o.src === src).map(o => o.key);
	toRevoke.forEach(function(key) { revokeObjectURL(key, true); });

	renderedMagnifyingGlass[index] = false;
	rendered[index] = false;
	renderedMagnifyingGlassQuality[index] = false;
	renderedQuality[index] = false;

	setRenderQueue(doublePage ? 3 : 2, doublePage ? 4 : 2, false, false, false, runAi);

	if(scaleMagnifyingGlass)
		setRenderQueue(doublePage ? 3 : 2, doublePage ? 4 : 2, false, true, false, runAi);
}

async function setRenderQueue(prev = 1, next = 1, scale = false, magnifyingGlass = false, prioritizeNext = false, runAi = true)
{
	//console.time('readingRender');

	let _rendered = magnifyingGlass ? renderedMagnifyingGlass : rendered;
	let _renderedQuality = magnifyingGlass ? renderedMagnifyingGlassQuality : renderedQuality;
	const prioritizeForward = prioritizeNext ? Math.max(0, prioritizeNext) : 0;

	// Note: manga (right-to-left) mode only flips the visual layout — goNext() still increments
	// currentIndex — so "forward" here is always currentIndex + distance regardless of it.
	for(let i = 0, len = Math.max(next, prev + prioritizeForward); i < len; i++)
	{
		const backwardDistance = i - prioritizeForward;
		const forwardI = currentIndex + i;
		const backwardI = currentIndex - backwardDistance;

		// Forward pages in the active reading direction
		if(i < next && shouldQueueRender(forwardI, _rendered, _renderedQuality, scale, magnifyingGlass) && imagesData[forwardI] && !isRendering(forwardI, magnifyingGlass))
		{
			setRendering(forwardI, magnifyingGlass, true);

			if(renderEbook) // Render ebook instantly
			{
				await render(forwardI, scale, magnifyingGlass, 0, runAi);
			}
			else
			{
				queue.add('readingRender', async function(queueIndex) {

					return render(forwardI, scale, magnifyingGlass, queueIndex, runAi);

				}, queue.index('readingRender'));
			}
		}

		// Backward pages after giving forward pages a head start
		if(backwardDistance > 0 && backwardDistance <= prev && forwardI != backwardI && shouldQueueRender(backwardI, _rendered, _renderedQuality, scale, magnifyingGlass) && imagesData[backwardI] && !isRendering(backwardI, magnifyingGlass))
		{
			setRendering(backwardI, magnifyingGlass, true);

			if(renderEbook) // Render ebook instantly
			{
				render(backwardI, scale, magnifyingGlass, 0, runAi);
			}
			else
			{
				queue.add('readingRender', async function(queueIndex) {

					return render(backwardI, scale, magnifyingGlass, queueIndex, runAi);

				}, queue.index('readingRender'));
			}
		}
	}

	queue.end('readingRender', function() {

		//console.timeEnd('readingRender');

	});
}

async function setOnRender(num = 1, callback = false)
{
	queue.clean('readingRender');
	ai.clean();
	rendering = {};

	onRender = {
		num: num,
		callback: callback,
	};
}

async function render(index, _scale = false, magnifyingGlass = false, queueIndex = 0, runAi = true)
{
	try
	{
		let imageData = imagesData[index] || false;

		if(imageData)
		{
		let contentRight = template._contentRight();

		let rImg = contentRight.querySelector(magnifyingGlass ? '.reading-lens > div > div > div.r-flex .r-img-i'+index : '.reading-body > div > div.r-flex .r-img-i'+index);
		if(!rImg) return;

		const rotated90 = (imageData?.rotated == 1 || imageData?.rotated == 2) ? true : false;

		if(renderEbook)
		{
			const ebookPage = ebook.page(index - 1);
			const ebookHtml = (ebookPage && typeof ebookPage.html !== 'undefined' && ebookPage.html)
				? ebookPage.html
				: '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:24px;font-family:sans-serif;">Page unavailable</body></html>';

			rendered[index] = 1;
			renderedMagnifyingGlass[index] = 1;

			let iframe = ebook.pageToIframe(ebookHtml);
			let iframeMG = iframe.cloneNode(true);
			fitEbookIframeContent(iframe);
			fitEbookIframeContent(iframeMG);

			let ocImg = contentRight.querySelector('.r-img-i'+index+' oc-img');
			let ocImgMG = contentRight.querySelector('.reading-lens .r-img-i'+index+' oc-img');

			if(ocImg)
			{
				let prevIframe = ocImg.querySelector('iframe');
				if(prevIframe) prevIframe.remove();

				ocImg.appendChild(iframe);
			}

			if(ocImgMG)
			{
				let prevIframeMG = ocImgMG.querySelector('iframe');
				if(prevIframeMG) prevIframeMG.remove();

				ocImgMG.appendChild(iframeMG);
			}

			if(ebookConfigChanged)
			{
				ebook.applyConfigToHtml(iframe.contentDocument);
				ebook.applyConfigToHtml(iframeMG.contentDocument);
			}
		}
		else if(renderImages || renderCanvas)
		{
			const shouldSyncDecode = ((onRender && onRender.num > 0) || _scale !== false);
			let renderQuality = shouldUseProcessedImageRender(index, magnifyingGlass) ? 'pending' : 'fast';
			let cssMethods = {
				'pixelated': 'pixelated',
				'webkit-optimize-contrast': '-webkit-optimize-contrast',
			};

			let affineInterpolationMethods = {
				'bicubic': 'bicubic',
				'bilinear': 'bilinear',
				'nohalo': 'nohalo',
				'locally-bounded-bicubic': 'lbb',
				'vertex-split-quadratic-basis-spline': 'vsqbs',
			};

			_scale = (_scale || scale);

			let ocImg = rImg.querySelector('oc-img');
			if(!ocImg) return;

			let img = ocImg.querySelector('img');
			if(!img) return;

			let originalWidth = +ocImg.dataset.width;
			let originalHeight = +ocImg.dataset.height;

			if(isNaN(originalWidth) || isNaN(originalHeight)) return;

			if(magnifyingGlass)
				_scale = scale * scaleMagnifyingGlass;

			let renderDevicePixelRatio = window.devicePixelRatio;
			if(isPdfCanvasMode())
			{
				// Keyed off pdfFastRead, which now covers most documents rather than only huge
				// ones. That is deliberate: this ratio multiplies the pixels in the canvas AND
				// in the bitmap Chromium decodes for every cached page, so raising it to 1.25
				// across the board was measured at several hundred megabytes on a large file.
				const pdfDevicePixelRatioCap = file?.pdfFastRead ? 1 : 1.25;
				renderDevicePixelRatio = Math.min(renderDevicePixelRatio, pdfDevicePixelRatioCap);
			}
			_scale = _scale * renderDevicePixelRatio;

			let _config = {
				width: rotated90 ? Math.round(originalHeight * _scale) : Math.round(originalWidth * _scale),
				height: rotated90 ? Math.round(originalWidth * _scale) : Math.round(originalHeight * _scale),
				compressionLevel: 0,
				// kernel: 'lanczos3',
			};

			let src = img.dataset.src;
			const path = img.dataset.path;
			const key = isPdfCanvasMode() ? src+'|pdf|'+_config.width : src+'|'+_config.width+'x'+_config.height;
			fileManager.macosStartAccessingSecurityScopedResource(src);

			if(compatible.image.convert(path)) // Convert unsupported images
				src = await workers.convertImage(path, {priorize: true});

			// The AI pipeline reads its input from a file path, but PDF pages are rasterised
			// straight to blobs by renderBlobPdf() and are never written to disk — openComic()
			// only makes the PDF itself available, not its pages. Without this the pipeline
			// always failed with "Input file is missing: .../page-XXXX.jpg", so no AI feature
			// ever ran on a PDF. Extract just this page, and only when AI is actually enabled.
			if(runAi && renderCanvas && file && imageData.name && ai.willProcess(imageData))
			{
				// imagesData carries the name without the extension ("page-0001"), while the
				// extraction "only" filter and the file status map are both keyed by the real
				// filename ("page-0001.jpg"). Without this the filter matched nothing, so no
				// page was ever extracted and the AI kept reading a stale low-resolution file.
				// renderBlob below normalises the same way.
				const aiPageName = /\.jpg$/.test(imageData.name) ? imageData.name : imageData.name + '.jpg';

				// Extract at the resolution the page will actually be shown at. fileCompressed's
				// default config.width is only devicePixelRatio * 300 (it exists for vector
				// thumbnails), and extractPdf() rasterises at exactly config.width — so relying
				// on the default fed the AI a ~300px wide page whose output then had to be blown
				// up to full size, which is what made descreened pages look blurry.
				const aiExtractWidth = Math.max(1, Math.min(
					_config.width,
					config.renderMaxWidth,
					PDF_RENDER_MAX_WIDTH
				));

				const extracted = file.getFileStatus ? file.getFileStatus(aiPageName) : false;

				if(!fs.existsSync(src) || !extracted?.extracted || extracted?.width !== aiExtractWidth)
				{
					try
					{
						// force: extract() otherwise short-circuits on checkIfAlreadyExtracted()
						// whenever a file is already on disk, and the one sitting there is the
						// low-resolution copy left by thumbnail generation — which is exactly
						// the stale input we are trying to replace. The guard above already
						// limits this to pages that genuinely need re-rendering.
						await file.extract({only: [aiPageName], width: aiExtractWidth, force: true});
						fileManager.setTmpUsage(src);
					}
					catch(error)
					{
						console.error('Failed to extract page for the AI pipeline: '+src, error);
					}
				}
			}

			const aiPath = ai.image(src, imageData, {
				run: runAi,
				start: function() {

					if(!magnifyingGlass && !ocImg.querySelector('.ai-loading'))
					{
						const html = template.load('ai.loading.html');
						ocImg.insertAdjacentHTML('beforeend', html);

						//const loading = ocImg.querySelector('.ai-loading .loading');
						//if(loading) events.loadingProgress(loading, 0);
					}

				},
				progress: function(progress) {

					/*const icon = ocImg.querySelector('.ai-loading .material-icon');
					if(icon) icon.style.animationDuration = '1s';

					const loading = ocImg.querySelector('.ai-loading .loading');
					if(loading)
					{
						loading.style.opacity = 1;
						events.loadingProgress(loading, progress);
					}*/

				},
				end: function(aiPath) {

					const aiLoading = ocImg.querySelector('.ai-loading');
					if(aiLoading) aiLoading.remove();

					reRenderImage(index, false);

				}
			});

			if(aiPath)
				src = aiPath;

			const imageSize = aiPath ? reading.ai.size(imageData) : imageData;
			_config.kernel = _config.width > imageSize.width ? config.readingImageInterpolationMethodUpscaling : config.readingImageInterpolationMethodDownscaling;

			if(renderCanvas)
			{
				let maxWidth = config.renderMaxWidth;
				if(isPdfCanvasMode())
					maxWidth = Math.min(maxWidth, PDF_RENDER_MAX_WIDTH);

				if(_config.width > maxWidth)
				{
					const ratio = maxWidth / _config.width;
					_config.width = maxWidth;
					_config.height = Math.max(1, Math.round(_config.height * ratio));
				}

				// Skip cache if AI path was applied; cache key is based on original src, not aiPath
				if(!aiPath && renderedObjectsURLCache[key])
				{
					const data = renderedObjectsURLCache[key];
					syncRenderedPdfDimensions(index, imageData, data);
					img.src = await decodeBeforeSwap(data.blob);
					img.dataset.baseSrc = src;
					img.classList.add('blobRendered', 'blobRender', 'sizeFromImg');
					img.style.imageRendering = '';

					img.dataset.width = Math.round(data.width);
					img.dataset.height = Math.round(data.height);
					renderQuality = 'processed';
				}
				else {
					try {
						let name = imageData.name;
						name = (name && !/\.jpg$/.test(name)) ? name + '.jpg' : name;

						let data = false;

						if (name) {
							// If an AI-produced path is available, prefer loading it directly instead of
							// rendering the original PDF page blob. This ensures AI output is shown.
							if (aiPath) {
									if (_config.kernel && cssMethods[_config.kernel]) {
										// aiPath is already assigned to src above
										await srcToImage(src, img);
										img.style.imageRendering = cssMethods[_config.kernel];
									}
									else {
										// Deliberately no ensureDirectImageSource() here. It pointed the element at
										// the raw AI output, which is then overwritten by the correctly sized blob a
										// few milliseconds later — one unscaled intermediate frame, visible as a
										// flicker on every page turn. The reader already waits for the render to
										// finish before showing the page (see setOnRender), so there is nothing to
										// gain from displaying the unscaled file first, and the catch below still
										// falls back to it if the resize fails.
										let aiResizeConfig = {..._config};
										if(!aiResizeConfig.kernel || aiResizeConfig.kernel === 'chromium')
											aiResizeConfig.kernel = 'lanczos3';

										if(!(await image.isAnimated(src))) {
											if(affineInterpolationMethods[aiResizeConfig.kernel]) {
												aiResizeConfig.imageWidth = rotated90 ? imageSize.height : imageSize.width;
												aiResizeConfig.imageHeight = rotated90 ? imageSize.width : imageSize.height;
												aiResizeConfig.interpolator = affineInterpolationMethods[aiResizeConfig.kernel];
												aiResizeConfig.kernel = false;
											}

											try {
												const aiData = await image.resizeToBlob(src, aiResizeConfig);

												// Register the blob so revokeObjectURL()/revokeAllObjectURL() can
												// free it later; unregistered blobs leaked for every AI page.
												renderedObjectsURL.push({data: aiData, img: img, key: 'ai|'+src+'|'+aiResizeConfig.width, src, index, createdAt: Date.now()});
												pruneRenderedObjectURL();

												if(queueIndex !== queue.index('readingRender')) return; // Return if the queue is different

												img.src = await decodeBeforeSwap(aiData.blob);
												img.dataset.baseSrc = src;
												img.classList.add('blobRendered', 'blobRender');
												img.style.imageRendering = '';
												renderQuality = 'processed';
											}
											catch(error) {
												console.error(error);
												await srcToImage(src, img);
												renderQuality = 'fast';
											}
										}
										else {
											renderQuality = 'processed';
										}
									}
									// leave data false so we don't cache a rendered blob
							} else {
								data = await file.renderBlob(name, _config);

								if (!data || !data.blob) {
									await srcToImage(src, img);
								} else {
									renderedObjectsURL.push({ data: data, img: img, key, src, index, createdAt: Date.now() });
									renderedObjectsURLCache[key] = data;
									pruneRenderedObjectURL();
									syncRenderedPdfDimensions(index, imageData, data);

									if (queueIndex !== queue.index('readingRender')) return; // Return if the queue is different

img.src = await decodeBeforeSwap(data.blob);
img.dataset.baseSrc = src;
								img.classList.add('blobRendered', 'blobRender', 'sizeFromImg');
								img.style.imageRendering = '';

									img.dataset.width = Math.round(data.width);
									img.dataset.height = Math.round(data.height);
									renderQuality = 'processed';
								}
							}
						} else {
							await srcToImage(src, img);
							renderQuality = 'processed';
						}
					} catch (error) {
						console.error(error);
						await srcToImage(src, img);
						renderQuality = 'fast';
					}
				}
			}
			else if(!shouldUseProcessedImageRender(index, magnifyingGlass))
			{
				await srcToImage(src, img);
				renderQuality = 'fast';
			}
			else if(_config.width !== imageSize.width && _config.kernel && _config.kernel != 'chromium' && !magnifyingGlass)
			{
				if(cssMethods[_config.kernel])
				{
					img.src = app.encodeSrcURI(app.shortWindowsPath(src, true));
					img.classList.remove('blobRendered', 'blobRender');
					img.style.imageRendering = cssMethods[_config.kernel];
					img.dataset.baseSrc = src;
					renderQuality = 'processed';
				}
				else if(renderedObjectsURLCache[key])
				{
					img.src = await decodeBeforeSwap(renderedObjectsURLCache[key].blob);
					img.dataset.baseSrc = src;
					img.classList.add('blobRendered', 'blobRender');
					img.style.imageRendering = '';
					renderQuality = 'processed';
				}
				else
				{
					await ensureDirectImageSource(src, img);

					if(!(await image.isAnimated(src)))
					{
						if(affineInterpolationMethods[_config.kernel])
						{
							_config.imageWidth = rotated90 ? imageSize.height : imageSize.width;
							_config.imageHeight = rotated90 ? imageSize.width : imageSize.height;
							_config.interpolator = affineInterpolationMethods[_config.kernel];

							_config.kernel = false;
						}

						try
						{
							let data = await image.resizeToBlob(src, _config);

							renderedObjectsURL.push({data: data, img: img, key, src, index, createdAt: Date.now()});
							renderedObjectsURLCache[key] = {blob: data.blob};
							pruneRenderedObjectURL();

							if(queueIndex !== queue.index('readingRender')) return; // Return if the queue is different

							img.src = await decodeBeforeSwap(data.blob);
							img.dataset.baseSrc = src;
							img.classList.add('blobRendered', 'blobRender');
							img.style.imageRendering = '';
							renderQuality = 'processed';
						}
						catch(error)
						{
							console.error(error);

							await srcToImage(src, img);
							renderQuality = 'fast';
						}
					}
					else
					{
						renderQuality = 'processed';
					}
				}
			}
			else
			{
				await srcToImage(src, img);
				renderQuality = 'processed';
			}

			if(shouldSyncDecode)
				await decodeImage(img, true);
			else
				decodeImage(img, false);

			if(magnifyingGlass)
			{
				renderedMagnifyingGlass[index] = _scale;
				renderedMagnifyingGlassQuality[index] = renderQuality === 'pending' ? 'fast' : renderQuality;
			}
			else
			{
				rendered[index] = _scale;
				renderedQuality[index] = renderQuality === 'pending' ? 'fast' : renderQuality;
			}
		}

		if(onRender)
		{
			onRender.num--;

			if(onRender.num <= 0)
			{
				let img = rImg.querySelector('oc-img img');

				if(img && !img.complete)
				{
					await new Promise(function(resolve){

						img.onload = resolve;
						img.onerror = resolve;

					});
				}

				onRender.callback();
				onRender = false;
			}
		}
		}

		return;
	}
	finally
	{
		setRendering(index, magnifyingGlass, false);
	}
}

async function srcToImage(src, img)
{
	img.src = app.encodeSrcURI(app.shortWindowsPath(src, true));
	img.classList.remove('blobRendered', 'blobRender');
	img.style.imageRendering = '';
	img.dataset.baseSrc = src;

	return true;
}

// The visible <img> is usually already showing a fast/raw preview of this same page when the
// 'processed' (resized/rendered) blob is ready to take over. Assigning it straight to img.src
// makes the browser blank the element for however long that blob takes to decode - imperceptible
// for a small page, but a visible flash-to-blank-and-back on a big one (a large page, or a PDF
// rendered at a high DPI). Decoding the blob off-DOM first and only swapping img.src once decode
// resolves lets the browser paint it immediately, since the decoded bitmap is already in its
// image cache under that blob URL.
async function decodeBeforeSwap(src)
{
	try
	{
		const pre = new Image();
		pre.src = src;
		await pre.decode();
	}
	catch(error) {}

	return src;
}

async function decodeImage(img, sync = false)
{
	if(sync)
	{
		try
		{
			await img.decode();
		}
		catch(e){}
	}

	observer.observe(img);
}

var observer = false;

function createObserver()
{
	if(observer)
		observer.disconnect();

	observer = new IntersectionObserver(function(entries) {

		for(let i = 0, len = entries.length; i < len; i++)
		{
			const entry = entries[i];

			if(entry.isIntersecting || entry.intersectionRatio > 0)
			{
				observer.unobserve(entry.target);

				try
				{
					const decodePromise = entry.target.decode();

					if(decodePromise && decodePromise.catch)
						decodePromise.catch(function(){});
				}
				catch(e){}
			}
		}

	}, {
		root: template._contentRight().firstElementChild,
		// 9000px of lookahead in webtoon/scroll mode eagerly decoded roughly ten screens of
		// full-width pages at once, which is a large synchronous cost and a lot of resident
		// bitmap memory. 3000px still stays comfortably ahead of normal scrolling.
		rootMargin: isPdfCanvasMode() ? '1200px' : (reading.readingViewIs('scroll') ? '3000px' : '2500px'),
		threshold: 0,
	});
}

module.exports = {
	setFile: setFile,
	reset: reset,
	setImagesData: setImagesData,
	setMagnifyingGlassStatus: setMagnifyingGlassStatus,
	setScale: setScale,
	setScaleMagnifyingGlass: setScaleMagnifyingGlass,
	render: render,
	focusIndex: focusIndex,
	resized: resized,
	setEbookConfigChanged: setEbookConfigChanged,
	setOnRender: setOnRender,
	revokeAllObjectURL: revokeAllObjectURL,
	get rendered() {return rendered},
}
