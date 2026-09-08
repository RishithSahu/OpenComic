// Dedicated worker holding one pdf.js document open for as long as one PDF is being read, so
// that page.render() - the part of reading a PDF that actually costs real time - runs off the
// renderer's main thread instead of stealing frames from it. Everything else about reading a
// PDF (opening it for the page list, metadata, sizing) stays on the main thread in
// file-manager.js exactly as before; this worker only ever renders pages it is asked for.
const p = require('path'),
	fs = require('fs');

function asarToAsarUnpacked(path)
{
	if(!/app\.asar\.unpacked/.test(path))
	{
		var pathUnpacked = path.replace(/app\.asar/, 'app.asar.unpacked');

		if(fs.existsSync(pathUnpacked)) path = pathUnpacked;
	}

	return path;
}

function posixPath(path)
{
	return path.split(p.sep).join(p.posix.sep);
}

const appDir = asarToAsarUnpacked(p.join(__dirname, '..', '..'));

var unpdf = false;
var doc = false;
var rangeTransport = false;

// Mirrors PdfFileRangeTransport in file-manager.js: a local file does not need a network
// transport at all, so pdf.js's range requests are answered straight from an open file
// descriptor. Kept as a separate copy rather than a shared import - this worker and the main
// thread each construct it against their own `unpdf` module instance (pdf.js does not support
// sharing one import across two realms), and the class is small enough that duplicating it is
// cheaper than the coupling a shared module would add between the two.
function makeRangeTransportClass()
{
	return class PdfFileRangeTransport extends unpdf.PDFDataRangeTransport {

		constructor(filePath, size)
		{
			super(size, new Uint8Array(0), false, null);

			this.filePath = filePath;
			this.fileSize = size;
			this.fd = fs.openSync(filePath, 'r');
			this.closed = false;
			this.pending = 0;
		}

		requestDataRange(begin, end)
		{
			if(this.closed) return;

			const start = Math.max(0, begin);
			const stop = Math.min(this.fileSize, end);
			const length = Math.max(0, stop - start);

			if(!length)
			{
				this.onDataRange(start, new Uint8Array(0));
				return;
			}

			const buffer = Buffer.allocUnsafe(length);
			this.pending++;

			fs.read(this.fd, buffer, 0, length, start, (error, read) => {

				this.pending--;

				if(this.closed)
				{
					this.closeWhenIdle();
					return;
				}

				if(error) return;

				this.onDataRange(start, new Uint8Array(buffer.buffer, buffer.byteOffset, read));

			});
		}

		abort() { this.close(); }

		close()
		{
			this.closed = true;
			this.closeWhenIdle();
		}

		closeWhenIdle()
		{
			if(!this.closed || this.pending > 0 || this.fd === false) return;

			const fd = this.fd;
			this.fd = false;

			try { fs.closeSync(fd); }
			catch (error) { }
		}

	};
}

// A plain `await import(...)` here would be exactly right for a classic worker (dynamic import
// does not require the importing script itself to be a module) - except this file is compiled
// by the same `tsc` pass as everything else in scripts/, targeting CommonJS, and that pass
// rewrites a literal `import(...)` call into `require()`. require() cannot load an ES module
// like pdf.mjs. Routing the call through `new Function` hides it from tsc's static rewrite (it
// only recognises an `import(...)` expression, not a call to a variable holding one), so what
// actually runs is the real, unmodified dynamic import.
const dynamicImport = new Function('specifier', 'return import(specifier);');

async function loadPdfjs()
{
	if(unpdf) return;

	unpdf = await dynamicImport(asarToAsarUnpacked(p.join(appDir, 'node_modules/pdfjs-dist/build/pdf.mjs')));
	unpdf.GlobalWorkerOptions.workerSrc = asarToAsarUnpacked(p.join(appDir, 'node_modules/pdfjs-dist/build/pdf.worker.mjs'));

}

