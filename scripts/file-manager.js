const requestFileAccess = require(p.join(appDir, '.dist/file-manager/request-file-access.js')),
	filePassword = require(p.join(appDir, '.dist/file-manager/file-password.js')),
	diskType = require(p.join(appDir, '.dist/file-manager/disk-type.js'));

var un7z = false, bin7z = false, yauzl = false, fastXmlParser = false, Minimatch = false;
var activeLogTimers = Object.create(null);

function startLogTimer(key = '')
{
	if(!activeLogTimers[key])
	{
		activeLogTimers[key] = 1;
		console.time(key);
	}
	else
	{
		activeLogTimers[key]++;
	}
}

function endLogTimer(key = '')
{
	const active = activeLogTimers[key] || 0;
	if(!active) return;

	if(active === 1)
	{
		delete activeLogTimers[key];
		console.timeEnd(key);
	}
	else
	{
		activeLogTimers[key] = active - 1;
	}
}

var file = function (path, _config = false) {

	this.path = path;
	this._sha = sha1(p.normalize(path || ''));

	this.files = [];

	this.isCompressed = false;
	this.isFolder = false;

	this.config = {
		cache: true, // Compressed
		sort: true,
		filtered: true,
		sha: true,
		only: false,
		log: true,
	};

	if (_config) this.config = { ...this.config, ..._config };

	this.updateConfig = function (config) {

		for (let key in config) {
			this.config[key] = config[key];
		}

	}

	this.getType = function () {

		if (fs.existsSync(path)) {
			if (compatible.compressed(path))
				this.isCompressed = true;
			else if (fs.statSync(path).isDirectory())
				this.isFolder = true;
		}

		return { folder: this.isFolder, compressed: this.isCompressed };
	}

	this.alreadyRead = false;

	this.read = async function (config = {}, path = false) {

		const sha = path ? sha1(p.normalize(path)) : this._sha;
		const key = 'read--' + sha + (config.forceType ? '--' + config.forceType : '') + (config.prefixes ? '--' + Object.values(config.prefixes).join('-') : '');

		const release = await mutex.lock(key);

		try {
			return await this._read(config, path);
		}
		catch (error) {
			throw error;
		}
		finally {
			release();
		}

	}

	this._read = async function (config = {}, path = false) {

		path = path || this.path;
		let _realPath = realPath(path, -1);

		this.updateConfig(config);

		let files = [];

		if (isServer(path)) {
			if (!containsCompressed(path))
				files = await this.readServer(path, _realPath);
			else
				files = await this.readServerCompressed(path, _realPath);
		}
		else if (containsCompressed(path)) {
			if (compatible.compressed(path))
				files = await this.readCompressed(path, _realPath);
			else
				files = await this.readInsideCompressed(path, _realPath);
		}
		else {
			if (compatible.compressed(path))
				files = await this.readCompressed(path, _realPath);
			else if (fs.existsSync(_realPath) && fs.statSync(_realPath).isDirectory())
				files = await this.readDir(path, _realPath);
		}

		if (this.config.sort)
			files = sort(files, this.config.sort);

		if (this.config.only && typeof this.config.only === 'number')
			files = this.only(files);

		if (this.config.sha)
			files = this.sha(files);

		if (this.path === path) {
			this.alreadyRead = true;
			this.files = files;
		}

		return this.config.filtered ? filtered(files, this.config.specialFiles) : files;
	}

	this.readDir = function (path = false, _realPath = false) {

		path = path || this.path;
		_realPath = _realPath || realPath(path, -1);

		let _this = this;

		this.macosStartAccessingSecurityScopedResource(_realPath);

		return fsp.readdir(_realPath, { withFileTypes: !_this.config.fastRead }).then(function (_files) {

			let files = [];

			if (_files) {
				for (let i = 0, len = _files.length; i < len; i++) {
					let name = _this.config.fastRead ? _files[i] : _files[i].name;

					let filePath = fastJoin(path, name);
					let retrunPath = filePath;

					if (!_this.config.fastRead && _files[i].isDirectory())
						files.push({ name: name, path: retrunPath, folder: true, compressed: false });
					else if (compatible.compressed(filePath))
						files.push({ name: name, path: retrunPath, folder: false, compressed: true });
					else
						files.push({ name: name, path: retrunPath, folder: false, compressed: false });
				}
			}

			return files;

		});

	}

	this.openCompressed = function (path, _realPath = false, mtime = false) {

		if (this.config.prefixes)
			_realPath = _realPath || realPath(path, -1, this.config.prefixes);
		else
			_realPath = _realPath || realPath(path, -1);

		mtime = mtime || fs.statSync(firstCompressedFileRealPath(path)).mtime.getTime();

		let now = Date.now();

		if (!compressedOpened[path] || compressedOpened[path].mtimeMainCompressed != mtime) {
			if (compressedOpened[path]) {
				compressedOpened[path].compressed.destroy();
			}
			compressedOpened[path] = {
				lastUsage: now,
				mtimeMainCompressed: mtime,
				compressed: fileManager.fileCompressed(path, _realPath, this.config.forceType, this.config.prefixes, { log: this.config.log }),
			};
		}
		else {
			compressedOpened[path].lastUsage = now;

			// When opening for reading (not thumbnails), clear the thumbnail flag and reset cached files
			// so readPdf will do a full read with all pages
			const compressedFile = compressedOpened[path].compressed;
			const hasSyntheticSinglePage = compressedFile.partialRead === true || isPartialFileList(compressedFile.files);

			if (!this.config.fromThumbnailsGeneration && (compressedFile.config.fromThumbnailsGeneration || hasSyntheticSinglePage)) {
				compressedOpened[path].compressed.config.fromThumbnailsGeneration = false;
				compressedOpened[path].compressed.config.width = compressedOpened[path].compressed._config.width;
				compressedOpened[path].compressed.files = false;
				compressedOpened[path].compressed.partialRead = false;
				// Also reset the PDF object so it reopens without thumbnail restrictions
				if (compressedOpened[path].compressed.pdf) {
					compressedOpened[path].compressed.pdf.destroy();
					compressedOpened[path].compressed.pdf = null;
				}
			}
		}

		cleanCompressedOpened(path);

		if (this.config.progress)
			compressedOpened[path].compressed.progress = this.config.progress;

		if (this.config.fromThumbnailsGeneration) {
			compressedOpened[path].compressed.config.fromThumbnailsGeneration = true;
			compressedOpened[path].compressed.config.width = Math.min(compressedOpened[path].compressed._config.width, Math.round(window.devicePixelRatio * 300));
		}

		return compressedOpened[path].compressed;

	}

	this.updateContentRightIndex = function (index = false) {

		index = index || template.contentRightIndex();

		for (let path in compressedOpened) {
			compressedOpened[path].compressed.contentRightIndex = index;
		}

	}

	this.readCompressed = async function (path = false, _realPath = false) {

		path = path || this.path;
		_realPath = _realPath || realPath(path, -1);

		let _isServer = isServer(path);

		let mtime = !_isServer ? fs.statSync(firstCompressedFile(path)).mtime.getTime() : 1;
		let compressed = this.openCompressed(path, _realPath, mtime);
		let ownsForceFullRead = false;

		if (this.config.forceFullRead) {
			try {
				cache.deleteJson(compressed.cacheFile);
			}
			catch (e) { }
			// Guard so concurrent thumbnail reads cannot write a 1-page cache while the full
			// read is in flight. The owner is tracked so this read can still persist its own
			// (complete) result below — otherwise every chapter change re-extracted the archive.
			ownsForceFullRead = !forceFullReadInProgress[compressed.cacheFile];
			forceFullReadInProgress[compressed.cacheFile] = true;
			this.config.fromThumbnailsGeneration = false;

			// Also clear any in-memory single-page results and reset PDF object
			try {
				compressed.files = false;
				if (compressed.pdf) {
					compressed.pdf.destroy();
					compressed.pdf = null;
				}
			}
			catch (e) { }
		}

		try {

		let json = cache.readJson(compressed.cacheFile);
		let isBadPdfCache = false;

		if (this.config.cache && !this.config.forceFullRead) {
			if (json && json.files) {
				if (json.mtime == mtime || _isServer) {
					// Discard a cached thumbnail-only page list when the caller wants the real
					// contents. `json.partial` covers indexes written by this version; the
					// heuristic inside isPartialFileList() recovers ones written by earlier
					// versions, so an already-poisoned cache self-heals instead of needing a
					// manual "clear file cache".
					isBadPdfCache = !this.config.fromThumbnailsGeneration && (json.partial === true || isPartialFileList(json.files));

					if (!isBadPdfCache) {
						if (json.error && !this.config.fromThumbnailsGeneration && !this.config.subtask)
							dom.compressedError({ message: json.error }, false, sha1(this.path), this.path);

						setFileData(path, json.files);

						return json.files;
					}
				}

				if (fs.existsSync(compressed.tmp))
					await fsp.rmdir(compressed.tmp, { recursive: true });
			}
		}

		if (this.config.cacheOnly)
			throw new Error('notCacheOnly');

		await this.extractIfInsideAnotherCompressed(path, _realPath);

		let files = await compressed.read(this.config);

		// Self-heal: a reader asked for the real contents but the shared compressed object was
		// still in thumbnail mode (a concurrent thumbnail job can flip that flag mid-flight),
		// so it handed back the synthetic single page. Redo the read with thumbnail mode
		// explicitly off instead of letting the caller display a one-page file.
		if (!this.config.fromThumbnailsGeneration && isPartialFileList(files)) {
			compressed.config.fromThumbnailsGeneration = false;
			compressed.files = false;
			compressed.partialRead = false;

			if (compressed.pdf) {
				try { compressed.pdf.destroy(); } catch (e) { }
				compressed.pdf = null;
			}

			files = await compressed.read({ ...this.config, forceFullRead: true });
		}

		const partial = isPartialFileList(files);
		let metadata = {};

		// Thumbnails mode should not parse full metadata (especially PDFs), because it
		// forces expensive opens while we only need the first visual page.
		if (!this.config.fromThumbnailsGeneration) {
			metadata = await compressed.readMetadata(this.config);
			this.saveCompressedMetadata(path, metadata);
		}

		if (metadata.poster)
			files = this.setPosterFromMetadata(files, metadata.poster);

		if (!json || json.mtime != mtime || isBadPdfCache) {
			// Never persist a thumbnail-only page list: that is what left an opened file stuck
			// on its first page until its cache was cleared manually.
			if (!this.config.fromThumbnailsGeneration && !partial) {
				try {
					if (ownsForceFullRead || !forceFullReadInProgress[compressed.cacheFile]) {
						cache.writeJson(compressed.cacheFile, { mtime: mtime, files: files, metadata: metadata });
					}
				}
				catch (e) { }
			}
		}

		// Same reasoning for the shared in-memory index consumed by the reader.
		if (!partial)
			setFileData(path, files);

		return files;

		}
		finally {
			// Also runs when the read above throws, so a failed forced read cannot leave the
			// guard set and permanently disable caching for this archive.
			if (ownsForceFullRead)
				delete forceFullReadInProgress[compressed.cacheFile];
		}

	}

	this.readInsideCompressed = async function (path = false, _realPath = false) {

		path = path || this.path;
		_realPath = _realPath || realPath(path, -1);

		let lastCompressed = lastCompressedFile(path);

		let files = [];

		if (lastCompressed) {
			let _files = await this.readCompressed(lastCompressed);
			files = this.readFromFilesList(_files, path, lastCompressed);
		}

		return files;

	}

	this.serverHasCache = function (path) {

		path = serverClient.fixPath(path || this.path);
		let sha = sha1(path);
		let cacheFile = (cache.zstd !== false) ? 'server-files-' + sha + '.json.zstd' : 'server-files-' + sha + '.json';

		return cache.existsFile(cacheFile);

	}

	this.readServer = async function (path = false, _realPath = false) {

		path = serverClient.fixPath(path || this.path);
		_realPath = _realPath || realPath(path, -1);

		let sha = sha1(path);
		let cacheFile = 'server-files-' + sha + '.json';

		if (this.config.cache && (this.config.cacheOnly || this.config.cacheServer || serverInOfflineMode)) {
			let json = cache.readJson(cacheFile);

			if (json && json.files)
				return json.files;
		}

		if (serverInOfflineMode)
			return [];

		if (this.config.cacheOnly)
			throw new Error('notCacheOnly');

		let files = await serverClient.read(path);

		return files;

	}

	this.readServerCompressed = async function (path = false, _realPath = false) {

		path = serverClient.fixPath(path || this.path);
		_realPath = _realPath || realPath(path, -1);

		if (compatible.compressed(path))
			return this._readServerCompressed(path, _realPath);
		else
			return this.readServerInsideCompressed(path, _realPath);
	}

	this._readServerCompressed = async function (path = false, _realPath = false) {

		path = serverClient.fixPath(path || this.path);
		_realPath = _realPath || realPath(path, -1);

		if (this.config.cache && (this.config.cacheOnly || this.config.cacheServer || serverInOfflineMode)) {
			let files = false;

			const cacheOnly = this.config.cacheOnly;
			this.updateConfig({ cacheOnly: true });

			try {
				files = await this.readCompressed(path, _realPath);
			}
			catch (error) {
				if (!error.message || !/notCacheOnly/.test(error.message))
					throw new Error(error);
			}

			this.updateConfig({ cacheOnly: cacheOnly });

			if (files !== false && files?.length)
				return files;

			if (this.config.cacheOnly)
				throw new Error('notCacheOnly');
		}

		let firstCompressed = firstCompressedFile(path, 0);

		if (firstCompressed) {
			if (!serverClient.existsSync(realPath(firstCompressed, -1))) {
				// Download file to tmp
				let file = await serverClient.download(path, { only: [firstCompressed] });

				if (this.config.fromThumbnailsGeneration)
					downloadedCompressedFile(firstCompressed);
			}
		}

		return this.readCompressed(path, _realPath);

	}

	this.readServerInsideCompressed = async function (path = false, _realPath = false) {

		path = path || this.path;
		_realPath = _realPath || realPath(path, -1);

		if (this.config.cache && (this.config.cacheOnly || this.config.cacheServer || serverInOfflineMode)) {
			let files = false;

			const cacheOnly = this.config.cacheOnly;
			this.updateConfig({ cacheOnly: true });

			try {
				files = await this.readInsideCompressed(path, _realPath);
			}
			catch (error) {
				if (!error.message || !/notCacheOnly/.test(error.message))
					throw new Error(error);
			}

			this.updateConfig({ cacheOnly: cacheOnly });

			if (this.config.cacheOnly)
				throw new Error('notCacheOnly');

			if (files !== false && files?.length)
				return files;
		}

		let firstCompressed = firstCompressedFile(path, 0);

		if (firstCompressed) {
			if (!serverClient.existsSync(realPath(firstCompressed, -1))) {
				// Download file to tmp
				let file = await serverClient.download(path, { only: [firstCompressed] });

				if (this.config.fromThumbnailsGeneration)
					downloadedCompressedFile(firstCompressed);
			}
		}

		return this.readInsideCompressed(path, _realPath);

	}

	// If compressed is inside other compressed, decompress here others compressed files (Only compresses files ignoring others files)
	this.extractIfInsideAnotherCompressed = async function (path = false, _realPath = false) {

		path = path || this.path;
		_realPath = _realPath || realPath(path, -1);

		if (_realPath !== path && !fs.existsSync(_realPath)) {
			let compressedFiles = allCompressedFiles(path);

			if (compressedFiles.length > 1) {
				for (let i = 0, len = compressedFiles.length - 1; i < len; i++) {
					let path = compressedFiles[i];
					let _realPath = realPath(path, -1);
					let _realPathNext = realPath(compressedFiles[i + 1], -1);
					let only = removePathPart(compressedFiles[i + 1], path);

					if (!fs.existsSync(_realPathNext)) {
						let toDecompress = this.openCompressed(path, _realPath);
						await toDecompress.extract({ only: [only] });
					}
				}
			}
		}

		return;
	}

	this._images = async function (num, files, fullFiltered, from = false, fromReached = false, findPoster = false, deep = 0) {

		const images = [];
		let imagesNum = 0;
		const normalizedFrom = from ? p.normalize(from) : false;
		const normalizedFromKey = (normalizedFrom && process.platform === 'win32') ? normalizedFrom.toLowerCase() : normalizedFrom;

		const reverse = num < 0 ? true : false;
		const len = fullFiltered.length;
		const start = reverse ? len - 1 : 0;
		const end = reverse ? -1 : len;
		const step = reverse ? -1 : 1;

		let index = 0;

		for (let i = start; i !== end; i += step) {
			let file = fullFiltered[i];
			const filePath = file?.path || '';
			const normalizedFilePath = filePath ? p.normalize(filePath) : '';
			const normalizedFileKey = (normalizedFilePath && process.platform === 'win32') ? normalizedFilePath.toLowerCase() : normalizedFilePath;
			const fromMatchesFile = !!normalizedFromKey && normalizedFileKey === normalizedFromKey;
			const fromInFile = !!normalizedFromKey && !!normalizedFileKey && normalizedFromKey.startsWith(normalizedFileKey);
			let image = false;

			if (!normalizedFromKey || fromReached || fromInFile) {
				if (file.folder || file.compressed) {
					const _files = file.files || await this.read({ cacheServer: true, filtered: false }, file.path);
					const _fullFiltered = fileManager.filtered(_files);

					let poster = false;

					if (findPoster) {
						poster = this._poster(files, file.path); // Find poster in the same folder where the folder/file is located
						if (!poster) poster = this._poster(files, file.path, true); // Also match generic poster names (cover.jpg, poster.jpg, etc.) beside the file
						if (!poster) poster = this._poster(_files, file.path, true); // Find poster inside folder/file
					}

					if (poster) {
						image = poster.path;
					}
					else {
						image = await this._images((reverse ? -1 : 1), _files, _fullFiltered, from, fromReached, findPoster, deep + 1);
						fromReached = image.fromReached;
						image = image.images[0] || false;
					}

					// IMPORTANT: If we only wanted 1 image (thumbnail cover check), stop trying to recursively parse thousands of nested images
					if (image && Math.abs(num) === 1) {
						images.push(image);
						break;
					}
				}
				else if (compatible.image(file.name)) {
					image = file.path;
				}

				if (image && (!from || fromReached)) {
					images.push(image);
					imagesNum++;

					if (imagesNum == Math.abs(num))
						break;
				}
			}

			if (fromMatchesFile)
				fromReached = true;

			if (this.config.cacheOnly && index > 16 && deep > 0)
				throw new Error('notCacheOnly');

			index++;
		}

		return { images: images, fromReached: fromReached };
	}

	// Get the first images of a folder/compressed
	this.images = async function (only = 1, from = false, findPoster = false, _files = false, _path = false, _isCompressed = false) {

		this.updateConfig({ filtered: false, sort: { extraKey: 'Reading' } });

		// Find poster in the same folder where the folder/file is located
		if (findPoster) {
			const poster = await this.poster();
			if (poster) return poster;
		}

		if (!this.alreadyRead)
			await this.read({ cacheServer: true, filtered: false });

		const files = _files || this.files;
		const path = _path || this.path;

		const fullFiltered = fileManager.filtered(files);

		_isCompressed = _isCompressed || isCompressed(path);

		// Find poster inside folder/file
		if (findPoster) {
			const poster = this._poster(files, path, true, _isCompressed);
			if (poster) return poster;
		}

		// Inore single folders
		if (config.ignoreSingleFoldersLibrary && fullFiltered.length == 1 && (fullFiltered[0].folder || fullFiltered[0].compressed)) {
			const file = fullFiltered[0];
			const files = file.files ? file.files : await this.read({ cacheServer: true, filtered: false }, file.path);

			return this.images(only, from, findPoster, files, file.path, _isCompressed);
		}

		// If no poster is found, find as a list of images
		let images = (await this._images(only, files, fullFiltered, from, false, findPoster)).images;

		for (let i = 0, len = images.length; i < len; i++) {
			images[i] = { name: p.basename(images[i]), path: images[i], folder: false, compressed: false };
		}

		if (this.config.sha)
			images = this.sha(images);

		return (Math.abs(only) == 1) ? (images[0] || false) : images;
	}

	this._poster = function (files, path = false, inside = false, _isCompressed = false) {

		path = path || this.path;

		const name = p.parse(path).name;
		const regex = new RegExp('^(?:[\-\s0-9+])?(?:' + pregQuote(name) + '(?:[_-]?(?:cover|default|folder|series|poster|thumbnail))?' + (inside ? '|cover|default|folder|series|poster|thumbnail' : '') + ')(?:[\-\s0-9+])?\.[a-z0-9]+$');

		const len = files.length;
		let poster = false;

		for (let i = 0; i < len; i++) {
			const file = files[i];

			if (!file.folder && !file.compressed && (regex.test(file.name) || file.poster)) {
				if (!poster && compatible.image(file.path)) {
					file.sha = sha1(file.path);
					poster = file;
				}
				else if (compatible.image.special(file.path)) // prioritize tbn poster
				{
					file.sha = sha1(file.path);
					poster = file;

					break;
				}
			}
		}

		if (!poster && inside && len && (config.useTheFirstImageAsPosterInFolders || config.useTheFirstImageAsPosterInFiles)) {
			_isCompressed = _isCompressed || isCompressed(path);

			if ((!_isCompressed && config.useTheFirstImageAsPosterInFolders) || (_isCompressed && config.useTheFirstImageAsPosterInFiles)) {
				for (let i = 0; i < len; i++) {
					const file = files[i];

					if (!file.folder && !file.compressed) {
						if (compatible.image(file.path)) {
							file.sha = sha1(file.path);
							file.fromFirstImageAsPoster = true;
							poster = file;

							break;
						}
					}
					else {
						break;
					}
				}
			}
		}

		return poster;
	}

	this.poster = async function () {

		const dirname = p.dirname(this.path);

		try {
			const file = fileManager.file(dirname);
			file.updateConfig({ fastRead: true, filtered: false, sha: false, cacheServer: true, sort: { extraKey: 'Reading' } });
			const files = await file.read();
			file.destroy();

			return this._poster(files);
		}
		catch (error) {
			console.error(error);

			if (!macosMAS)
				throw new Error(error);
			//else
			//	fileManager.requestFileAccess.check(this.path, error);
		}

		return false;
	}

	this.setPosterFromMetadata = function (files, poster) {

		for (let i = 0, len = files.length; i < len; i++) {
			if (files[i].name == poster) {
				files[i].poster = true;

				break;
			}
		}

		return files;

	}

	this.saveCompressedMetadata = function (path, metadata) {

		if (metadata.title || metadata.author) {
			storage.setVar('compressedMetadata', path, {
				title: metadata.title,
				author: metadata.author,
			});
		}

	}

	this.sha = function (files) {

		for (let i = 0, len = files.length; i < len; i++) {
			files[i].sha = sha1(files[i].path);
		}

		return files;
	}

	this.only = function (files) {

		let only = this.config.only;
		let _files = [];

		if (only >= 0) {
			let len = files.length;
			let limit = only;
			if (limit > len) limit = len;

			for (let i = 0; i < limit; i++) {
				_files.push(files[i]);
			}
		}
		else {
			let len = files.length;
			let limit = len + only;
			if (limit < 0) limit = 0;

			for (let i = len - 1; i >= limit; i--) {
				_files.push(files[i]);
			}
		}

		return _files;
	}

	this._readFromFilesList = function (segments, files) {

		let segment = segments.shift();
		let remaining = segments.length;

		// Always hand back an array. Every falsy result below used to escape as undefined, and
		// undefined survives the whole way out: readInsideCompressed() returns it, _read() feeds
		// it to sort(), which only sorts `if (files)` and returns whatever it was given, and sha()
		// then evaluates undefined.length. That surfaced as "Error when unzipping - Cannot read
		// properties of undefined (reading 'length')" rather than simply an empty folder.
		if (!files)
			return [];

		for (let i = 0, len = files.length; i < len; i++) {
			let file = files[i];

			if (file.name == segment) {
				// A matched entry that is a file rather than a folder has no .files.
				if (remaining == 0)
					return file.files || [];
				else
					return this._readFromFilesList(segments, file.files);
			}
		}

		// Nothing matched this segment.
		return [];

	}

	this.readFromFilesList = function (files, path, lastCompressed) {

		let segments = splitPath(removePathPart(path, lastCompressed));

		return this._readFromFilesList(segments, files);

	}

	// Makes the files available, extracting them from the respective compressed files if necessary
	this.makeAvailable = async function (files, callbackWhenFileAvailable = false, forceCheck = false, fromThumbnailsGeneration = false) {

		let filesToDecompress = false, filesToDecompressNum = 0;

		for (let i = 0, len = files.length; i < len; i++) {
			let file = files[i];

			let _path = realPath(file.path, -1, this.config.prefixes);

			if ((!forceCheck || _path === file.path) && fs.existsSync(_path)) {
				if (callbackWhenFileAvailable) callbackWhenFileAvailable(file);
			}
			else {
				if (!filesToDecompress) filesToDecompress = {};

				let compressedFile = lastCompressedFile(file.path);

				if (!compressedFile && isServer(file.path)) {
					compressedFile = serverClient.getTypeAdress(file.path);

					if (!filesToDecompress[compressedFile]) filesToDecompress[compressedFile] = [];
					filesToDecompress[compressedFile].push(file.path);
				}
				else if (compressedFile && simpleExists(compressedFile)) {
					if (!filesToDecompress[compressedFile]) filesToDecompress[compressedFile] = [];
					filesToDecompress[compressedFile].push(removePathPart(file.path, compressedFile));
				}
				else {
					continue;
				}

				filesToDecompressNum++;
			}

			if (_path !== file.path) // If it is different it is because it is not a compressed file
				fileManager.setTmpUsage(_path);
		}

		if (filesToDecompress) {
			let _this = this;

			for (let compressedFile in filesToDecompress) {
				try {
					if (isServer(compressedFile)) {
						if (containsCompressed(compressedFile, 0, false)) {
							let firstCompressed = firstCompressedFile(compressedFile, 0, false);

							// Download file to tmp
							let file = await serverClient.download(compressedFile, { only: [firstCompressed] });

							let compressed = this.openCompressed(compressedFile);

							await this.extractIfInsideAnotherCompressed(compressedFile);

							await compressed.extract({ only: filesToDecompress[compressedFile] }, function (file) {

								if (_this.config.sha) file.sha = sha1(file.path);
								if (callbackWhenFileAvailable) callbackWhenFileAvailable(file);

							});

							if (fromThumbnailsGeneration || _this.config.fromThumbnailsGeneration)
								downloadedCompressedFile(firstCompressed);
						}
						else {
							await serverClient.download(compressedFile, { only: filesToDecompress[compressedFile] }, function (file) {

								if (_this.config.sha) file.sha = sha1(file.path);
								if (callbackWhenFileAvailable) callbackWhenFileAvailable(file);

							});
						}
					}
					else {
						let compressed = this.openCompressed(compressedFile);

						await this.extractIfInsideAnotherCompressed(compressedFile);

						await compressed.extract({ only: filesToDecompress[compressedFile] }, function (file) {

							if (_this.config.sha) file.sha = sha1(file.path);
							if (callbackWhenFileAvailable) callbackWhenFileAvailable(file);

						});
					}
				}
				catch (error) {
					if (fromThumbnailsGeneration || _this.config.fromThumbnailsGeneration) {
						console.warn('Warning: makeAvailable skipped failed compressed file | ' + compressedFile, error);
						continue;
					}

					throw error;
				}
			}
		}

		return filesToDecompressNum;
	}

	this.macosScopedResources = [];

	this.macosStartAccessingSecurityScopedResource = function (path) {

		if (macosMAS) {
			let securityScopedBookmarks = storage.get('securityScopedBookmarks');
			let segments = splitPath(path);

			if (!segments[0])
				segments[0] = p.sep;

			for (let i = 1, len = segments.length; i < len; i++) {
				let _path = p.join(...segments);
				let bookmark = securityScopedBookmarks[_path] || false;

				if (bookmark) {
					try {
						this.macosScopedResources.push(electronRemote.app.startAccessingSecurityScopedResource(bookmark));
						break;
					}
					catch { }
				}

				segments.pop();
			}
		}
	}

	this.destroyed = false;

	this.destroy = function () {

		this.destroyed = true;

		for (let path in this.compressedOpened) {
			this.compressedOpened[path].compressed.destroy();
			delete this.compressedOpened[path];
		}

		// Stop accessing security scoped resources
		for (let i = 0, len = this.macosScopedResources.length; i < len; i++) {
			this.macosScopedResources[i]();
		}

		this.macosScopedResources = [];

	};

	this.afterDestroy = function () {

		if (this.destroyed)
			this.destroy();

	}
}

