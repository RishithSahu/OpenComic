const domPoster = require(p.join(appDir, '.dist/dom/poster.js')),
	domManager = require(p.join(appDir, '.dist/dom/dom.js')),
	labels = require(p.join(appDir, '.dist/dom/labels.js')),
	cache = require(p.join(appDir, '.dist/cache.js')),
	fileInfo = require(p.join(appDir, '.dist/dom/file-info.js')),
	clearFileCache = require(p.join(appDir, '.dist/dom/clear-file-cache.js')),
	search = require(p.join(appDir, '.dist/dom/search.js')),
	header = require(p.join(appDir, '.dist/dom/header.js')),
	boxes = require(p.join(appDir, '.dist/dom/boxes.js')),
	history = require(p.join(appDir, '.dist/dom/history.js')),
	coverflow = require(p.join(appDir, '.dist/dom/coverflow.js')),
	scroll = require(p.join(appDir, '.dist/dom/scroll.js'));

/*Page - Index*/

function orderBy(a, b, mode, key = false, key2 = false) {
	let aValue = a;
	let bValue = b;

	if (key2) {
		aValue = a[key][key2];
		bValue = b[key][key2];
	}
	else if (key) {
		aValue = a[key];
		bValue = b[key];
	}

	if (mode != 'real-numeric') {
		aValue = aValue.toLowerCase();
		bValue = bValue.toLowerCase();
	}

	if (mode == 'simple') {
		if (aValue > bValue) return 1;
		if (aValue < bValue) return -1;

		return 0;
	}
	else if (mode == 'real-numeric') {
		if (aValue > bValue) return 1;
		if (aValue < bValue) return -1;

		return 0;
	}
	else if (mode == 'numeric') {
		let matchA = aValue.match(/([0-9]+)/g);
		let matchB = bValue.match(/([0-9]+)/g);

		if (!matchA) return 1;
		if (!matchB) return -1;

		for (let i = 0, len = Math.min(matchA.length, matchB.length); i < len; i++) {
			if (+matchA[i] > +matchB[i]) return 1;
			if (+matchA[i] < +matchB[i]) return -1;
		}

		if (matchA.length > matchB.length) return 1;
		if (matchA.length < matchB.length) return -1;

		if (aValue > bValue) return 1;
		if (aValue < bValue) return -1;

		return 0;
	}
	else if (mode == 'simple-numeric') {
		let matchA = aValue.split(/([0-9]+)/);
		let matchB = bValue.split(/([0-9]+)/);

		if (!matchA) return 1;
		if (!matchB) return -1;

		for (let i = 0, len = Math.min(matchA.length, matchB.length); i < len; i++) {
			if (isNaN(matchA[i]) || isNaN(matchB[i])) {
				if (matchA[i] > matchB[i]) return 1;
				if (matchA[i] < matchB[i]) return -1;
			}
			else {
				if (+matchA[i] > +matchB[i]) return 1;
				if (+matchA[i] < +matchB[i]) return -1;
			}
		}

		return (matchA.length < matchB.length) ? 1 : -1;
	}
}

function addImageToDom(sha, path, animation = true) {
	const src = dom.queryAll('img.sha-image-' + sha).setAttribute('src', app.encodeSrcURI(app.shortWindowsPath(path, true)));
	bindThumbnailRecovery(src._this);

	if (animation) {
		src.addClass('a', 'active', 'border');
	}
	else {
		src.addClass('active', 'border');
		src.filter('.folder-poster-img').addClass('has-poster');
	}

	// Lets a cover flow card drop its placeholder once its thumbnail actually lands.
	coverflow.imageLoaded(sha);
}

function getThumbnailCardInfo(image) {
	if (!image)
		return false;

	const item = image.closest('.gamepad-item[data-path]');

	if (!item)
		return false;

	return {
		item,
		path: item.dataset.path || '',
		folder: item.dataset.folder === 'true',
		forceSize: +(item.dataset.forceSize || handlebarsContext.page.viewModuleSize || 150),
	};
}

// Recovery attempts are bounded per card: some sources simply cannot be decoded (truncated
// scans, unsupported variants), and an unbounded retry loop pegs a CPU core regenerating a
// thumbnail that will always fail to load.
const THUMBNAIL_RECOVERY_MAX_ATTEMPTS = 3;
const thumbnailRecoveryAttempts = new Map();

function thumbnailRecoveryKey(info) {
	return info.path + '|' + info.forceSize + '|' + (info.folder ? 'folder' : 'image');
}

function handleThumbnailLoad(event) {
	const image = event?.currentTarget || event;

	if (!image)
		return;

	image.dataset.thumbnailState = 'loaded';
	image.classList.remove('thumbnail-load-error');

	const info = getThumbnailCardInfo(image);

	if (!info?.path)
		return;

	thumbnailRecoveryAttempts.delete(thumbnailRecoveryKey(info));

	if (info.folder)
		scroll.clearRetryStateByPath(info.path);
}

async function retryStandaloneThumbnail(path, forceSize = false) {
	const normalizedPath = p.normalize(path || '');

	if (!normalizedPath || !compatible.image(normalizedPath))
		return false;

	const viewModuleSize = +(forceSize || handlebarsContext.page.viewModuleSize || 150);

	try {
		await cache.deleteInCache(normalizedPath);
	}
	catch {}

	const file = fileManager.file(normalizedPath, { fromThumbnailsGeneration: true, subtask: true, log: false, sort: { extraKey: 'Reading' } });

	try {
		const imageData = {
			path: normalizedPath,
			forceSize: viewModuleSize,
		};

		const thumbnail = cache.returnThumbnailsImages(imageData, function (data) {
			addImageToDom(data.sha, data.path, false);
		}, file);

		if (thumbnail?.cache && thumbnail.path)
			addImageToDom(thumbnail.sha, thumbnail.path, false);

		return true;
	}
	catch (error) {
		console.error(error);
		fileManager.requestFileAccess.check(normalizedPath, error);
		return false;
	}
	finally {
		file.destroy();
	}
}

function handleThumbnailError(event) {
	const image = event?.currentTarget || event;

	if (!image)
		return;

	const src = image.getAttribute('src');

	if (!src)
		return;

	const info = getThumbnailCardInfo(image);

	if (!info?.path)
		return;

	image.dataset.thumbnailState = 'error';
	image.classList.add('thumbnail-load-error');
	image.classList.remove('a', 'active', 'has-poster');
	image.removeAttribute('src');

	const recoveryKey = thumbnailRecoveryKey(info);
	const attempts = (thumbnailRecoveryAttempts.get(recoveryKey) || 0) + 1;

	if (attempts > THUMBNAIL_RECOVERY_MAX_ATTEMPTS)
		return;

	thumbnailRecoveryAttempts.set(recoveryKey, attempts);

	while (thumbnailRecoveryAttempts.size > 500)
		thumbnailRecoveryAttempts.delete(thumbnailRecoveryAttempts.keys().next().value);

	const throttleKey = 'thumbnail-recovery-' + sha1(recoveryKey);

	app.setThrottle(throttleKey, async function () {
		if (info.folder) {
			await scroll.retryByPath(info.path, { invalidateCache: true });
			scroll.check();
		}
		else {
			await retryStandaloneThumbnail(info.path, info.forceSize);
		}
	}, 80, 240);
}

function bindThumbnailRecovery(scope = false) {
	const root = scope || template._contentRight();

	if (!root)
		return;

	let images = [];

	if (Array.isArray(root))
		images = root;
	else if ((typeof NodeList !== 'undefined' && root instanceof NodeList) || (typeof HTMLCollection !== 'undefined' && root instanceof HTMLCollection))
		images = Array.from(root);
	else if (root.tagName === 'IMG')
		images = [root];
	else if (root.querySelectorAll)
		images = Array.from(root.querySelectorAll('img[class*="sha-image-"]'));

	for (let i = 0, len = images.length; i < len; i++) {
		const image = images[i];

		if (!image || image.dataset.thumbnailRecoveryBound === '1')
			continue;

		image.dataset.thumbnailRecoveryBound = '1';
		image.addEventListener('load', handleThumbnailLoad);
		image.addEventListener('error', handleThumbnailError);

		const src = image.getAttribute('src');

		if (!src)
			continue;

		if (image.complete) {
			if (image.naturalWidth > 0)
				handleThumbnailLoad(image);
			else
				handleThumbnailError(image);
		}
	}
}

async function addProgressToDom(sha, progress, animation = true) {
	const src = document.querySelectorAll('.sha-' + sha);
	const _src = dom.this(src);

	if (!animation)
		_src.addClass('disable-transitions');

	// Progress bar
	if (handlebarsContext.page.progressBar) {
		const _progress = dom.this(src).find('.progress-bar', true);
		_progress.class(progress.percent, 'show');

		for (const item of _progress._this) {
			item.firstElementChild.style.transform = 'translateX(calc(-100% + ' + progress.percent + '%))';
			if (item.children[1]) item.children[1].style.transform = 'translateX(calc(' + progress.percent + '% + 4px))';
		}
	}

	if (handlebarsContext.page.progressPages || handlebarsContext.page.progressPercent)
		dom.this(src).find('.progress-pages').addClass('show');

	// Pages
	if (handlebarsContext.page.progressPages) {
		dom.this(src).find('.progress-pages > svg text:first-child textPath, .progress-pages > span:not([class])', true).html(progress.read + ' / ' + progress.total);
		dom.this(src).find('.progress-pages > span.progress-pages-read', true).html(progress.read + '/' + progress.total);
	}

	// percent
	if (handlebarsContext.page.progressPercent) {
		dom.this(src).find('.progress-pages > svg text:nth-child(2) textPath, .progress-percent > span', true).html(progress.percentRound + '%');
		dom.this(src).find('.progress-pages > span.progress-pages-percent', true).html(progress.percentRound + '%');
		dom.this(src).find('.progress-percent', true).addClass('show');
	}

	if (!animation) {
		await app.sleep(100);
		_src.removeClass('disable-transitions');
	}
}

function setWindowTitle(title = 'OpenComic') {
	let _title = document.querySelector('head title');
	_title.innerText = title;
}

function translatePageName(name) {
	name = name.replace(/^[0-9]+\_sortonly - /, '');

	return name.replace(/^page\-0*([0-9]+)/, language.global.pageAndNumber);
}

function metadataPathName(file, force = false) {
	if (fileManager.isOpds(file.path) || fileManager.isBase64(file.name)) {
		return opds.pathName(file.name);
	}

	const metadata = storage.getKey('compressedMetadata', file.path);
	if (metadata && metadata.title && !/^untitled$/i.test(metadata.title.trim()))
		return metadata.title;

	const fileName = file.name.replace(/\.[^\.]*$/, '');
	return config.showFileExtension || !fileName ? file.name : fileName;
}

function getTrackingFolderMetadata(path, trackingFolderMetadata = false, isFolder = false) {
	trackingFolderMetadata = trackingFolderMetadata || relative.get('trackingFolderMetadata') || {};

	const folderPath = p.normalize(isFolder ? path : p.dirname(path));
	const metadata = trackingFolderMetadata[folderPath];

	if (!metadata || typeof metadata !== 'object')
		return false;

	const genres = Array.isArray(metadata.genres) ? metadata.genres.filter(Boolean) : [];
	const demographic = metadata.demographic ? app.capitalize(String(metadata.demographic)) : '';
	const year = metadata.serializationYear ? String(metadata.serializationYear) : '';
	const ratingValue = (+metadata.rating > 0) ? Math.round(+metadata.rating) : 0;
	const rating = ratingValue ? ('★ '+ratingValue+'/100') : '';

	const metadataSubname = metadata.author || '';
	let metadataTopSubname = '';
	const parts = [];

	if (metadata.author)
		parts.push(metadata.author);

	if (demographic)
		parts.push(demographic);

	if (year)
		parts.push(year);

	if (rating)
		parts.push(rating);

	if (parts.length) {
		metadataTopSubname = parts.join(' · ');
	}

	return {
		metadataTitle: metadata.title || '',
		metadataAuthor: metadata.author || '',
		metadataDemographic: demographic,
		metadataYear: year,
		metadataRating: rating,
		metadataRatingValue: ratingValue,
		metadataGenres: genres,
		metadataGenresText: genres.join(' · '),
		metadataDescription: metadata.description || '',
		metadataSubname: metadataSubname,
		metadataTopSubname: metadataTopSubname,
		metadataSource: metadata.source || '',
		metadataConfidence: metadata.confidence || 0,
		metadataSeriesType: metadata.seriesType || '',
	};
}

function getFolderMetadataTop(path, mainPath, trackingFolderMetadata = false) {
	const folderPath = p.normalize(path || mainPath || '');
	if (!folderPath)
		return false;

	const metadata = getTrackingFolderMetadata(folderPath, trackingFolderMetadata, true);
	if (!metadata)
		return false;

	let description = metadata.metadataDescription || '';

	if (description) {
		description = app.stripTagsWithDOM(String(description)).replace(/\s+/g, ' ').trim();

		if (description.length > 2000)
			description = description.slice(0, 1997) + '...';
	}

	return {
		title: metadata.metadataTitle || p.basename(folderPath),
		subname: metadata.metadataTopSubname || metadata.metadataSubname || '',
		author: metadata.metadataAuthor || '',
		demographic: metadata.metadataDemographic || '',
		year: metadata.metadataYear || '',
		rating: metadata.metadataRating || '',
		ratingValue: metadata.metadataRatingValue || 0,
		genres: metadata.metadataGenres || [],
		genresText: metadata.metadataGenresText || '',
		description: description,
		seriesType: metadata.metadataSeriesType || '',
		isManga: metadata.metadataSeriesType === 'manga',
		isManhua: metadata.metadataSeriesType === 'manhua',
		isManhwa: metadata.metadataSeriesType === 'manhwa',
		isGeneric: !metadata.metadataSeriesType,
	};
}

async function readFilesIndexPage(path, mainPath, fromGoBack, notAutomaticBrowsing, fromGoForwards) {
	const file = fileManager.file(path);
	let files;

	try {
		files = await file.read();
	}
	catch (error) {
		console.error(error);

		dom.compressedError(error);
		fileManager.requestFileAccess.check(path, error);

		return {
			path: path,
			mainPath: mainPath,
			files: []
		};
	}

	const basic = {
		path: path,
		mainPath: mainPath,
		files: files,
	};

	// Get comic reading progress image
	let _readingProgress = relative.get('readingProgress');
	let readingProgress = _readingProgress[mainPath]?.path ? _readingProgress[mainPath] : false;
	let readingProgressCurrentPath = (mainPath != path) ? (_readingProgress[path]?.path ? _readingProgress[path] : false) : false;

	// const isCompressed = fileManager.isCompressed(fileManager.firstCompressedFile(path));
	const isCompressed = fileManager.isCompressed(path);
	const openingBehavior = isCompressed ? config.openingBehaviorFile : config.openingBehaviorFolder;

	const lastFolder = ['first-page-last', 'continue-reading-last', 'continue-reading-first-page-last'].includes(openingBehavior);
	let openFirstPage = ['first-page', 'continue-reading-first-page', 'first-page-last', 'continue-reading-first-page-last'].includes(openingBehavior);
	let openContinueReading = ['continue-reading', 'continue-reading-first-page', 'continue-reading-last', 'continue-reading-first-page-last'].includes(openingBehavior);

	if (openContinueReading && !fromGoBack && !notAutomaticBrowsing && readingProgress) {
		const isParentPath = fileManager.isParentPath(path, readingProgress.path);

		if (isParentPath || readingProgressCurrentPath) {
			if (!isParentPath && readingProgressCurrentPath)
				readingProgress = readingProgressCurrentPath;
		}
		else {
			openContinueReading = false;
		}

		if (openContinueReading && !fileManager.simpleExists(readingProgress.path))
			openContinueReading = false;
	}
	else {
		openContinueReading = false;
	}

	// Only in last deep folded
	if (lastFolder) {
		let hasFolder = false;

		for (let i = 0, len = files.length; i < len; i++) {
			if (files[i].folder || files[i].compressed) {
				hasFolder = true;
				break;
			}
		}

		if (hasFolder) {
			openFirstPage = false;
			openContinueReading = false;
		}
	}

	if (openContinueReading && !fromGoBack && !fromGoForwards && !notAutomaticBrowsing) {
		if (readingProgress.ebook)
			reading.setNextOpenChapterProgress(readingProgress.chapterIndex, readingProgress.chapterProgress);

		file.destroy();

		return {
			open: true,
			path: readingProgress.path,
			mainPath: mainPath,
			files: files,
		};
	}
	else if (openFirstPage && !fromGoBack && !fromGoForwards && !notAutomaticBrowsing) {
		let first;

		try {
			// Reuse the file we already fully read above. Using thumbnail-mode reads here can
			// leak a synthetic 1-page state into the first reading session.
			first = await file.images(1, false, false, files, path, isCompressed);
		}
		catch (error) {
			console.error(error);
			dom.compressedError(error);

			return basic;
		}

		if (first) {
			file.destroy();

			return {
				open: true,
				path: first.path,
				mainPath: mainPath,
				files: files,
			};
		}
	}

	file.destroy();

	// Only unwrap a lone plain subfolder here (e.g. "Series/Volume 1/" holding just "Volume 1/pages"),
	// never a lone compressed file: recursing into it flips openingBehavior from
	// config.openingBehaviorFolder to config.openingBehaviorFile, whose default
	// ('continue-reading-first-page') then jumps straight into the reader - so browsing into a
	// folder containing a single archive skipped the folder page entirely and opened the comic.
	if (config.ignoreSingleFoldersLibrary && !fromGoBack && !fromGoForwards && !notAutomaticBrowsing && files.length == 1 && files[0].folder) {
		return readFilesIndexPage(files[0].path, mainPath, fromGoBack, notAutomaticBrowsing, fromGoForwards);
	}

	return basic;
}

