var saveIsActive = false;

// Which of the (up to three) folders a single read writes an entry for `role` identifies:
// 'mainPath' for dom.history.mainPath itself, 'chapter' for the read file's immediate parent,
// 'series' for that parent's own parent. This is what lets dom/boxes.js's Continue reading
// tell a real series apart from a chapter subfolder below it or a category folder above it
// without having to compare timestamps: role is fixed at the moment each entry is written and
// stays true forever, whereas the *entries themselves* keep getting overwritten independently
// as more is read (a chapter's own path is unique to it and never touched again once you move
// on, while mainPath/the series folder get overwritten by every subsequent read anywhere in
// the same series) - comparing which entries currently share a timestamp does not survive
// that, since a chapter read weeks ago and never revisited ends up the sole survivor of what
// was once a matching group, indistinguishable from a genuine standalone series by anything
// other than this tag.
function save(path = false, mainPath = false, role = 'mainPath') {
	if (!onReading || !reading.isLoaded())
		return;

	reading.hideMouseInFullscreen();

	if (!saveIsActive)
		return;

	if (!path) {
		const image = reading.getImage(reading.currentPage());

		if (!image || !image.path)
			return;

		path = p.normalize(image.path);
	}

	const dirname = p.dirname(path);

	if (mainPath === false) {
		mainPath = dom.history.mainPath;

		// Save also the current folder progress. For a compressed chapter (Series/Chapter016.cbz)
		// `dirname` is the archive's own path - the chapter, not the series - since a page inside
		// one is addressed as a real joined path (.../Chapter016.cbz/page001.jpg per file-manager.js),
		// so p.dirname() of it lands on the archive itself. For a chapter subfolder of loose pages
		// it is that subfolder directly. Either way this is the chapter level, tagged as such.
		if (mainPath !== dirname)
			save(path, dirname, 'chapter');

		// Also save progress one level above that. For a flat "series/chapter.cbz" library this
		// is mainPath itself (a no-op, already covered by the base save below) - but for a library
		// organised into another level above the series (a category folder containing series
		// folders that are themselves split into chapters), mainPath is stuck at the category,
		// `dirname` is the chapter, and this is the series folder in between - the one
		// dom/boxes.js's Continue reading actually wants, tagged 'series' so it can tell this
		// apart from the chapter above without needing to know the real folder structure.
		const parentOfDirname = p.dirname(dirname);
		if (mainPath !== parentOfDirname && dirname !== parentOfDirname)
			save(path, parentOfDirname, 'series');
	}

	const hasChildFolders = Object.values(reading.currentComics()).find((comic) => comic.folder);
	const isParent = mainPath !== dirname || hasChildFolders ? true : false;

	// Calculate progress of eBook
	let progress = 0;
	let chapterIndex = 0;
	let chapterProgress = 0;

	if (reading.isEbook()) {
		const page = reading._ebook?.pages?.[reading.currentPageIndex()];

		if (page) {
			progress = page.progress || 0;
			chapterIndex = page.chapterIndex || 0;
			chapterProgress = page.chapterProgress || 0;
		}
	}

	// Calculate general progress in pages
	let currentPage = reading.currentPage();
	const totalPages = reading.totalPages();

	if (reading.doublePage.active() && totalPages - currentPage === 1)
		currentPage++;

	const percent = (totalPages === 1) ? 0 : (((currentPage - 1) / (totalPages - 1)) * 100);

	const _progressData = {
		index: currentPage,
		path: relative.path(path.replace(/\?page=[0-9]+$/, '')),
		lastReading: Date.now(),
		role: role,
		ebook: reading.isEbook(),
		progress: progress,
		chapterIndex: chapterIndex,
		chapterProgress: chapterProgress,
		// Visible progress
		page: !isParent ? currentPage : 0, // Calculate from childrens if is parent
		pages: !isParent ? totalPages : 0, // Calculate from childrens if is parent
		percent: !isParent ? percent : 0, // Calculate from childrens if is parent
		completed: !isParent ? (currentPage >= totalPages) : false, // Calculate from childrens if is parent
	};

	storage.updateVar('readingProgress', relative.path(mainPath), _progressData);

	dom.history.updateLastComic(path);

	return true;
}

var interval = false;

function _setInterval() {
	clearTimeout(interval);
	interval = setInterval(save, 60 * 2 * 1000); // Save every 2 minutes
}

async function get(path, cache = true, cacheOnly = false) {
	const _readPages = await readPages(path);
	const totalPages = await countPages(path, cache, cacheOnly);

	let percent = (totalPages === 1) ? 0 : ((((_readPages || 1) - 1) / (totalPages - 1)) * 100);
	if (percent > 100) percent = 100;

	return {
		read: _readPages,
		total: totalPages,
		percent: percent,
		percentRound: Math.round(percent),
		completed: (_readPages >= totalPages),
	};
}

async function simpleGet(path, cache = true, cacheOnly = false) {
	const _someRead = await someRead(path);

	return {
		completed: !_someRead ? false : await getCompleted(path),
		someRead: _someRead,
	};
}