// `disableFontFace: true` below is meant to keep pdf.js off every one of these paths (it steers
// both FontLoader's own registration and the operator-list drawing code down the path-based,
// document-free branch instead) - this shim exists only as a second line of defence, in case
// some path still reaches `ownerDocument` despite that (which measurements after the first
// version of this fix suggest happens for at least one real file). Where a real implementation
// is cheap and correct - `createElement('canvas')` - it is one, backed by an actual
// OffscreenCanvas, so font-load probing that reaches this still behaves properly rather than
// merely not crashing. Everything else is a harmless no-op sized to what FontLoader touches.
//
// Deliberately no `fonts` property. FontLoader treats a truthy `ownerDocument.fonts` as "the
// CSS Font Loading API is available" and switches to a branch that constructs a real `FontFace`
// - a Window-scoped constructor with no guarantee of existing in a worker at all, which would
// trade this crash for a worse, unguarded one. Leaving `fonts` absent keeps that branch closed
// and pdf.js on the plain `@font-face`-rule path this shim actually covers.
function createFakeDocument()
{
	const fakeHead = { append() {} };

	const fakeElement = () => ({
		style: {},
		sheet: { cssRules: { length: 0 }, insertRule() {} },
		append() {}, appendChild() {}, remove() {}, setAttribute() {},
	});

	return {
		baseURI: 'file:///',
		documentElement: { getElementsByTagName: () => [fakeHead] },
		body: { append() {} },
		createElement(tag) {
			if (tag === 'canvas') {
				try { return new OffscreenCanvas(300, 150); }
				catch (error) { return fakeElement(); }
			}
			return fakeElement();
		},
	};
}

async function openDocument(filePath)
{
	await loadPdfjs();

	if(doc) return doc;

	const size = fs.statSync(filePath).size;
	rangeTransport = new (makeRangeTransportClass())(filePath, size);

	doc = await unpdf.getDocument({
		range: rangeTransport,
		wasmUrl: posixPath(asarToAsarUnpacked(p.join(appDir, 'node_modules/pdfjs-dist/wasm/'))),
		cMapUrl: posixPath(asarToAsarUnpacked(p.join(appDir, 'node_modules/pdfjs-dist/cmaps/'))),
		cMapPacked: true,
		isImageDecoderSupported: true,
		disableAutoFetch: true,
		disableStream: true,
		rangeChunkSize: 256 * 1024,

		// A worker has no `document`. Left unset, pdf.js still tries to register embedded fonts
		// as CSS @font-face rules through one (FontLoader's `ownerDocument`, defaulting to the
		// global `document`), which crashed every page with any embedded font/text run -
		// `Cannot read properties of undefined (reading 'createElement')` - the moment it tried.
		// This makes pdf.js draw glyphs itself, as vector paths straight onto the canvas, which
		// needs nothing from a document. Fixed text-heavy PDFs (translated dialogue overlays,
		// not just image panels) rendering at all, not just a quality trade-off.
		disableFontFace: true,

		// Belt and suspenders alongside disableFontFace above - see createFakeDocument().
		ownerDocument: createFakeDocument(),
	}).promise;

	return doc;
}

// Same drawing setup as rasterizePdfPage() in file-manager.js - see that function's comments
// for why OffscreenCanvas, why alpha:false, why a white fill first.
async function renderPage(pageNumber, scale, quality)
{
	const page = await doc.getPage(pageNumber);

	try
	{
		const viewport = page.getViewport({ scale });
		const width = Math.max(1, Math.round(viewport.width));
		const height = Math.max(1, Math.round(viewport.height));

		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext('2d', { alpha: false });

		context.fillStyle = '#ffffff';
		context.fillRect(0, 0, width, height);

		await page.render({ canvasContext: context, viewport: viewport }).promise;

		const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality });
		const buffer = await blob.arrayBuffer();

		return { width, height, buffer };
	}
	finally
	{
		page.cleanup();
	}
}

self.addEventListener('message', async function(message) {

	const data = message.data;

	try
	{
		switch (data.cmd)
		{
			case 'open':

				await openDocument(data.filePath);
				self.postMessage({ cmd: 'opened', ok: true });

				break;

			case 'render':

				try
				{
					const result = await renderPage(data.pageNumber, data.scale, data.quality);
					self.postMessage({ cmd: 'rendered', id: data.id, ok: true, width: result.width, height: result.height, buffer: result.buffer }, [result.buffer]);
				}
				catch (error)
				{
					self.postMessage({ cmd: 'rendered', id: data.id, ok: false, error: (error && error.message) || String(error), errorName: error && error.name, errorStack: error && error.stack });
				}

				break;

			case 'cleanup':

				// Mirrors schedulePdfCleanup() on the main thread's own document: decoded image
				// streams and fonts are cached across the whole document, not just per page, and
				// this worker's document accumulates the same way over a long reading session.
				try { if(doc) await doc.cleanup(); }
				catch (error) { }

				break;

			case 'destroy':

				try { if(doc) await doc.destroy(); }
				catch (error) { }

				try { if(rangeTransport) rangeTransport.close(); }
				catch (error) { }

				self.close();

				break;
		}
	}
	catch (error)
	{
		self.postMessage({ cmd: data.cmd === 'render' ? 'rendered' : 'opened', id: data.id, ok: false, error: (error && error.message) || String(error) });
	}

});