async function loadFilesIndexPage(files, file, animation, path, keepScroll, mainPath, _indexLabel) {
	threads.clean('folderThumbnails');
	handlebarsContext.folderMetadataTop = false;

	let pathFiles = [];
	let thumbnails = [];
	const metadataQueuePaths = [];
	const metadataQueueSet = new Set();
	const trackingFolderMetadata = relative.get('trackingFolderMetadata') || {};

	const queueMetadataPath = function (_path) {
		if (!_path)
			return;

		const key = String(_path).toLowerCase();
		if (metadataQueueSet.has(key))
			return;

		metadataQueueSet.add(key);
		metadataQueuePaths.push(_path);
	}

	queueMetadataPath(path);

	// Get comic reading progress image
	let _readingProgress = relative.get('readingProgress');

	let readingProgress = _readingProgress[mainPath]?.path ? _readingProgress[mainPath] : false;
	let readingProgressCurrentPath = (mainPath != path) ? (_readingProgress[path]?.path ? _readingProgress[path] : false) : false;

	if (files) {
		// Cover flow displays a volume many times larger than the grid ever does - larger,
		// even at its biggest card size, than the grid's own largest cached tier (300) was
		// ever meant to cover. Reusing whatever the grid happens to be set to (150 by
		// default) meant a cover flow row was routinely stretching a thumbnail out well past
		// its own resolution, which is what read as blurry - not a decoding or filtering
		// issue, just a thumbnail asked to be too small for how large this view actually
		// shows it. `500` (see getSizes() in cache.js) exists specifically for this view;
		// requesting it here costs nothing extra for the grid, which keeps asking for
		// whatever size it always did.
		const viewModuleSize = (handlebarsContext.page.view == 'coverflow') ? 1400 : (handlebarsContext.page.viewModuleSize || 150);
		let images = [];

		for (let i = 0, len = files.length; i < len; i++) {
			const file = files[i];

			if (compatible.image(file.path)) {
				file.forceSize = viewModuleSize;
				file.sha = cache.imageSizeSha(file);
				images.push(file);
			}
		}

		if (readingProgress) {
			let path = readingProgress.path;
			let sha = sha1(path);

			images.push({ path: path, sha: sha });

			readingProgress.sha = sha;
		}

		if (readingProgressCurrentPath) {
			let path = readingProgressCurrentPath.path;
			let sha = sha1(path);

			images.push({ path: path, sha: sha });

			readingProgressCurrentPath.sha = sha;
		}

		thumbnails = cache.returnThumbnailsImages(images, function (data) {

			addImageToDom(data.sha, data.path);

		}, file);

		// handlebarsContext.page.view, not config.view directly - see the matching fix a little
		// further down in this same function, where using config.view here left the row's
		// thumbnail windowing keyed to the wrong view whenever a folder's own view differed
		// from the global default.
		let visibleItems = calculateVisibleItems(handlebarsContext.page.view, keepScroll);

		for (let i = 0, len = files.length; i < len; i++) {
			let file = files[i];
			let fileName = file.name;
			let filePath = file.path;

			let realPath = fileManager.realPath(filePath, -1);

			if (compatible.image(realPath)) {
				let sha = file.sha;

				let thumbnail = thumbnails[file.sha];

				pathFiles.push({
					sha: sha,
					name: translatePageName(fileName.replace(/\.[^\.]*$/, '')),
					path: filePath,
					mainPath: mainPath,
					thumbnail: (thumbnail.cache) ? thumbnail.path : '',
					folder: false,
				});
			}
			else if (file.folder || file.compressed) {
				// See the matching comment above this function's other branch: cover flow
				// needs its own, larger cached tier regardless of the grid's size setting.
				let images = await getFolderThumbnails(filePath, (handlebarsContext.page.view == 'coverflow') ? 1400 : false, i, visibleItems.start, visibleItems.end);
				const trackingMetadata = getTrackingFolderMetadata(filePath, trackingFolderMetadata, file.folder);

				if (i >= visibleItems.start && i <= (visibleItems.end + 12))
					queueMetadataPath(filePath);

				pathFiles.push({
					sha: file.sha,
					name: metadataPathName(file),
					subname: trackingMetadata?.metadataSubname || false,
					path: filePath,
					mainPath: mainPath,
					poster: images.poster,
					images: images.images,
					addToQueue: images.addToQueue,
					folder: true,
					compressed: file.compressed,
					progress: images.progress,
					...(trackingMetadata || {}),
				});
			}
		}
	}
	else {
		let images = [];

		if (readingProgress) {
			let path = readingProgress.path;
			let sha = sha1(path);

			images.push({ path: path, sha: sha });

			readingProgress.sha = sha;
		}

		if (readingProgressCurrentPath) {
			let path = readingProgressCurrentPath.path;
			let sha = sha1(path);

			images.push({ path: path, sha: sha });

			readingProgressCurrentPath.sha = sha;
		}

		thumbnails = cache.returnThumbnailsImages(images, function (data) {

			addImageToDom(data.sha, data.path);

		}, file);
	}

	if (_indexLabel?.filter) {
		pathFiles = dom.labels.filterList(pathFiles, _indexLabel.filter, { ignoreGenre: true });
	}

	handlebarsContext.comics = pathFiles;
	handlebarsContext.internalRankingSidebar = false;

	const processReadingProgress = function (progress) {

		const sha = progress.sha;
		const thumbnail = thumbnails[sha];

		progress.sha = sha;
		progress.thumbnail = (thumbnail.cache) ? thumbnail.path : '';
		progress.mainPath = mainPath;
		progress.pathText = returnTextPath(progress.path, mainPath, true, !progress.ebook);
		progress.exists = fileManager.simpleExists(progress.path);

		progress.contextMenu = {
			path: p.dirname(progress.path),
		};

		return progress;

	}

	// Comic reading progress
	// In a subfolder, only show the current folder's progress (not the global/library-wide one)
	if (mainPath != path) {
		handlebarsContext.comicsReadingProgress = false;
		if (readingProgressCurrentPath)
			handlebarsContext.comicsReadingProgressCurrentPath = processReadingProgress(readingProgressCurrentPath);
		else
			handlebarsContext.comicsReadingProgressCurrentPath = false;
	} else {
		if (readingProgress)
			handlebarsContext.comicsReadingProgress = processReadingProgress(readingProgress);
		else
			handlebarsContext.comicsReadingProgress = false;

		handlebarsContext.comicsReadingProgressCurrentPath = false;
	}

	handlebarsContext.folderMetadataTop = getFolderMetadataTop(path, mainPath, trackingFolderMetadata);

	if (tracking?.queueFolderMetadataScrapeMany && metadataQueuePaths.length)
		tracking.queueFolderMetadataScrapeMany(metadataQueuePaths, { priority: true, fast: true });

	if (!pathFiles.length && fileManager.isServer(path) && serverClient.serverLastError()) {
		handlebarsContext.serverLastError = serverClient.serverLastError();
		handlebarsContext.serverHasCache = file.serverHasCache(path);
	}

	events.events();

	// Not config.view directly: setCurrentPageVars('browsing', ...) (called just before this
	// function, from loadIndexPage) already resolved the per-folder override onto
	// handlebarsContext.page.view - reading config.view here instead would render whatever the
	// global default is regardless of what was actually picked for this folder, which is what
	// made switching to cover flow (or back) appear to do nothing on a plain folder.
	return { files: pathFiles, readingProgress: readingProgress || {}, readingProgressCurrentPath: readingProgressCurrentPath || {}, html: template.load('index.content.right.' + handlebarsContext.page.view + '.html') };

}

async function reloadIndex(fromSetOfflineMode = false, animation = true) {
	indexLabel = prevIndexLabel;
	loadIndexPage(animation, history.path, true, true, history.mainPath, false, true, fromSetOfflineMode);
}

function reload(fromSetOfflineMode = false, animation = true) {
	if (onReading)
		reading.reload(true);
	else if (handlebarsContext.page.key == 'recently-opened')
		recentlyOpened.reload(animation);
	else
		reloadIndex(fromSetOfflineMode, animation);
}

storage.onChangeFromOtherInstance(['comics', 'recentlySearched', 'masterFolders', 'favorites', 'labels', 'comicLabels', 'readingProgress', 'recentlyOpened', 'opdsCatalogs', 'trackingFolderMetadata'], function (key) {

	if (!onReading) {
		if (!document.querySelector('.dialogs .dialog, .menu-close.a, .search-bar.active')) {
			app.setThrottle('reloadOnChangeFromOtherInstance', function () {

				dom.reload();

			}, 100, 200);
		}
	}

});

var indexLabel = false, prevIndexLabel = {};

function setIndexLabel(options) {
	options.has = (options && Object.keys(options).some(key => key !== 'filter' && key !== 'has'));
	indexLabel = options;
}

function setPrevIndexLabel(options) {
	options.has = (options && Object.keys(options).some(key => key !== 'filter' && key !== 'has'));
	prevIndexLabel = options;
}

var currentPath = false, currentPathScrollTop = [];

function setCurrentPathScrollTop(path = false) {
	const isOpds = fileManager.isOpds(currentPath);

	const contentRight = template._contentRight();
	const scrollElement = isOpds ? contentRight.querySelector('.opds-browse-content') : contentRight.firstElementChild;

	currentPathScrollTop[currentPath === false ? 0 : currentPath] = scrollElement ? scrollElement.scrollTop : 0;

	if (path !== false) {
		for (let _path in currentPathScrollTop) {
			if (_path != 0 && !new RegExp('^' + pregQuote(_path)).test(path))
				delete currentPathScrollTop[_path];
		}
	}

	currentPath = path;
}

async function loadIndexPage(animation = true, path = false, content = false, keepScroll = false, mainPath = false, fromGoBack = false, notAutomaticBrowsing = false, fromSetOfflineMode = false, fromGoForwards = false) {
	let wasReading = onReading;
	onReading = _onReading = false;

	if (wasReading) {
		fileManager.closeAllCompressed();
	}

	app.clearMemory();

	fileManager.revokeAllObjectURL();
	reading.render.revokeAllObjectURL();
	workers.clean('convertImage');

	scroll.reset();
	reading.hideContent();
	reading.music.pause();

	setWindowTitle();

	const isOpds = fileManager.isOpds(path);
	setCurrentPathScrollTop(path);

	const pathScrollTopKey = path === false ? 0 : path;

	if (currentPathScrollTop[pathScrollTopKey])
		keepScroll = currentPathScrollTop[pathScrollTopKey];

	const _indexLabel = prevIndexLabel = (indexLabel || {});
	indexLabel = false;

	handlebarsContext.serverLastError = false;

	let contentRightIndex = template.contentRightIndex();

	if (_indexLabel.opds || isOpds) {
		if (!template._contentLeft().querySelector('.menu-list'))
			dom.loadIndexContentLeft(animation);

		opds.loadOpdsCatalogs();

		if (!path) {
			dom.fromLibrary(true);
			dom.indexPathControl(false);

			generateAppMenu();

			dom.setCurrentPageVars('index', _indexLabel);
			dom.floatingActionButton(false);

			handlebarsContext.headerTitle = false;
			handlebarsContext.headerTitlePath = false;

			// OPDS
			await opds.home();
		}
		else {
			if (!fromGoBack && !opds.isPublication(path))
				indexPathControl(path, mainPath);

			generateAppMenu();

			dom.setCurrentPageVars('browsing', { filter: _indexLabel?.filter || {} });
			dom.headerPath(path, mainPath);
			dom.floatingActionButton(false);

			// OPDS
			await opds.browse(path, mainPath, keepScroll);
		}
	}
	else if (!path) {
		dom.fromLibrary(true);
		dom.indexPathControl(false);

		generateAppMenu();

		if (!fromSetOfflineMode)
			fileManager.setServerInOfflineMode(false);

		dom.setCurrentPageVars('index', _indexLabel);

		let sort = config.sortIndex;
		let sortInvert = config.sortInvertIndex;
		let continueReading = config.continueReadingIndex;
		let recentlyAdded = config.recentlyAddedIndex;

		let sortAndView = false;

		if (_indexLabel.has) {
			let labelKey = '';

			if (_indexLabel.favorites)
				labelKey = 'favorites';
			else if (_indexLabel.opds)
				labelKey = 'opds';
			else if (_indexLabel.masterFolder)
				labelKey = 'masterFolder-' + _indexLabel.index;
			else if (_indexLabel.server)
				labelKey = 'server-' + _indexLabel.index;
			else if (_indexLabel.label)
				labelKey = 'label-' + _indexLabel.index;

			sortAndView = config.sortAndView[labelKey] || defaultSortAndView;

			sort = sortAndView.sort;
			sortInvert = sortAndView.sortInvert;
			continueReading = sortAndView.continueReading;
			recentlyAdded = sortAndView.recentlyAdded;
		}

		let order = '';
		let orderKey = 'name';
		let orderKey2 = false;

		if (sort == 'name') {
			order = 'simple';
		}
		else if (sort == 'numeric') {
			order = 'numeric';
		}
		else if (sort == 'name-numeric') {
			order = 'simple-numeric';
		}
		else if (sort == 'last-add') {
			order = 'real-numeric';
			orderKey = 'added';
			sortInvert = !sortInvert;
		}
		else {
			order = 'real-numeric';
			orderKey = 'readingProgress';
			orderKey2 = 'lastReading';
			sortInvert = !sortInvert;
		}

		let comics = [];
		let comicPaths = new Set();

		let ignore = fileManager.ignoreFilesRegex();

		// Get comics in master folders
		let masterFolders = relative.get('masterFolders');

		if (!isEmpty(masterFolders)) {
			for (let path of masterFolders) {
				if (fs.existsSync(path) && (!_indexLabel.masterFolder || _indexLabel.masterFolder == path) && !_indexLabel.server) {
					let file = fileManager.file(path);
					let files = await file.readDir();
					file.destroy();

					for (let i = 0, len = files.length; i < len; i++) {
						let folder = files[i];

						if (ignore && ignore.test(folder.name))
							continue;

						if ((folder.folder || folder.compressed) && !comicPaths.has(folder.path)) {
							comics.push({
								name: metadataPathName(folder),
								path: folder.path,
								added: Math.round(fs.statSync(folder.path).ctimeMs / 1000),
								folder: true,
								compressed: folder.compressed,
								fromMasterFolder: true,
							});

							comicPaths.add(folder.path);
						}
					}
				}
			}
		}

		// Get server file lists
		let servers = storage.get('servers');

		if (!isEmpty(servers)) {
			if (_indexLabel.server) {
				const root = history.root();
				selectMenuItem(dom.labels.menuItemSelector(root.indexLabel?.has ? root.indexLabel : _indexLabel));

				handlebarsContext.animationDelay = 0.2;
				template.loadContentRight('index.content.right.loading.html', animation, keepScroll);
				handlebarsContext.animationDelay = false;

				contentRightIndex = template.contentRightIndex();
			}

			for (let i = 0, len2 = servers.length; i < len2; i++) {
				const server = servers[i];

				if ((((server.showOnLibrary || _indexLabel.favorites || _indexLabel.label) && !_indexLabel.server) || _indexLabel.server == server.path) && !_indexLabel.masterFolder) {
					const file = fileManager.file(server.path);
					if (!_indexLabel.server) file.updateConfig({ cacheServer: true });
					let files = await file.readServer();

					if (server.filesInSubfolders && !_indexLabel.server) {
						let _files = [];

						for (let j = 0, len = files.length; j < len; j++) {
							const folder = files[j];

							if (folder.folder || folder.compressed) {
								const _file = fileManager.file(folder.path);
								_file.updateConfig({ cacheServer: true });
								_files = _files.concat(await _file.readServer());
							}
						}

						if (_indexLabel.has)
							_files = _files.concat(files);

						files = _files;
					}

					const len = files.length;

					for (let j = 0; j < len; j++) {
						const folder = files[j];

						if (ignore && ignore.test(folder.name))
							continue;

						if ((folder.folder || folder.compressed) && !comicPaths.has(folder.path)) {
							comics.push({
								name: metadataPathName(folder),
								path: folder.path,
								added: Math.round(folder.mtime / 1000),
								folder: true,
								compressed: folder.compressed,
								fromMasterFolder: true,
							});

							comicPaths.add(folder.path);
						}
					}

					if (!len && _indexLabel.server && serverClient.serverLastError()) {
						handlebarsContext.serverLastError = serverClient.serverLastError();
						handlebarsContext.serverHasCache = file.serverHasCache(server.path);
					}

					file.destroy();
				}
			}
		}

		// Get comics in library
		let comicsStorage = relative.get('comics');

		if (!isEmpty(comicsStorage) && !_indexLabel.masterFolder && !_indexLabel.server) {
			for (const comic of comicsStorage) {
				const path = comic.path;

				if (!comicPaths.has(path) && fs.existsSync(path)) {
					comic.name = metadataPathName(comic);
					comics.push(comic);

					comicPaths.add(path);
				}
			}
		}

		// Get comics in favorite/labels that are not in master folders, servers and library, like comics in subfolders
		if (!_indexLabel?.filter?.onlyRoot && (_indexLabel.favorites || _indexLabel.label)) {
			const labelsPath = [];

			// Favorites
			const favorites = relative.get('favorites');

			for (let path in favorites) {
				labelsPath.push(path);
			}

			// Labels
			const comicLabels = relative.get('comicLabels');

			for (let path in comicLabels) {
				labelsPath.push(path);
			}

			// Process
			for (const path of labelsPath) {
				if (!comicPaths.has(path) && fileManager.simpleExists(path)) {
					const isServer = fileManager.isServer(path);
					const firstCompressedFile = fileManager.firstCompressedFile(path, 0, false);

					comics.push({
						name: metadataPathName({ path: path, name: p.basename(path) }),
						path: path,
						added: isServer ? 0 : Math.round(fs.statSync(firstCompressedFile).ctimeMs / 1000),
						folder: true,
						compressed: compatible.compressed(path),
						fromMasterFolder: true,
					});

					comicPaths.add(path);
				}
			}
		}

		const hasGenreFilter = !!(_indexLabel?.filter?.genre || (_indexLabel?.filter?.genres && _indexLabel.filter.genres.length));

		// In genre-filter mode, include all indexed tracked folders (not only current home-page pool)
		if (hasGenreFilter && !_indexLabel.server) {
			const trackingFolderMetadata = relative.get('trackingFolderMetadata') || {};

			for (const metadataPath in trackingFolderMetadata) {
				const metadata = trackingFolderMetadata[metadataPath];
				if (!metadata || !Array.isArray(metadata.genres) || !metadata.genres.length)
					continue;

				const normalizedPath = p.normalize(metadataPath);
				if (comicPaths.has(normalizedPath) || !fileManager.simpleExists(normalizedPath))
					continue;

				let statsPath = normalizedPath;

				try {
					const firstCompressedFile = fileManager.firstCompressedFile(normalizedPath, 0, false);
					if (firstCompressedFile)
						statsPath = firstCompressedFile;
				}
				catch (error) { }

				let added = 0;

				try {
					if (!fileManager.isServer(normalizedPath))
						added = Math.round(fs.statSync(statsPath).ctimeMs / 1000);
				}
				catch (error) { }

				comics.push({
					name: metadata.title || metadataPathName({ path: normalizedPath, name: p.basename(normalizedPath) }),
					path: normalizedPath,
					added: added,
					folder: true,
					compressed: compatible.compressed(normalizedPath),
					fromMasterFolder: true,
				});

				comicPaths.add(normalizedPath);
			}
		}

		cache.cleanQueue();
		cache.stopQueue();
		threads.stop('folderThumbnails');

		let len = comics.length;

		if (len && _indexLabel.has) {
			if (_indexLabel.favorites) {
				let favorites = relative.get('favorites');
				let _comics = [];

				for (let i = 0; i < len; i++) {
					if (favorites[comics[i].path])
						_comics.push(comics[i]);
				}

				comics = _comics;
				len = comics.length;
			}
			else if (_indexLabel.label) {
				let labels = storage.get('labels') || [];
				let label = labels[_indexLabel.index] || false;

				let comicLabels = relative.get('comicLabels');
				let _comics = [];

				for (let i = 0; i < len; i++) {
					if (comicLabels[comics[i].path] && comicLabels[comics[i].path].includes(label))
						_comics.push(comics[i]);
				}

				comics = _comics;
				len = comics.length;
			}
		}

		if (_indexLabel?.filter) {
			comics = dom.labels.filterList(comics, _indexLabel.filter);
			len = comics.length;
		}

		if (len) {
			// Comic reading progress
			let readingProgress = relative.get('readingProgress');
			const trackingFolderMetadata = relative.get('trackingFolderMetadata') || {};
			const metadataQueuePaths = [];
			const metadataQueueSet = new Set();

			const queueMetadataPath = function (_path) {
				if (!_path)
					return;

				const key = String(_path).toLowerCase();
				if (metadataQueueSet.has(key))
					return;

				metadataQueueSet.add(key);
				metadataQueuePaths.push(_path);
			}

			for (let i = 0; i < len; i++) {
				comics[i].readingProgress = readingProgress[comics[i].path] || { lastReading: 0 };
			}

			comics.sort(function (a, b) {
				return (sortInvert) ? -(orderBy(a, b, order, orderKey, orderKey2)) : orderBy(a, b, order, orderKey, orderKey2);
			});

			const view = sortAndView ? sortAndView.view : config.viewIndex;
			let visibleItems = calculateVisibleItems(view, keepScroll);

			for (let i = 0; i < len; i++) {
				// See the comment on the other getFolderThumbnails() call in this file: cover
				// flow needs its own, larger cached tier regardless of the grid's size setting.
				let images = await getFolderThumbnails(comics[i].path, (view == 'coverflow') ? 1400 : false, i, visibleItems.start, visibleItems.end);
				const trackingMetadata = getTrackingFolderMetadata(comics[i].path, trackingFolderMetadata, true);

				comics[i].sha = sha1(comics[i].path);
				comics[i].poster = images.poster;
				comics[i].images = images.images;
				comics[i].addToQueue = images.addToQueue;
				comics[i].mainPath = comics[i].path;
				comics[i].progress = images.progress;
				comics[i].subname = trackingMetadata?.metadataSubname || comics[i].subname || false;

				if (trackingMetadata)
					comics[i] = { ...comics[i], ...trackingMetadata };

				if (i < 36 || (i >= visibleItems.start && i <= (visibleItems.end + 16)))
					queueMetadataPath(comics[i].path);
			}

			if (tracking?.queueFolderMetadataScrapeMany && metadataQueuePaths.length)
				tracking.queueFolderMetadataScrapeMany(metadataQueuePaths, { priority: true, fast: true });
		}

		// Avoid continue if another loadIndexPage has been run
		if (contentRightIndex != template.contentRightIndex()) return;

		dom.boxes.reset();
		if (sort != 'last-reading' && continueReading) await dom.boxes.continueReading(comics);
		if (contentRightIndex != template.contentRightIndex()) return;
		if (sort != 'last-reading') await dom.boxes.recommended(comics, true);
		if (contentRightIndex != template.contentRightIndex()) return;
		if (sort != 'last-add' && recentlyAdded) await dom.boxes.recentlyAdded(comics);

		handlebarsContext.comics = comics;
		handlebarsContext.comicsIndex = true;
		handlebarsContext.sortAndView = sortAndView || false;
		handlebarsContext.internalRankingSidebar = handlebarsContext.page.rankingSidebar ? dom.boxes.internalRankingSidebar(comics) : false;
		handlebarsContext.comicsReadingProgress = false;
		handlebarsContext.comicsReadingProgressCurrentPath = false;
		handlebarsContext.folderMetadataTop = false;

		template.loadContentRight('index.content.right.' + (sortAndView ? sortAndView.view : config.viewIndex) + '.html', animation, keepScroll);

		cache.resumeQueue();
		threads.resume('folderThumbnails');

		handlebarsContext.headerTitle = false;
		handlebarsContext.headerTitlePath = false;
		dom.loadIndexHeader(_indexLabel.has ? _indexLabel.name : false, animation);

		if (!template._contentLeft().querySelector('.menu-list'))
			dom.loadIndexContentLeft(animation);

		if (!content) {
			template.loadGlobalElement('index.elements.menus.html', 'menus');
			floatingActionButton(true, 'dom.addComicButtons();');
		}

		if (_indexLabel.has)
			floatingActionButton(false);

		events.events();

	}
	else {
		const browsingPath = path;
		const files = await readFilesIndexPage(path, mainPath, fromGoBack, notAutomaticBrowsing, fromGoForwards);

		path = files.path;
		mainPath = files.mainPath;

		if (files.open) {
			if (!fromGoBack && !fromGoForwards) {
				recentlyOpened.set(browsingPath);
			}
			template.loadContentRight('index.content.right.loading.html', animation, keepScroll);
			dom.openComic(animation, path, mainPath, false, false, false, true);

			return;
		}

		if (!fromGoBack)
			indexPathControl(path, mainPath);

		dom.boxes.reset();
		handlebarsContext.comics = [];
		handlebarsContext.comicsIndex = false;
		handlebarsContext.sortAndView = false;
		handlebarsContext.internalRankingSidebar = false;
		handlebarsContext.comicsDeep2 = path.replace(new RegExp('^\s*' + pregQuote(mainPathR)), '').split(p.sep).length >= 2 ? true : false;
		dom.setCurrentPageVars('browsing', { filter: _indexLabel?.filter || {} });

		if (handlebarsContext.comicsDeep2) {
			// nextComic()/previousComic() open the sibling archive to peek at its first page, real
			// I/O that can fail (a very long combined path, a corrupted archive, a permission
			// issue) - this call is intentionally not awaited so it does not block the header from
			// rendering, but that also means an unhandled rejection here previously left the
			// prev/next-chapter buttons stuck in whatever state the template happened to start
			// them in, with nothing surfaced about why.
			showIfHasPrevOrNext(path, mainPath).catch(function (error) {

				console.error('Failed to check for previous/next chapter:', error);

			});
		}

		headerPath(path, mainPath);

		dom.loadIndexHeader(false, animation);

		let ST = setTimeout(function () {

			if (!template._contentLeft().querySelector('.menu-list'))
				dom.loadIndexContentLeft(animation);

			template.loadContentRight('index.content.right.loading.html', animation, keepScroll);
			ST = false;

		}, 50);

		contentRightIndex = template.contentRightIndex();

		if (!content) {
			template.loadGlobalElement('index.elements.menus.html', 'menus');
			floatingActionButton(false);
		}

		cache.cleanQueue();
		cache.stopQueue();
		threads.stop('folderThumbnails');

		// Avoid continue if another loadIndexPage has been run
		if (contentRightIndex != template.contentRightIndex())
			return;

		const file = fileManager.file(path);
		const indexData = await loadFilesIndexPage(files.files, file, animation, path, keepScroll, mainPath, _indexLabel);
		file.destroy();

		let contentRightScroll = template.contentRight().children()

		if (ST === false) {
			contentRightScroll.html(indexData.html);
		}
		else {
			clearTimeout(ST);

			if (!template._contentLeft().querySelector('.menu-list'))
				dom.loadIndexContentLeft(animation);

			template.changeContentRight(indexData.html, animation, keepScroll);
		}

		if (keepScroll > 1)
			contentRightScroll.scrollTop(keepScroll);

		cache.resumeQueue();
		threads.resume('folderThumbnails');

		generateAppMenu();
	}

	if (readingActive)
		readingActive = false;

	const root = history.root();

	if (!_indexLabel.has && !root.indexLabel?.has) {
		if (!root.recentlyOpened)
			selectMenuItem('library');
		else
			selectMenuItem('recently-opened');
	}
	else {
		selectMenuItem(dom.labels.menuItemSelector(root.indexLabel.has ? root.indexLabel : _indexLabel));
	}

	shortcuts.register(isOpds || _indexLabel.opds ? 'opds' : 'browse');
	mountRecommendationFeedbackControls();
	restoreRecommendationFeedbackStates();
	bindThumbnailRecovery();
	scroll.check();
	gamepad.updateBrowsableItems(path ? sha1(path) : 'library');
	reading.discord.update();
	scroll.event();
	tabs.update();
}