// Compressed files
var fileCompressed = function (path, _realPath = false, forceType = false, prefixes = false, _config = false) {

	this.path = path;
	this.realPath = _realPath || realPath(path, -1);
	this.forceType = forceType;
	this.prefixes = prefixes;
	this.virtualPath = this.path;
	this.sha = sha1(p.normalize(path));

	if (prefixes) {
		const extension = app.extname(path);

		if (extension) {
			for (let ext in prefixes) {
				if (compatible.compressed[ext].has(extension)) {
					this.sha = prefixes[ext] + '-' + this.sha;

					break;
				}
			}
		}
	}

	this.cacheFile = 'compressed-files-' + this.sha + '.json';
	this.tmp = p.join(tempFolder, this.sha);
	this.tmpPartialExtraction = p.join(this.tmp, this.sha + '-opencomic-partial-extraction.txt');
	this.tmpIsVector = p.join(this.tmp, this.sha + '-opencomic-is-vector.txt');

	this.contentRightIndex = template.contentRightIndex();

	this.fullExtracted = false;

	this.files = false;
	this.filesStatus = {};
	this.metadata = false;

	// `_config` holds the pristine per-object defaults that updateConfig() fills unspecified
	// keys from; `config` is the live per-read config. They MUST NOT be the same object:
	// openCompressed() stamps per-read intent (fromThumbnailsGeneration, width) onto `config`,
	// and while these were aliased that stamp landed in the defaults too. updateConfig() then
	// re-injected `fromThumbnailsGeneration: true` into every later read, so once a file had a
	// thumbnail generated it stayed permanently in thumbnail mode and the reader only ever got
	// the synthetic first page — until the object was destroyed or its cache cleared by hand.
	this._config = {
		// only: false,
		cache: true,
		//width: window.devicePixelRatio * (handlebarsContext.page.viewModuleSize || 150), // Vector width
		width: window.devicePixelRatio * 300, // Vector width
		height: false, // Vector height
		force: false, // Forces the extraction even if the file exists
		log: true,
	};

	if (_config) this._config = { ...this._config, ..._config };

	this.config = { ...this._config };

	this._features = {
		'7z': { // 7z incldues multiple formats, like zip, rar, tar, etc.
			read: true,
			single: true,
			vector: false,
			canvas: false,
			html: false,
			ebook: false,
			progress: true,
		},
		pdf: {
			read: true,
			single: true,
			vector: true,
			canvas: true,
			html: true,
			ebook: false,
			progress: true,
		},
		epub: {
			read: true,
			single: true,
			vector: true,
			canvas: false,
			html: true,
			ebook: true,
			progress: true,
		},
	};

	this.features = false;

	this.log = function (message) {

		if (this.config.log)
			console.log(message);

	}

	this.time = function (key, message) {

		if (this.config.log)
			startLogTimer(key);

	}

	this.timeEnd = function (key, message) {

		if (this.config.log)
			endLogTimer(key);

	}

	this.updateConfigOnly = function (_only) {

		if (!_only)
			return this.config.only = this.config._only = _only;

		let only = {};

		for (let i = 0, len = _only.length; i < len; i++) {
			only[_only[i]] = true;
		}

		this.config._only = _only;
		return this.config.only = only;

	}

	this.updateConfig = function (config) {

		for (let key in this._config) {
			if (typeof config[key] === 'undefined')
				config[key] = this._config[key];
		}

		this.config = config;

		if (config.only)
			this.updateConfigOnly(config.only);

	}

	this.getFeatures = function (force = false) {

		if (this.features && !force) return this.features;

		force = force || this.forceType;
		let ext = app.extname(this.path) || false;
		let pathToDetect = this.path;

		// If a virtual path points inside a compressed file (for example an EPUB chapter),
		// detect features from the containing compressed file.
		if (containsCompressed(this.path) && !compatible.compressed(this.path)) {
			const compressedPath = lastCompressedFile(this.path);
			if (compressedPath) {
				pathToDetect = compressedPath;
				if (!ext) ext = app.extname(compressedPath);
			}
		}

		if (!force) {
			if (compatible.compressed._7z(pathToDetect))
				force = '7z';
			else if (compatible.compressed.pdf.has(ext))
				force = 'pdf';
			else if (compatible.compressed.epub.has(ext))
				force = 'epub';
		}

		// Last chance inference in case forceType is unknown or malformed.
		if (!this._features[force]) {
			if (compatible.compressed.epub.has(ext))
				force = 'epub';
			else if (compatible.compressed.pdf.has(ext))
				force = 'pdf';
			else if (compatible.compressed._7z(pathToDetect))
				force = '7z';
		}

		if (!this._features[force])
			throw new Error('Unsupported compressed type for path: ' + this.path + ' (forceType: ' + (this.forceType || '') + ', ext: ' + (ext || '') + ')');

		this.features = this._features[force];
		this.features.ext = force;
		this.features.fileExt = ext;
		this.features[force] = true;

		return this.features;

	}

	this.setTmpUsage = function () {

		if (this.path !== this.realPath)
			fileManager.setTmpUsage(this.realPath);

	}

	this.saveErrorToCache = function (error) {

		let json = cache.readJson(this.cacheFile);

		if (json) {
			json.error = (error.detail || error.message);
			try {
				if (!forceFullReadInProgress[this.cacheFile])
					cache.writeJson(this.cacheFile, json);
				else
					console.log('[saveErrorToCache] skipping write due to forceFullReadInProgress', this.cacheFile);
			}
			catch (e) {}
		}

	}

	this.read = async function (config = {}) {

		this.updateConfig(config);
		this.getFeatures();

		if (this.config.forceFullRead) {
			this.config.fromThumbnailsGeneration = false;
			this.files = false;
			this.partialRead = false;
		}
		else if (this.config.cache && this.files) {
			// Never serve the cached thumbnail-only page list to a caller that wants the real
			// contents — that is how an opened file ended up showing a single page.
			if (this.config.fromThumbnailsGeneration || !isPartialFileList(this.files))
				return this.files;
		}

		return this.readCurrent();
	}

	this.readCurrent = async function () {

		this.setTmpUsage();

		const release = await mutex.lock('readCompressed--' + this.sha + '--' + this.features.ext + '--' + this.features.fileExt);
		const message = 'readCompressed | ' + this.features.ext + (this.features.fileExt && this.features.ext !== this.features.fileExt ? ' (' + this.features.fileExt + ')' : '') + ' | ' + this.path;

		this.time(message);
		let files = false;

		try {
			if (this.features['7z'])
				files = await this.read7z();
			else if (this.features.pdf)
				files = await this.readPdf();
			else if (this.features.epub)
				files = await this.readEpub();
		}
		catch (error) {
			throw error;
		}
		finally {
			this.timeEnd(message);
			release();
		}

		return files;
	}

	this.readMetadata = async function (config = {}) {

		this.updateConfig(config);
		this.getFeatures();

		if (this.config.cache && this.metadata)
			return this.metadata;

		return this.readCurrentMetadata();
	}

	this.readCurrentMetadata = function () {

		if (this.features['7z'])
			return this.readCompressedMetadata();
		else if (this.features.pdf)
			return this.readPdfMetadata();
		else if (this.features.epub)
			return this.readEpubMetadata();

		return {};
	}

	this.readCompressedMetadata = async function (files = false, compressedPath = '') {

		files = files || await this.read();
		let len = files.length;

		if (/*config.ignoreSingleFoldersLibrary && */len === 1 && files[0].folder && files[0].files && files[0].files.length)
			return this.readCompressedMetadata(files[0].files, p.join(compressedPath, files[0].name));

		let comicInfoFile = false;

		for (let i = 0; i < len; i++) {
			if (files[i].name == 'ComicInfo.xml') {
				comicInfoFile = files[i];

				break;
			}
		}

		if (comicInfoFile) {
			if (fastXmlParser === false) {
				fastXmlParser = require('fast-xml-parser').XMLParser;
				fastXmlParser = new fastXmlParser({ ignoreAttributes: false });
			}

			if (compressedPath !== false && lastCompressedFile(this.path) === lastCompressedFile(comicInfoFile.path)) {
				const only = this.config.only;
				await this.extract({ only: [p.join(compressedPath, comicInfoFile.name)] });
				this.updateConfig({ only: only });
			}
			else {
				const file = fileManager.file(this.path);
				await file.makeAvailable([{ path: comicInfoFile.path }]);
				file.destroy();
			}

			let xml = await fsp.readFile(realPath(comicInfoFile.path, -1));
			let metadata = fastXmlParser.parse(xml);

			let comicInfo = metadata.ComicInfo || {};
			let poster = false;

			if (comicInfo.Pages && comicInfo.Pages.Page) {
				let _poster = false;

				for (let i = 0, len = comicInfo.Pages.Page.length; i < len; i++) {
					let page = comicInfo.Pages.Page[i];

					if (page['@_Type'] == 'FrontCover') {
						_poster = +page['@_Image'];

						break;
					}
					else if (page['@_Type'] == 'InnerCover') {
						_poster = +page['@_Image'];
					}
				}

				if (_poster !== false) {
					let index = 0;

					for (let i = 0, len = files.length; i < len; i++) {
						let file = files[i];

						if (!file.folder && !file.compressed && compatible.image(file.path)) {
							if (index === _poster) {
								poster = file.name;
								file.poster = true;

								break;
							}

							index++;
						}
					}

				}
			}

			for (let key in comicInfo) {
				if (comicInfo[key] instanceof Object && comicInfo[key]['#text']) {
					comicInfo[key] = comicInfo[key]['#text'];
				}
			}

			// https://anansi-project.github.io/docs/category/schemas
			return {
				title: comicInfo.Title || '',
				series: comicInfo.Series || '',
				localizedSeries: comicInfo.LocalizedSeries || '',
				seriesGroup: comicInfo.SeriesGroup || '',

				poster: poster,

				bookNumber: comicInfo.Number || 0,
				bookTotal: comicInfo.Count || 0,
				volume: comicInfo.Volume || 0,
				pages: comicInfo.PageCount || 0,

				storyArc: comicInfo.StoryArc || '',
				storyArcNumber: comicInfo.StoryArcNumber || 0,

				alternateSeries: comicInfo.AlternateSeries || 0,
				alternateBookNumber: comicInfo.AlternateNumber || 0,
				alternateBookTotal: comicInfo.AlternateCount || 0,

				manga: (comicInfo.Manga == 'Yes' || comicInfo.Manga == 'YesAndRightToLeft') ? true : (comicInfo.Manga == 'No' ? false : null),

				author: comicInfo.Writer || '',
				writer: comicInfo.Writer || '',
				penciller: comicInfo.Penciller || '',
				inker: comicInfo.Inker || '',
				colorist: comicInfo.Colorist || '',
				letterer: comicInfo.Letterer || '',
				coverArtist: comicInfo.CoverArtist || '',
				editor: comicInfo.Editor || '',
				translator: comicInfo.Translator || '',
				publisher: comicInfo.Publisher || '',
				imprint: comicInfo.Imprint || '',

				ageRating: comicInfo.AgeRating || '',
				genre: comicInfo.Genre || '',
				tags: comicInfo.Tags || '',
				web: comicInfo.Web || '',
				description: comicInfo.Summary || '',

				characters: comicInfo.Characters || '',
				teams: comicInfo.Teams || '',
				locations: comicInfo.Locations || '',
				mainCharacterOrTeam: comicInfo.MainCharacterOrTeam || '',

				releaseDate: (comicInfo.Year && comicInfo.Month && comicInfo.Day) ? comicInfo.Year + '-' + comicInfo.Month + '-' + comicInfo.Day : '',
				year: comicInfo.Year || 0,
				month: comicInfo.Month || 0,
				day: comicInfo.Day || 0,

				language: comicInfo.LanguageISO || '',
				format: comicInfo.Format || '',
				scanInformation: comicInfo.ScanInformation || '',
				notes: comicInfo.Notes || '',
				GTIN: comicInfo.GTIN || '',

				metadata: metadata,
			};
		}

		return {};

	}

	this.callbackWhenFileExtracted = false;

	this.extract = async function (config = {}, callbackWhenFileExtracted = false) {

		this.updateConfig(config);
		this.getFeatures();

		this.callbackWhenFileExtracted = callbackWhenFileExtracted;

		if (!fs.existsSync(this.tmp)) {
			fs.mkdirSync(this.tmp);

			if (this.config.only)
				fs.writeFileSync(this.tmpPartialExtraction, '');
		}
		else if (!this.config.only) {
			if (fs.existsSync(this.tmpPartialExtraction))
				fs.unlinkSync(this.tmpPartialExtraction);
		}

		if (this.features.vector && !fs.existsSync(this.tmpIsVector))
			fs.writeFileSync(this.tmpIsVector, window.devicePixelRatio.toString());

		if (!this.config.force) {
			let only = await this.checkIfAlreadyExtracted();

			if (only === null)
				return true;
			else
				this.updateConfigOnly(only);
		}

		if (this.features.progress)
			this.setProgress(0);

		return this.extractCurrent();
	}

	this.extractCurrent = async function () {

		this.setTmpUsage();

		const release = await mutex.lock('extractCurrent--' + this.sha + '--' + this.features.ext + '--' + this.features.fileExt);
		const message = 'extractCompressed | ' + this.features.ext + (this.features.fileExt && this.features.ext !== this.features.fileExt ? ' (' + this.features.fileExt + ')' : '') + ' |' + (this.config._only ? ' (' + this.config._only.length + ' files)' : '') + ' ' + this.path;

		this.time(message);
		let files = false;

		try {
			if (this.features['7z'])
				files = await this.extract7z();
			else if (this.features.pdf)
				files = await this.extractPdf();
			else if (this.features.epub)
				files = await this.extractEpub();
		}
		catch (error) {
			throw error;
		}
		finally {
			this.timeEnd(message);
			release();
		}

		return files;

	}

	this.checkIfAlreadyExtracted = async function () {

		if (this.config.only) {
			let only = [];

			for (let path in this.config.only) {
				const _path = p.join(this.path, path);
				const globalExtracting = getGlobalExtracting(_path);
				const alreadyExtracted = this.isExtractedFileValid(path);

				if (globalExtracting || alreadyExtracted) {
					if (globalExtracting) {
						try {
							await globalExtracting.promise;
						}
						catch (error) {
							// Stale/failed lock: extract again if file is still invalid.
							if (!this.isExtractedFileValid(path)) {
								setGlobalExtracting(_path);
								only.push(path);
								continue;
							}
						}
					}

					if (this.isExtractedFileValid(path))
						this.whenExtractFile(_path);
					else {
						setGlobalExtracting(_path);
						only.push(path);
					}
				}
				else {
					setGlobalExtracting(_path);
					only.push(path);
				}
			}

			if (!only.length)
				return null;
			else
				return only;
		}
		else {
			try {
				let file = fileManager.file(this.path);
				let files = await file.read({ cacheOnly: true });
				files = this.filesToOnedimension(files);

				let only = [];
				let someIsExtracted = false;

				for (let i = 0, len = files.length; i < len; i++) {
					const file = files[i];

					if (file.folder)
						continue;

					const _path = p.join(this.path, file.pathInCompressed);
					const globalExtracting = getGlobalExtracting(_path);
					const alreadyExtracted = this.isExtractedFileValid(file.pathInCompressed);

					if (globalExtracting || alreadyExtracted) {
						if (globalExtracting) {
							try {
								await globalExtracting.promise;
							}
							catch (error) {
								if (!this.isExtractedFileValid(file.pathInCompressed)) {
									setGlobalExtracting(_path);
									only.push(file.pathInCompressed);
									continue;
								}
							}
						}

						if (this.isExtractedFileValid(file.pathInCompressed)) {
							this.whenExtractFile(_path);
							someIsExtracted = true;
						}
						else {
							setGlobalExtracting(_path);
							only.push(file.pathInCompressed);
						}
					}
					else {
						setGlobalExtracting(_path);
						only.push(file.pathInCompressed);
					}
				}

				if (!only.length)
					return null;
				else if (someIsExtracted)
					return only;
				else
					return false;
			}
			catch (error) {
				console.error(error);

				return false;
			}
		}

	}

	this.renderBlob = async function (file, config = {}) {

		this.updateConfig(config);
		this.getFeatures();

		if (this.features.pdf)
			return this.renderBlobPdf(file);

	}

	this.ebookPages = async function (config = {}) {

		this.getFeatures();

		if (this.features.ebook)
			return this.ebookPagesEpub(config);

	}

	this.ebook = async function (config = {}) {

		this.updateConfig(config);
		this.getFeatures();

		if (this.features.ebook)
			return this.ebookEpub();

	}

	this.setFileStatus = function (path, data = {}) {

		if (!this.filesStatus[path]) {
			this.filesStatus[path] = data;
		}
		else {
			for (let key in data) {
				if (key != 'extracted' || data[key])
					this.filesStatus[path][key] = data[key];
			}
		}

	}

	this.getFileStatus = function (file) {

		return this.filesStatus[file] || false;

	}

	this.isExtractedFileValid = function (pathInCompressed) {
		const extractedPath = p.join(this.tmp, pathInCompressed);

		if (!fs.existsSync(extractedPath))
			return false;

		try {
			const stat = fs.statSync(extractedPath);

			if (!stat.isFile() || stat.size <= 0)
				return false;

			const expectedSize = fileSizes.get(p.join(this.path, pathInCompressed));
			if (expectedSize && stat.size !== expectedSize)
				return false;

			return true;
		}
		catch (error) {
			return false;
		}
	}

	this.removeTmp = function (name) {

		return removePathPart(name, this.tmp);

	}

	this.isCompressed = function (name) {

		return compatible.compressed(name);

	}

	this.isFolder = function (path) {

		if (fs.statSync(realPath(path, -1, this.prefixes)).isDirectory())
			return true;

		return false;
	}

	this.folderPathRegExp = false;

	this.folderPath = function (path) {

		if (!this.folderPathRegExp)
			this.folderPathRegExp = new RegExp(pregQuote(p.sep) + '[^' + pregQuote(p.sep) + ']+$');

		return path.replace(this.folderPathRegExp, '');

	}

	this._filesToMultidimension = function (files, dimensions, from = false) {

		const _files = [];

		for (let key in dimensions) {
			const value = dimensions[key];

			if (typeof value === 'number') {
				const file = files[value];

				const data = {
					name: key,
					fixedName: file.fixedName || key,
					originalName: file.originalName || file.fixedName || key,
					path: file.path,
					folder: file.folder ? true : false,
					fileSize: file.fileSize || 0,
					compressed: this.isCompressed(file.name),
				};

				if (file.folder)
					data.files = [];

				_files.push(data);
			}
			else {
				const _name = from ? p.join(from, key) : key;

				_files.push({
					name: key,
					path: p.join(this.path, _name),
					folder: true,
					fileSize: 0,
					files: this._filesToMultidimension(files, value, _name),
				});
			}
		}

		return _files;
	}

	this.filesToMultidimension = function (files) {

		files.sort(function (a, b) {

			if (a.name === b.name) // This is technically not possible
				return 0;

			return a.name > b.name ? 1 : -1;

		});

		let dimensions = {};

		let firstFile = files[0];

		for (let i = 0, len = files.length; i < len; i++) {
			let file = files[i];
			let fileIndex = i;
			let segments = splitPath(file.name);

			let dimension = dimensions;

			for (let i = 0, len = segments.length; i < len; i++) {
				let segment = segments[i];

				if (segment) {
					if (!dimension[segment] || typeof dimension[segment] === 'number') dimension[segment] = (i + 1 == len) ? fileIndex : {};
					dimension = dimension[segment];
				}
			}
		}

		let _files = this._filesToMultidimension(files, dimensions);

		return _files;
	}

	this.filesToOnedimension = function (files, _files = [], parentPath = '') {

		for (let i = 0, len = files.length; i < len; i++) {
			let file = files[i];

			let _parentPath = p.join(parentPath, file.name);

			_files.push({ name: file.name, path: file.path, pathInCompressed: _parentPath, folder: file.folder, compressed: file.compressed })

			if (file.files)
				_files = this.filesToOnedimension(file.files, _files, _parentPath);
		}

		return _files;
	}

	this.whenExtractFile = function (path) {

		if (this.callbackWhenFileExtracted) {
			let name = p.basename(path);

			let file = {
				name: name,
				path: path,
				folder: this.isFolder(path),
				compressed: this.isCompressed(name),
			};

			globalWhenExtractFile(path);
			this.callbackWhenFileExtracted(file);
		}
		else {
			globalWhenExtractFile(path);
		}

	}

	this.rejectAllWhenExtractFile = function () {

		for (let i = 0, len = this.config._only.length; i < len; i++) {
			globalWhenExtractFileReject(p.join(this.path, this.config._only[i]));
		}

	}

	this.progressIndex = 0;
	this.progressPrev = false;

	this.progress = {};

	this.setProgress = function (progress, index = false) {

		index = index !== false ? index : this.contentRightIndex;

		if (!progress)
			this.progressPrev = false;

		if (this.progress && this.progress.multiply)
			progress = progress * this.progress.multiply;

		const loading = document.querySelector('.content-right .content-right-' + index + ' .loading.loading96');
		events.loadingProgress(loading, progress);

	}

	this.stackOnlyInTasks = function (only, stackSize = 100) {

		const tasks = [];

		if (only) {
			for (let i = 0, len = Math.ceil(only.length / stackSize); i < len; i++) {
				tasks.push(only.slice(i * stackSize, i * stackSize + stackSize));
			}

			return tasks;
		}
		else {
			return [only];
		}

	}

	this.getOptimalTask = function (fileSize, status, optimalFileSize, maxItems, numThreads) {

		if (!status.tasks[status.current])
			status.tasks[status.current] = { size: 0, items: 0 };

		let current = status.current;
		let task = status.tasks[current];

		if (!status.fullSize) {
			task.size += fileSize;
			task.items++;

			if (task.size > optimalFileSize)
				status.current++;

			if (status.current >= numThreads) {
				status.fullSize = true;
				status.current = 0;
			}
		}
		else if (!status.full) {
			let full = true;

			for (let t = status.current; t < numThreads; t++) {
				task = status.tasks[t];

				if (task.items >= maxItems)
					continue;

				status.current = t;
				full = false;

				break;
			}

			current = status.current;
			status.current++;

			task.size += fileSize;
			task.items++;

			if (full) {
				status.full = true;
				status.current = numThreads;
			}
			else if (status.current >= numThreads) {
				status.current = 0;
			}
		}
		else {
			task.size += fileSize;
			task.items++;

			if (task.items >= maxItems)
				status.current++;
		}

		return current;

	}

	this.stackBySize = function (only, optimalFileSize = 30, maxItems = 100) {

		if (!only)
			return [only];

		optimalFileSize *= 1024 * 1024; // In bytes

		const numThreads = threads.num();
		const tasks = [];

		const status = {
			tasks: {},
			current: 0,
			fullSize: false,
			full: false,
		};

		for (let i = 0, len = only.length; i < len; i++) {
			const name = only[i];
			const fileSize = fileSizes.get(p.join(this.path, name)) ?? (1024 * 100); // If the size is not known, it is considered to be 100KB.

			const task = this.getOptimalTask(fileSize, status, optimalFileSize, maxItems, numThreads);

			if (!tasks[task]) tasks[task] = [];
			tasks[task].push(name);
		}

		return tasks;

	}

	this.isFullyWrittenToDisk = async function (path, realPath, prevDiskSize = 0, intent = 0) {

		const fileSize = fileSizes.get(path) ?? 0;
		const stat = await fsp.stat(realPath);
		const diskSize = stat.size;

		if ((intent < 6 || prevDiskSize !== diskSize) && (diskSize !== fileSize || (intent === 0 && diskSize === 0))) // Not fully written to disk, try again in 5 milliseconds
		{
			await app.sleep(5);

			return this.isFullyWrittenToDisk(path, realPath, diskSize, intent + 1);
		}

		return true;

	}

	this.fixUnsupportedCharsInWindows = function (path) {

		if (process.platform !== 'win32')
			return path;

		// Replace dots and spaces at the end of the filename
		path = path.replace(/([\. ]+)([\\\/]|$)/g, function (match, unsupported, separator) {

			return '_'.repeat(unsupported.length) + separator;

		});

		// Replace unsupported characters
		path = path.replace(/[<>:|?*"]/g, '_');

		return path;

	}

	this.getOptimalThreads = function () {

		const disk = diskType.check(this.realPath);

		if (disk.hdd)
			return { readKey: 'readUsingThreadsHDD', extractKey: 'extractUsingThreadsHDD', read: threads.SINGLE, extract: threads.SINGLE };
		else
			return { readKey: 'readUsingThreads', extractKey: 'extractUsingThreads', read: threads.ALL, extract: threads.ALL };

	}

	// 7z
	this._7z = false;

	this.open7z = async function (extract = false, only = '') {

		// Not support this cache
		// if(this._7z) return this._7z;

		if (un7z === false) un7z = require('node-7z');
		if (bin7z === false) bin7z = asarToAsarUnpacked(require('7zip-bin-full').path7z);

		this.macosStartAccessingSecurityScopedResource(this.realPath);

		if (extract) {
			if (only) {
				only = (Array.isArray(only) ? only : [only]).map(item => item.startsWith('-') ? './' + item : item);
			}
			this._7z = un7z.extractFull(this.realPath, this.tmp, { $bin: bin7z, $progress: true, $cherryPick: only, charset: 'UTF-8', listFileCharset: 'UTF-8', password: filePassword.get(this.realPath) });
		}
		else
			this._7z = un7z.list(this.realPath, { $bin: bin7z, charset: 'UTF-8', listFileCharset: 'UTF-8', password: filePassword.get(this.realPath) });

		return this._7z;

	}

	// ---------------------------------------------------------------------------------------
	// In-process ZIP fast path.
	//
	// CBZ is by far the most common archive in a comic library and is just a ZIP, almost always
	// with its images STOREd rather than deflated — so a page is a plain byte range. Going
	// through 7-Zip means spawning a process to list the archive and another to extract, which
	// on a 279MB/192-page CBZ measured 420ms to list and 126ms per page, versus 23ms and 14ms
	// reading the central directory in-process.
	//
	// Only ZIP-family archives take this path, and any failure (encrypted entries, unusual
	// variants, malformed archives) falls back to the existing 7-Zip implementation, so CBR,
	// CB7, RAR and friends are completely unaffected.
	// ---------------------------------------------------------------------------------------

	this.canUseZipFastPath = function () {

		// No password pre-check: yauzl rejects encrypted entries on its own and both callers
		// fall back to 7-Zip on any error, which handles those correctly (including prompting).
		return /\.(cbz|zip)$/i.test(this.realPath);

	}

	this.openZip = function () {

		if (yauzl === false) yauzl = require('yauzl');

		const realPath = this.realPath;

		return new Promise(function (resolve, reject) {

			yauzl.open(realPath, { lazyEntries: true, autoClose: false, decodeStrings: true }, function (error, zip) {

				if (error) reject(error);
				else resolve(zip);

			});

		});

	}

	this.readZipEntries = function (zip) {

		return new Promise(function (resolve, reject) {

			const entries = [];

			zip.on('entry', function (entry) {

				// Directory entries end with a separator and carry no data.
				if (!/[\\/]$/.test(entry.fileName))
					entries.push(entry);

				zip.readEntry();

			});

			zip.on('end', function () { resolve(entries) });
			zip.on('error', reject);

			zip.readEntry();

		});

	}

	this.readZip = async function () {

		const zip = await this.openZip();

		try
		{
			const entries = await this.readZipEntries(zip);
			const files = [];

			for (let i = 0, len = entries.length; i < len; i++) {
				const entry = entries[i];

				const originalName = this.removeTmp(p.normalize(entry.fileName));
				const name = this.fixUnsupportedCharsInWindows(originalName);
				const same = originalName === name ? true : false;

				files.push({
					name: name,
					fixedName: (!same ? name : ''),
					originalName: (!same ? originalName : ''),
					path: p.join(this.path, name),
					fileSize: entry.uncompressedSize,
				});

				this.setFileStatus(name, { extracted: false });
			}

			// Must end exactly as read7z() does. A ZIP entry name carries its full path inside the
			// archive ("Some Folder/page001.jpg"), and the rest of the app expects that expanded into
			// the nested structure read7z() produces: entries whose `name` is just the leaf, plus
			// `folder: true` nodes holding their children.
			//
			// Returning the flat list broke every archive whose pages sit inside a wrapping folder,
			// which is how most omnibus/scanlation releases are packed. Opening one makes the reader
			// descend into that folder, which routes through readInsideCompressed() ->
			// _readFromFilesList(), and that searches for a node named after the folder — which a flat
			// list does not contain, since its only entries are named "Some Folder/page001.jpg".
			// ComicInfo.xml inside a subfolder was missed for the same reason, and a nested archive
			// lacked the `compressed` flag that tells it apart from a page.
			//
			// Assigning this.files also restores the per-object read cache; without it every read
			// reopened and reparsed the archive.
			this.files = this.filesToMultidimension(files);

			return this.files;
		}
		finally
		{
			try { zip.close(); } catch (e) { }
		}

	}

	this.writeZipEntry = function (zip, entry, toPath) {

		return new Promise(function (resolve, reject) {

			zip.openReadStream(entry, function (error, readStream) {

				if (error) return reject(error);

				fs.mkdirSync(p.dirname(toPath), { recursive: true });

				const writeStream = fs.createWriteStream(toPath);

				readStream.on('error', reject);
				writeStream.on('error', reject);
				writeStream.on('finish', resolve);

				readStream.pipe(writeStream);

			});

		});

	}

	this.extractZip = async function () {

		const self = this;
		const zip = await this.openZip();

		try
		{
			const entries = await this.readZipEntries(zip);
			const only = this.config._only || false;
			const onlyLen = only ? only.length : 0;

			// config._only holds the (possibly Windows-sanitised) names; map back to the real
			// entry names the archive uses, exactly as extract7z() does.
			const wanted = {};

			for (let i = 0; i < onlyLen; i++) {
				const file = only[i];
				wanted[fileOriginalName.get(file) || file] = true;
			}

			this.progressIndex = 1;

			for (let i = 0, len = entries.length; i < len; i++) {
				const entry = entries[i];
				const originalName = self.removeTmp(p.normalize(entry.fileName));

				if (onlyLen && !wanted[originalName])
					continue;

				const name = self.fixUnsupportedCharsInWindows(originalName);
				const path = p.join(self.path, name);
				const realPath = p.join(self.tmp, name);

				await self.writeZipEntry(zip, entry, realPath);

				if (onlyLen)
					self.setProgress(self.progressIndex++ / onlyLen);
				else
					self.setProgress((i + 1) / len);

				try { fileManager.setTmpUsage(realPath); } catch (e) { }

				self.setFileStatus(name, { extracted: true });
				self.whenExtractFile(path);
			}

			return;
		}
		finally
		{
			try { zip.close(); } catch (e) { }
		}

	}

	this.read7z = async function (callback = false) {

		// ZIP archives are read in-process; anything unexpected falls back to 7-Zip below.
		if (this.canUseZipFastPath()) {
			try {
				return await this.readZip();
			}
			catch (error) {
				console.warn('Warning: ZIP fast path failed, falling back to 7-Zip | ' + this.path, error);
			}
		}


		const self = this;
		const optimalThreads = this.getOptimalThreads();

		return threads.job(optimalThreads.readKey, { useThreads: optimalThreads.read }, async function () {

			return new Promise(async function (resolve, reject) {

				let readSome = false;
				let endEvent = false;

				const files = [];
				const _7z = await self.open7z();

				_7z.on('data', function (data) {

					if (data.file) {
						if (/^D/.test(data.attributes) && !data.size) // Ignore directories
							return;

						const originalName = self.removeTmp(p.normalize(data.file));
						const name = self.fixUnsupportedCharsInWindows(originalName);
						const same = originalName === name ? true : false;

						files.push({ name: name, fixedName: (!same ? name : ''), originalName: (!same ? originalName : ''), path: p.join(self.path, name), fileSize: data.size });
						self.setFileStatus(name, { extracted: false });

						readSome = true;
					}

				}).on('end', function (data) {

					endEvent = true;

					self.files = self.filesToMultidimension(files);
					resolve(self.files);

				}).on('error', function (error) {

					if (readSome) {
						//self.saveErrorToCache(error);
						dom.compressedError(error, false, sha1(self.path), self.path);

						// Just in case the 'end' event is not called
						setTimeout(function () {

							if (endEvent)
								return;

							self.files = self.filesToMultidimension(files);
							resolve(self.files);

						}, 5000);
					}
					else {
						reject(error);
					}

				});

			});

		});

	}

	this.extract7z = async function () {

		// Same fast path as read7z(): stream ZIP entries straight to the temp folder instead of
		// spawning 7-Zip. The files land in exactly the same place with the same status/progress
		// side effects, so nothing downstream can tell the difference.
		if (this.canUseZipFastPath()) {
			try {
				return await this.extractZip();
			}
			catch (error) {
				console.warn('Warning: ZIP extract fast path failed, falling back to 7-Zip | ' + this.path, error);
			}
		}

		const self = this;
		const optimalThreads = this.getOptimalThreads();

		const only = [];
		const extractName = {};

		const onlyLen = this.config._only ? this.config._only.length : false;

		// Use the original file name and not the extracted one, which may be different on Windows due to incompatibility with certain characters (fixUnsupportedCharsInWindows)
		for (let i = 0; i < onlyLen; i++) {
			const file = this.config._only[i];
			const originalName = fileOriginalName.get(file) || file;

			if (!extractName[originalName]) {
				extractName[originalName] = file;
				only.push(originalName);
			}
		}

		this.progressIndex = 1;

		const tasks = this.stackBySize(only || false, 30, 100);
		const promises = [];

		for (let i = 0, len = tasks.length; i < len; i++) {
			const onlyStack = tasks[i];

			let extractedSome = false;
			let hasError = false;

			promises.push(threads.job(optimalThreads.extractKey, { useThreads: optimalThreads.extract }, async function () {

				return new Promise(async function (resolve, reject) {

					const waitDisk = [];
					const _7z = await self.open7z(true, onlyStack);

					_7z.on('data', function (data) {

						const extract = data.status == 'extracted' ? true : false;

						if (extract) {
							waitDisk.push(new Promise(async function (_resolve) {

								self.setProgress(self.progressIndex++ / onlyLen);

								let name = self.removeTmp(p.normalize(data.file));
								name = extractName[name] || name;

								const path = p.join(self.path, name);
								const realPath = p.join(self.tmp, name);

								await self.isFullyWrittenToDisk(path, realPath);

								// Mark the extracted temp file as in-use so cleanup won't remove it
								try { fileManager.setTmpUsage(realPath); } catch (e) { }

								self.setFileStatus(name, { extracted: extract });
								self.whenExtractFile(path);

								extractedSome = true;
								_resolve();

							}));
						}

					}).on('progress', function (progress) {

						if (!onlyLen)
							self.setProgress(progress.percent / 100);

					}).on('end', async function () {

						if (!hasError) {
							await Promise.all(waitDisk);
							resolve();
						}

					}).on('error', async function (error) {

						hasError = true;

						if (filePassword.check(error)) {
							if (fs.existsSync(self.tmp))
								fs.rmSync(self.tmp, { recursive: true });

							if (!self.config.fromThumbnailsGeneration) {
								const password = await filePassword.request(self.path);

								if (password) {
									if (!fs.existsSync(self.tmp))
										fs.mkdirSync(self.tmp);

									resolve(self.extract7z());
								}
								else {
									self.rejectAllWhenExtractFile();
									reject(error);
								}
							}
							else {
								self.rejectAllWhenExtractFile();
								reject(error);
							}
						}
						else if (extractedSome) {
							self.saveErrorToCache(error);
							dom.compressedError(error, false, sha1(self.path), self.path);

							await Promise.all(waitDisk);
							resolve();
						}
						else {
							reject(error);
						}

					});

				});

			}));

		}

		await Promise.all(promises);

		this.setProgress(1);

		return;
	}


	// PDF
	this.pdf = false;
	this.pdfFastRead = false;
	// True while `this.files` holds the synthetic thumbnail-only page list from readPdf().
	this.partialRead = false;

	this.openPdf = async function () {

		if (this.pdf) return this.pdf;

		if (unpdf === false) await loadPdfjs();

		this.macosStartAccessingSecurityScopedResource(this.realPath);

		let pdfOptions = {
			url: encodeURIComponent(this.realPath).replace(/\%2F/g, '/').replace(/\%5C/g, '\\').replace(/\%3A/g, ':'),
			wasmUrl: fileManager.posixPath(asarToAsarUnpacked(p.join(appDir, 'node_modules/pdfjs-dist/wasm/'))),
			cMapUrl: fileManager.posixPath(asarToAsarUnpacked(p.join(appDir, 'node_modules/pdfjs-dist/cmaps/'))),
			cMapPacked: true,
		};

		// Local filesystem PDFs can fail in pdf.js with "Unexpected server response (200)"
		// when range/stream transport is used in Electron. Disable it for file paths.
		if (!isServer(this.path)) {
			pdfOptions.disableRange = true;
			pdfOptions.disableStream = true;
			pdfOptions.disableAutoFetch = true;
		}

		// For thumbnail generation, minimize memory by preventing pdfjs from pre-loading the entire PDF
		if (this.config.fromThumbnailsGeneration) {
			pdfOptions.disableAutoFetch = true;
			pdfOptions.disableStream = true;
			pdfOptions.disableFontFace = true;
		}

		try {
			this.pdf = await unpdf.getDocument(pdfOptions).promise;
		}
		catch (error) {
			const responseError = error && error.name === 'ResponseException' && /Unexpected server response \(200\)/i.test(error.message || '');

			// Fallback to direct file bytes for local files when URL transport fails.
			if (!isServer(this.path) && responseError) {
				const buffer = await fsp.readFile(this.realPath);
				const dataOptions = {
					data: new Uint8Array(buffer),
					wasmUrl: pdfOptions.wasmUrl,
					cMapUrl: pdfOptions.cMapUrl,
					cMapPacked: true,
					disableRange: true,
					disableStream: true,
					disableAutoFetch: true,
				};

				if (this.config.fromThumbnailsGeneration) {
					dataOptions.disableAutoFetch = true;
					dataOptions.disableFontFace = true;
				}

				this.pdf = await unpdf.getDocument(dataOptions).promise;
			}
			else {
				throw error;
			}
		}

		return this.pdf;

	}

	this.useFastPdfRead = async function (pdf = false) {

		if (this.config.fromThumbnailsGeneration)
			return false;

		pdf = pdf || await this.openPdf();

		if ((pdf?.numPages || 0) >= 120)
			return true;

		if (!isServer(this.path)) {
			try {
				if (fs.statSync(this.realPath).size >= 100 * 1024 * 1024)
					return true;
			}
			catch (error) {}
		}

		return false;

	}

	this.updatePdfPageSizeCache = function (file, size = false) {

		const width = Math.max(1, Math.round(size?.width || 0));
		const height = Math.max(1, Math.round(size?.height || 0));

		if (!file || !width || !height)
			return false;

		const nextSize = { width: width, height: height };
		const status = this.getFileStatus(file) || {};
		const prevSize = status.size || {};
		const changed = status.sizeApproximate || prevSize.width !== width || prevSize.height !== height;

		if (!changed)
			return false;

		this.setFileStatus(file, {
			size: nextSize,
			sizeApproximate: false,
		});

		if (Array.isArray(this.files)) {
			const entry = this.files.find(function (current) {
				return current?.name === file;
			});

			if (entry)
				entry.size = nextSize;
		}

		const json = cache.readJson(this.cacheFile);
		if (json && Array.isArray(json.files)) {
			const entry = json.files.find(function (current) {
				return current?.name === file;
			});

			if (entry) {
				entry.size = nextSize;
				try {
					if (!forceFullReadInProgress[this.cacheFile])
						cache.writeJson(this.cacheFile, json);
					else
						console.log('[updatePdfPageSizeCache] skipping write due to forceFullReadInProgress', this.cacheFile, file);
				}
				catch (e) { }
			}
		}

		return true;

	}

	this.readPdf = async function () {

		let _this = this;

		let files = [];

		if (this.config.forceFullRead)
			this.config.fromThumbnailsGeneration = false;

		// For thumbnail generation, skip loading the entire PDF just for metadata.
		// Return a synthetic page-1 entry with dummy dimensions — the actual rendering
		// happens in extractPdf which will open the PDF only briefly for page 1.
		// The entry is explicitly tagged so it can never be mistaken for a real one-page PDF,
		// persisted to the on-disk index, or handed to the reader.
		if (this.config.fromThumbnailsGeneration) {
			let file = 'page-0001.jpg';
			let size = { width: 800, height: 1200 };
			files.push({ name: file, path: p.join(this.path, file), folder: false, compressed: false, size: size, page: 1, partialRead: true });
			this.setFileStatus(file, { page: 1, extracted: false, size: size });
			this.partialRead = true;
			return this.files = files;
		}

		this.partialRead = false;

		let pdf = await this.openPdf();
		let pages = pdf.numPages;
		let leadingZeros = Math.max(String(pages).length, 4);
		this.pdfFastRead = await this.useFastPdfRead(pdf);

		if (this.pdfFastRead) {
			let firstPage;
			let retries = 5;
			while (retries > 0) {
				try {
					if (!this.pdf) pdf = await this.openPdf();
					firstPage = await pdf.getPage(1);
					break;
				} catch (e) {
					if (e.message && (e.message.includes('Invalid page request') || e.message.includes('Worker was destroyed') || e.message.includes('Transport destroyed'))) {
						this.pdf = null;
						retries--;
						if (retries === 0) throw e;
						await new Promise(r => setTimeout(r, 100));
					} else {
						throw e;
					}
				}
			}

			const viewport = firstPage.getViewport({ scale: 1 });
			const defaultSize = {
				width: viewport.width,
				height: viewport.height,
			};
			firstPage.cleanup();

			for (let i = 1; i <= pages; i++) {
				let file = 'page-' + String(i).padStart(leadingZeros, '0') + '.jpg';
				let size = {
					width: defaultSize.width,
					height: defaultSize.height,
				};

				files.push({ name: file, path: p.join(this.path, file), folder: false, compressed: false, size: size, page: i });
				this.setFileStatus(file, { page: i, extracted: false, size: size, sizeApproximate: i !== 1 });
			}

			return this.files = files;
		}

		for (let i = 1; i <= pages; i++) {
			let file = 'page-' + String(i).padStart(leadingZeros, '0') + '.jpg';

			let page;
			let retries = 5;
			while (retries > 0) {
				try {
					if (!this.pdf) pdf = await this.openPdf();
					page = await pdf.getPage(i);
					break;
				} catch (e) {
					if (e.message && (e.message.includes('Invalid page request') || e.message.includes('Worker was destroyed') || e.message.includes('Transport destroyed'))) {
						this.pdf = null;
						retries--;
						if (retries === 0) throw e;
						// Yield to let concurrent destruction resolve gracefully
						await new Promise(r => setTimeout(r, 100));
					} else {
						throw e;
					}
				}
			}

			let viewport = page.getViewport({ scale: 1 });

			let size = { width: viewport.width, height: viewport.height };

			files.push({ name: file, path: p.join(this.path, file), folder: false, compressed: false, size: size, page: i });
			this.setFileStatus(file, { page: i, extracted: false, size: size });
		}

		return this.files = files;

	}

	this.parsePdfMetadataXml = function (xml) {

		const find = function (key, value) {

			const isObject = (typeof value === 'object' && !Array.isArray(value) && value !== null);
			const keys = isObject ? Object.keys(value) : 0;
			const len = keys.length;
			let object = {};

			if (len === 1) {
				const _key = keys[0];

				if (_key === 'rdf:value')
					object[key] = value[_key];
				else
					object = { ...object, ...find(key, value[_key]) };
			}
			else if (len > 1) {
				for (let _key in value) {
					if (_key === 'rdf:value')
						object[key] = value[_key];
					else
						object = { ...object, ...find(_key, value[_key]) };
				}
			}
			else {
				object[key] = Array.isArray(value) ? value.join(', ') : value;
			}

			return object;

		}

		let metadata = {};

		for (let i = 0, len = xml.length; i < len; i++) {
			for (let key in xml[i]) {
				const object = find(key, xml[i][key]);
				metadata = { ...metadata, ...object };
			}
		}

		for (let key in metadata) {
			const _key = app.extract(/([^:]+)$/, key, 1).toLowerCase();
			if (!metadata[_key]) metadata[_key] = metadata[key];

			const _key2 = key.replace(/:/g, '_').toLowerCase();
			if (!metadata[_key2]) metadata[_key2] = metadata[key];
		}

		return metadata;

	}

	this.readPdfMetadata = async function () {

		let pdf;
		let metadata;
		let retries = 5;
		while (retries > 0) {
			try {
				if (!this.pdf) pdf = await this.openPdf();
				else pdf = this.pdf;
				metadata = await pdf.getMetadata();
				break;
			} catch (e) {
				if (e.message && (e.message.includes('Invalid page request') || e.message.includes('Worker was destroyed') || e.message.includes('Transport destroyed'))) {
					this.pdf = null;
					retries--;
					if (retries === 0) throw e;
					await new Promise(r => setTimeout(r, 100));
				} else {
					throw e;
				}
			}
		}

		let map = {};

		if (metadata.metadata) {
			let _map = Object.fromEntries(metadata.metadata);
			map._map = _map;

			for (let key in _map) {
				let item = _map;

				let _key = app.extract(/([^:]+)$/, key, 1);
				if (!map[_key]) map[_key] = Array.isArray(_map[key]) ? _map[key].join(', ') : _map[key];
			}
		}

		if (fastXmlParser === false) {
			fastXmlParser = require('fast-xml-parser').XMLParser;
			fastXmlParser = new fastXmlParser({ ignoreAttributes: false });
		}

		let metadataXml = {};

		if (metadata.metadata) {
			metadataXml = fastXmlParser.parse(metadata.metadata.getRaw('data'));
			metadataXml = this.parsePdfMetadataXml(metadataXml?.['x:xmpmeta']?.['rdf:RDF']?.['rdf:Description'] || {});
		}

		return {
			title: metadata.info.Title || map.title || '',
			series: metadataXml.calibre_series || metadataXml.series || map.series || '',

			bookNumber: metadataXml.calibresi_series_index || metadataXml.series_index || map.series_index || app.extract(/([0-9.]+)$/, map.series ?? '') || 0,

			author: map.creator || metadata.info.Author || '',
			publisher: map.publisher || '',

			subject: metadata.info.Subject || [],

			description: app.stripTagsWithDOM(map.description || metadata.info.Description || metadata.info.Subject || ''),

			language: metadataXml.language || map.language || metadata.info.Language || '',

			web: map.identifier ? app.extract(/^(?:url|uri):(.*)/iu, map.identifier) : '',
			identifier: map.identifier,

			releaseDate: map.metadatadate || '',
			modifiedDate: map.modifydate || '',

			creatorTool: map.creatortool || '',
			ISBN: metadataXml.isbn || map.isbn || '',

			metadata: {
				info: metadata.info,
				map: map,
			},
		};

	}

	this.extractPdf = async function () {

		let pdf = await this.openPdf();
		let pages = pdf.numPages;
		let leadingZeros = Math.max(String(pages).length, 4);

		let only = this.config.only;

		// When 'only' filter is set, extract just those specific pages instead of iterating ALL pages
		let pagesToExtract = [];
		if (only) {
			for (let fileName in only) {
				let match = fileName.match(/page-(\d+)\.jpg/);
				if (match) pagesToExtract.push(parseInt(match[1], 10));
			}
			pagesToExtract.sort((a, b) => a - b);
		}

		// For thumbnail generation with no 'only' filter, only extract page 1
		if (!only && this.config.fromThumbnailsGeneration) {
			pagesToExtract = [1];
		}

		let totalFiles = pagesToExtract.length || pages;
		let progressIndex = 1;

		let pageList = pagesToExtract.length > 0 ? pagesToExtract : Array.from({ length: pages }, (_, i) => i + 1);

		for (let pi = 0; pi < pageList.length; pi++) {
			let i = pageList[pi];
			if (i > pages) continue;
			let file = 'page-' + String(i).padStart(leadingZeros, '0') + '.jpg';
			let path = p.join(this.tmp, file);
			let virtualPath = p.join(this.path, file);

			let status = this.getFileStatus(file);

			if ((!only || only[file]) && (this.config.force || !status.extracted || status.width !== this.config.width || !fs.existsSync(path))) {
				// Render page
				let page;
				let retries = 5;
				while (retries > 0) {
					try {
						if (!this.pdf) pdf = await this.openPdf();
						page = await pdf.getPage(i);
						break;
					} catch (e) {
						if (e.message && (e.message.includes('Invalid page request') || e.message.includes('Worker was destroyed') || e.message.includes('Transport destroyed'))) {
							this.pdf = null;
							retries--;
							if (retries === 0) throw e;
							await new Promise(r => setTimeout(r, 100));
						} else {
							throw e;
						}
					}
				}

				let width = (status?.size?.width || page.getViewport({ scale: 1 }).width);

				let scale = this.config.width / width;
				let viewport = page.getViewport({ scale: scale });

				let canvas = document.createElement('canvas');
				canvas.width = viewport.width;
				canvas.height = viewport.height;
				let context = canvas.getContext('2d');

				try {
					await page.render({ canvasContext: context, viewport: viewport }).promise;
				}
				catch (error) {
					const isCancelled = error && (error.name === 'RenderingCancelledException' || /Rendering cancelled/i.test(error.message || ''));

					// Cancellation is expected when rapidly switching pages/views; skip silently.
					if (isCancelled) {
						canvas.width = 0;
						canvas.height = 0;
						canvas = null;
						context = null;
						page.cleanup();
						continue;
					}

					throw error;
				}

				let imageData = canvas.toDataURL('image/jpeg', 1);

				try {
					fs.writeFileSync(path, Buffer.from(imageData.replace(/^data:image\/[a-z]+;base64,/, ''), 'base64'));
				} catch (e) {
					if (e.code !== 'ENOENT') console.error('Error writing PDF thumbnail:', e);
				}

				// Mark the extracted temp file as in-use so cleanup won't remove it
				try {
					fileManager.setTmpUsage(path);
				} catch (e) { /* best-effort */ }

				// Free canvas and image data immediately to prevent memory accumulation
				canvas.width = 0;
				canvas.height = 0;
				canvas = null;
				context = null;
				imageData = null;

				this.setFileStatus(file, { page: i, extracted: true, width: this.config.width });

				this.setProgress(progressIndex++ / totalFiles);
				this.whenExtractFile(virtualPath);

				page.cleanup();
			}
		}

		// Destroy PDF immediately after thumbnail extraction to free memory
		if (this.config.fromThumbnailsGeneration && this.pdf) {
			this.pdf.destroy();
			this.pdf = null;
		}

		this.setProgress(1);

		return;

	}

	this.renderBlobPdf = async function (file) {

		let pdf = await this.openPdf();
		let pages = pdf.numPages;

		let status = this.getFileStatus(file);

		if (status) {
			this.log('renderBlobPdf');
			let page;
			let retries = 5;
			while (retries > 0) {
				try {
					if (!this.pdf) pdf = await this.openPdf();
					page = await pdf.getPage(status.page);
					break;
				} catch (e) {
					if (e.message && (e.message.includes('Invalid page request') || e.message.includes('Worker was destroyed') || e.message.includes('Transport destroyed'))) {
						this.pdf = null;
						retries--;
						if (retries === 0) throw e;
						await new Promise(r => setTimeout(r, 100));
					} else {
						throw e;
					}
				}
			}

			const originalViewport = page.getViewport({ scale: 1 });
			const originalSize = {
				width: originalViewport.width,
				height: originalViewport.height,
			};

			let scale = this.config.width / originalSize.width;
			let viewport = page.getViewport({ scale: scale });
			const renderWidth = Math.max(1, Math.round(viewport.width));
			const renderHeight = Math.max(1, Math.round(viewport.height));

			let canvas = document.createElement('canvas');
			canvas.width = viewport.width = renderWidth;
			canvas.height = viewport.height = renderHeight;
			let context = canvas.getContext('2d');

			if (this.pdfFastRead) {
				context.fillStyle = '#ffffff';
				context.fillRect(0, 0, canvas.width, canvas.height);
			}

			try {
				await page.render({ canvasContext: context, viewport: viewport }).promise;
			}
			catch (error) {
				const isCancelled = error && (error.name === 'RenderingCancelledException' || /Rendering cancelled/i.test(error.message || ''));

				if (isCancelled) {
					canvas.width = 0;
					canvas.height = 0;
					canvas = null;
					context = null;
					page.cleanup();

					return false;
				}

				throw error;
			}

			const blob = await new Promise((resolve) => {
				if (this.pdfFastRead)
					canvas.toBlob(resolve, 'image/jpeg', 0.9);
				else
					canvas.toBlob(resolve, 'image/png');
			});

			// Free canvas immediately after blob creation to prevent memory accumulation
			canvas.width = 0;
			canvas.height = 0;
			canvas = null;
			context = null;

			const sizeUpdated = this.updatePdfPageSizeCache(file, originalSize);
			page.cleanup();

			this.setFileStatus(file, { rendered: true, widthRendered: this.config.width });

			return {
				blob: URL.createObjectURL(blob),
				width: renderWidth,
				height: renderHeight,
				size: blob.size,
				originalWidth: originalSize.width,
				originalHeight: originalSize.height,
				sizeUpdated: sizeUpdated,
			};
		}

		return false;
	}

	// ePub
	this.epub = false;

	this.openEpub = async function () {

		if (this.epub) return this.epub;

		if (ebook.epub === false)
			ebook.epub = require(p.join(appDir, '.dist/ebook/epub.js'));

		this.macosStartAccessingSecurityScopedResource(this.realPath);
		this.epub = ebook.epub.load(this.realPath);

		return this.epub;

	}

	this.readEpub = async function () {

		let _this = this;

		let files = [];

		let epub = await this.openEpub();
		let _files = await epub.readEpubFiles();

		for (let i = 0, len = _files.length; i < len; i++) {
			let file = _files[i];

			files.push({ name: file, path: p.join(this.path, file), folder: false, compressed: false });
			this.setFileStatus(file, { extracted: false });
		}

		return this.files = files;

	}

	this.readEpubMetadata = async function () {

		let epub = await this.openEpub();
		let metadata = await epub.readEpubMetadata();

		return {
			title: metadata.title || '',
			series: metadata.series || '',

			bookNumber: metadata.seriesIndex || '',

			author: metadata.creator || '',
			publisher: metadata.publisher || '',
			contributor: metadata.contributor || [],

			/*author: comicInfo.Writer || '',
			writer: comicInfo.Writer || '',
			penciller: comicInfo.Penciller || '',
			inker: comicInfo.Inker || '',
			colorist: comicInfo.Colorist || '',
			letterer: comicInfo.Letterer || '',
			coverArtist: comicInfo.CoverArtist || '',
			editor: comicInfo.Editor || '',
			translator: comicInfo.Translator || '',
			publisher: comicInfo.Publisher || '',
			imprint: comicInfo.Imprint || '',*/

			subject: metadata.subject || [],
			genre: metadata.genre || '',

			description: metadata.description || '',
			longDescription: metadata.longDescription || '',
			rights: metadata.rights || '',

			language: metadata.language || '',

			web: metadata.identifier ? app.extract(/^(?:url|uri):(.*)/iu, metadata.identifier) : '',
			identifier: metadata.identifier,
			source: metadata.source,

			releaseDate: metadata.pubdate || '',
			modifiedDate: metadata.modified_date || '',

			ISBN: app.extract(/isbn:([0-9\-\.]+)/iu, metadata.identifier) || '',

			metadata: metadata,
		};

	}

	this.extractEpub = async function () {

		let epub = await this.openEpub();
		let only = this.config.only;
		let _this = this;

		let files = await this.read();
		files = this.filesToOnedimension(files);

		let filesToRender = [];

		for (let i = 0, len = files.length; i < len; i++) {
			let file = files[i].pathInCompressed;
			let path = p.join(this.tmp, file);
			let virtualPath = p.join(this.path, file);

			let status = this.getFileStatus(file);

			if ((!only || only[file]) && (this.config.force || !status.extracted || status.width !== this.config.width || !fs.existsSync(path))) {
				filesToRender.push({
					name: file,
					path: path,
				});
			}
		}

		let totalFiles = filesToRender.length;
		let progressIndex = 1;

		if (!onReading) {
			if (epub.extracted)
				this.setProgress(0.5);
			else
				this.setProgress(0);
		}

		await epub.renderFiles(filesToRender, { width: this.config.width }, function (file) {

			let path = p.join(_this.tmp, file);
			let virtualPath = p.join(_this.path, file);

			_this.setFileStatus(file, { extracted: true, width: _this.config.width });

			_this.setProgress(epub.extracted ? (0.5 + progressIndex++ / totalFiles / 2) : (progressIndex++ / totalFiles));

			// Mark the extracted temp file as in-use so cleanup won't remove it
			try { fileManager.setTmpUsage(path); } catch (e) { }

			_this.whenExtractFile(virtualPath);

		});

		if (!onReading)
			this.setProgress(1);

		return;

	}

	this.renderEpubPage = async function (file, canvas) {


	}

	this.ebookPagesEpub = async function (config = {}) {

		this.time('ebookPagesEpub: ' + this.path);

		const debug = (stage, payload = {}) => {
			try {
				console.log('[epub-debug][file-manager]['+stage+']', {
					path: this.path,
					...payload,
				});
			}
			catch (error) {}
		};

		const startedAt = Date.now();
		debug('start', {config: {width: config?.width, height: config?.height}});

		let timeoutST = false;
		let pages = { pages: [], toc: [], landmarks: false };

		try
		{
			const isTimeoutError = function (error, label) {
				const message = String(error?.message || '');
				return message.indexOf(label + ':') === 0;
			};

			const withTimeout = function (promise, timeout, label) {
				return new Promise(function (resolve, reject) {
					let done = false;

					const st = setTimeout(function () {
						if (done) return;
						done = true;
						reject(new Error(label + ': ' + timeout + 'ms'));
					}, timeout);

					Promise.resolve(promise).then(function (res) {
						if (done) return;
						done = true;
						clearTimeout(st);
						resolve(res);
					}).catch(function (error) {
						if (done) return;
						done = true;
						clearTimeout(st);
						reject(error);
					});
				});
			};

			let epub = false;
			try
			{
				debug('openEpub:begin');
				epub = await withTimeout(this.openEpub(), 45000, 'ebookPagesEpub.openEpubTimeout');
				debug('openEpub:ok');
			}
			catch(error)
			{
				if(isTimeoutError(error, 'ebookPagesEpub.openEpubTimeout'))
				{
					debug('openEpub:timeout-retry');
					epub = await this.openEpub();
					debug('openEpub:retry-ok');
				}
				else
				{
					debug('openEpub:error', {error: String(error?.message || error)});
					throw error;
				}
			}
			let _this = this;

			let totalFiles = 0;

			try
			{
				debug('readEpubFiles:begin');
				const epubFiles = await withTimeout(epub.readEpubFiles(), 30000, 'ebookPagesEpub.readEpubFilesTimeout');
				totalFiles = Array.isArray(epubFiles) ? epubFiles.length : 0;
				debug('readEpubFiles:ok', {totalFiles: totalFiles});
			}
			catch(error)
			{
				if(!isTimeoutError(error, 'ebookPagesEpub.readEpubFilesTimeout'))
				{
					debug('readEpubFiles:error', {error: String(error?.message || error)});
					throw error;
				}

				debug('readEpubFiles:timeout-fallback');
			}

			if(totalFiles <= 0)
				totalFiles = Math.max(1, +(epub?.epub?.spine?.items?.length || 1));

			debug('pagination:begin', {totalFiles: totalFiles});

			let progressIndex = 1;

			if (epub.extracted)
				this.setProgress(0.5);
			else
				this.setProgress(0);

			pages = await epub.epubPages(config, function () {

				// _this.setFileStatus(file, {extracted: true, width: _this.config.width});
				_this.setProgress(epub.extracted ? (0.5 + progressIndex++ / totalFiles / 2) : (progressIndex++ / totalFiles));

			});

			debug('pagination:ok', {
				pages: pages?.pages?.length || 0,
				toc: pages?.toc?.length || 0,
				durationMs: Date.now() - startedAt,
			});
		}
		catch (error)
		{
			console.error(error);
			debug('error', {
				error: String(error?.message || error),
				stack: String(error?.stack || ''),
				durationMs: Date.now() - startedAt,
			});
		}
		finally
		{
			if (timeoutST) clearTimeout(timeoutST);
			this.setProgress(1);
			this.timeEnd('ebookPagesEpub: ' + this.path);
			debug('end', {
				pages: pages?.pages?.length || 0,
				toc: pages?.toc?.length || 0,
				durationMs: Date.now() - startedAt,
			});
		}

		if (!pages || !pages.pages)
			return { pages: [], toc: [], landmarks: false };

		return pages;

	}

	this.ebookEpub = async function () {

		let epub = await this.openEpub();
		return epub.ebook;

	}

	this.macosScopedResources = [];

	this.macosStartAccessingSecurityScopedResource = function (path) {

		if (macosMAS) {
			let securityScopedBookmarks = storage.get('securityScopedBookmarks');
			let segments = splitPath(path);

			if (!segments[0])
				segments[0] = p.sep;

			for (let i = 1, len = segments.length; i < len; i++) {
				let _path = p.join(...segments);
				let bookmark = securityScopedBookmarks[_path] || false;

				if (bookmark) {
					try {
						this.macosScopedResources.push(electronRemote.app.startAccessingSecurityScopedResource(bookmark));
						break;
					}
					catch { }
				}

				segments.pop();
			}
		}

	}

	this.destroy = function () {

		if (this.tar) this.tar.destroy();
		if (this.pdf) this.pdf.destroy();
		if (this.epub) this.epub.destroy();

		delete this.zip;
		delete this._7z;
		delete this.rar;
		delete this.tar;
		delete this.pdf;
		delete this.epub;

		this.filesStatus = {};

		// Stop accessing security scoped resources
		for (let i = 0, len = this.macosScopedResources.length; i < len; i++) {
			this.macosScopedResources[i]();
		}

		this.macosScopedResources = [];

	}

}

var fileDataInMap = new Set();
var fileSizes = new Map();
var fileOriginalName = new Map();

function _setFileData(files) {
	for (let i = 0, len = files.length; i < len; i++) {
		const file = files[i];

		if (file.files) {
			_setFileData(file.files);
		}
		else {
			if (file.fileSize)
				fileSizes.set(file.path, file.fileSize);

			if (file.fixedName && file.originalName)
				fileOriginalName.set(file.fixedName, file.originalName);
		}
	}
}

function setFileData(path, files) {
	if (fileDataInMap.has(path))
		return;

	fileDataInMap.add(path);
	_setFileData(files);
}

var extractingPromises = {};
var extractingPromisesST = {};

function setGlobalExtracting(path) {
	extractingPromisesST[path] = setTimeout(function () {

		globalWhenExtractFileReject(path, new Error('extractTimeout: ' + path));

	}, 600000);

	let _resolve = false;
	let _reject = false;

	extractingPromises[path] = {
		promise: new Promise(async function (resolve, reject) {

			_resolve = resolve;
			_reject = reject;

		}),
		resolve: false,
		reject: false,
	};

	extractingPromises[path].resolve = _resolve;
	extractingPromises[path].reject = _reject;
}

function getGlobalExtracting(path) {
	return extractingPromises[path] || false;
}

function globalWhenExtractFile(path) {
	if (extractingPromisesST[path]) clearTimeout(extractingPromisesST[path]);
	delete extractingPromisesST[path];

	if (extractingPromises[path]) {
		const globalExtracting = extractingPromises[path];
		delete extractingPromises[path];
		globalExtracting.resolve();
	}
}

function globalWhenExtractFileReject(path, error = false) {
	if (extractingPromisesST[path]) clearTimeout(extractingPromisesST[path]);
	delete extractingPromisesST[path];

	if (extractingPromises[path]) {
		const globalExtracting = extractingPromises[path];
		delete extractingPromises[path];
		globalExtracting.reject(error || new Error('extractRejected: ' + path));
	}
}

// Use this to remove generated vector images if window.devicePixelRatio is changed
async function removeTmpVector() {
	let file = fileManager.file(tempFolder);
	let folders = await file.read();

	let devicePixelRatio = window.devicePixelRatio;

	for (let i = 0, len = folders.length; i < len; i++) {
		let folder = folders[i];
		let vector = p.join(tempFolder, folder.name, folder.name + '-opencomic-is-vector.txt');

		if (fs.existsSync(vector)) {
			let _devicePixelRatio = +readFile(vector);

			if (devicePixelRatio !== _devicePixelRatio)
				fs.rm(p.join(tempFolder, folder.name), { recursive: true, force: true }, function () { });
		}
	}
}

var downloadedCompressedFiles = {
	list: [],
	sizes: {},
};
// Guard map to prevent cache writes while a forceFullRead is in progress for a compressed cache file
var forceFullReadInProgress = {};

// A "partial" file list is the synthetic single page that readPdf() returns when it is only
// asked to produce a thumbnail. It must never be persisted to the on-disk index, kept in the
// shared in-memory index, or handed to the reader — doing so is what made an opened file show
// only its first page until its cache was cleared by hand.
//
// New lists carry an explicit `partialRead` marker; the name/page test is the fallback that
// recognises lists already written to disk by earlier versions, which had no marker.
function isPartialFileList(files) {
	if (!Array.isArray(files) || files.length !== 1)
		return false;

	const first = files[0] || {};

	if (first.partialRead === true)
		return true;

	return +first.page === 1 && /^page-0*1\.(?:jpg|jpeg|png)$/i.test(first.name || '');
}

function downloadedCompressedFile(path) {
	let realPath = fileManager.realPath(path, -1);

	let totalSize = 0;
	let list = [];

	for (let i = 0, len = downloadedCompressedFiles.list.length; i < len; i++) {
		let _realPath = downloadedCompressedFiles.list[i];

		if (fs.existsSync(_realPath) && _realPath !== realPath) {
			let size = downloadedCompressedFiles.sizes[_realPath] || fs.statSync(_realPath).size;

			downloadedCompressedFiles.sizes[_realPath] = size;
			list.push(_realPath);

			totalSize += size;
		}
	}

	downloadedCompressedFiles.list = list;
	downloadedCompressedFiles.list.push(realPath);

	let size = downloadedCompressedFiles.sizes[realPath] || fs.statSync(realPath).size;

	downloadedCompressedFiles.sizes[realPath] = size;
	totalSize += size;

	let maxSize = ((config.tmpMaxSize || 2) / 2) * 1000 * 1000 * 1000; // 50% of tmpMaxSize

	if (totalSize > maxSize) {
		let list = [];
		let sizes = {};

		for (let i = 0, len = downloadedCompressedFiles.list.length; i < len; i++) {
			let _realPath = downloadedCompressedFiles.list[i];
			let size = downloadedCompressedFiles.sizes[_realPath] || fs.statSync(_realPath).size;

			if (totalSize > maxSize) {
				if (fs.existsSync(_realPath)) {
					totalSize -= size;
					fs.unlinkSync(_realPath);
				}
			}
			else {
				list.push(_realPath);
				sizes[_realPath] = size;
			}
		}

		downloadedCompressedFiles.list = list;
		downloadedCompressedFiles.sizes = sizes;
	}
}

function realPath(path, index = 0, prefixes = false) {
	const _isServer = isServer(path);
	const segments = splitPath(_isServer ? serverClient.fixPath(path) : path);
	const len = segments.length;
	const numSegments = len + index;

	let virtualPath;

	let newPath = virtualPath = (len > 0) ? (isEmpty(segments[0]) ? '/' : segments[0]) : '';

	if (_isServer) {
		let adress = p.normalize(serverClient.getAdress(path));

		newPath = p.join(tempFolder, sha1(adress));
		virtualPath = adress;

		if (!segments[1])
			segments[0] = segments[1] = segments[2] = '';
		else
			segments[0] = segments[1] = '';
	}

	for (let i = 1; i < len; i++) {
		newPath = p.join(newPath, segments[i]);
		virtualPath = p.join(virtualPath, segments[i]);

		if (i < numSegments) {
			const extension = app.extnameC(newPath);

			if (extension) {
				if (compatible.compressed.has(extension) /* && fs.existsSync(newPath) && !fs.statSync(newPath).isDirectory()*/) {
					let sha = sha1(p.normalize(virtualPath));

					if (prefixes) {
						for (let ext in prefixes) {
							if (compatible.compressed[ext].has(extension)) {
								sha = prefixes[ext] + '-' + sha;

								break;
							}
						}
					}

					newPath = p.join(tempFolder, sha);
				}
				else if (compatible.image.convert.has(extension) && i + 1 === len) {
					const sha = sha1(p.dirname(p.normalize(virtualPath)));

					let image = p.basename(virtualPath);
					image = image + '.png';

					newPath = p.join(tempFolder, sha, image);
				}
			}
		}
	}

	return newPath;
}

async function convertUnsupportedImages(files) {
	const promises = [];

	for (let i = 0, len = files.length; i < len; i++) {
		const file = files[i];
		const path = file.path;

		if (!file.folder && !file.compressed && compatible.image.convert(path)) // Convert unsupported images
			promises.push(workers.convertImage(path));
	}

	await Promise.all(promises);

	return true;
}

async function blobUnsupportedImages(files, options = { useThreads: 1 }) {
	const promises = [];

	for (let i = 0, len = files.length; i < len; i++) {
		const file = files[i];
		const path = file.path;

		if (!file.folder && !file.compressed && compatible.image.blob(path)) // Convert unsupported images to Blob
			promises.push(workers.convertImageToBlob(path, options));
	}

	await Promise.all(promises);

	return true;
}

var tmpUsageST = false, tmpUsageQueue = [];

function setTmpUsage(path) {
	tmpUsageQueue.push(path);

	if (tmpUsageST === false) {
		tmpUsageST = setTimeout(function () {

			tmpUsageST = false;

			const len = tmpUsageQueue.length;
			if (len === 0) return;

			const time = app.time();
			const tmpUsage = storage.get('tmpUsage');

			for (let i = 0; i < len; i++) {
				const path = tmpUsageQueue[i];

				if (!tmpUsage[path]) tmpUsage[path] = {};
				tmpUsage[path].lastAccess = time;
			}

			storage.setThrottle('tmpUsage', tmpUsage);
			tmpUsageQueue = [];

		}, 1000);
	}
}

var serverInOfflineMode = false;

function setServerInOfflineMode(value = false) {
	serverInOfflineMode = value;
}

function isServer(path) {
	if (/^(?:\.[\/\\]+)?(?:smb|ssh|sftp|scp|ftp|ftps|s3|webdavs?|opdsfs?)\:[\/\\]{1,2}/.test(path))
		return true;

	return false;
}

function isOpds(path) {
	if (/^(?:\.[\/\\]+)?(?:opds)\:[\/\\]{1,2}/.test(path))
		return true;

	return false;
}

function isBase64(path) {
	if (/^base64,/.test(path))
		return true;

	return false;
}

function isCompressed(name) {
	return compatible.compressed(name);
}

function firstCompressedFile(path, index = 0, checkDirectory = true) {
	let segments = splitPath(path);
	let len = segments.length;

	let newPath = (len > 0) ? (isEmpty(segments[0]) ? '/' : segments[0]) : '';
	let numSegments = len + index;

	let _isServer = isServer(path);

	for (let i = 1; i < len; i++) {
		newPath = join(newPath, segments[i]);

		if (i < numSegments) {
			if (compatible.compressed(newPath) && (!checkDirectory || _isServer || !fs.existsSync(newPath) || !fs.statSync(newPath).isDirectory()))
				return newPath;
		}
	}

	return newPath;
}

function firstCompressedFileRealPath(path, index = 0) {
	return isServer(path) ? realPath(firstCompressedFile(path, index), -1) : firstCompressedFile(path, index);
}


function lastCompressedFile(path, index = 0) {
	let segments = splitPath(path);
	let len = segments.length;

	let newPath = (len > 0) ? (isEmpty(segments[0]) ? '/' : segments[0]) : '';
	let numSegments = len + index;

	let lastCompressed = false;

	for (let i = 1; i < len; i++) {
		newPath = join(newPath, segments[i]);

		if (i < numSegments) {
			if (compatible.compressed(newPath))
				lastCompressed = newPath;
		}
	}

	return lastCompressed;
}

function allCompressedFiles(path, index = 0) {
	let segments = splitPath(path);
	let len = segments.length;

	let newPath = (len > 0) ? (isEmpty(segments[0]) ? '/' : segments[0]) : '';
	let numSegments = len + index;

	let lastCompressed = false;

	let files = [];

	for (let i = 1; i < len; i++) {
		newPath = join(newPath, segments[i]);

		if (i < numSegments) {
			if (compatible.compressed(newPath))
				files.push(newPath);
		}
	}

	return files;
}

// `fileManager.file(path).getType()` is a cheap fs.existsSync + fs.statSync check, but the
// `file` object it runs on allocates ~47 closures per construction (every `this.x = function`
// in the constructor). Call sites that only want {folder, compressed} and discard the object
// immediately — folder metadata lookups, reading-progress lookups, and every visible library
// card while scrolling a large folder — do that allocation for nothing. This does the same
// check with none of it.
function getPathType(path) {
	const result = { folder: false, compressed: false };

	if (!path || !fs.existsSync(path))
		return result;

	if (compatible.compressed(path))
		result.compressed = true;
	else if (fs.statSync(path).isDirectory())
		result.folder = true;

	return result;
}

function containsCompressed(path, index = 0) {
	let segments = splitPath(path);
	let len = segments.length;

	var virtualPath = (len > 0) ? (isEmpty(segments[0]) ? '/' : segments[0]) : '';
	let numSegments = len + index;

	let _isServer = isServer(path);

	for (let i = 1; i < len; i++) {
		virtualPath = p.join(virtualPath, segments[i]);

		if (i < numSegments) {
			if (compatible.compressed(virtualPath) && (_isServer || !fs.statSync(virtualPath).isDirectory())) {
				return true;
			}
		}
	}

	return false;
}

function compressedMetadata(path = false) {
	if (!path) return false;

	const sha = sha1(p.normalize(path));
	const cacheFile = 'compressed-files-' + sha + '.json';

	if (cache.existsJson(cacheFile))
		return cache.readJson(cacheFile).metadata || false;

	return false;
}

function join() {
	const string = p.join.apply(null, arguments);
	return serverClient.fixPath(string);
}

function normalize() {
	const string = p.normalize.apply(null, arguments);
	return serverClient.fixPath(string);
}

function splitPath(path) {
	const first = app.extract(/^([\\\/]*[^\\\/]+)[\\\/]*/, path);
	const segments = path.replace(/^([\\\/]*[^\\\/]+)[\\\/]*/, '').split(p.sep).filter(i => i);

	segments.unshift(first);

	return segments;
}

function isParentPath(parentPath, fullPath) {
	parentPath = serverClient.fixPath(parentPath);
	fullPath = serverClient.fixPath(fullPath);

	parentPath = parentPath.endsWith(p.sep) ? parentPath : parentPath + p.sep;
	fullPath = fullPath.endsWith(p.sep) ? fullPath : fullPath + p.sep;

	return fullPath.startsWith(parentPath);
}

function removePathPart(path, partToRemove) {
	path = serverClient.fixPath(path);
	partToRemove = serverClient.fixPath(partToRemove);

	path = path.startsWith(partToRemove) ? path.slice(partToRemove.length) : path;
	path = path.startsWith(p.sep) ? path.slice(p.sep.length) : path;

	return path;
}

function pathType(path) {
	if (compatible.image(path))
		return { folder: false, compressed: false };
	else if (compatible.compressed(path))
		return { folder: false, compressed: true };
	else if (fs.statSync(path).isDirectory())
		return { folder: true, compressed: false };
	else
		return false;
}

function posixPath(path) {
	return path.split(p.sep).join(p.posix.sep);
}

function simpleExists(path, server = false) {
	if (isServer(path) || isOpds(path)) {
		// TODO: Check if server path exists from cache file list

		return true;
	}
	else {
		path = firstCompressedFile(path, 0, false);

		if (fs.existsSync(path))
			return true;
	}

	return false;
}

function replaceReservedCharacters(filename) {
	return filename.replace(/[/\\?%*:|"<>]/g, '-');
}

function genearteFilePath(saveTo, fileName) {
	let path = p.join(saveTo, fileName);

	const extension = p.extname(fileName);
	const imageName = p.basename(fileName, extension);

	for (let i = 1; i < 100; i++) {
		if (!fs.existsSync(path))
			break;

		path = p.join(saveTo, imageName + ' (' + i + ')' + extension);
	}

	return path;
}

var _ignoreFilesRegex = false, ignoreFilesRegexCache = {};

function ignoreFilesRegex(ignoreFilesRegex = false, force = false) {
	ignoreFilesRegex = ignoreFilesRegex || config.ignoreFilesRegex || [];

	if (!force) {
		if (_ignoreFilesRegex)
			return _ignoreFilesRegex;
	}

	const len = ignoreFilesRegex.length;

	if (!len) {
		_ignoreFilesRegex = false;

		return false;
	}

	ignoreFilesRegexCache = {};
	const list = [];

	for (let i = 0; i < len; i++) {
		let pattern = ignoreFilesRegex[i];
		let flags = 'iu';

		let regex = false;

		if (/\/.*\/[a-z]*/.test(pattern)) // Is Regex
		{
			flags = app.extract(/\/.*\/([a-z]*)/, pattern, 1);
			pattern = app.extract(/\/(.*)\/[a-z]*/, pattern, 1);

			regex = new RegExp(pattern, flags);
		}
		else // Is File Pattern
		{
			if (Minimatch === false)
				Minimatch = require('minimatch').Minimatch;

			const mm = new Minimatch(pattern, {
				// noCase: true,
				nocomment: true,
				noglobstar: true,
				optimizationLevel: 2,
			});

			regex = mm.makeRe();
		}

		list.push(regex);
	}

	let i = 0;

	_ignoreFilesRegex = {
		test: function (string) {

			if (ignoreFilesRegexCache[string] !== undefined)
				return ignoreFilesRegexCache[string];

			let match = false;

			for (i = 0; i < len; i++) {
				const regex = list[i];

				if (regex.test(string)) {
					match = true;
					break;
				}
			}

			if (string.length < 1000) // Avoid cache too long strings
				ignoreFilesRegexCache[string] = match;

			return match;

		},
		list: list,
	};

	return _ignoreFilesRegex;
}

function filtered(files, specialFiles = false, ignoreFiles = true) {
	const ignore = ignoreFiles ? ignoreFilesRegex() : false;
	const filtered = [];

	if (files) {
		for (let i = 0, len = files.length; i < len; i++) {
			const file = files[i];
			const specialFile = (specialFiles && !file.folder && !file.compressed && compatible.image.special(file.path)) ? true : false;

			if (ignore && ignore.test(file.name) && !specialFile)
				continue;

			if (file.folder || file.compressed)
				filtered.push(file);
			else if (compatible.image(file.path) || specialFile)
				filtered.push(file);
		}
	}

	return filtered;
}

function sort(files, options = {}) {
	if (files) {
		const extraKey = options?.extraKey ?? '';

		const sort = config['sort' + extraKey];
		const sortInvert = config['sortInvert' + extraKey];
		const foldersFirst = config['foldersFirst' + extraKey];
		const compressedFirst = config['compressedFirst' + extraKey];

		let order = '';

		if (sort == 'name')
			order = 'simple';
		else if (sort == 'numeric')
			order = 'numeric';
		else
			order = 'simple-numeric';

		files.sort(function (a, b) {

			const aFirst = (foldersFirst && a.folder) || (compressedFirst && a.compressed);
			const bFirst = (foldersFirst && b.folder) || (compressedFirst && b.compressed);

			if (aFirst && !bFirst)
				return -1;

			if (bFirst && !aFirst)
				return 1;

			return (sortInvert) ? -(dom.orderBy(a, b, order, 'name')) : dom.orderBy(a, b, order, 'name');
		});

		return files;
	}

	return files;
}

function macosSecurityScopedBookmarks(files) {
	if (macosMAS && files.bookmarks && files.bookmarks[0]) {
		let securityScopedBookmarks = storage.get('securityScopedBookmarks');

		for (let i = 0, len = files.bookmarks.length; i < len; i++) {
			securityScopedBookmarks[p.normalize(files.filePaths[i])] = files.bookmarks[i];
		}

		storage.set('securityScopedBookmarks', securityScopedBookmarks);
	}
}

var macosScopedResources = {};
var macosScopedResourcesST1 = false;
var macosScopedResourcesST2 = false;

function macosStartAccessingSecurityScopedResource(path) {

	if (macosMAS) {
		const securityScopedBookmarks = storage.get('securityScopedBookmarks');
		const segments = splitPath(path);

		if (!segments[0])
			segments[0] = p.sep;

		let start = false;

		for (let i = 1, len = segments.length; i < len; i++) {
			const _path = p.join(...segments);
			const bookmark = securityScopedBookmarks[_path] || false;

			if (bookmark) {
				try {
					if (macosScopedResources[_path]) {
						macosScopedResources[_path].used = Date.now();
					}
					else {
						macosScopedResources[_path] = {
							used: Date.now(),
							stop: electronRemote.app.startAccessingSecurityScopedResource(bookmark),
						};
					}

					start = true;

					break;
				}
				catch { }
			}

			segments.pop();
		}

		if (start) {
			// Throttling
			if (macosScopedResourcesST1 === false) {
				macosScopedResourcesST1 = setTimeout(function () {

					macosStopAccessingSecurityScopedResource();
					macosScopedResourcesST1 = false;

				}, 500);
			}

			// Debounce
			if (macosScopedResourcesST2 !== false) clearTimeout(macosScopedResourcesST2);
			macosScopedResourcesST2 = setTimeout(function () {

				macosStopAccessingSecurityScopedResource();
				macosScopedResourcesST2 = false;

			}, 1000 * 5);
		}
	}
}

// Stop accessing security scoped resources
function macosStopAccessingSecurityScopedResource() {
	for (let path in macosScopedResources) {
		const resource = macosScopedResources[path];

		if (Date.now() - resource.used > 1000 * 5) {
			resource.stop();
			delete macosScopedResources[path];
		}
	}
}

// Code from https://github.com/sindresorhus/read-chunk
async function readChunk(filePath, { length, startPosition }) {
	const fileDescriptor = await fsp.open(filePath, 'r');

	try {
		let { bytesRead, buffer } = await fileDescriptor.read({
			buffer: new Uint8Array(length),
			length,
			position: startPosition,
		});

		if (bytesRead < length)
			buffer = buffer.subarray(0, bytesRead);

		return buffer;
	}
	finally {
		await fileDescriptor?.close();
	}
}

async function dirSize(dir) {
	let stat = await fsp.stat(dir);
	if (!stat.isDirectory())
		return stat.size;

	let files = await fsp.readdir(dir, { withFileTypes: true });
	let size = 0;

	for (let i = 0, len = files.length; i < len; i++) {
		let file = files[i];
		let path = p.join(dir, file.name);

		if (file.isDirectory())
			size += await dirSize(path);
		else if (file.isFile())
			size += (await fsp.stat(path)).size;
	}

	return size;
}

function dirSizeSync(dir) {
	let stat = fs.statSync(dir);
	if (!stat.isDirectory())
		return stat.size;

	let files = fs.readdirSync(dir, { withFileTypes: true });
	let size = 0;

	for (let i = 0, len = files.length; i < len; i++) {
		let file = files[i];
		let path = p.join(dir, file.name);

		if (file.isDirectory())
			size += dirSizeSync(path);
		else if (file.isFile())
			size += fs.statSync(path).size;
	}

	return size;
}

function copyToTmp(path) {
	const name = p.basename(path);
	const tmp = p.join(tempFolder, sha1(p.dirname(path)));

	const newPath = p.join(tmp, sha1(name) + p.extname(name));

	if (!fs.existsSync(tmp))
		fs.mkdirSync(tmp, { recursive: true });

	if (!fs.existsSync(newPath))
		fs.copyFileSync(path, newPath);

	const tmpUsage = storage.get('tmpUsage');

	if (!tmpUsage[newPath]) tmpUsage[newPath] = {};
	tmpUsage[newPath].lastAccess = app.time();

	storage.setThrottle('tmpUsage', tmpUsage);

	return newPath;
}

var blobObjectsURL = {};

function fileToBlob(path) {
	if (blobObjectsURL[path]) return blobObjectsURL[path];

	const data = fs.readFileSync(path);

	const blob = new Blob([data], { type: compatible.mime.get(path) });
	const blobURL = URL.createObjectURL(blob);

	blobObjectsURL[path] = blobURL;
	return blobObjectsURL[path];
}

function bufferToBlob(path, buffer, mime = 'image/png') {
	if (blobObjectsURL[path]) return blobObjectsURL[path];

	const blob = new Blob([buffer], { type: mime });
	const blobURL = URL.createObjectURL(blob);

	blobObjectsURL[path] = blobURL;
	return blobObjectsURL[path];
}

function getBlob(path) {
	if (blobObjectsURL[path]) return blobObjectsURL[path];
	return false;
}

function revokeObjectURL(key) {
	if (!blobObjectsURL[key]) return;

	URL.revokeObjectURL(blobObjectsURL[key]);
	delete blobObjectsURL[key];
}

function revokeAllObjectURL() {
	for (let key in blobObjectsURL) {
		URL.revokeObjectURL(blobObjectsURL[key]);
	}

	blobObjectsURL = {};
}

var prevDevicePixelRatio = window.devicePixelRatio;

window.addEventListener('resize', function () {

	if (prevDevicePixelRatio !== window.devicePixelRatio) {
		prevDevicePixelRatio = window.devicePixelRatio;

		removeTmpVector();
	}

});

var compressedOpened = {};

function closeAllCompressed() {
	for (let path in compressedOpened) {
		compressedOpened[path].compressed.destroy();
		delete compressedOpened[path];
	}
	compressedOpened = {};
}

function cleanCompressedOpened(excludePath) {

	let compressed = [];

	for (let path in compressedOpened) {
		if (path === excludePath) continue; // Never clean the caller's entry
		compressed.push({ path: path, lastUsage: compressedOpened[path].lastUsage });
	}

	compressed.sort(function (a, b) {

		if (a.lastUsage === b.lastUsage)
			return 0;

		return a.lastUsage < b.lastUsage ? 1 : -1;
	});

	let len = compressed.length;

	if (len > 10) // Keep max 10 compressed files to avoid aborting active background thumbnail extractions
	{
		for (let i = 10; i < len; i++) {
			let p = compressed[i].path;
			compressedOpened[p].compressed.destroy();
			delete compressedOpened[p];
		}
	}
}

module.exports = {
	file: function (path, _config = false) {
		return new file(path, _config);
	},
	getPathType: getPathType,
	fileCompressed: function (path, realPath = false, forceType = false, prefixes = false, _config = false) { // This consider moving it to a separate file
		if (!forceType && path && containsCompressed(path) && !compatible.compressed(path)) {
			const compressedPath = lastCompressedFile(path);
			if (compressedPath) {
				path = compressedPath;
				realPath = false;
			}
		}

		return new fileCompressed(path, realPath, forceType, prefixes, _config);
	},
	closeAllCompressed: closeAllCompressed,
	removeTmpVector: removeTmpVector,
	removePathPart: removePathPart,
	filtered: filtered,
	ignoreFilesRegex: ignoreFilesRegex,
	sort: sort,
	realPath: realPath,
	pathType: pathType,
	posixPath: posixPath,
	isCompressed: isCompressed,
	isServer: isServer,
	isOpds: isOpds,
	isBase64: isBase64,
	setServerInOfflineMode: setServerInOfflineMode,
	serverInOfflineMode: function () { return serverInOfflineMode },
	firstCompressedFile: firstCompressedFile,
	lastCompressedFile: lastCompressedFile,
	containsCompressed: containsCompressed,
	compressedMetadata: compressedMetadata,
	join: join,
	normalize: normalize,
	splitPath: splitPath,
	isParentPath: isParentPath,
	simpleExists: simpleExists,
	replaceReservedCharacters: replaceReservedCharacters,
	genearteFilePath: genearteFilePath,
	convertUnsupportedImages: convertUnsupportedImages,
	blobUnsupportedImages: blobUnsupportedImages,
	setTmpUsage: setTmpUsage,
	macosScopedResources: function () { return macosScopedResources },
	macosSecurityScopedBookmarks: macosSecurityScopedBookmarks,
	macosStartAccessingSecurityScopedResource: macosStartAccessingSecurityScopedResource,
	readChunk: readChunk,
	dirSize: dirSize,
	dirSizeSync: dirSizeSync,
	copyToTmp: copyToTmp,
	fileToBlob: fileToBlob,
	bufferToBlob: bufferToBlob,
	getBlob: getBlob,
	revokeObjectURL: revokeObjectURL,
	revokeAllObjectURL: revokeAllObjectURL,
	fileSizes: function () { return fileSizes },
	requestFileAccess: requestFileAccess,
	filePassword: filePassword,
	diskType: diskType,
}