async function getFolderItemProgress(path, cache = true, cacheOnly = true) {
	if (!path) {
		return {
			read: 0,
			total: 0,
			percent: 0,
			percentRound: 0,
			completed: false,
		};
	}

	const readingProgress = relative.get('readingProgress');
	const file = fileManager.file(path);
	file.updateConfig({ cacheOnly: cacheOnly, sort: false });

	let files = [];

	try {
		files = await file.read({}, path);
	}
	finally {
		file.destroy();
	}

	let total = 0;
	let read = 0;

	const isCompleted = function(item) {
		if (!item) return false;
		if (item.completed) return true;
		if (item.pages && item.page >= item.pages) return true;
		return false;
	};

	for (const _file of files) {
		total++;

		if (_file.folder || _file.compressed) {
			const progress = readingProgress[_file.path];

			if (isCompleted(progress) && fileManager.simpleExists(_file.path, true)) {
				read++;
				continue;
			}

			// Fallback for nested structures without direct folder progress:
			// consider completed only if all tracked descendants are completed.
			const regex = new RegExp('^\\s*' + pregQuote(_file.path) + '(?:[\\\\/]|$)');
			let hasTrackedChildren = false;
			let hasIncomplete = false;

			for (const key in readingProgress) {
				if (!regex.test(key))
					continue;

				const item = readingProgress[key];

				if (item && item.pages && fileManager.simpleExists(key, true)) {
					hasTrackedChildren = true;

					if (!isCompleted(item)) {
						hasIncomplete = true;
						break;
					}
				}
			}

			if (hasTrackedChildren && !hasIncomplete)
				read++;
		}
		else {
			const item = readingProgress[_file.path];

			if (isCompleted(item) && fileManager.simpleExists(_file.path, true))
				read++;
		}
	}

	let percent = (total === 0) ? 0 : ((read / total) * 100);
	if (percent > 100) percent = 100;

	return {
		read: read,
		total: total,
		percent: percent,
		percentRound: Math.round(percent),
		completed: (total > 0 && read >= total),
	};
}

async function someRead(path) {
	const readingProgress = relative.get('readingProgress');
	const paths = await findReadingProgressPaths(path, false);

	for (const key of paths) {
		const progress = readingProgress[key];

		if (progress && progress.page && fileManager.simpleExists(key, true))
			return true;
	}

	return false;
}

async function readPages(path) {
	const readingProgress = relative.get('readingProgress');
	const paths = await findReadingProgressPaths(path, false);

	let pages = 0;

	for (const key of paths) {
		const progress = readingProgress[key];

		if (progress && progress.page && fileManager.simpleExists(key, true))
			pages += progress.page;
	}

	return pages;
}

var readingPages = false;

async function _countPages(path, file, first = false, cache = true, cacheOnly = false) {
	const readingProgress = relative.get('readingProgress');
	const progress = readingProgress[path];
	if (progress && progress.pages) return progress.pages;

	if (readingPages === false)
		readingPages = storage.get('readingPages') || {};

	const time = app.time();
	const pages = readingPages[path]?.pages;

	// Always use cached page count if available (avoids opening PDFs just for counting)
	if (pages !== undefined && cache) {
		readingPages[path].lastAccess = time;
		return pages;
	}

	// In cacheOnly mode (folder browsing), don't open files just for counting
	if (cacheOnly) {
		const regex = new RegExp('^\\s*' + pregQuote(path) + '(?:[\\\\/]|$)');
		let cachedCount = 0;
		let foundInReadingProgress = false;

		for (let key in readingProgress) {
			if (!regex.test(key))
				continue;

			const item = readingProgress[key];

			if (item && item.pages && fileManager.simpleExists(key, true)) {
				cachedCount += item.pages;
				foundInReadingProgress = true;
			}
		}

		if (foundInReadingProgress && cachedCount > 0)
			return cachedCount;

		cachedCount = 0;

		for (let key in readingPages) {
			if (!regex.test(key))
				continue;

			const item = readingPages[key];

			if (item && item.pages)
				cachedCount += item.pages;
		}

		if (cachedCount > 0)
			return cachedCount;

		return 1;
	}

	const files = await file.read({}, path);

	let count = 0;
	let images = 0;
	let hasChildFolders = false;

	for (let i = 0, len = files.length; i < len; i++) {
		const _file = files[i];

		if (_file.folder || _file.compressed) {
			count += await _countPages(_file.path, file, false, cache, cacheOnly);
			hasChildFolders = true;
		}
		else// if(compatible.image(_file.path))
		{
			images++;
		}
	}

	if (!hasChildFolders)
		count += images;

	readingPages[path] = {
		pages: count,
		lastAccess: time
	};

	storage.setThrottle('readingPages', readingPages);

	return count;
}

async function countPages(path = false, cache = true, cacheOnly = false) {
	if (!path) return 0;

	const file = fileManager.file(path);
	file.updateConfig({ cacheOnly: cacheOnly, sort: false });
	const pages = await _countPages(path, file, true, cache, cacheOnly);
	file.destroy();

	return pages;
}