function loadIndexContentLeft(animation) {
	// Master folders
	let masterFolders = relative.get('masterFolders');

	masterFolders = masterFolders.map(function (path, i) {

		path = path;

		return {
			id: 'master-folder-' + i,
			key: i,
			name: p.basename(path),
			path: path,
		};

	});

	masterFolders.sort(function (a, b) {

		if (a.name === b.name)
			return 0;

		return a.name > b.name ? 1 : -1;

	});

	handlebarsContext.masterFolders = masterFolders;

	// Labels
	let labels = storage.get('labels');

	let _labels = [];

	for (let i = 0, len = labels.length; i < len; i++) {
		_labels.push({
			id: 'label-' + i,
			key: i,
			name: labels[i],
		});
	}

	_labels.sort(function (a, b) {

		if (a.name === b.name)
			return 0;

		return a.name > b.name ? 1 : -1;

	});

	handlebarsContext.labels = _labels;

	// Servers
	let servers = storage.get('servers');

	let _servers = [];

	for (let i = 0, len = servers.length; i < len; i++) {
		_servers.push({
			id: 'server-' + i,
			key: i,
			name: servers[i].name,
			path: servers[i].path,
		});
	}

	_servers.sort(function (a, b) {

		if (a.name === b.name)
			return 0;

		return a.name > b.name ? 1 : -1;

	});

	handlebarsContext.servers = _servers;

	// OPDS Catalogs
	const opdsCatalogs = storage.get('opdsCatalogs');
	const opdsCatalogsLeft = [];

	for (let i = 0, len = opdsCatalogs.length; i < len; i++) {
		opdsCatalogsLeft.push({
			id: 'opds-' + i,
			key: i,
			title: opdsCatalogs[i].title,
			url: opdsCatalogs[i].url,
			showOnLeft: opdsCatalogs[i].showOnLeft,
			openInBrowserOnly: opdsCatalogs[i].openInBrowserOnly,
		});
	}

	opdsCatalogsLeft.sort(function (a, b) {

		if (a.name === b.name)
			return 0;

		return a.name > b.name ? 1 : -1;

	});

	handlebarsContext.opdsCatalogsLeft = opdsCatalogsLeft;

	// Is from
	handlebarsContext.isFrom = currentSelectMenuItem;

	template.loadContentLeft('index.content.left.html', animation);

	setTimeout(function () {

		// Show hover text in menus that are long
		const menus = template._contentLeft().querySelectorAll('.menu-item');

		for (const menu of menus) {
			if (menu.scrollWidth > menu.clientWidth)
				menu.classList.add('hover-text');
			else
				menu.removeAttribute('hover-text');
		}

		events.eventHover();
		bindOpdsSidebarContextMenu();

	}, 100);

	handlebarsContext.isFrom = false;
}

function bindOpdsSidebarContextMenu() {
	const contentLeft = template._contentLeft();
	if (!contentLeft) return;

	const items = contentLeft.querySelectorAll('.menu-item');

	for (const item of items) {
		const onclick = item.getAttribute('onclick') || '';
		const match = onclick.match(/^dom\.labels\.opds\([^,]+,\s*([0-9]+),/);

		if (!match) continue;

		const index = +match[1];

		item.setAttribute('oncontextmenu', `opds.delete(${index}); return false;`);
	}
}

function loadIndexHeader(title = false, animation = true) {
	handlebarsContext.indexHeaderTitle = title || language.global.library;
	template.loadHeader('index.header.html', animation);
}

function indexHeader(title = false) {
	handlebarsContext.indexHeaderTitle = title || language.global.library;
	return template.load('index.header.html');
}

function continueReadingError() {
	events.snackbar({
		key: 'continueReadingError',
		text: language.comics.continueReadingNotExists,
		duration: 6,
		buttons: [
			{
				text: language.buttons.dismiss,
				function: 'events.closeSnackbar();',
			},
		],
	});
}

function compressedError(error, showInPage = true, snackbarKey = '', path = false) {
	if (showInPage) {
		handlebarsContext.compressedError = error ? (error.detail || error.message) : '';
		handlebarsContext.contentRightMessage = template.load('content.right.message.compressed.error.html');
		template._contentRight().firstElementChild.innerHTML = template.load('content.right.message.html');
	}
	else {
		const message = language.error.uncompress.title + (error ? ': ' + (error.detail || error.message) : '');

		events.snackbar({
			key: 'compressedError' + snackbarKey,
			text: message,
			duration: 6,
			update: true,
			updateShown: true,
			buttons: [
				{
					text: language.buttons.dismiss,
					function: 'events.closeSnackbar();',
				},
			],
		});

		if (path)
			console.warn('%cError when unzipping %c' + path + '%c: ' + message, '', 'color: #cc0000;', '');
	}
}

function addSepToEnd(path) {
	if (!new RegExp(pregQuote(p.sep) + '\s*$').test(path))
		path = path + p.sep;

	return path;
}

var mainPathR = false;

function returnTextPath(path, mainPath, image = false, extension = true) {
	mainPathR = addSepToEnd(p.dirname(mainPath));

	let files = path.replace(new RegExp('^\s*' + pregQuote(mainPathR)), '').split(p.sep);
	path = [];

	let _path = mainPathR;

	for (let i = 0, len = files.length; i < len; i++) {
		_path = p.normalize(p.join(_path, files[i]));
		files[i] = metadataPathName({ path: _path, name: files[i] }, true);

		if (!extension && i == len - 1)
			files[i] = p.parse(files[i]).name;

		path.push(translatePageName(image ? htmlEntities(files[i]) : files[i]));
	}

	return path.join(image ? '<i class="material-icon navegation">chevron_right</i>' : ' / ');
}

var isFromLibrary = true;

function fromLibrary(value) {
	isFromLibrary = value;
}

function headerPath(path, mainPath, windowTitle = false) {
	let _mainPath = mainPath;

	if ((config.showFullPathLibrary && isFromLibrary) || (config.showFullPathOpened && !isFromLibrary))
		_mainPath = p.parse(path).root;

	mainPathR = addSepToEnd(p.dirname(_mainPath));

	let files = path.replace(new RegExp('^\s*' + pregQuote(mainPathR)), '').split(p.sep);
	path = [];

	let _path = mainPathR;

	for (let i = 0, len = files.length; i < len; i++) {
		if (!files[i] && i === len - 1)
			continue;

		_path = p.normalize(p.join(_path, files[i]));
		path.push({ name: metadataPathName({ path: _path, name: files[i] }, true), path: _path, mainPath: mainPath });
	}

	const root = history.root();

	if (config.showLibraryPath && (isFromLibrary || root.indexLabel?.has || root.recentlyOpened))
		path.unshift({ name: labels.getName(root.indexLabel, root.recentlyOpened), path: '', mainPath: '' });

	let len = path.length;

	if (len > 0)
		path[len - 1].last = true;

	if (windowTitle && len > 0) {
		let firstCompressedFile = fileManager.firstCompressedFile(_path);
		setWindowTitle(dom.metadataPathName({ path: firstCompressedFile, name: p.basename(firstCompressedFile) }, true));
	}

	handlebarsContext.headerTitlePath = path;
}

async function nextComic(path, mainPath) {
	let file = fileManager.file(mainPath, { cacheServer: true, subtask: true, fromThumbnailsGeneration: true, log: false, sort: { extraKey: 'Reading' } });
	let image = await file.images(1, path);
	file.destroy();

	return image && image.path ? image.path : false;
}

async function previousComic(path, mainPath) {
	let file = fileManager.file(mainPath, { cacheServer: true, subtask: true, fromThumbnailsGeneration: true, log: false, sort: { extraKey: 'Reading' } });
	let image = await file.images(-1, path);
	file.destroy();

	return image && image.path ? image.path : false;
}

async function goNextComic(path, mainPath) {
	let _nextComic = await nextComic(history.path, history.mainPath);

	if (_nextComic) {
		dom.loadIndexPage(true, p.dirname(_nextComic), false, false, history.mainPath, false, true);
	}
}

async function goPrevComic(path, mainPath) {
	let prevComic = await previousComic(history.path, history.mainPath);

	if (prevComic) {
		dom.loadIndexPage(true, p.dirname(prevComic), false, false, history.mainPath, false, true);
	}
}

async function showIfHasPrevOrNext(path, mainPath) {
	let _nextComic = await nextComic(path, mainPath);
	let prevComic = await previousComic(path, mainPath);

	let barHeader = template._barHeader();

	let buttonNext = barHeader.querySelector('.button-next-comic');
	let buttonPrev = barHeader.querySelector('.button-prev-comic');

	if (buttonNext) {
		if (_nextComic)
			buttonNext.classList.remove('disable-pointer');
	}

	if (buttonPrev) {
		if (prevComic)
			buttonPrev.classList.remove('disable-pointer');
	}
}

function pickAtRandom() {
	const contentRight = template._contentRight();
	const comics = contentRight.querySelectorAll('div:not(.box-content) > .content-view-module > div, .content-view-list .medium-list');

	const random = Math.floor(Math.random() * comics.length);
	const item = comics[random];

	if (item && typeof item.click === 'function')
		item.click();
}

async function _getFolderThumbnails(file, images, _images, path, folderSha, isAsync = false, forceSize = false) {
	const viewModuleSize = forceSize ? forceSize : (handlebarsContext.page.viewModuleSize || 150);

	let shaIndex = {};
	let poster = false;

	if (Array.isArray(_images)) // 4 Images
	{
		if (isAsync) dom.queryAll('.sha-' + folderSha + ' .folder-poster, .sha-' + folderSha + ':not(.medium-list) .progress-pages').remove();

		for (let i = 0, len = _images.length; i < len; i++) {
			_images[i].vars = { i: i };
			shaIndex[i] = _images[i].sha;
		}

		_images = cache.returnThumbnailsImages(_images, function (data, vars) {

			addImageToDom(data.sha, data.path);
			addImageToDom(folderSha + '-' + vars.i, data.path);

		}, file);

		for (let i = 0, len = images.length; i < len; i++) {
			let imageCache = _images[shaIndex[i]];

			if (imageCache && imageCache.cache) {
				images[i].path = imageCache.path;
				images[i].cache = true;

				if (isAsync) {
					addImageToDom(imageCache.sha, imageCache.path, false);
					addImageToDom(folderSha + '-' + i, imageCache.path, false);
				}
			}
		}
	}
	else // Poster
	{
		if (isAsync) dom.queryAll('.sha-' + folderSha + ' .folder-images').remove();

		poster = cache.returnThumbnailsImages({ path: _images.path, sha: _images.sha, type: 'poster', forceSize: viewModuleSize }, function (data) {

			addImageToDom(data.sha, data.path);
			addImageToDom(folderSha + '-0', data.path);

		}, file);

		if (isAsync && poster.path) {
			addImageToDom(poster.sha, poster.path, false);
			addImageToDom(folderSha + '-0', poster.path, false);
		}

		poster.sha = folderSha + '-0';

		images = false;
	}

	return { poster: poster, images: images };
}

async function selectFolderThumbnailSource(file, path) {
	// Check for .tbn poster file in parent directory (created by "Set as poster")
	const tbnPath = p.resolve(p.dirname(path), p.parse(path).name + '.tbn');
	if (fs.existsSync(tbnPath))
		return { path: tbnPath, sha: sha1(tbnPath), type: 'poster' };

	if (p.basename(path) === 'Pepper & Carrot') {
		try {
			const entries = fs.readdirSync(path);
			const tbnName = entries.find(name => /\.tbn$/i.test(name));
			if (tbnName) {
				const tbnInside = p.join(path, tbnName);
				return { path: tbnInside, sha: sha1(tbnInside), type: 'poster' };
			}
		}
		catch {}
	}

	const files = await file.read({ cacheServer: true, filtered: false });
	const fullFiltered = fileManager.filtered(files);

	if (!fullFiltered.length)
		return false;

	const coverRegex = /^cover(?:[\s._-].*)?\.[a-z0-9]+$/i;

	// Wrapper folders are common in omnibus/scanlation releases: the whole archive is often one
	// top-level folder holding every page (or one folder per included volume), rather than
	// pages sitting directly at the archive root. The old version of this loop skipped any
	// `folder: true` entry outright instead of looking inside it, so an archive packed that way
	// never got a thumbnail - firstFile/firstImage stayed unset, and the function fell straight
	// through to "return false". pickThumbnailCandidate() recurses into folders instead, so it
	// finds the same cover/first-image/first-file candidates wherever in the tree they are.
	function pickThumbnailCandidate(items) {
		let coverImage = false;
		let firstImage = false;
		let firstFile = false;

		for (const item of items) {
			if (item.folder) {
				const nested = pickThumbnailCandidate(item.files || []);

				if (nested.coverImage)
					return nested; // Propagate the short-circuit all the way up.

				if (!firstImage && nested.firstImage)
					firstImage = nested.firstImage;

				if (!firstFile && nested.firstFile)
					firstFile = nested.firstFile;

				continue;
			}

			if (!firstFile)
				firstFile = item;

			if (item.compressed)
				continue;

			if (compatible.image(item.path)) {
				if (!firstImage)
					firstImage = item;

				if (coverRegex.test(item.name)) {
					coverImage = item;
					return { coverImage, firstImage, firstFile };
				}
			}
		}

		return { coverImage, firstImage, firstFile };
	}

	const { coverImage, firstImage, firstFile } = pickThumbnailCandidate(fullFiltered);

	const pickedImage = coverImage || firstImage;

	if (pickedImage)
		return { path: pickedImage.path, sha: pickedImage.sha || sha1(pickedImage.path), type: 'poster' };

	if (!firstFile || !firstFile.compressed)
		return false;

	const innerFile = fileManager.file(firstFile.path, { fromThumbnailsGeneration: true, subtask: true, log: false, sort: { extraKey: 'Reading' } });

	try {
		const first = await innerFile.images(1, false, false);

		if (first && first.path)
			return { path: first.path, sha: first.sha || sha1(first.path), type: 'poster' };
	}
	catch (error) {
		if (!error?.message || !/notCacheOnly/.test(error.message))
			throw error;
	}
	finally {
		innerFile.destroy();
	}

	return false;
}

async function getFolderThumbnails(path, forceSize = false, index = 0, start = 0, end = 99999) {
	const getProgress = handlebarsContext.page.fadeCompleted || handlebarsContext.page.progressBar || handlebarsContext.page.progressPages || handlebarsContext.page.progressPercent;
	const folderSha = sha1(path + (forceSize ? '?size=' + forceSize : ''));

	let poster = { cache: false, path: '', sha: folderSha + '-0' };

	let images = [
		{ cache: false, path: '', sha: folderSha + '-0' },
		{ cache: false, path: '', sha: folderSha + '-1' },
		{ cache: false, path: '', sha: folderSha + '-2' },
		{ cache: false, path: '', sha: folderSha + '-3' },
	];

	let progress = false;

	let addToQueue = false;
	let addToQueueProgress = false;

	if (index >= start && index <= end) {
		try {
			// width, when forceSize is set (cover flow's 1400 tier), is what openCompressed()
			// (file-manager.js) actually rasterises a PDF page's own cached source at - without it,
			// that raw source stays capped at its own unrelated 300px default regardless of forceSize.
			let file = fileManager.file(path, { fromThumbnailsGeneration: true, subtask: true, log: false, sort: { extraKey: 'Reading' }, ...(forceSize ? { width: Math.round(window.devicePixelRatio * forceSize) } : {}) });
			file.updateConfig({ cacheOnly: true });

			let _images = cache.folderThumbnails.get(path, forceSize);

			if (_images) {
				_images = _images.poster ? _images.poster : (_images.images?.[0] || false);

				// Invalidate stale cache entries whose compressed source file was renamed or deleted
				if (_images && _images.path) {
					const compressedFile = fileManager.lastCompressedFile(_images.path);
					if (compressedFile && !fileManager.simpleExists(compressedFile)) {
						cache.folderThumbnails.remove(path);
						_images = false;
					}
					// If cached poster is from inside a compressed file, check if a cover
					// image now exists directly in the folder and should be preferred
					else if (compressedFile) {
						try {
							const coverRegex = /^cover(?:[\s._-].*)?\.[a-z0-9]+$/i;
							const entries = fs.readdirSync(path);
							const hasCover = entries.some(name => coverRegex.test(name) && compatible.image(name));
							if (hasCover) {
								cache.folderThumbnails.remove(path);
								_images = false;
							}
						} catch {}
					}
				}
			}

			if (!_images) {
				_images = await selectFolderThumbnailSource(file, path);

				if (_images)
					cache.folderThumbnails.set(path, _images);
			}

			if (_images)
				_images = await _getFolderThumbnails(file, images, _images, path, folderSha, false, forceSize);

			file.destroy();

			if (_images) {
				poster = _images.poster;
				images = _images.poster ? false : _images.images;
			}
		}
		catch (error) {
			if (error.message && /notCacheOnly/.test(error.message)) {
				addToQueue = 1;
			}
			else {
				console.error(error);

				dom.compressedError(error, false);
				fileManager.requestFileAccess.check(path, error);
			}
		}

		try {
			if (getProgress) {
				const type = fileManager.getPathType(path);
				progress = type.folder ? await reading.progress.getFolderItemProgress(path, true, true) : await reading.progress.get(path, true, true);
			}
		}
		catch (error) {
			if (error.message && /notCacheOnly/.test(error.message))
				addToQueueProgress = 1;
		}
	}
	else {
		addToQueue = 2;
		addToQueueProgress = 2;
	}

	if (forceSize !== null || addToQueue || addToQueueProgress) {
		scroll.setStatus(folderSha, {
			index,
			path,
			forceSize,
			thumbnails: addToQueue,
			progress: addToQueueProgress,
			folderSha,
		});
	}

	return { poster: poster, images: images, addToQueue: addToQueue, progress: progress };
}

function calculateVisibleItems(view, scrollTop = false) {
	const element = template._contentRight().firstElementChild;
	let rect = element.getBoundingClientRect();

	if (rect.width == 0 || rect.height == 0)
		rect = { width: window.innerWidth, height: window.innerHeight };

	scrollTop = scrollTop || 0; // element.scrollTop;

	let start = 0;
	let end = 100;

	if (view == 'module') {
		const viewModuleSize = handlebarsContext.page.viewModuleSize || 150;

		const sizes = {
			100: {
				width: 116,
				height: 230,
			},
			150: {
				width: 166,
				height: 305,
			},
			200: {
				width: 216,
				height: 380,
			},
			250: {
				width: 266,
				height: 455,
			},
			300: {
				width: 316,
				height: 530,
			},
		};

		const size = sizes[viewModuleSize] || sizes[150];

		const itemsPerLine = Math.max(1, Math.floor((rect.width - 16) / size.width));
		const lines = Math.ceil(rect.height / size.height);
		const line = Math.floor(scrollTop / size.height);

		start = scrollTop ? (line - 1) * itemsPerLine : 0; // 1 margin line
		end = (line + lines + 1) * itemsPerLine; // 1 margin line
	}
	else if (view == 'coverflow') {
		// Cover flow does not scroll - what is on screen is a window around the centred
		// cover, so the thumbnails worth generating are the ones near it. The margin (14) is
		// wider than the covers actually drawn (WINDOW, 8 in dom/coverflow.js), so they are
		// already warm by the time they rotate into view. The backdrop collage (COLLAGE_TILES,
		// ±12 there) resolves its own random page per volume independently of this window.
		const centre = coverflow.index || 0;

		start = centre - 14;
		end = centre + 14;
	}
	else {
		start = scrollTop ? Math.floor(scrollTop / 72) - 4 : 0; // 4 margin items
		end = Math.floor((scrollTop + rect.height) / 72) + 4; // 4 margin items
	}

	return { start: start, end: end };
}

function goStartPath() {
	const root = history.root();

	if (root.indexLabel?.has && !root.recentlyOpened)
		indexLabel = root.indexLabel;

	if (root.recentlyOpened)
		recentlyOpened.load(true);
	else
		loadIndexPage(true, false);
}

function filterByGenre(genre = '', event = false) {
	if (event?.preventDefault)
		event.preventDefault();

	if (event?.stopPropagation)
		event.stopPropagation();

	const normalizedGenre = app.stripTagsWithDOM(String(genre || '')).replace(/\s+/g, ' ').trim();
	if (!normalizedGenre)
		return;

	const currentFilter = { ...((prevIndexLabel || {}).filter || {}) };
	const activeGenre = String(currentFilter.genre || '').trim().toLowerCase();

	if (activeGenre === normalizedGenre.toLowerCase()) {
		delete currentFilter.genre;
		delete currentFilter.genres;
		delete currentFilter.hasGenre;
	}
	else {
		currentFilter.genre = normalizedGenre;
		currentFilter.genres = [normalizedGenre];
		currentFilter.hasGenre = true;
	}

	const nextIndexLabel = {
		filter: currentFilter,
	};

	setIndexLabel(nextIndexLabel);
	setPrevIndexLabel(nextIndexLabel);

	loadIndexPage(true, false);
}

var barBackStatus = false;

// This needs to be improved more, if is from fromNextAndPrev, consider changing the previous route/path
function indexPathControl(path = false, mainPath = false, isComic = false, fromNextAndPrev = false, fromRecentlyOpened = false, fromPage = false) {
	if (path === false || mainPath === false) {
		handlebarsContext.fromRecentlyOpened = fromRecentlyOpened;

		history.clean();
		history.add({ root: true, file: false, path: false, mainPath: false, isComic: false, indexLabel: prevIndexLabel, recentlyOpened: fromRecentlyOpened, page: fromPage });
	}
	else {
		mainPathR = addSepToEnd(p.dirname(mainPath));

		const files = path.replace(new RegExp('^\s*' + pregQuote(mainPathR)), '').split(p.sep);
		const index = files.length - 1;

		const current = history.current();

		if (index >= 0) {
			const page = { file: files[index], path: path, mainPath: mainPath, isComic: isComic, indexLabel: prevIndexLabel };

			if (current && isComic && fromNextAndPrev && current.isComic) {
				history.update(page);
			}
			else if (!current || current.path !== path || current.mainPath !== mainPath || current.isComic !== isComic) {
				if (!history.fromGoForwards())
					history.cleanForwards();

				history.add(page);
			}
			else if (current && !current.root) {
				history.update(page);
			}
		}
	}

	const current = history.current();

	if (!current.root) {
		if (!barBackStatus) {
			template.setHeaderDelay();
			handlebarsContext.barBack = 'show';

			//dom.queryAll('.bar-left, .bar-back').css({animationDelay: ''});
			//dom.queryAll('.bar-left').removeClass('disable', 'active').addClass('show');
		}
		else {
			handlebarsContext.barBack = 'active';
		}

		barBackStatus = true;
	}
	else {
		if (barBackStatus) {
			template.setHeaderDelay();
			handlebarsContext.barBack = 'disable';

			//dom.queryAll('.bar-left, .bar-back').css({animationDelay: ''});
			//dom.queryAll('.bar-left').removeClass('active', 'show').addClass('disable');
		}
		else {
			handlebarsContext.barBack = '';
		}

		barBackStatus = false;
	}
}

/* Page - Recently Opened */

function loadRecentlyOpened(animation = true) {
	indexPathControl(false);
	selectMenuItem('recently-opened');

	onReading = _onReading = false;
	app.clearMemory();

	reading.hideContent();

	generateAppMenu();

	recentlyOpened.load(animation);

	if (readingActive)
		readingActive = false;
}

/* Page - Theme */

/*Page - Language*/

function loadLanguagePage(animation = true) {
	indexPathControl(false, false, false, false, false, 'languages');
	selectMenuItem('language');

	setCurrentPathScrollTop();

	onReading = _onReading = false;
	app.clearMemory();

	reading.hideContent();

	generateAppMenu();

	if (typeof handlebarsContext.languagesList == 'undefined') {
		var languagesList = JSON.parse(readFileApp('/languages/languagesList.json'));

		handlebarsContext.languagesList = [];

		for (let code in languagesList) {
			if (typeof languagesList[code].active != 'undefined' && languagesList[code].active) {
				handlebarsContext.languagesList.push({ code: code, name: languagesList[code].name, nativeName: languagesList[code].nativeName });
			}
		}
	}

	handlebarsContext.languagesList.sort(function (a, b) {

		if (a.nativeName == b.nativeName)
			return 0;

		return a.nativeName > b.nativeName ? 1 : -1;

	});

	template.loadContentRight('languages.content.right.html', animation);
	template.loadHeader('languages.header.html', animation);
	template.loadGlobalElement('general.elements.menus.html', 'menus');
	floatingActionButton(false);

	events.events();
	gamepad.updateBrowsableItems('languagesPage');
	tabs.update();

	if (readingActive)
		readingActive = false;
}

function changeLanguage(lan) {
	loadLanguage(lan);

	template.contentRight('.language-list.active').removeClass('active');
	template.contentRight('.language-list-' + lan).addClass('active');

	dom.loadIndexContentLeft(false);
	template.loadHeader('languages.header.html', false);
	storage.updateVar('config', 'language', lan);

	gamepad.updateBrowsableItems(gamepad.currentKey());
	tabs.update();
}

/* Page - Settings */

function loadSettingsPage(animation = true) {
	indexPathControl(false, false, false, false, false, 'settings');
	selectMenuItem('settings');

	setCurrentPathScrollTop();

	onReading = _onReading = false;
	app.clearMemory();

	reading.hideContent();

	generateAppMenu();

	settings.start();

	template.loadContentRight('settings.content.right.html', animation);
	template.loadHeader('settings.header.html', animation);
	template.loadGlobalElement('general.elements.menus.html', 'menus');
	floatingActionButton(false);

	settings.startSecond();

	if (readingActive)
		readingActive = false;

	tabs.update();
}

/* Page - Theme */

function loadThemePage(animation = true) {
	indexPathControl(false, false, false, false, false, 'themes');
	selectMenuItem('theme');

	setCurrentPathScrollTop();

	onReading = _onReading = false;
	app.clearMemory();

	reading.hideContent();

	generateAppMenu();

	//template.loadContentRight('theme.content.right.html', animation);
	template.loadHeader('theme.header.html', animation);
	template.loadGlobalElement('general.elements.menus.html', 'menus');
	floatingActionButton(false);

	theme.start();

	if (readingActive)
		readingActive = false;

	tabs.update();
}

/* Page - Library Weather */

function loadWeatherPage(animation = true) {
	indexPathControl(false, false, false, false, false, 'weather');
	selectMenuItem('weather');

	setCurrentPathScrollTop();

	onReading = _onReading = false;
	app.clearMemory();

	reading.hideContent();

	generateAppMenu();

	template.loadHeader('weather.header.html', animation);
	template.loadGlobalElement('general.elements.menus.html', 'menus');
	floatingActionButton(false);

	weather.start();

	if (readingActive)
		readingActive = false;

	tabs.update();
}

/* Page - Library Constellation */

function loadConstellationPage(animation = true) {
	indexPathControl(false, false, false, false, false, 'constellation');
	selectMenuItem('constellation');

	setCurrentPathScrollTop();

	onReading = _onReading = false;
	app.clearMemory();

	reading.hideContent();

	generateAppMenu();

	template.loadHeader('constellation.header.html', animation);
	template.loadGlobalElement('general.elements.menus.html', 'menus');
	floatingActionButton(false);

	constellation.start();

	if (readingActive)
		readingActive = false;

	tabs.update();
}

/* Page - Series Relationship Explorer */

function loadRelationshipExplorerPage(path, animation = true) {
	indexPathControl(false, false, false, false, false, 'relationships');

	setCurrentPathScrollTop();

	onReading = _onReading = false;
	app.clearMemory();

	reading.hideContent();

	generateAppMenu();

	template.loadHeader('relationship-explorer.header.html', animation);
	template.loadGlobalElement('general.elements.menus.html', 'menus');
	floatingActionButton(false);

	relationshipExplorer.start(path);

	if (readingActive)
		readingActive = false;

	tabs.update();
}

var currentSelectMenuItem = false;

function selectMenuItem(page) {
	currentSelectMenuItem = page;
	let contentLeft = template._contentLeft();

	let active = contentLeft.querySelector('.menu-item.active');
	if (active) active.classList.remove('active');

	page = contentLeft.querySelector('.menu-item-' + page);
	if (page) page.classList.add('active');
}

var addComicButtonsST = false, addComicButtonsActive = false;

function addComicButtons(show = true, first = true) {
	clearTimeout(addComicButtonsST);

	if (show) {
		var more = false, have = false;

		$($('.floating-action-button-min').get().reverse()).each(function () {

			if (!$(this).hasClass('s')) {
				if (!have)
					$(this).removeClass('h').addClass('s');
				else
					more = true;

				have = true;
			}

		});

		if (more)
			addComicButtonsST = setTimeout(function () { addComicButtons(true, false) }, 50);

		if (first) {
			floatingActionButton(true, 'dom.addComicButtons(false);');
			$('.floating-action-button-add > div').css('transform', 'rotate(135deg)');
		}

		addComicButtonsActive = true;
	}
	else {
		var more = false, have = false;

		$('.floating-action-button-min').each(function () {

			if (!$(this).hasClass('h')) {
				if (!have)
					$(this).removeClass('s').addClass('h');
				else
					more = true;

				have = true;
			}

		});

		if (more)
			addComicButtonsST = setTimeout(function () { addComicButtons(false, false) }, 50);

		if (first) {
			floatingActionButton(true, 'dom.addComicButtons();');
			$('.floating-action-button-add > div').css('transform', '');
		}

		addComicButtonsActive = false;
	}
}

function floatingActionButton(active, callback) {
	if (active) {
		$('.floating-action-button-add').removeClass('disable').attr('onclick', callback);
	}
	else {
		if (addComicButtonsActive)
			addComicButtons(false);

		$('.floating-action-button-add').addClass('disable');
	}
}

const defaultSortAndView = {
	view: 'module',
	sort: 'name',
	sortInvert: false,
	continueReading: true,
	recentlyAdded: true,
	rankingSidebar: true,
	viewModuleSize: 150,
};

function setCurrentPageVars(page, _indexLabel = false) {
	_indexLabel = _indexLabel || {};
	let labelKey = false;
	let sortAndView = false;

	let key = page;

	if (_indexLabel.has) {
		if (_indexLabel.favorites) {
			labelKey = key = 'favorites';
		}
		else if (_indexLabel.opds) {
			labelKey = key = 'opds';
		}
		else if (_indexLabel.masterFolder) {
			labelKey = 'masterFolder-' + _indexLabel.index;
			key = 'masterFolder';
		}
		else if (_indexLabel.server) {
			labelKey = 'server-' + _indexLabel.index;
			key = 'server';
		}
		else if (_indexLabel.label) {
			labelKey = 'label-' + _indexLabel.index;
			key = 'label';
		}

		sortAndView = config.sortAndView[labelKey] || defaultSortAndView;
	}

	let extraKey = '';

	if (page == 'recently-opened')
		extraKey = 'RecentlyOpened';
	else if (page == 'index')
		extraKey = 'Index';
	else if (page == 'reading')
		extraKey = 'Reading';

	const sortAndViewOpds = config.sortAndView.opds || defaultSortAndView;

	// A plain folder ('browsing': neither the library root nor a labeled page, which already
	// get their own sortAndView entry above) remembers its view *per folder* rather than
	// sharing one global choice with every other folder - cover flow makes sense for a folder
	// of volumes, but reused for the next, unrelated folder browsed into (a folder of loose
	// pages, say) it is just wrong, and there is no way to tell those two shapes apart except
	// by what was actually chosen for that specific folder. See changeView()'s matching branch.
	const folderView = (!sortAndView && page == 'browsing' && currentPath) ? (config.folderView || {})[currentPath] : false;

	handlebarsContext.page = {
		..._indexLabel,
		...{
			key: key,
			name: labelKey ? labelKey : page,
			view: sortAndView ? sortAndView.view : (folderView || config['view' + extraKey]),
			sort: sortAndView ? sortAndView.sort : config['sort' + extraKey],
			sortInvert: sortAndView ? sortAndView.sortInvert : config['sortInvert' + extraKey],
			foldersFirst: sortAndView ? true : (config['foldersFirst' + extraKey] || false),
			compressedFirst: sortAndView ? true : (config['compressedFirst' + extraKey] || false),
			boxes: (page == 'recently-opened' || page == 'browsing') ? false : true,
			continueReading: sortAndView ? sortAndView.continueReading : config['continueReading' + extraKey],
			recentlyAdded: sortAndView ? sortAndView.recentlyAdded : config['recentlyAdded' + extraKey],
			rankingSidebar: sortAndView ? sortAndView.rankingSidebar : config['rankingSidebar' + extraKey],
			viewModuleSize: sortAndView ? sortAndView.viewModuleSize : config['viewModuleSize' + extraKey],
			filter: _indexLabel.filter || {},
			labelOrFavorites: !!(_indexLabel.label || _indexLabel.favorites),
			fadeCompleted: sortAndView ? sortAndView.fadeCompleted : config['fadeCompleted' + extraKey],
			progressBar: sortAndView ? sortAndView.progressBar : config['progressBar' + extraKey],
			progressPages: sortAndView ? sortAndView.progressPages : config['progressPages' + extraKey],
			progressPercent: sortAndView ? sortAndView.progressPercent : config['progressPercent' + extraKey],
			opds: {
				continueReading: sortAndViewOpds.continueReading,
				recentlyAdded: sortAndViewOpds.recentlyAdded,
			},
		}
	};
}

function changeView(mode, page) {
	let labelKey = false;
	let sortAndView = false;

	if (/favorites|opds|masterFolder|server|label/.test(page)) {
		labelKey = page;

		sortAndView = config.sortAndView[labelKey] || defaultSortAndView;
	}

	let changed = false;

	if (sortAndView) {
		if (mode != sortAndView.view) {
			sortAndView.view = mode;
			config.sortAndView[labelKey] = sortAndView;

			storage.updateVar('config', 'sortAndView', config.sortAndView);
			selectElement('.view-' + mode);
			changed = true;
		}
	}
	// A plain folder ('browsing') remembers its view per folder rather than sharing one
	// global choice with every other folder - see the matching lookup in setCurrentPageVars().
	else if (page == 'browsing' && currentPath) {
		const folderView = config.folderView || {};

		if (mode != (folderView[currentPath] || config.view)) {
			folderView[currentPath] = mode;
			config.folderView = folderView;

			storage.updateVar('config', 'folderView', folderView);
			selectElement('.view-' + mode);
			changed = true;
		}
	}
	else {
		let extraKey = '';

		if (page == 'recently-opened')
			extraKey = 'RecentlyOpened';
		else if (page == 'index')
			extraKey = 'Index';
		else if (page == 'reading')
			extraKey = 'Reading';

		if (mode != config['view' + extraKey]) {
			storage.updateVar('config', 'view' + extraKey, mode);
			selectElement('.view-' + mode);
			changed = true;
		}
	}

	if (changed) {
		dom.this(template._globalElement().querySelector('.view-module-size')).class(!(mode == 'module'), 'disable-pointer');
		dom.reload();
	}
}

function changeViewModuleSize(size, end, page) {
	if (!end) return;

	let labelKey = false;
	let sortAndView = false;

	if (/favorites|opds|masterFolder|server|label/.test(page)) {
		labelKey = page;

		sortAndView = config.sortAndView[labelKey] || defaultSortAndView;
	}

	let changed = false;

	if (sortAndView) {
		if (size != sortAndView.viewModuleSize) {
			sortAndView.viewModuleSize = size;
			config.sortAndView[labelKey] = sortAndView;

			storage.updateVar('config', 'sortAndView', config.sortAndView);
			changed = true;
		}
	}
	else {
		let extraKey = '';

		if (page == 'recently-opened')
			extraKey = 'RecentlyOpened';
		else if (page == 'index')
			extraKey = 'Index';
		else if (page == 'reading')
			extraKey = 'Reading';

		if (size != config['viewModuleSize' + extraKey]) {
			storage.updateVar('config', 'viewModuleSize' + extraKey, size);
			changed = true;
		}
	}

	if (changed)
		dom.reload();
}

function changeSort(type, mode, page) {
	let labelKey = false;
	let sortAndView = false;

	if (/favorites|opds|masterFolder|server|label/.test(page)) {
		labelKey = page;

		sortAndView = config.sortAndView[labelKey] || defaultSortAndView;
	}

	let changed = false;

	if (sortAndView) {
		if (type == 1) {
			if (mode != sortAndView.sort) {
				sortAndView.sort = mode;
				changed = true;
			}
		}
		else if (type == 2) {
			if (mode != sortAndView.sortInvert) {
				sortAndView.sortInvert = mode;
				changed = true;
			}
		}

		if (changed) {
			config.sortAndView[labelKey] = sortAndView;

			storage.updateVar('config', 'sortAndView', config.sortAndView);
			selectElement('.sort-' + mode);
		}
	}
	else {
		let extraKey = '';

		if (page == 'recently-opened')
			extraKey = 'RecentlyOpened';
		else if (page == 'index')
			extraKey = 'Index';
		else if (page == 'reading')
			extraKey = 'Reading';

		if (type == 1) {
			if (mode != config['sort' + extraKey]) {
				storage.updateVar('config', 'sort' + extraKey, mode);
				selectElement('.sort-' + mode);
				changed = true;
			}
		}
		else if (type == 2) {
			if (mode != config['sortInvert' + extraKey]) {
				storage.updateVar('config', 'sortInvert' + extraKey, mode);
				changed = true;
			}
		}
		else if (type == 3) {
			if (mode != config['foldersFirst' + extraKey]) {
				storage.updateVar('config', 'foldersFirst' + extraKey, mode);
				changed = true;
			}
		}
		else if (type == 4) {
			if (mode != config['compressedFirst' + extraKey]) {
				storage.updateVar('config', 'compressedFirst' + extraKey, mode);
				changed = true;
			}
		}
	}

	if (changed)
		dom.reload();
}

function changeConfig(key, value, page) {
	let labelKey = false;
	let sortAndView = false;

	if (/favorites|opds|masterFolder|server|label/.test(page)) {
		labelKey = page;

		sortAndView = config.sortAndView[labelKey] || defaultSortAndView;
	}

	let changed = false;

	if (sortAndView) {
		sortAndView[key] = value;

		config.sortAndView[labelKey] = sortAndView;
		storage.updateVar('config', 'sortAndView', config.sortAndView);
	}
	else {
		let extraKey = '';

		if (page == 'recently-opened')
			extraKey = 'RecentlyOpened';
		else if (page == 'index')
			extraKey = 'Index';

		storage.updateVar('config', key + extraKey, value);
	}

	dom.reload();
}

function selectElement(element) {
	$(element).parent().children().removeClass('s');
	$(element).addClass('s');
}

//Enable/Disable night mode

function nightMode(force = null) {
	let _app = document.querySelector('.app');

	if ((force === null && _app.classList.contains('night-mode')) || force === false) {
		_app.classList.remove('night-mode');
		dom.queryAll('.button-night-mode').html('light_mode');
		handlebarsContext.nightMode = false;
		storage.updateVar('config', 'nightMode', false);
	}
	else {
		_app.classList.add('night-mode');
		dom.queryAll('.button-night-mode').html('dark_mode');
		handlebarsContext.nightMode = true;
		storage.updateVar('config', 'nightMode', true);
	}

	nightModeConfig(_app);

	titleBar.setColors();
}

function nightModeConfig(_app = false) {
	_app = _app || document.querySelector('.app');

	if (config.nightModeBlackBackground)
		_app.classList.add('night-mode-black-background');
	else
		_app.classList.remove('night-mode-black-background');

	if (config.nightModeWhiteBlankPage)
		_app.classList.add('night-mode-white-blank-page');
	else
		_app.classList.remove('night-mode-white-blank-page');
}

let comicContextMenuIndex = 0;

// Show the comic context menu
async function comicContextMenu(path, mainPath, fromIndex = true, fromIndexNotMasterFolders = true, folder = false, gamepad = false) {
	comicContextMenuIndex++;

	let isServer = fileManager.isServer(path);
	if (fileManager.isOpds(path)) {
		if (this && typeof this.click === 'function') {
			opds.fromContextMenu = true;
			this.click();
		}

		return;
	}

	const canBeDelete = (!fileManager.isServer(path) && !fileManager.lastCompressedFile(p.dirname(path))) ? true : false;

	dom.query('#index-context-menu .separator-remove').css({ display: canBeDelete ? 'block' : 'none' });

	// Remove
	const contextMenuContent = document.querySelector('#index-context-menu .menu-simple-content > div');
	let rename = document.querySelector('#index-context-menu .context-menu-rename');
	let editMetadata = document.querySelector('#index-context-menu .context-menu-edit-metadata');
	let refreshMetadata = document.querySelector('#index-context-menu .context-menu-refresh-metadata');

	if (!rename && contextMenuContent) {
		const separatorRemove = contextMenuContent.querySelector('.separator-remove');
		const renameHTML = '<div class="menu-simple-element menu-simple-element-little context-menu-rename gamepad-item"><i class="material-icon menu-simple-icon-first">edit</i><span>' + language.buttons.edit + '</span></div>';

		if (separatorRemove)
			separatorRemove.insertAdjacentHTML('beforebegin', renameHTML);
		else
			contextMenuContent.insertAdjacentHTML('beforeend', renameHTML);

		rename = document.querySelector('#index-context-menu .context-menu-rename');
	}

	if (!editMetadata && contextMenuContent) {
		const editMetadataLabel = language.global?.contextMenu?.editMetadata || 'Edit metadata';
		const editMetadataHTML = '<div class="menu-simple-element menu-simple-element-little context-menu-edit-metadata gamepad-item"><i class="material-icon menu-simple-icon-first">tune</i><span>' + editMetadataLabel + '</span></div>';

		if (rename)
			rename.insertAdjacentHTML('afterend', editMetadataHTML);
		else {
			const separatorRemove = contextMenuContent.querySelector('.separator-remove');

			if (separatorRemove)
				separatorRemove.insertAdjacentHTML('beforebegin', editMetadataHTML);
			else
				contextMenuContent.insertAdjacentHTML('beforeend', editMetadataHTML);
		}

		editMetadata = document.querySelector('#index-context-menu .context-menu-edit-metadata');
	}

	if (!refreshMetadata && contextMenuContent) {
		const refreshMetadataLabel = 'Refresh metadata';
		const refreshMetadataHTML = '<div class="menu-simple-element menu-simple-element-little context-menu-refresh-metadata gamepad-item"><i class="material-icon menu-simple-icon-first">refresh</i><span>' + refreshMetadataLabel + '</span></div>';

		if (editMetadata)
			editMetadata.insertAdjacentHTML('afterend', refreshMetadataHTML);
		else if (rename)
			rename.insertAdjacentHTML('afterend', refreshMetadataHTML);
		else {
			const separatorRemove = contextMenuContent.querySelector('.separator-remove');

			if (separatorRemove)
				separatorRemove.insertAdjacentHTML('beforebegin', refreshMetadataHTML);
			else
				contextMenuContent.insertAdjacentHTML('beforeend', refreshMetadataHTML);
		}

		refreshMetadata = document.querySelector('#index-context-menu .context-menu-refresh-metadata');
	}

	let setFormat = document.querySelector('#index-context-menu .context-menu-set-format');

	if (!setFormat && contextMenuContent) {
		const setFormatLabel = 'Set format';
		const setFormatHTML = '<div class="menu-simple-element menu-simple-element-little context-menu-set-format gamepad-item"><i class="material-icon menu-simple-icon-first">auto_stories</i><span>' + setFormatLabel + '</span></div>';

		if (refreshMetadata)
			refreshMetadata.insertAdjacentHTML('afterend', setFormatHTML);
		else if (editMetadata)
			editMetadata.insertAdjacentHTML('afterend', setFormatHTML);
		else if (rename)
			rename.insertAdjacentHTML('afterend', setFormatHTML);
		else {
			const separatorRemove = contextMenuContent.querySelector('.separator-remove');

			if (separatorRemove)
				separatorRemove.insertAdjacentHTML('beforebegin', setFormatHTML);
			else
				contextMenuContent.insertAdjacentHTML('beforeend', setFormatHTML);
		}

		setFormat = document.querySelector('#index-context-menu .context-menu-set-format');
	}

	let viewRelationships = document.querySelector('#index-context-menu .context-menu-view-relationships');

	if (!viewRelationships && contextMenuContent) {
		const viewRelationshipsLabel = 'View relationships';
		const viewRelationshipsHTML = '<div class="menu-simple-element menu-simple-element-little context-menu-view-relationships gamepad-item"><i class="material-icon menu-simple-icon-first">hub</i><span>' + viewRelationshipsLabel + '</span></div>';

		if (setFormat)
			setFormat.insertAdjacentHTML('afterend', viewRelationshipsHTML);
		else if (refreshMetadata)
			refreshMetadata.insertAdjacentHTML('afterend', viewRelationshipsHTML);
		else if (editMetadata)
			editMetadata.insertAdjacentHTML('afterend', viewRelationshipsHTML);
		else if (rename)
			rename.insertAdjacentHTML('afterend', viewRelationshipsHTML);
		else {
			const separatorRemove = contextMenuContent.querySelector('.separator-remove');

			if (separatorRemove)
				separatorRemove.insertAdjacentHTML('beforebegin', viewRelationshipsHTML);
			else
				contextMenuContent.insertAdjacentHTML('beforeend', viewRelationshipsHTML);
		}

		viewRelationships = document.querySelector('#index-context-menu .context-menu-view-relationships');
	}

	if (rename) {
		const canRename = !isServer && !/app\.asar\.unpacked/.test(path);
		rename.style.display = canRename ? 'block' : 'none';

		if (canRename)
			rename.setAttribute('onclick', 'dom.renameDialog(\'' + escapeQuotes(escapeBackSlash(path), 'simples') + '\');');
	}

	if (editMetadata) {
		const canEditMetadata = !isServer && folder && !/app\.asar\.unpacked/.test(path);
		editMetadata.style.display = canEditMetadata ? 'block' : 'none';

		if (canEditMetadata)
			editMetadata.setAttribute('onclick', 'dom.editMetadataDialog(\'' + escapeQuotes(escapeBackSlash(path), 'simples') + '\');');
	}

	if (refreshMetadata) {
		const canRefreshMetadata = !isServer && folder && !/app\.asar\.unpacked/.test(path);
		refreshMetadata.style.display = canRefreshMetadata ? 'block' : 'none';

		if (canRefreshMetadata)
			refreshMetadata.setAttribute('onclick', 'dom.refreshFolderMetadata(\'' + escapeQuotes(escapeBackSlash(path), 'simples') + '\');');
	}

	if (setFormat) {
		const canSetFormat = !isServer && folder && !/app\.asar\.unpacked/.test(path);
		setFormat.style.display = canSetFormat ? 'block' : 'none';

		if (canSetFormat)
			setFormat.setAttribute('onclick', 'dom.setFolderFormatDialog(\'' + escapeQuotes(escapeBackSlash(path), 'simples') + '\');');
	}

	if (viewRelationships) {
		const canViewRelationships = !isServer && folder && !/app\.asar\.unpacked/.test(path);
		viewRelationships.style.display = canViewRelationships ? 'block' : 'none';

		if (canViewRelationships)
			viewRelationships.setAttribute('onclick', 'dom.loadRelationshipExplorerPage(\'' + escapeQuotes(escapeBackSlash(path), 'simples') + '\');');
	}

	let remove = document.querySelector('#index-context-menu .context-menu-remove');

	if (fromIndexNotMasterFolders) {
		remove.style.display = 'block';
		remove.setAttribute('onclick', 'dom.removeComic(\'' + escapeQuotes(escapeBackSlash(path), 'simples') + '\');');
	}
	else {
		remove.style.display = 'none';
	}

	// Move to trash
	let moveToTrash = document.querySelector('#index-context-menu .context-menu-move-to-trash');

	if (canBeDelete) {
		moveToTrash.style.display = 'block';
		moveToTrash.setAttribute('onclick', 'dom.moveToTrash(\'' + escapeQuotes(escapeBackSlash(path), 'simples') + '\', ' + (fromIndexNotMasterFolders ? 'true' : 'false') + ');');
	}
	else {
		moveToTrash.style.display = 'none';
	}

	// Delete permanently
	let deletePermanently = document.querySelector('#index-context-menu .context-menu-delete-permanently');

	if (canBeDelete) {
		deletePermanently.style.display = 'block';
		deletePermanently.setAttribute('onclick', 'dom.deletePermanently(\'' + escapeQuotes(escapeBackSlash(path), 'simples') + '\', ' + (fromIndexNotMasterFolders ? 'true' : 'false') + ');');
	}
	else {
		deletePermanently.style.display = 'none';
	}

	dom.query('#index-context-menu .separator-labels').css({ display: fromIndex ? 'block' : 'none' });

	// Open in new tab
	let openInNewTab = document.querySelector('#index-context-menu .context-menu-open-in-new-tab');
	openInNewTab.setAttribute('onclick', 'tabs.openPath(\'' + escapeQuotes(escapeBackSlash(path), 'simples') + '\', \'' + escapeQuotes(escapeBackSlash(mainPath), 'simples') + '\');');

	// Open in new window
	let openInNewWindow = document.querySelector('#index-context-menu .context-menu-open-in-new-window');
	openInNewWindow.setAttribute('onclick', 'openPathInNewWindow(\'' + escapeQuotes(escapeBackSlash(path), 'simples') + '\', \'' + escapeQuotes(escapeBackSlash(mainPath), 'simples') + '\');');

	// Mark read an unread
	let markRead = document.querySelector('#index-context-menu .context-menu-mark-read');
	let markUnread = document.querySelector('#index-context-menu .context-menu-mark-unread');
	let separatorMark = document.querySelector('#index-context-menu .separator-mark');

	if (fromIndex || folder) {
		const currentIndex = comicContextMenuIndex;

		markRead.style.display = 'block';
		markUnread.style.display = 'block';
		separatorMark.style.display = 'block';

		markRead.classList.add('disable-pointer');
		markUnread.classList.add('disable-pointer');

		(async function () {

			try {
				const type = fileManager.getPathType(path);
				const progress = type.folder ? await reading.progress.getFolderItemProgress(path, true, true) : await reading.progress.get(path, true, true);
				reading.progress.updateProgress(path, progress);

				if (currentIndex !== comicContextMenuIndex)
					return;

				dom.this(markRead).class(progress.completed, 'disable-pointer');
				markRead.setAttribute('onclick', 'reading.progress.read(\'' + escapeQuotes(escapeBackSlash(path), 'simples') + '\');');

				dom.this(markUnread).class((progress.percent === 0), 'disable-pointer');
				markUnread.setAttribute('onclick', 'reading.progress.unread(\'' + escapeQuotes(escapeBackSlash(path), 'simples') + '\');');
			}
			catch (error) {
				console.error(error);
			}

		})()
	}
	else {
		markRead.style.display = 'none';
		markUnread.style.display = 'none';
		separatorMark.style.display = 'none';
	}

	// Favorite
	let favorite = document.querySelector('#index-context-menu .context-menu-favorite');

	if (fromIndex || folder) {
		let favorites = relative.get('favorites');
		let isFavorte = favorites[path] ? true : false;

		favorite.style.display = 'block';
		favorite.setAttribute('onclick', 'dom.labels.setFavorite(\'' + escapeQuotes(escapeBackSlash(path), 'simples') + '\');');

		if (isFavorte)
			favorite.querySelector('i').classList.add('fill');
		else
			favorite.querySelector('i').classList.remove('fill');
	}
	else {
		favorite.style.display = 'none';
	}

	// Labels
	let labels = document.querySelector('#index-context-menu .context-menu-labels');

	if (fromIndex || folder) {
		labels.style.display = 'block';
		labels.setAttribute('onclick', 'dom.labels.setLabels(\'' + escapeQuotes(escapeBackSlash(path), 'simples') + '\');');

		if (dom.labels.has(path))
			labels.querySelector('i').classList.add('fill');
		else
			labels.querySelector('i').classList.remove('fill');
	}
	else {
		labels.style.display = 'none';
	}

	// Hide from Continue reading - only makes sense for a real series folder, the same set
	// buildIndexedBoxCandidates() (dom/boxes.js) ever considers showing there in the first place.
	let hideContinueReading = document.querySelector('#index-context-menu .context-menu-hide-continue-reading');

	if (fromIndex || folder) {
		hideContinueReading.style.display = 'block';
		hideContinueReading.setAttribute('onclick', 'dom.labels.setHideFromContinueReading(\'' + escapeQuotes(escapeBackSlash(path), 'simples') + '\');');

		const isHidden = dom.labels.isHiddenFromContinueReading(path);
		hideContinueReading.querySelector('span').textContent = isHidden ? language.global.contextMenu.showInContinueReading : language.global.contextMenu.hideFromContinueReading;
		hideContinueReading.querySelector('i').textContent = isHidden ? 'visibility' : 'visibility_off';
	}
	else {
		hideContinueReading.style.display = 'none';
	}

	if (isServer) {
		dom.query('#index-context-menu .separator-poster').css({ display: 'none' });

		let openFileLocation = document.querySelector('#index-context-menu .context-menu-open-file-location');
		let addPoster = document.querySelector('#index-context-menu .context-menu-add-poster');
		let deletePoster = document.querySelector('#index-context-menu .context-menu-delete-poster');
		let clearFileCache = document.querySelector('#index-context-menu .context-menu-clear-file-cache');
		let setAsPoster = document.querySelector('#index-context-menu .context-menu-set-as-poster');
		let setAsPosterFolders = document.querySelector('#index-context-menu .context-menu-set-as-poster-folders');

		openFileLocation.style.display = 'none';
		addPoster.style.display = 'none';
		deletePoster.style.display = 'none';
		clearFileCache.style.display = 'none';
		setAsPoster.style.display = 'none';
		setAsPosterFolders.style.display = 'none';
	}
	else {
		dom.query('#index-context-menu .separator-poster').css({ display: 'block' });

		// Open file location
		let openFileLocation = document.querySelector('#index-context-menu .context-menu-open-file-location');
		openFileLocation.setAttribute('onclick', 'electron.shell.showItemInFolder(\'' + escapeQuotes(escapeBackSlash(fileManager.firstCompressedFile(path)), 'simples') + '\');');
		openFileLocation.style.display = 'block';

		// Add poster and delete
		let addPoster = document.querySelector('#index-context-menu .context-menu-add-poster');
		let deletePoster = document.querySelector('#index-context-menu .context-menu-delete-poster');
		addPoster.style.display = 'block';
		deletePoster.style.display = 'block';

		if (folder) {
			addPoster.style.display = 'block';

			let images = [];

			try {
				let file = fileManager.file(path, { subtask: true });
				images = await file.images(2, false, true);
				file.destroy();
			}
			catch { }

			let poster = !Array.isArray(images) ? images : false;

			addPoster.setAttribute('onclick', 'dom.poster.add(' + (fromIndexNotMasterFolders ? 'true' : 'false') + ', \'' + escapeQuotes(escapeBackSlash(path), 'simples') + '\', ' + (poster ? '\'' + escapeQuotes(escapeBackSlash(poster.path), 'simples') + '\'' : 'false') + ');');
			addPoster.querySelector('span').innerHTML = poster ? language.global.contextMenu.changePoster : language.global.contextMenu.addPoster;

			if (poster && !poster.fromFirstImageAsPoster) {
				deletePoster.style.display = 'block';
				deletePoster.setAttribute('onclick', 'dom.poster.delete(\'' + escapeQuotes(escapeBackSlash(poster.path), 'simples') + '\');');
			}
			else {
				deletePoster.style.display = 'none';
			}

			openFileLocation.querySelector('span').innerHTML = language.global.contextMenu.openFolderLocation;
		}
		else {
			addPoster.style.display = 'none';
			deletePoster.style.display = 'none';

			openFileLocation.querySelector('span').innerHTML = language.global.contextMenu.openFileLocation;
		}

		// Set image as poster
		let setAsPoster = document.querySelector('#index-context-menu .context-menu-set-as-poster');
		let setAsPosterFolders = document.querySelector('#index-context-menu .context-menu-set-as-poster-folders');

		if (!folder) {
			setAsPoster.style.display = 'block';
			setAsPosterFolders.style.display = 'block';

			setAsPoster.setAttribute('onclick', 'dom.poster.setAsPoster(\'' + escapeQuotes(escapeBackSlash(path), 'simples') + '\');');
			setAsPosterFolders.setAttribute('onclick', 'dom.poster.setAsPosterFolders(\'' + escapeQuotes(escapeBackSlash(path), 'simples') + '\', \'' + escapeQuotes(escapeBackSlash(mainPath), 'simples') + '\');');
		}
		else {
			setAsPoster.style.display = 'none';
			setAsPosterFolders.style.display = 'none';
		}

		// Clear file cache
		let clearFileCache = document.querySelector('#index-context-menu .context-menu-clear-file-cache');

		clearFileCache.setAttribute('onclick', 'dom.clearFileCache.clear(\'' + escapeQuotes(escapeBackSlash(path), 'simples') + '\');');
		clearFileCache.style.display = folder ? 'block' : 'none';
	}

	// File info
	let fileInfo = document.querySelector('#index-context-menu .context-menu-file-info');

	fileInfo.setAttribute('onclick', 'dom.fileInfo.show(\'' + escapeQuotes(escapeBackSlash(path), 'simples') + '\');');
	fileInfo.style.display = folder ? 'block' : 'none';

	if (/app\.asar\.unpacked/.test(path)) // Is the Pepper & Carrot example comic
	{
		let addPoster = document.querySelector('#index-context-menu .context-menu-add-poster');
		let deletePoster = document.querySelector('#index-context-menu .context-menu-delete-poster');
		let setAsPoster = document.querySelector('#index-context-menu .context-menu-set-as-poster');
		let setAsPosterFolders = document.querySelector('#index-context-menu .context-menu-set-as-poster-folders');
		let moveToTrash = document.querySelector('#index-context-menu .context-menu-move-to-trash');
		let deletePermanently = document.querySelector('#index-context-menu .context-menu-delete-permanently');

		addPoster.style.display = 'none';
		deletePoster.style.display = 'none';
		setAsPoster.style.display = 'none';
		setAsPosterFolders.style.display = 'none';
		moveToTrash.style.display = 'none';
		deletePermanently.style.display = 'none';

		if (!fromIndex) {
			dom.query('#index-context-menu .separator-poster').css({ display: 'none' });
			dom.query('#index-context-menu .separator-remove').css({ display: 'none' });
		}
	}

	if (gamepad)
		events.activeMenu('#index-context-menu', false, 'gamepad');
	else
		events.activeContextMenu('#index-context-menu');
}

function renameDialog(path, save = false) {
	path = relative.path(path);

	if (save) {
		const input = document.querySelector('.dialog .input-rename-name');
		const name = (input ? input.value : '').trim();
		return renamePath(path, name);
	}

	if (!fileManager.simpleExists(path))
		return;

	let currentName = p.basename(path);
	const metadata = storage.getKey('compressedMetadata', path);

	if (metadata && metadata.title)
		currentName = metadata.title;

	try {
		if (!metadata?.title && fs.statSync(path).isFile())
			currentName = p.parse(path).name;
	}
	catch { }

	handlebarsContext.renameName = currentName;
	const renameContent = '<div class="input input-margin-top input-compact"><div><div class="inputBorder"><div class="left"></div><div class="right"></div><div class="top"><div></div><span></span></div><div class="bottom"></div></div><div class="placeholder">' + language.global.title + '</div><input type="text" value="' + escapeQuotes(currentName, 'double') + '" class="input-rename-name"></div></div>';

	events.dialog({
		header: language.buttons.edit,
		width: 420,
		height: false,
		content: renameContent,
		buttons: [
			{
				text: language.buttons.cancel,
				function: 'events.closeDialog();',
			},
			{
				text: language.buttons.save,
				function: 'dom.renameDialog(\'' + escapeQuotes(escapeBackSlash(path), 'simples') + '\', true);',
			}
		],
	});

	events.eventInput();
	events.focus('.dialog .input-rename-name');
}

function reloadMetadataUi() {
	const contentRight = template._contentRight();
	const scrollElement = contentRight?.firstElementChild;
	const keepScroll = scrollElement ? scrollElement.scrollTop : false;

	if (!onReading && (handlebarsContext.page.key === 'index' || handlebarsContext.page.key === 'browsing')) {
		loadIndexPage(false, history.path, true, keepScroll, history.mainPath, false, true);
	}
	else {
		dom.reload(false, false);
	}
}

function getRecommendationFeedback() {
	const feedback = storage.get('recommendationFeedback');

	if (!feedback || typeof feedback !== 'object' || Array.isArray(feedback))
		return {};

	return feedback;
}

const RECOMMENDATION_SUPPRESS_DISLIKES = 200;

function resolveRecommendedComicPathBySha(sha = '') {
	if (!sha)
		return '';

	const boxesList = Array.isArray(handlebarsContext.boxes) ? handlebarsContext.boxes : [];

	for (let b = 0, blen = boxesList.length; b < blen; b++) {
		const box = boxesList[b];
		if (box?.variant !== 'recommended' || !Array.isArray(box.comics))
			continue;

		for (let c = 0, clen = box.comics.length; c < clen; c++) {
			const comic = box.comics[c];
			if (String(comic?.sha || '') === String(sha))
				return comic?.path || '';
		}
	}

	return '';
}

function mountRecommendationFeedbackControls() {
	const contentRight = template._contentRight();
	const recommendedBox = contentRight?.querySelector('.boxes .box.box-recommended');

	if (!recommendedBox)
		return;

	if (recommendedBox.querySelector('.recommendation-feedback'))
		return;

	const feedback = getRecommendationFeedback();
	const items = recommendedBox.querySelectorAll('.content-view-module > div');

	for (let i = 0, len = items.length; i < len; i++) {
		const item = items[i];
		const image = item.querySelector('.item-image');
		if (!image)
			continue;

		const previousControls = item.querySelector('.recommendation-feedback-controls');
		if (previousControls)
			previousControls.remove();

		const className = Array.from(item.classList).find(function (name) {
			return /^sha\-/.test(name);
		}) || '';

		const sha = className.replace(/^sha\-/, '');
		const path = resolveRecommendedComicPathBySha(sha);
		if (!path)
			continue;

		const normalizedPath = relative.path(path);
		const entry = feedback[normalizedPath] || feedback[path] || {};
		const currentRating = Number(entry.lastRating || entry.rating || 0);
		const controls = document.createElement('div');
		controls.className = 'recommendation-feedback-controls' + (currentRating ? ' has-rating' : '');

		const createButton = function (rating, icon, label) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'recommendation-feedback-button recommendation-feedback-' + (rating > 0 ? 'up' : 'down');
			button.setAttribute('title', label);
			button.innerHTML = '<i class="material-icon">' + icon + '</i>';

			if (currentRating === rating)
				button.classList.add('active');

			button.addEventListener('mousedown', function (event) {
				event.stopPropagation();
			});

			button.addEventListener('click', function (event) {
				event.preventDefault();
				event.stopPropagation();
				dom.rateRecommendation(path, rating);
			});

			return button;
		};

		controls.appendChild(createButton(1, 'thumb_up', 'Good recommendation'));
		controls.appendChild(createButton(-1, 'thumb_down', 'Bad recommendation'));
		image.appendChild(controls);
	}
}