async function _getCompleted(path, file, first = false) {
	const readingProgress = relative.get('readingProgress');
	const progress = readingProgress[path];

	const isCompleted = function(item) {
		if (!item) return false;
		if (item.completed) return true;
		if (item.pages && item.page >= item.pages) return true;
		return false;
	};

	if (isCompleted(progress))
		return true;

	const regex = new RegExp('^\\s*' + pregQuote(path) + '(?:[\\\\/]|$)');
	let hasTrackedChildren = false;

	for (const key in readingProgress) {
		if (key === path || !regex.test(key))
			continue;

		const item = readingProgress[key];

		if (item && item.pages && fileManager.simpleExists(key, true)) {
			hasTrackedChildren = true;

			if (!isCompleted(item))
				return false;
		}
	}

	if (hasTrackedChildren)
		return true;

	// Avoid deep file reads on recursive calls; direct parents can resolve from descendants.
	if (!first)
		return false;

	let files = [];

	try {
		files = await file.read({}, path);
	}
	catch (error) {
		return false;
	}

	let hasChildren = false;

	for (let i = 0, len = files.length; i < len; i++) {
		const _file = files[i];

		if (_file.folder || _file.compressed) {
			hasChildren = true;

			if (!(await _getCompleted(_file.path, file, false)))
				return false;
		}
		else {
			hasChildren = true;

			if (!isCompleted(readingProgress[_file.path]))
				return false;
		}
	}

	return hasChildren;
}

async function getCompleted(path) {
	if (!path) return false;

	const file = fileManager.file(path);
	file.updateConfig({ sort: false });
	const completed = await _getCompleted(path, file, true);
	file.destroy();

	return completed;
}

async function _findReadingProgressPaths(path, file) {
	let paths = [];
	const files = await file.read({}, path);

	let hasImages = false;

	for (let i = 0, len = files.length; i < len; i++) {
		const _file = files[i];

		if (_file.folder || _file.compressed) {
			paths = [...paths, ...(await _findReadingProgressPaths(_file.path, file))];
		}
		else// if(compatible.image(_file.path))
		{
			hasImages = true;
		}
	}

	if (hasImages)
		paths.push(path);

	return paths;
}

async function findReadingProgressPaths(path, all = false) {
	if (!all) {
		const regex = new RegExp('^\s*' + pregQuote(path) + '(?:[\\\/\\\\]|$)');
		const readingProgress = relative.get('readingProgress');

		let paths = Object.keys(readingProgress).filter(function (key) {

			return regex.test(key);

		});

		if (paths.length > 1) {
			// Remove parent key
			paths = paths.filter(function (key) {

				return path !== key;

			});
		}

		return paths;
	}
	else {
		const file = fileManager.file(path);
		file.updateConfig({ sort: false });
		const paths = await _findReadingProgressPaths(path, file);
		file.destroy();

		return paths;
	}
}

async function read(path) {
	const readingProgress = storage.get('readingProgress');
	const paths = await findReadingProgressPaths(path, true);

	for (let key of paths) {
		key = relative.path(key);

		const progress = readingProgress[key];
		const pages = await countPages(key);

		readingProgress[key] = {
			...progress,
			...{
				page: pages,
				pages: pages,
				percent: 100,
				completed: true,
			}
		};
	}

	storage.set('readingProgress', readingProgress);
	updateProgress(path);

}

async function unread(path) {
	const readingProgress = storage.get('readingProgress');
	const paths = await findReadingProgressPaths(path, false);

	for (let key of paths) {
		key = relative.path(key);
		const progress = readingProgress[key];

		progress.page = 0;
		progress.percent = 0;
		progress.completed = false;
	}

	storage.set('readingProgress', readingProgress);
	updateProgress(path);
}

async function updateProgress(path, progress = false) {
	progress = progress || await get(path, false); // false to force a recount

	const sizes = [
		false,
		100,
		150,
		200,
		250,
		300,
	];

	for (const size of sizes) {
		const folderSha = sha1(path + (size ? '?size=' + size : ''));
		dom.addProgressToDom(folderSha, progress, true);
	}
}

function purge() {
	if (!readingPages) return;

	const time = app.time();
	const cacheMaxOld = config.cacheMaxOld * 60 * 60 * 24;

	for (let key in readingPages) {
		if (time - readingPages[key].lastAccess > cacheMaxOld)
			delete readingPages[key];
	}

	storage.set('readingPages', readingPages);

	return;
}

module.exports = {
	save,
	activeSave: function (active = true) { saveIsActive = active },
	setInterval: _setInterval,
	get,
	getFolderItemProgress,
	simpleGet,
	readPages,
	countPages,
	read,
	unread,
	updateProgress,
	purge,
}

window.addEventListener('beforeunload', function () {
	if (saveIsActive && typeof reading !== 'undefined' && reading.isEbook && reading.isEbook()) {
		save();
	}
});