function restoreRecommendationFeedbackStates() {
	const contentRight = template._contentRight();
	const recommendedBox = contentRight?.querySelector('.boxes .box.box-recommended');

	if (!recommendedBox)
		return;

	const feedback = getRecommendationFeedback();
	const containers = recommendedBox.querySelectorAll('.recommendation-feedback[data-path]');

	for (let i = 0, len = containers.length; i < len; i++) {
		const container = containers[i];
		const path = container.getAttribute('data-path');
		if (!path)
			continue;

		const normalizedPath = p.normalize(path);
		const entry = feedback[normalizedPath] || feedback[path] || {};
		const lastRating = Number(entry.lastRating || entry.rating || 0);

		if (!lastRating)
			continue;

		const buttons = container.querySelectorAll('.recommendation-feedback-button');

		for (let j = 0, blen = buttons.length; j < blen; j++) {
			const btn = buttons[j];
			const btnRating = Number(btn.getAttribute('data-rating') || 0);

			if (btnRating === lastRating)
				btn.classList.add('fill');
		}
	}
}

function rateRecommendation(path, rating, event = false) {
	if (event) {
		event.preventDefault();
		event.stopPropagation();
	}

	path = relative.path(path);
	if (!path)
		return false;

	rating = rating > 0 ? 1 : -1;

	const feedback = app.copy(getRecommendationFeedback());
	const item = feedback[path] || {};

	let shown = Math.max(0, +(item.shown || 0));
	let liked = Math.max(0, +(item.liked || 0));
	let disliked = Math.max(0, +(item.disliked || 0));

	const legacyRating = Number(item.rating || 0);
	if (legacyRating > 0) {
		shown = Math.max(shown, 1);
		liked = Math.max(liked, 1);
	}
	else if (legacyRating < 0) {
		shown = Math.max(shown, 1);
		disliked = Math.max(disliked, 1);
	}

	if (rating > 0)
		liked++;
	else
		disliked++;

	const reachedSuppressionThreshold = (rating < 0 && (item.disliked || 0) < RECOMMENDATION_SUPPRESS_DISLIKES && disliked >= RECOMMENDATION_SUPPRESS_DISLIKES);

	feedback[path] = {
		shown,
		liked,
		disliked,
		lastRating: rating,
		updatedAt: Date.now(),
	};

	storage.update('recommendationFeedback', feedback);

	const clickedButton = (event && event.currentTarget && event.currentTarget.classList) ? event.currentTarget : null;

	if (clickedButton) {
		const container = clickedButton.closest('.recommendation-feedback');

		if (container) {
			const buttons = container.querySelectorAll('.recommendation-feedback-button');

			for (let i = 0, len = buttons.length; i < len; i++) {
				buttons[i].classList.remove('fill', 'feedback-pressed', 'feedback-pressed-up', 'feedback-pressed-down');
			}
		}

		clickedButton.classList.add('fill', 'feedback-pressed', (rating > 0 ? 'feedback-pressed-up' : 'feedback-pressed-down'));

		setTimeout(function () {
			clickedButton.classList.remove('feedback-pressed', 'feedback-pressed-up', 'feedback-pressed-down');
		}, 460);
	}

	const applyFeedbackButtonState = function () {
		const contentRight = template._contentRight();
		const recommendedBox = contentRight?.querySelector('.boxes .box.box-recommended');

		if (!recommendedBox)
			return;

		const escapeSelectorAttr = function (value) {
			return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
		};

		const escapedPath = escapeSelectorAttr(path);
		const escapedNormalizedPath = escapeSelectorAttr(p.normalize(path));
		const selectors = [
			'.recommendation-feedback[data-path="' + escapedPath + '"]',
			'.recommendation-feedback[data-path="' + escapedNormalizedPath + '"]',
		];

		let container = null;

		for (let i = 0; i < selectors.length; i++) {
			container = recommendedBox.querySelector(selectors[i]);
			if (container)
				break;
		}

		if (!container)
			return;

		const buttons = container.querySelectorAll('.recommendation-feedback-button');

		for (let i = 0, len = buttons.length; i < len; i++) {
			const button = buttons[i];
			const buttonRating = Number(button.getAttribute('data-rating') || 0);

			button.classList.remove('fill', 'feedback-pressed', 'feedback-pressed-up', 'feedback-pressed-down');

			if (buttonRating === rating)
				button.classList.add('fill');
		}

		const active = container.querySelector('.recommendation-feedback-button[data-rating="' + rating + '"]');

		if (active) {
			active.classList.add('feedback-pressed', (rating > 0 ? 'feedback-pressed-up' : 'feedback-pressed-down'));

			setTimeout(function () {
				active.classList.remove('feedback-pressed', 'feedback-pressed-up', 'feedback-pressed-down');
			}, 420);
		}
	};

	applyFeedbackButtonState();

	if (rating < 0) {
		const contentRight = template._contentRight();
		const recommendedBox = contentRight?.querySelector('.boxes .box.box-recommended');

		if (recommendedBox) {
			const normalizedTarget = String(p.normalize(path || '')).toLowerCase();

			const boxesList = Array.isArray(handlebarsContext.boxes) ? handlebarsContext.boxes : [];
			for (let i = 0, len = boxesList.length; i < len; i++) {
				const box = boxesList[i];
				if (box?.variant !== 'recommended' || !Array.isArray(box.comics))
					continue;

				box.comics = box.comics.filter(function (comic) {
					const comicPath = String(p.normalize(comic?.path || '')).toLowerCase();
					return comicPath !== normalizedTarget;
				});
			}

			const removeCard = function () {
				let feedbackContainer = null;

				if (clickedButton)
					feedbackContainer = clickedButton.closest('.recommendation-feedback');

				if (!feedbackContainer) {
					const escaped = String(path || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
					feedbackContainer = recommendedBox.querySelector('.recommendation-feedback[data-path="' + escaped + '"]');
				}

				const card = feedbackContainer?.closest('.content-view-module > div');
				if (!card)
					return;

				card.classList.add('recommendation-removing');

				setTimeout(function () {
					card.remove();

					const remaining = recommendedBox.querySelectorAll('.content-view-module > div').length;
					if (!remaining)
						recommendedBox.remove();
				}, 260);
			};

			setTimeout(removeCard, 120);
		}

		if (reachedSuppressionThreshold) {
			const cardName = clickedButton?.closest('.content-view-module > div')?.getAttribute('data-name') || p.basename(path);
			const safePath = escapeQuotes(escapeBackSlash(path), 'simples');

			events.dialog({
				header: 'Recommendation disabled',
				width: 460,
				height: false,
				content: '"' + String(cardName || '').replace(/"/g, '&quot;') + '" reached ' + RECOMMENDATION_SUPPRESS_DISLIKES + ' dislikes and will no longer be recommended. You can delete it if you no longer want to keep it in your library.',
				buttons: [
					{
						text: language.buttons.close,
						function: 'events.closeDialog();',
					},
					{
						text: 'Delete series',
						function: 'events.closeDialog(); dom.deletePermanently(\'' + safePath + '\', false);',
					}
				],
			});
		}
	}

	return false;
}

function refreshFolderMetadata(path) {
	path = relative.path(path);

	const folderPath = tracking.getFolderMetadataPath(path);
	if (!folderPath)
		return;

	const metadata = tracking.getFolderMetadata(folderPath) || {};
	const fallbackTitle = metadata.title || p.basename(folderPath);

	(async function () {
		try {
			// A folder whose confirmed match is MyAnimeList's (source: 'myanimelist', malId set,
			// no anilistId) used to still be refreshed through the AniList-only path below
			// regardless - which does nothing with a MAL id and falls back to a fresh, generic
			// fuzzy search instead of actually refreshing the existing match (see
			// refetchFolderMetadataFromMyAnimeList()'s own comment for the fuller version of this).
			if (metadata.anilistId > 0)
				await tracking.refetchFolderMetadataFromAniList(folderPath, metadata.anilistId || 0, true, fallbackTitle);
			else if (metadata.malId > 0)
				await tracking.refetchFolderMetadataFromMyAnimeList(folderPath, metadata.malId, true, fallbackTitle);
			else
				await tracking.refetchFolderMetadataFromAniList(folderPath, 0, true, fallbackTitle);

			reloadMetadataUi();
			events.snackbar({
				key: 'metadataRefreshOk',
				text: 'Metadata refreshed',
				duration: 4,
			});
		}
		catch (error) {
			console.error(error);
			events.snackbar({
				key: 'metadataRefreshFail',
				text: 'Metadata refresh failed',
				duration: 5,
			});
		}
	})();
}

// The folder-context-menu "Set format" action - a manual correction for when metadata fetch gets
// a title's manga/manhua/manhwa classification wrong, or a folder AniList/MAL never matched at
// all still needs one to pick a header design and reading mode. Picking one here calls
// tracking.setFolderSeriesType(), which locks metadata.seriesType against being overwritten by a
// future scrape (seriesTypeManual, folder-metadata.js) and forces the matching reading-mode
// default (reading.setTrackedSeriesReadingMode()) even over a reading mode the user had
// separately customised for this folder - see that function's own comment for why.
function setFolderFormatDialog(path) {
	path = relative.path(path);

	const folderPath = tracking.getFolderMetadataPath(path);
	if (!folderPath)
		return;

	const metadata = tracking.getFolderMetadata(folderPath) || {};
	const currentType = metadata.seriesTypeManual ? (metadata.seriesType || '') : '';
	const escapedPath = escapeQuotes(escapeBackSlash(folderPath), 'simples');

	const option = function (value, label, description) {
		const active = currentType === value;

		// Not menu-simple-element here - that class is built for a single-line 40px menu row
		// (fixed height, white-space: nowrap, display: flex as a row), which ran the label and
		// description together onto one clipped line instead of stacking them. This needs its own
		// block-stacked layout instead.
		return '<div class="gamepad-item" style="display:block; border-radius:10px; margin-bottom:8px; padding:12px 14px; cursor:pointer;'
			+ (active ? ' outline: 2px solid currentColor;' : ' outline: 1px solid rgba(128,128,128,0.35);') + '" onclick="dom.setFolderFormat(\'' + escapedPath + '\', \'' + value + '\');">'
			+ '<div class="body-medium" style="display:block; font-weight:600;">' + label + (active ? ' &nbsp;&#10003;' : '') + '</div>'
			+ '<div class="body-small" style="display:block; opacity:0.7; margin-top:4px;">' + description + '</div>'
			+ '</div>';
	};

	const content = ''
		+ '<div class="body-small" style="opacity:0.75; margin-bottom:14px;">Overrides whatever metadata fetch detected for this series, and switches its reading mode to match (paged vs. vertical scroll).</div>'
		+ option('manga', 'Manga', 'Paged, double-page spreads.')
		+ option('manhua', 'Manhua', 'Vertical, continuous scroll.')
		+ option('manhwa', 'Manhwa', 'Vertical, continuous scroll.');

	const buttons = [
		{
			text: language.buttons.cancel,
			function: 'events.closeDialog();',
		},
	];

	if (currentType) {
		buttons.push({
			text: 'Auto-detect',
			function: 'dom.setFolderFormat(\'' + escapedPath + '\', \'\');',
		});
	}

	events.dialog({
		header: 'Set format',
		width: 420,
		height: false,
		content: content,
		buttons: buttons,
	});
}

function setFolderFormat(path, seriesType) {
	path = relative.path(path);

	const folderPath = tracking.getFolderMetadataPath(path);
	if (!folderPath)
		return;

	tracking.setFolderSeriesType(folderPath, seriesType);
	events.closeDialog();
	reloadMetadataUi();

	events.snackbar({
		key: 'seriesFormatSet',
		text: seriesType ? ('Format set to ' + seriesType.charAt(0).toUpperCase() + seriesType.slice(1)) : 'Format set to auto-detect',
		duration: 4,
	});
}

function markFolderMetadataWrongMatch(path) {
	path = relative.path(path);

	const folderPath = tracking.getFolderMetadataPath(path);
	if (!folderPath)
		return;

	events.closeDialog();

	(async function () {
		try {
			await tracking.reportWrongFolderMetadataMatch(folderPath, true);
			reloadMetadataUi();
			events.snackbar({
				key: 'metadataWrongMatch',
				text: 'Marked as wrong match. Searching again...',
				duration: 5,
			});
		}
		catch (error) {
			console.error(error);
			events.snackbar({
				key: 'metadataWrongMatchFail',
				text: 'Could not re-search metadata',
				duration: 5,
			});
		}
	})();
}

function editMetadataDialog(path, save = false, clear = false) {
	path = relative.path(path);

	const folderPath = tracking.getFolderMetadataPath(path);
	const metadataSnapshot = function (metadata = false) {
		if (!metadata || typeof metadata !== 'object')
			return '';

		const genres = Array.isArray(metadata.genres) ? metadata.genres.join('\n') : '';
		const clusters = Array.isArray(metadata?.recommendation?.genreClusters) ? metadata.recommendation.genreClusters.join('\n') : '';

		return [
			metadata.anilistId || 0,
			metadata.title || '',
			metadata.author || '',
			metadata.demographic || '',
			genres,
			metadata.description || '',
			metadata.serializationYear || 0,
			metadata?.recommendation?.readingTimeMinutes || 0,
			clusters,
			metadata.source || '',
			metadata.confidence || 0,
		].join('::');
	};

	if (!folderPath)
		return;

	if (clear) {
		const previousMetadata = tracking.getFolderMetadata(folderPath);

		tracking.clearFolderMetadata(folderPath);
		events.closeDialog();

		if (metadataSnapshot(previousMetadata))
			setTimeout(reloadMetadataUi, 0);

		return;
	}

	if (save) {
		const previousMetadata = tracking.getFolderMetadata(folderPath);
		const input = function (selector) {
			return (document.querySelector(selector)?.value || '').trim();
		};
		const parseList = function (value) {
			return String(value || '').split(/[\n,]/).map(function (part) {
				return part.trim();
			}).filter(Boolean);
		};
		const toInteger = function (value, min = 0, max = Number.MAX_SAFE_INTEGER) {
			let number = Math.floor(Number(value));
			if (!Number.isFinite(number))
				number = min;
			if (number < min)
				number = min;
			if (number > max)
				number = max;
			return number;
		};

		const title = input('.input-metadata-title');
		const author = input('.input-metadata-author');
		const demographic = input('.input-metadata-demographic').toLowerCase();
		const genres = parseList(input('.input-metadata-genres'));
		const description = input('.input-metadata-description');
		const serializationYear = toInteger(input('.input-metadata-serialization-year'), 0, 3000);
		const readingTimeMinutes = toInteger(input('.input-metadata-reading-time'), 0, 1000000);
		const genreClusters = parseList(input('.input-metadata-genre-clusters'));
		const source = input('.input-metadata-source').toLowerCase();
		const anilistId = toInteger(input('.input-metadata-anilist-id'), 0, 1000000000);
		const malId = toInteger(input('.input-metadata-mal-id'), 0, 1000000000);
		const confidence = toInteger(input('.input-metadata-confidence'), 0, 100);

		const savedMetadata = tracking.setFolderMetadata(folderPath, {
			anilistId: anilistId,
			malId: malId,
			title: title,
			author: author,
			demographic: demographic,
			genres: genres,
			description: description,
			serializationYear: serializationYear,
			recommendation: {
				readingTimeMinutes: readingTimeMinutes,
				genreClusters: genreClusters,
			},
			source: source || 'manual',
			confidence: confidence,
		});
		const metadataChanged = metadataSnapshot(previousMetadata) !== metadataSnapshot(savedMetadata);

		events.closeDialog();

		(async function() {
			try
			{
				// Prefer whichever id the user actually filled in - a malId with no anilistId
				// used to still go through the AniList-only refetch below regardless, which does
				// nothing useful with an id from a different site and falls back to a fresh,
				// generic fuzzy search using the folder's own name (see
				// refetchFolderMetadataFromMyAnimeList()'s own comment) - not what "I looked this
				// up on MAL and am telling you which one it is" means.
				if(anilistId > 0)
					await tracking.refetchFolderMetadataFromAniList(folderPath, anilistId, true, title);
				else if(malId > 0)
					await tracking.refetchFolderMetadataFromMyAnimeList(folderPath, malId, true, title);
				else
					await tracking.refetchFolderMetadataFromAniList(folderPath, anilistId, true, title);

				setTimeout(reloadMetadataUi, 0);
			}
			catch(error)
			{
				console.error(error);

				if(metadataChanged)
					setTimeout(reloadMetadataUi, 0);
			}
		})();

		return;
	}

	const metadata = tracking.getFolderMetadata(folderPath) || {};
	const escapeHtml = function (value = '') {
		return String(value || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	};

	const titleLabel = language.global?.title || 'Title';
	const authorLabel = language.dialog?.fileInfo?.data?.author || 'Author';
	const demographicLabel = language.dialog?.fileInfo?.data?.demographic || 'Demographic';
	const genresLabel = language.dialog?.fileInfo?.data?.genre || 'Genres';
	const descriptionLabel = language.settings?.tracking?.description || language.dialog?.fileInfo?.data?.description || 'Description';
	const yearLabel = language.dialog?.fileInfo?.data?.year || language.dialog?.fileInfo?.data?.releaseDate || 'Year';
	const sourceLabel = language.dialog?.fileInfo?.data?.source || 'Source';
	const confidenceLabel = 'Confidence';
	const readingTimeLabel = 'Reading time (minutes)';
	const clustersLabel = 'Genre clusters';
	const anilistIdLabel = 'AniList ID';
	const malIdLabel = 'MyAnimeList ID';
	const sourceValue = String(metadata.source || '').toLowerCase();
	const demographicValue = String(metadata.demographic || '').toLowerCase();

	const sourceOption = function (value, label) {
		const selected = sourceValue === value ? ' selected' : '';
		return '<option value="' + value + '"' + selected + '>' + label + '</option>';
	};
	const demographicOption = function (value, label) {
		const selected = demographicValue === value ? ' selected' : '';
		return '<option value="' + value + '"' + selected + '>' + label + '</option>';
	};

	const content = ''
		+ '<div class="body-medium" style="max-height: 68vh; overflow: auto; padding-right: 10px;">'
		+ '<div class="input input-margin-top input-compact"><div><div class="inputBorder"><div class="left"></div><div class="right"></div><div class="top"><div></div><span></span></div><div class="bottom"></div></div><div class="placeholder">' + anilistIdLabel + '</div><input type="number" min="0" value="' + escapeQuotes(String(metadata.anilistId || ''), 'double') + '" class="input-metadata-anilist-id"></div></div>'
		+ '<div class="input input-margin-top input-compact"><div><div class="inputBorder"><div class="left"></div><div class="right"></div><div class="top"><div></div><span></span></div><div class="bottom"></div></div><div class="placeholder">' + malIdLabel + '</div><input type="number" min="0" value="' + escapeQuotes(String(metadata.malId || ''), 'double') + '" class="input-metadata-mal-id"></div></div>'
		+ '<div class="input input-margin-top input-compact"><div><div class="inputBorder"><div class="left"></div><div class="right"></div><div class="top"><div></div><span></span></div><div class="bottom"></div></div><div class="placeholder">' + titleLabel + '</div><input type="text" value="' + escapeQuotes(metadata.title || p.basename(folderPath), 'double') + '" class="input-metadata-title"></div></div>'
		+ '<div class="input input-margin-top input-compact"><div><div class="inputBorder"><div class="left"></div><div class="right"></div><div class="top"><div></div><span></span></div><div class="bottom"></div></div><div class="placeholder">' + authorLabel + '</div><input type="text" value="' + escapeQuotes(metadata.author || '', 'double') + '" class="input-metadata-author"></div></div>'
		+ '<div style="margin-top: 14px;"><div class="body-small" style="margin-bottom: 6px; opacity: 0.8;">' + demographicLabel + '</div><select class="input-metadata-demographic" style="width: 100%; padding: 10px; border-radius: 8px;">'
		+ demographicOption('', '-')
		+ demographicOption('shonen', 'Shonen')
		+ demographicOption('seinen', 'Seinen')
		+ demographicOption('shojo', 'Shojo')
		+ demographicOption('josei', 'Josei')
		+ demographicOption('kodomomuke', 'Kodomomuke')
		+ '</select></div>'
		+ '<div class="input input-margin-top input-compact"><div><div class="inputBorder"><div class="left"></div><div class="right"></div><div class="top"><div></div><span></span></div><div class="bottom"></div></div><div class="placeholder">' + genresLabel + ' (comma separated)</div><input type="text" value="' + escapeQuotes((Array.isArray(metadata.genres) ? metadata.genres.join(', ') : ''), 'double') + '" class="input-metadata-genres"></div></div>'
		+ '<div class="input input-margin-top input-compact"><div><div class="inputBorder"><div class="left"></div><div class="right"></div><div class="top"><div></div><span></span></div><div class="bottom"></div></div><div class="placeholder">' + yearLabel + '</div><input type="number" min="0" max="3000" value="' + escapeQuotes(String(metadata.serializationYear || ''), 'double') + '" class="input-metadata-serialization-year"></div></div>'
		+ '<div style="margin-top: 14px;"><div class="body-small" style="margin-bottom: 6px; opacity: 0.8;">' + descriptionLabel + '</div><textarea class="input-metadata-description" style="width: 100%; min-height: 120px; padding: 10px; border-radius: 8px; resize: vertical;">' + escapeHtml(metadata.description || '') + '</textarea></div>'
		+ '<div class="input input-margin-top input-compact"><div><div class="inputBorder"><div class="left"></div><div class="right"></div><div class="top"><div></div><span></span></div><div class="bottom"></div></div><div class="placeholder">' + readingTimeLabel + '</div><input type="number" min="0" value="' + escapeQuotes(String(metadata?.recommendation?.readingTimeMinutes || ''), 'double') + '" class="input-metadata-reading-time"></div></div>'
		+ '<div class="input input-margin-top input-compact"><div><div class="inputBorder"><div class="left"></div><div class="right"></div><div class="top"><div></div><span></span></div><div class="bottom"></div></div><div class="placeholder">' + clustersLabel + ' (comma separated)</div><input type="text" value="' + escapeQuotes((Array.isArray(metadata?.recommendation?.genreClusters) ? metadata.recommendation.genreClusters.join(', ') : ''), 'double') + '" class="input-metadata-genre-clusters"></div></div>'
		+ '<div style="margin-top: 14px;"><div class="body-small" style="margin-bottom: 6px; opacity: 0.8;">' + sourceLabel + '</div><select class="input-metadata-source" style="width: 100%; padding: 10px; border-radius: 8px;">'
		+ sourceOption('', '-')
		+ sourceOption('anilist', 'AniList')
		+ sourceOption('myanimelist', 'MyAnimeList')
		+ sourceOption('manual', 'Manual')
		+ sourceOption('import', 'Import')
		+ '</select></div>'
		+ '<div class="input input-margin-top input-compact"><div><div class="inputBorder"><div class="left"></div><div class="right"></div><div class="top"><div></div><span></span></div><div class="bottom"></div></div><div class="placeholder">' + confidenceLabel + ' (0-100)</div><input type="number" min="0" max="100" value="' + escapeQuotes(String(metadata.confidence || ''), 'double') + '" class="input-metadata-confidence"></div></div>'
		+ '</div>';

	const escapedPath = escapeQuotes(escapeBackSlash(folderPath), 'simples');
	const buttons = [
		{
			text: language.buttons.cancel,
			function: 'events.closeDialog();',
		},
	];

	if (metadata.anilistId || metadata.malId) {
		buttons.push({
			text: 'Wrong match',
			function: 'dom.markFolderMetadataWrongMatch(\'' + escapedPath + '\');',
		});
	}

	buttons.push(
		{
			text: language.buttons.remove || language.global?.contextMenu?.remove || 'Remove',
			function: 'dom.editMetadataDialog(\'' + escapedPath + '\', false, true);',
		},
		{
			text: language.buttons.save,
			function: 'dom.editMetadataDialog(\'' + escapedPath + '\', true);',
		}
	);

	events.dialog({
		header: (language.buttons?.edit || 'Edit') + ' metadata',
		width: 560,
		height: false,
		content: content,
		buttons: buttons,
	});

	events.eventInput();
	events.focus('.dialog .input-metadata-title');
}

function renamePath(path, name = '') {
	path = relative.path(path);

	if (!name) {
		events.snackbar({
			key: 'renameEmpty',
			text: language.global.valueCannotBeEmpty,
			duration: 5,
			buttons: [{ text: language.buttons.dismiss, function: 'events.closeSnackbar();' }],
		});
		return;
	}

	const compressedMetadata = storage.get('compressedMetadata') || {};
	const metadata = compressedMetadata[path] || {};

	metadata.title = name;
	compressedMetadata[path] = metadata;
	storage.set('compressedMetadata', compressedMetadata);

	let comics = storage.get('comics');
	comics = comics.map(comic => (comic.path === path ? { ...comic, name: name } : comic));
	storage.set('comics', comics);

	events.closeDialog();
	dom.loadIndexPage(true);
}

// Remove the comic from OpenComic
function removeComic(path, confirm = false, reload = true) {
	path = relative.path(path);

	if (typeof storage.isPepperCarrotPath === 'function' && storage.isPepperCarrotPath(path)) {
		storage.updateVar('config', 'pepperCarrotDeleted', true);
	}

	var _comics = [], comics = storage.get('comics');

	for (let i in comics) {
		if (comics[i].path != path)
			_comics.push(comics[i]);
	}

	storage.update('comics', _comics);

	if (reload) dom.reload();
}

async function moveToTrash(path, fromIndexNotMasterFolders = false, confirm = false) {
	await dom.poster.findAndDelete(path, true, true);
	await electron.ipcRenderer.invoke('move-to-trash', path);

	if (fromIndexNotMasterFolders)
		dom.removeComic(path, true, false);

	dom.reload();
}

async function deletePermanently(path, fromIndexNotMasterFolders = false, confirm = false) {
	if (confirm) {
		await dom.poster.findAndDelete(path, false, true);

		fs.rmSync(path, { recursive: true });

		if (fromIndexNotMasterFolders)
			dom.removeComic(path, true, false);

		dom.reload();
	}
	else {
		events.dialog({
			header: language.global.contextMenu.deletePermanently,
			width: 400,
			height: false,
			content: language.global.contextMenu.deletePermanentlyConfirm,
			buttons: [
				{
					text: language.buttons.cancel,
					function: 'events.closeDialog();',
				},
				{
					text: language.global.contextMenu.deletePermanently,
					function: 'events.closeDialog(); dom.deletePermanently(\'' + escapeQuotes(escapeBackSlash(path), 'simples') + '\', ' + (fromIndexNotMasterFolders ? 'true' : 'false') + ', true);',
				}
			],
		});
	}
}


var readingActive = false, skipNextComic = false, skipPreviousComic = false;
const NEXT_CHAPTER_PRELOAD_DELAY = 1200;
const NEXT_CHAPTER_PRELOAD_CACHE_LIMIT = 64;
var nextChapterPreloadToken = 0, nextChapterPreloadST = false;
var preloadedNextChapterPaths = new Map();

function clearNextChapterPreload(invalidateToken = true) {
	if (nextChapterPreloadST) {
		clearTimeout(nextChapterPreloadST);
		nextChapterPreloadST = false;
	}

	if (invalidateToken)
		nextChapterPreloadToken++;
}

function normalizeChapterPath(path = '') {
	return (typeof path === 'string' && path) ? p.normalize(path) : '';
}

function hasPreloadedNextChapter(path = '') {
	const normalizedPath = normalizeChapterPath(path);

	if (!normalizedPath)
		return false;

	return preloadedNextChapterPaths.has(normalizedPath);
}

function rememberPreloadedNextChapter(path = '') {
	const normalizedPath = normalizeChapterPath(path);

	if (!normalizedPath)
		return;

	preloadedNextChapterPaths.set(normalizedPath, Date.now());

	while (preloadedNextChapterPaths.size > NEXT_CHAPTER_PRELOAD_CACHE_LIMIT) {
		const oldestPath = preloadedNextChapterPaths.keys().next().value;

		if (!oldestPath)
			break;

		preloadedNextChapterPaths.delete(oldestPath);
	}
}

function getNextChapterPreloadCount() {
	if (reading && typeof reading.readingViewIs === 'function' && reading.readingViewIs('scroll'))
		return 1;

	return 2;
}

async function preloadNextChapterFirstPages(nextChapterPath = '', token = 0) {
	const normalizedPath = normalizeChapterPath(nextChapterPath);

	if (!normalizedPath || token !== nextChapterPreloadToken || hasPreloadedNextChapter(normalizedPath))
		return false;

	const preloadFile = fileManager.file(normalizedPath, {
		cacheServer: true,
		subtask: true,
		fromThumbnailsGeneration: true,
		log: false,
		sort: { extraKey: 'Reading' },
	});

	try {
		const preloadCount = getNextChapterPreloadCount();
		let preloadTargets = await preloadFile.images(preloadCount);

		if (token !== nextChapterPreloadToken)
			return false;

		if (!preloadTargets)
			return false;

		if (!Array.isArray(preloadTargets))
			preloadTargets = [preloadTargets];

		if (!preloadTargets.length)
			return false;

		await preloadFile.makeAvailable(preloadTargets, false, false, true);

		if (token !== nextChapterPreloadToken)
			return false;

		rememberPreloadedNextChapter(normalizedPath);

		return true;
	}
	catch (error) {
		return false;
	}
	finally {
		preloadFile.destroy();
	}
}

function scheduleNextChapterPreload(currentPath = '', currentMainPath = '', nextChapterPath = '', isCanvas = false, isEbook = false) {
	clearNextChapterPreload(false);

	const normalizedCurrentPath = normalizeChapterPath(currentPath);
	const normalizedMainPath = normalizeChapterPath(currentMainPath);
	const normalizedNextPath = normalizeChapterPath(nextChapterPath);

	if (!normalizedCurrentPath || !normalizedMainPath || !normalizedNextPath || isCanvas || isEbook)
		return;

	if (fileManager.isServer(normalizedNextPath) || hasPreloadedNextChapter(normalizedNextPath))
		return;

	const token = ++nextChapterPreloadToken;

	nextChapterPreloadST = setTimeout(async function () {

		nextChapterPreloadST = false;

		if (token !== nextChapterPreloadToken || !onReading || !readingActive)
			return;

		if (normalizeChapterPath(history.path) !== normalizedCurrentPath || normalizeChapterPath(history.mainPath) !== normalizedMainPath)
			return;

		const currentHandoffTarget = normalizeChapterPath((reading && typeof reading.manga === 'function' && reading.manga()) ? skipPreviousComic : skipNextComic);

		if (currentHandoffTarget !== normalizedNextPath)
			return;

		await preloadNextChapterFirstPages(normalizedNextPath, token);

	}, NEXT_CHAPTER_PRELOAD_DELAY);
}

async function openComic(animation = true, path = true, mainPath = true, end = false, fromGoBack = false, fromNextAndPrev = false) {
	clearNextChapterPreload();

	settings.purgeTemporaryFilesEveryTimes(10);
	fileManager.revokeAllObjectURL();
	reading.render.revokeAllObjectURL();
	workers.clean('convertImage');

	dom.setCurrentPageVars('reading');

	// Start reading comic
	if (config.readingStartReadingInFullScreen && !fromNextAndPrev && !fromGoBack) {
		if (!isFullScreen)
			fullScreen(true);
	}

	reading.setIsLoaded(false);
	onReading = _onReading = true;

	setCurrentPathScrollTop(path);

	let now = Date.now();
	const originalPath = path;

	if (typeof mainPath !== 'string' || !mainPath)
		mainPath = path;

	if (!fileManager.isServer(originalPath)) {
		try {
			if (fs.existsSync(originalPath) && !fs.statSync(originalPath).isDirectory()) {
				const originalRoot = p.parse(originalPath).root;

				if (mainPath === originalPath || mainPath === originalRoot)
					mainPath = p.dirname(originalPath);
			}
		}
		catch (error) { }
	}

	if (!fileManager.isServer(mainPath)) {
		try {
			if (fs.existsSync(mainPath) && !fs.statSync(mainPath).isDirectory())
				mainPath = p.dirname(mainPath);
		}
		catch (error) { }
	}

	let startImage = false;
	let imagePath = path;
	let indexStart = 1;

	if (compatible.image(path)) {
		startImage = path;
		path = p.dirname(path);
	}

	if (typeof mainPath !== 'string' || !mainPath)
		mainPath = path;

	// Show loadign page
	headerPath(path, mainPath, true);

	// Load files
	let file = fileManager.file(path);
	let files = [];

	try {
		// No forceFullRead here anymore: thumbnail reads no longer persist their synthetic
		// single-page result (file-manager.js only writes the cache when
		// !fromThumbnailsGeneration), and readCompressed() still detects and discards legacy
		// poisoned PDF caches. Deleting the index and re-listing the archive on every single
		// chapter change made next/prev navigation re-read the whole file every time.
		files = await file.read({ filtered: false, sort: { extraKey: 'Reading' } });
	}
	catch (error) {
		console.error(error);
		dom.compressedError(error);

		return;
	}

	let hasMusic = await reading.music.has(files, path);
	handlebarsContext.hasMusic = hasMusic;

	files = fileManager.filtered(files);

	handlebarsContext.comics = [];

	if (!template._contentRight().querySelector('.loading')) {
		handlebarsContext.loading = true;
		template.loadContentRight('reading.content.right.html', animation);
		file.updateContentRightIndex();
	}

	handlebarsContext.barBack = 'active';
	template.loadHeader('reading.header.html', animation);
	template.loadContentLeft('reading.content.left.html', animation);
	tabs.update();

	let isCanvas = false;
	let isEbook = false;
	let compressedFile = fileManager.lastCompressedFile(path);

	if (hasMusic) files.push(...hasMusic); // Only to make available

	if (compressedFile) {
		let features = fileManager.fileCompressed(compressedFile);
		features = features.getFeatures();

		if (features.canvas) {
			await file.makeAvailable([{ path: compressedFile }]);
			isCanvas = true;
		}
		else if (features.ebook) {
			await file.makeAvailable([{ path: compressedFile }]);
			isEbook = true;
			// files = [];
		}
		else {
			await file.makeAvailable(files);
		}
	}
	else if (fileManager.isServer(path)) {
		await file.makeAvailable(files, false, true);
	}

	if (hasMusic) // Remove now
		files.splice(-hasMusic.length);

	file.destroy();

	skipNextComic = await nextComic(path, mainPath);
	skipPreviousComic = await previousComic(path, mainPath);

	// The user has gone back before finishing loading
	if (!onReading)
		return;

	if (!fromGoBack)
		indexPathControl(imagePath, mainPath, true, fromNextAndPrev);

	readingActive = true;

	cache.cleanQueue();
	cache.stopQueue();
	threads.stop('folderThumbnails');
	threads.clean('folderThumbnails');

	let comics = [];

	if (files) {
		let len = files.length;
		let images = [];

		for (let i = 0; i < len; i++) {
			let file = files[i];

			if (!file.folder && !file.compressed)
				images.push(file);
		}

		for (let i = 0; i < len; i++) {
			let file = files[i];

			if (file.folder || file.compressed) {
				let fileImage = fileManager.file(file.path, { fromThumbnailsGeneration: true, subtask: true, log: false, sort: { extraKey: 'Reading' } });
				let images = await fileImage.images(1);
				if (images) images = [images]; else images = [];
				fileImage.destroy();

				if (images.length > 0) {
					comics.push({
						name: file.name,
						path: file.path,
						mainPath: mainPath,
						fristImage: images[0].path,
						images: images,
						folder: true,
					});
				}
			}
			else {
				comics.push({
					sha: file.sha,
					name: file.name.replace(/\.[^\.]*$/, ''),
					image: fileManager.realPath(file.path),
					path: file.path,
					mainPath: mainPath,
					size: file.size || false,
					canvas: isCanvas,
					ebook: isEbook,
					folder: false,
				});
			}
		}
	}

	for (let i = 0, len = comics.length; i < len; i++) {
		comics[i].index = i + 1;

		if (comics[i].path == imagePath)
			indexStart = comics[i].index;
	}

	if (isEbook)
		comics = [];

	handlebarsContext.comics = comics;
	handlebarsContext.previousComic = skipPreviousComic;
	handlebarsContext.nextComic = skipNextComic;
	reading.setCurrentComics(comics);

	handlebarsContext.loading = true;

	if (Date.now() - now < 200) {
		if (template._contentRight().querySelector('.loading') && !template._contentRight().querySelector('.reading-body')) {
			handlebarsContext.loading = false;
			template._contentRight().firstElementChild.insertAdjacentHTML('beforeend', template.load('reading.content.right.html'));
		}
		else {
			template._contentRight().firstElementChild.innerHTML = template.load('reading.content.right.html');
		}

		template._contentLeft().firstElementChild.innerHTML = template.load('reading.content.left.html');
	}
	else {
		template.loadContentLeft('reading.content.left.html', animation);
		template.loadContentRight('reading.content.right.html', animation);
	}

	template._contentLeft().firstElementChild.style.height = 'calc(100% - 66px)';

	if (template.globalElement('.reading-elements-menus').length == 0) template.loadGlobalElement('reading.elements.menus.html', 'menus');

	floatingActionButton(false);

	events.events();

	reading.onLoad(function () {

		cache.resumeQueue();
		reading.discord.update();

		const handoffTarget = (reading && typeof reading.manga === 'function' && reading.manga()) ? skipPreviousComic : skipNextComic;
		scheduleNextChapterPreload(path, mainPath, handoffTarget, isCanvas, isEbook);

	});

	reading.read(path, indexStart, end, isCanvas, isEbook, imagePath);
	reading.hideContent(isFullScreen, true);
	reading.music.read(hasMusic, files);

	generateAppMenu();

	shortcuts.register('reading');
	gamepad.updateBrowsableItems('reading-' + sha1(path));
	tabs.update();
}

// Gamepad events
gamepad.setButtonEvent('reading', 1, function (key, button) {

	if (key == 1 && (!onReading || document.querySelector('.menu-simple.a')))
		gamepad.goBack();

});

module.exports = {
	loadIndexPage: loadIndexPage,
	loadIndexContentLeft: loadIndexContentLeft,
	loadIndexHeader: loadIndexHeader,
	indexHeader: indexHeader,
	headerPath: headerPath,
	setIndexLabel: setIndexLabel,
	setPrevIndexLabel: setPrevIndexLabel,
	prevIndexLabel: function () { return prevIndexLabel },
	reloadIndex: reloadIndex,
	reload: reload,
	loadRecentlyOpened: loadRecentlyOpened,
	loadLanguagePage: loadLanguagePage,
	loadSettingsPage: loadSettingsPage,
	loadThemePage: loadThemePage,
	loadWeatherPage: loadWeatherPage,
	loadConstellationPage: loadConstellationPage,
	loadRelationshipExplorerPage: loadRelationshipExplorerPage,
	changeLanguage: changeLanguage,
	selectMenuItem: selectMenuItem,
	floatingActionButton: floatingActionButton,
	setCurrentPageVars: setCurrentPageVars,
	changeView: changeView,
	changeViewModuleSize: changeViewModuleSize,
	coverflow: coverflow,
	changeSort: changeSort,
	changeBoxes: changeConfig,
	changeConfig: changeConfig,
	indexPathControl: indexPathControl,
	goStartPath: goStartPath,
	filterByGenre: filterByGenre,
	selectElement: selectElement,
	openComic: openComic,
	nextComic: function () { return skipNextComic },
	previousComic: function () { return skipPreviousComic },
	goNextComic: goNextComic,
	goPrevComic: goPrevComic,
	pickAtRandom: pickAtRandom,
	orderBy: orderBy,
	nightMode: nightMode,
	nightModeConfig: nightModeConfig,
	addComicButtons: addComicButtons,
	comicContextMenu: comicContextMenu,
	renameDialog: renameDialog,
	editMetadataDialog: editMetadataDialog,
	rateRecommendation: rateRecommendation,
	refreshFolderMetadata: refreshFolderMetadata,
	setFolderFormatDialog: setFolderFormatDialog,
	setFolderFormat: setFolderFormat,
	markFolderMetadataWrongMatch: markFolderMetadataWrongMatch,
	renamePath: renamePath,
	removeComic: removeComic,
	moveToTrash: moveToTrash,
	deletePermanently: deletePermanently,
	compressedError: compressedError,
	addImageToDom: addImageToDom,
	addProgressToDom: addProgressToDom,
	addSepToEnd: addSepToEnd,
	currentPathScrollTop: function () { return currentPathScrollTop },
	currentPath: function () { return currentPath },
	getFolderThumbnails: getFolderThumbnails,
	_getFolderThumbnails: _getFolderThumbnails,
	_selectFolderThumbnailSource: selectFolderThumbnailSource,
	translatePageName: translatePageName,
	metadataPathName: metadataPathName,
	setWindowTitle: setWindowTitle,
	fromLibrary: fromLibrary,
	continueReadingError: continueReadingError,
	calculateVisibleItems: calculateVisibleItems,
	poster: domPoster,
	search: search,
	labels: labels,
	fileInfo: fileInfo,
	clearFileCache: clearFileCache,
	boxes: boxes,
	header: header,
	history: history,
	scroll: scroll,
	this: domManager.this,
	query: domManager.query,
	queryAll: domManager.queryAll,
};
