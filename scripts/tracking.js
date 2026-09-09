const folderMetadataSchema = require(p.join(appDir, '.dist/tracking/folder-metadata.js'));
const folderTitle = require(p.join(appDir, '.dist/tracking/folder-title.js'));

const METADATA_SCRAPE_MIN_CONFIDENCE = 70;
const METADATA_SCRAPE_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days
const METADATA_SCRAPE_RETRY_COOLDOWN = 1000 * 60 * 60 * 6; // 6 hours
// The 6-hour cooldown above only lives in an in-memory Map, reset on every app restart - so a
// folder AniList has never matched (an obscure title, a fan translation, a typo'd folder name)
// got re-queried and re-searched on literally every single launch, forever, with no backoff
// across sessions. For a large library that is a sustained, evenly-paced burst of outbound
// requests at every startup regardless of how many of them fail the same way every time -
// exactly the kind of fixed-cadence automated pattern Cloudflare's bot management flags,
// independent of anything about the request itself. This is the durable, cross-session backoff
// for that case (see metadata.lastAttemptAt, folder-metadata.js).
const METADATA_SCRAPE_NO_MATCH_COOLDOWN = 1000 * 60 * 60 * 24 * 21; // 21 days
const METADATA_SCRAPE_QUEUE_DELAY = 2200;
const METADATA_SCRAPE_QUEUE_BATCH_SIZE = 24;
const METADATA_SCRAPE_QUEUE_DELAY_FAST = 500;
const METADATA_SCRAPE_QUEUE_FAST_COUNT = 8;
const METADATA_UI_REFRESH_THROTTLE = 1600;
const METADATA_UI_REFRESH_ACTIVE_THROTTLE = 4000;
const TRACKING_METADATA_DEBUG = false;

var sitesScripts = {};

function loadSiteScript(site)
{
	if(!sitesScripts[site])
	{
		const siteData = app.copy(trackingSites.site(site));

		if(siteData)
		{
			siteData.config.access.pass = storage.safe.decrypt(siteData.config.access.pass);
			siteData.config.access.token = storage.safe.decrypt(siteData.config.access.token);
			siteData.config.session.token = storage.safe.decrypt(siteData.config.session.token);
			siteData.config.session.refreshToken = storage.safe.decrypt(siteData.config.session.refreshToken);

			sitesScripts[site] = require(siteData.script);
			sitesScripts[site].setSiteData(siteData);
		}
	}
}

function setSiteData(site)
{
	const siteData = app.copy(trackingSites.site(site));

	if(siteData)
	{
		siteData.config.access.pass = storage.safe.decrypt(siteData.config.access.pass);
		siteData.config.access.token = storage.safe.decrypt(siteData.config.access.token);
		siteData.config.session.token = storage.safe.decrypt(siteData.config.session.token);
		siteData.config.session.refreshToken = storage.safe.decrypt(siteData.config.session.refreshToken);

		loadSiteScript(site);
		sitesScripts[site].setSiteData(siteData);
	}
}

var tracked = {}, trackST = [], trackIndex = 0;

async function track(chapter = false, volume = false, onlySite = false, reduceIfTrackingAtTheEndIsEnabled = false, fromTrackImage = false, force = false)
{
	await app.sleep(200);

	let fromDialog = false;

	if(chapter !== false || volume !== false)
	{
		fromDialog = !fromTrackImage;
	}
	else
	{
		chapter = getChapter();
		volume = getVolume();

		if(reduceIfTrackingAtTheEndIsEnabled && config.readingTrackingAtTheEnd)
		{
			chapter = chapter > 1 ? chapter - 1 : false;
			volume = volume > 1 ? volume - 1 : false;
		}
	}

	const _trackingSites = trackingSites.list(true);

	let haveToTracking = false;

	for(let key in _trackingSites)
	{
		if(_trackingSites[key].tracking.active)
			haveToTracking = true;
	}

	if(haveToTracking)
	{
		if(chapter === false && volume === false)
		{
			$('.bar-right-buttons .button-tracking-sites').html('sync_problem').addClass('tracking-problem');
		}
		else
		{
			if(!fromDialog)
				$('.bar-right-buttons .button-tracking-sites').html('sync').removeClass('tracking-problem');

			const mainPath = dom.history.mainPath;

			let chapters = '??';
			let volumes = '??';

			const tracking = storage.getKey('tracking', mainPath);

			for(let site in tracking)
			{
				if(!onlySite || onlySite == site)
				{
					const data = tracking[site];

					if(data.chapters)
						chapters = data.chapters;

					if(data.volumes)
						volumes = data.volumes;

					const lastUpdatedChapters = data.lastUpdatedChapters || 0;

					if(Date.now() - lastUpdatedChapters > 604800000) // One week
					{
						loadSiteScript(site);
						const comicData = (await sitesScripts[site].getComicData(data.id)) || {};
						setTrackingChapters(site, comicData, mainPath);
					}
				}
			}

			let allTracked = true;

			for(const site of _trackingSites)
			{
				const prevTracked = (tracked?.[mainPath]?.[site.key] || []).some((item) => (item.chapter === chapter && item.volume === volume));

				const progress = tracking[site.key]?.progress || {};
				const prevTrackedInSite = ((!chapter || chapter <= progress.chapters) && (!volume || volume <= progress.volumes)) ? true : false;

				if(site.config.session.valid && ((onlySite && onlySite == site.key) || (site.tracking.active && !prevTracked && !prevTrackedInSite && !onlySite)))
					allTracked = false;
			}

			if(!allTracked)
			{
				trackST[trackIndex] = setTimeout(function(vars) {

					for(const site of _trackingSites)
					{
						const prevTracked = (tracked?.[mainPath]?.[site.key] || []).some((item) => (item.chapter === vars.chapter && item.volume === vars.volume));

						if(site.config.session.valid && ((vars.onlySite && vars.onlySite == site.key) || (site.tracking.active && !prevTracked && !vars.onlySite)))
						{
							if(!tracked[mainPath]) tracked[mainPath] = {};
							if(!tracked[mainPath][site.key]) tracked[mainPath][site.key] = [];
							tracked[mainPath][site.key].push({chapter: vars.chapter, volume: vars.volume});

							loadSiteScript(site.key);

							sitesScripts[site.key].track({
								id: site.tracking.id,
								chapters: vars.chapter,
								chaptersInt: vars.chapter ? Math.floor(vars.chapter) : vars.chapter,
								volumes: vars.volume,
								volumesInt: vars.volume ? Math.floor(vars.volume) : vars.volume,
								force: vars.force,
								mainPath: mainPath,
							});
						}
					}

				}, 10500, { // 10.5 seconds to track
					chapter: chapter,
					volume: volume,
					onlySite: onlySite,
					fromTrackImage: fromTrackImage,
					force: !!force,
				});

				// Remove prev

				events.snackbar({
					key: 'trackingConfirm',
					text: language.reading.tracking.marked+': '+(chapter !== false ? language.reading.tracking.chapter+' '+chapter+'/'+chapters : '')+(volume !== false ? (chapter !== false ? ' · ' : '')+language.reading.tracking.volume+' '+volume+'/'+volumes : ''),
					duration: 10,
					update: true,
					buttons: [
						{
							text: language.buttons.dismiss,
							function: 'events.closeSnackbar();',
						},
						{
							text: language.buttons.undo,
							function: 'events.closeSnackbar(); clearTimeout(tracking.trackST()['+trackIndex+'])',
						},
					],
				});

				trackIndex++;
			}
		}
	}
}

var trackImageChapters = new Set();

function trackImage()
{
	let currentPage = reading.currentPage();
	const totalPages = reading.totalPages();
	if(reading.doublePage.active() && totalPages - currentPage === 1) currentPage++;

	const image = reading.getImage(currentPage);
	if(!image) return;

	const name = p.basename(image.path);
	const current = currentImages.find((image) => image.name === name);

	if(!current || (!current.chapter && !current.volume)) return;

	const prev = currentImages.slice(0, current.i).findLast((image) => (image.chapter && image.chapter !== current.chapter) || (image.volume && image.volume !== current.volume)) || false;
	const next = currentImages.slice(current.i + 1).find((image) => (image.chapter && image.chapter !== current.chapter) || (image.volume && image.volume !== current.volume)) || false;

	let _track = false;

	if(config.readingTrackingAtTheEnd)
	{
		if(totalPages === currentPage)
			_track = next || current;
		else
			_track = prev;
	}
	else
	{
		_track = current;
	}

	if(_track && (_track.chapter || _track.volume))
	{
		const key = (_track.chapter || 0)+':'+(_track.volume || 0);

		if(!trackImageChapters.has(key))
		{
			trackImageChapters.add(key);
			track(_track.chapter, _track.volume, false, false, true, false);
		}
	}
}

var currentAutoPrompt = {};
const metadataScrapeInFlight = new Map();
const metadataScrapeCooldown = new Map();
const metadataScrapeQueue = [];
const metadataScrapeQueueSet = new Set();
const metadataScrapeRejectedIds = new Map();
let metadataScrapeQueueActive = false;
let metadataUiRefreshST = false;
let metadataUiRefreshLast = 0;
let metadataUiRefreshPending = false;
const metadataScrapeStats = {
	queued: 0,
	started: 0,
	success: 0,
	unmatched: 0,
	failed: 0,
	retryBlocked: 0,
	lastDurationMs: 0,
	lastFolder: '',
	lastError: '',
};

function logMetadataScrape(event = '', payload = {})
{
	if(!TRACKING_METADATA_DEBUG)
		return;

	try
	{
		console.log('[tracking:metadata]', event, payload || {});
	}
	catch(error)
	{
		console.error(error);
	}
}

function getMetadataRejectedIds(cacheKey = '')
{
	return metadataScrapeRejectedIds.get(cacheKey) || new Set();
}

function rejectMetadataId(cacheKey = '', anilistId = 0)
{
	anilistId = +(anilistId || 0);
	if(!cacheKey || anilistId <= 0)
		return;

	if(!metadataScrapeRejectedIds.has(cacheKey))
		metadataScrapeRejectedIds.set(cacheKey, new Set());

	metadataScrapeRejectedIds.get(cacheKey).add(anilistId);
}

function allowMetadataId(cacheKey = '', anilistId = 0)
{
	anilistId = +(anilistId || 0);
	if(!cacheKey || anilistId <= 0)
		return;

	const rejected = metadataScrapeRejectedIds.get(cacheKey);
	if(!rejected)
		return;

	rejected.delete(anilistId);

	if(!rejected.size)
		metadataScrapeRejectedIds.delete(cacheKey);
}

function getMetadataScrapeStats()
{
	return app.copy(metadataScrapeStats);
}

function metadataScrapeCacheKey(path = '')
{
	return String(path || '').toLowerCase();
}

function metadataDisplayKey(metadata = false)
{
	if(!metadata) return '';

	const genres = Array.isArray(metadata.genres) ? metadata.genres.join('\n') : '';
	const clusters = Array.isArray(metadata?.recommendation?.genreClusters) ? metadata.recommendation.genreClusters.join('\n') : '';

	return [
		metadata.title || '',
		metadata.author || '',
		metadata.seriesType || '',
		metadata.demographic || '',
		metadata.serializationYear || 0,
		metadata.rating || 0,
		metadata.description || '',
		genres,
		metadata?.recommendation?.readingTimeMinutes || 0,
		clusters,
		metadata.source || '',
		metadata.confidence || 0,
	].join('::');
}

function shouldRefreshMetadataUi(folderPath = '', previous = false, next = false)
{
	if(metadataDisplayKey(previous) === metadataDisplayKey(next))
		return false;

	if(typeof dom === 'undefined' || !dom || typeof dom.reload !== 'function')
		return false;

	if(typeof handlebarsContext === 'undefined' || !handlebarsContext?.page?.key)
		return false;

	if(typeof onReading !== 'undefined' && onReading)
		return false;

	const pageKey = handlebarsContext.page.key;

	if(pageKey === 'index')
		return true;

	if(pageKey !== 'browsing')
		return false;

	const browsingPath = dom.history?.path ? p.normalize(dom.history.path) : '';
	if(!browsingPath)
		return false;

	const normalizedFolderPath = p.normalize(folderPath || '');
	const prefix = browsingPath+(browsingPath.endsWith(p.sep) ? '' : p.sep);

	return normalizedFolderPath === browsingPath || normalizedFolderPath.indexOf(prefix) === 0;
}

function queueMetadataUiRefresh()
{
	if(typeof dom === 'undefined' || !dom || typeof dom.reload !== 'function')
		return;

	const queueActive = metadataScrapeQueueActive || metadataScrapeQueue.length;

	// While the scrape queue is running, do not reload at all. dom.reload() rebuilds the whole
	// library page and resets the thumbnail queue with it, so refreshing every few seconds
	// during a long scrape meant thumbnails restarted from scratch over and over and the page
	// kept being torn down under the user. processMetadataScrapeQueue() calls back here once
	// the queue drains, which is when a single refresh actually shows everything at once.
	if(queueActive)
	{
		metadataUiRefreshPending = true;
		return;
	}

	const throttle = METADATA_UI_REFRESH_THROTTLE;

	if(metadataUiRefreshST)
	{
		metadataUiRefreshPending = true;
		return;
	}

	const elapsed = Date.now() - metadataUiRefreshLast;
	const wait = Math.max(0, throttle - elapsed);

	metadataUiRefreshST = setTimeout(function() {

		metadataUiRefreshST = false;
		metadataUiRefreshLast = Date.now();

		if(typeof onReading === 'undefined' || !onReading)
			dom.reload(false, false);

		if(metadataUiRefreshPending)
		{
			metadataUiRefreshPending = false;
			queueMetadataUiRefresh();
		}

	}, wait);
}

function normalizeMetadataQueueOptions(forceOrOptions = false)
{
	if(forceOrOptions && typeof forceOrOptions === 'object')
	{
		return {
			force: !!forceOrOptions.force,
			priority: !!forceOrOptions.priority,
			fast: !!forceOrOptions.fast,
		};
	}

	return { force: !!forceOrOptions, priority: false, fast: false };
}

function needsMetadataScrape(path = false)
{
	const folderPath = getFolderMetadataPath(path);
	if(!folderPath)
		return false;

	const metadata = getFolderMetadata(folderPath);
	if(!metadata)
		return true;

	if(metadata.source === 'manual' || metadata.source === 'import')
		return false;

	// A MyAnimeList match (the automatic backup for when AniList has no match, or is blocking
	// this session's requests - see scrapeFolderMetadata()) is a confirmed match in its own
	// right, not a placeholder to keep retrying AniList for: it does not go through the
	// confidence/rating backfill checks below (MAL's search does not carry a score to have
	// scored a confidence from, and a 0 rating there just means MAL has none, not that the
	// scrape needs redoing), only the same age-based TTL every confirmed match gets.
	if(metadata.source === 'myanimelist' && metadata.malId)
		return !metadata.updatedAt || (Date.now() - metadata.updatedAt) >= METADATA_SCRAPE_TTL;

	if(metadata.source !== 'anilist' || !metadata.anilistId)
	{
		// No confirmed match yet - but if one was already attempted recently (durably, across
		// restarts, unlike the in-memory metadataScrapeCooldown below), leave it be rather than
		// re-querying a title AniList has already failed to match every single time this or any
		// past session has opened this folder.
		if(metadata.lastAttemptAt && (Date.now() - metadata.lastAttemptAt) < METADATA_SCRAPE_NO_MATCH_COOLDOWN)
			return false;

		return true;
	}

	if((metadata.confidence || 0) < METADATA_SCRAPE_MIN_CONFIDENCE)
		return true;

	if((metadata.rating || 0) <= 0)
		return true;

	if(!metadata.seriesType)
		return true;

	if(!metadata.updatedAt)
		return true;

	return (Date.now() - metadata.updatedAt) >= METADATA_SCRAPE_TTL;
}

async function processMetadataScrapeQueue()
{
	if(metadataScrapeQueueActive)
		return;

	metadataScrapeQueueActive = true;

	try
	{
		let processed = 0;

		while(metadataScrapeQueue.length)
		{
			const item = metadataScrapeQueue.shift();
			if(!item) continue;

			const cacheKey = metadataScrapeCacheKey(item.path);
			metadataScrapeQueueSet.delete(cacheKey);

			try
			{
				await scrapeFolderMetadata(item.path, item.force);
			}
			catch(error)
			{
				console.error(error);
			}

			processed++;

			if(metadataScrapeQueue.length)
			{
				const baseDelay = (processed % METADATA_SCRAPE_QUEUE_BATCH_SIZE === 0) ? (METADATA_SCRAPE_QUEUE_DELAY * 3) : METADATA_SCRAPE_QUEUE_DELAY;
				const fastDelay = item.fast || processed <= METADATA_SCRAPE_QUEUE_FAST_COUNT;
				const delay = fastDelay ? METADATA_SCRAPE_QUEUE_DELAY_FAST : baseDelay;
				await app.sleep(delay);
			}
		}
	}
	finally
	{
		metadataScrapeQueueActive = false;

		if(metadataUiRefreshPending)
		{
			metadataUiRefreshPending = false;
			queueMetadataUiRefresh();
		}
	}
}

function queueFolderMetadataScrape(path = false, force = false)
{
	const folderPath = getFolderMetadataPath(path);
	if(!folderPath)
		return false;

	const options = normalizeMetadataQueueOptions(force);
	const shouldForce = !!options.force;

	if(!shouldForce && !needsMetadataScrape(folderPath))
		return false;

	const cacheKey = metadataScrapeCacheKey(folderPath);

	if(metadataScrapeInFlight.has(cacheKey))
		return false;

	if(metadataScrapeQueueSet.has(cacheKey))
	{
		if(shouldForce || options.priority || options.fast)
		{
			for(let i = 0, len = metadataScrapeQueue.length; i < len; i++)
			{
				if(metadataScrapeCacheKey(metadataScrapeQueue[i].path) === cacheKey)
				{
					metadataScrapeQueue[i].force = metadataScrapeQueue[i].force || shouldForce;
					metadataScrapeQueue[i].priority = metadataScrapeQueue[i].priority || options.priority;
					metadataScrapeQueue[i].fast = metadataScrapeQueue[i].fast || options.fast || options.priority;
					break;
				}
			}
		}

		return false;
	}

	metadataScrapeQueueSet.add(cacheKey);
	const entry = {
		path: folderPath,
		force: shouldForce,
		priority: !!options.priority,
		fast: !!options.fast || !!options.priority,
	};

	if(options.priority)
		metadataScrapeQueue.unshift(entry);
	else
		metadataScrapeQueue.push(entry);
	metadataScrapeStats.queued++;
	metadataScrapeStats.lastFolder = folderPath;
	logMetadataScrape('queued', {
		path: folderPath,
		force: shouldForce,
		queueSize: metadataScrapeQueue.length,
	});

	processMetadataScrapeQueue().catch(function(error) {
		console.error(error);
	});

	return true;
}

function queueFolderMetadataScrapeMany(paths = [], force = false)
{
	if(!Array.isArray(paths) || !paths.length)
		return 0;

	let queued = 0;

	for(let i = 0, len = paths.length; i < len; i++)
	{
		if(queueFolderMetadataScrape(paths[i], force))
			queued++;
	}

	return queued;
}

async function autoPrompt()
{
	scrapeFolderMetadata().catch(function(error) {
		console.error(error);
	});

	if(!config.readingTrackingAutoPrompt && !config.readingTrackingAutoPromptFavorites)
		return;

	const toAutoPrompt = trackingSites.list(true).filter(function(site) {

		if(!site.tracking.id && !site.tracking.autoPrompt && site.config.session.valid)
		{
			if(config.readingTrackingAutoPrompt || (config.readingTrackingAutoPromptFavorites && site.config.favorite))
				return true;
		}

		return false;

	});

	const title = extractFolderTitleCandidates()[0] || getTitle();

	for(const site of toAutoPrompt)
	{
		currentAutoPrompt = {
			site: site.key,
		};

		await new Promise(async function(resolve) {

			currentAutoPrompt.resolve = resolve;

			const results = await searchComic(site.key, title, true);
			const result = results[0] ?? false;

			if(!result)
				return resolve();

			currentAutoPrompt.result = result;

			handlebarsContext.autoPrompt = {
				site,
				result: {
					...result,
					url: site.pageUrl.replace('{{siteId}}', result.id),
				},
			}

			events.dialog({
				header: language.dialog.tracking.wantToTrack,
				width: 500,
				height: 248,
				content: template.load('dialog.tracking.auto.prompt.html'),
				onClose: 'tracking.setAutoPrompt(false);',
				buttons: false,
			});

		});

		await app.sleep(150);
		currentAutoPrompt = {};
	}

}

function setAutoPrompt(status = false)
{
	if(currentAutoPrompt.site)
	{
		const site = currentAutoPrompt.site;

		if(status)
		{
			if(currentAutoPrompt.result)
				setTrackingId(site, currentAutoPrompt.result.id);
		}
		else
		{
			setTrackingData(site, {
				autoPrompt: true,
			});
		}
	}

	if(currentAutoPrompt.resolve)
		currentAutoPrompt.resolve();
}

function saveSiteConfig(site, key, value)
{
	const siteData = trackingSites.site(site);
	const configSites = storage.getKey('config', 'trackingSites');

	siteData.config[key] = value;

	configSites[site] = siteData.config;
	storage.updateVar('config', 'trackingSites', configSites);

	setSiteData(site);
}

async function configTracking(site = '', force = false)
{
	const siteData = trackingSites.site(site, true);
	if(!siteData) return;

	if($('#tracking-sites, .bar-right-buttons .button-tracking-sites').length >= 2)
	{
		reading.magnifyingGlassControl(2);
		events.desactiveMenu('#tracking-sites', '.bar-right-buttons .button-tracking-sites');
	}

	loadSiteScript(site);

	// if we have a stored id, make sure it actually refers to the comic we're
	// currently reading – otherwise the user expect to land on a blank search
	// page rather than the previous manga's progress.
	if(siteData.config.session.valid && siteData.tracking.id)
	{
		const title = getTitle();
		if(title)
		{
			try {
				const data = await sitesScripts[site].getComicData(siteData.tracking.id);
				if(data && data.title)
				{
					const normalize = s => String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'');
					const n1 = normalize(title);
					const n2 = normalize(data.title);
					// if neither string contains the other, assume mismatch
					if(n1 && n2 && !(n1.includes(n2) || n2.includes(n1)))
					{
						searchDialog(site);
						return;
					}
				}
			} catch (e) {
				// ignore errors and fall back to showing current dialog
			}
		}
		currentTrackingDialog(site);
	}
	else if(siteData.config.session.valid)
	{
		searchDialog(site);
	}
	else
	{
		login(site, true);
	}
}

// Execute site login function
async function login(site, fromConfig = false)
{
	const siteData = trackingSites.site(site);
	if(!siteData) return;

	loadSiteScript(site);

	const session = await sitesScripts[site].login();

	if(session.valid)
	{
		setSessionToken(site, session);

		if(fromConfig)
			configTracking(site, true);
		else
			tracking.track(false, false, false, true, false, false);
	}
	else
	{
		invalidateSession(site, true, true);
	}
}

// Refresh tokens
async function refreshTokens(force = false)
{
	const _trackingSites = trackingSites.list(true);
	const time = app.time();

	for(let key in _trackingSites)
	{
		const siteData = _trackingSites[key];
		const site = siteData.key;
		const currentSession = siteData.config.session;

		// Check if session is valid and refresh token if needed
		if(currentSession.valid && currentSession.refreshToken && (force || !currentSession.expires || (currentSession.expires - currentSession.expiresIn / 2) < time))
		{
			loadSiteScript(site);

			sitesScripts[site].refreshToken().then(function(session) {

				if(session.valid)
					setSessionToken(site, session);
				else
					invalidateSession(site, true);

			});
		}
	}
}

// Save session token
function setSessionToken(site = '', session = {})
{
	session.expiresIn = (session.expiresIn || !session.refreshToken) ? session.expiresIn : 3600;
	const expires = (session.expiresIn ? app.time() + session.expiresIn : 0);

	saveSiteConfig(site, 'session', {
		valid: true,
		token: storage.safe.encrypt(session.token),
		refreshToken: storage.safe.encrypt(session.refreshToken),
		expires: expires,
		expiresIn: session.expiresIn,
	});
}

// Remove session token
function invalidateSession(site = '', loginDialog = false, fromConfig = false)
{
	saveSiteConfig(site, 'session', {valid: false, token: '', refreshToken: '', expires: 0, expiresIn: 0});

	if(loginDialog)
		invalidTokenDialog(site, fromConfig);
}

// Active and deactivate tracking site
function activeAndDeactivateTrackingSite(site = '', active = false)
{
	const _tracking = storage.getKey('tracking', dom.history.mainPath) || {};

	if(_tracking[site])
		_tracking[site].active = active;

	storage.updateVar('tracking', dom.history.mainPath, _tracking);
}

// Current dialog
async function currentTrackingDialog(site)
{
	const siteData = trackingSites.site(site, true);
	if(!siteData) return;

	loadSiteScript(site);

	events.dialog({
		header: false,
		width: 500,
		height: (!siteData.trackingChapter || !siteData.trackingVolume) ? 446 : 526,
		content: template.load('loading.html'),
		buttons: false,
	});

	const path = dom.history.mainPath;

	const data = await sitesScripts[site].getComicData(siteData.tracking.id);
	if(data === null) return; // Invalid session

	data.url = siteData.pageUrl.replace('{{siteId}}', siteData.tracking.id);
	handlebarsContext.trackingResult = data;
	handlebarsContext.siteData = siteData;

	if(!handlebarsContext.trackingResult.chapters)
		handlebarsContext.trackingResult.chapters = '??';

	if(!handlebarsContext.trackingResult.volumes)
		handlebarsContext.trackingResult.volumes = '??';

	// Ensure the progress fields default to the reader's current chapter/volume
	// so the dialog shows the chapter we're actually reading rather than
	// values fetched from the tracking site (which can be totals or stale).
	if(!handlebarsContext.trackingResult.progress) handlebarsContext.trackingResult.progress = {};
	// Use the reader's detected chapter/volume first, fallback to existing progress
	const readerChapter = getChapter();
	const readerVolume = getVolume();
	if(readerChapter) handlebarsContext.trackingResult.progress.chapters = readerChapter;
	else if(handlebarsContext.trackingResult.progress.chapters === undefined)
		handlebarsContext.trackingResult.progress.chapters = false;

	if(readerVolume) handlebarsContext.trackingResult.progress.volumes = readerVolume;
	else if(handlebarsContext.trackingResult.progress.volumes === undefined)
		handlebarsContext.trackingResult.progress.volumes = false;

	setTrackingChapters(site, data, path);

	$('.dialog-text').html(template.load('dialog.tracking.current.tracking.html'));

	events.events();
}

// Login dialogs
var getRedirectResultResolve = false;

async function getRedirectResult(site, url)
{
	const siteData = trackingSites.site(site);
	if(!siteData) return;

	events.dialog({
		header: hb.compile(language.dialog.auth.loginTo)({siteName: siteData.name}),
		width: 400,
		height: false,
		content: '<div style="height: 72px;">'+template.load('loading.html')+'</div>',
		onClose: 'tracking.handleOpenUrl();',
		buttons: [
			{
				text: language.buttons.cancel,
				function: 'events.closeDialog(); tracking.handleOpenUrl();',
			},
			{
				text: language.dialog.auth.manualLogin,
				function: 'events.closeDialog(); tracking.getTokenDialog(\''+site+'\');',
			}
		],
	});

	electron.shell.openExternal(url);

	return new Promise(function(resolve){
		getRedirectResultResolve = resolve;
	});
}

async function getTokenDialog(site = '', done = false)
{
	if(done)
	{
		const token = $('.input-token').val();
		const url = !/^(?:https?|opencomic):\/\//.test(token) ? 'opencomic://tracking/'+(!/=/.test(token) ? 'token=' : '')+token : token;

		tracking.handleOpenUrl(new URL(url));
	}
	else
	{
		const siteData = trackingSites.site(site);
		if(!siteData) return;

		if(!handlebarsContext.tracking) handlebarsContext.tracking = {};
		handlebarsContext.tracking.getTokenInput = hb.compile(language.dialog.tracking.getTokenInput)({siteName: siteData.name});

		events.dialog({
			header: hb.compile(language.dialog.tracking.getTokenHeader)({siteName: siteData.name}),
			width: 400,
			height: false,
			content: template.load('dialog.tracking.sites.token.html'),
			onClose: 'tracking.handleOpenUrl();',
			buttons: [
				{
					text: language.buttons.cancel,
					function: 'events.closeDialog(); tracking.handleOpenUrl();',
				},
				{
					text: language.buttons.ok,
					function: 'events.closeDialog(); tracking.getTokenDialog(\''+site+'\', true);',
				}
			],
		});

		events.focus('.input-token');
		events.eventInput();
	}
}

function invalidTokenDialog(site, fromConfig = false)
{
	const siteData = trackingSites.site(site);

	events.dialog({
		header: hb.compile(language.dialog.auth.sessionExpired)({siteName: siteData.name}),
		width: 400,
		height: false,
		content: hb.compile(language.dialog.auth.loginAgain)({siteName: siteData.name}),
		buttons: [
			{
				text: language.buttons.cancel,
				function: 'events.closeDialog();',
			},
			{
				text: language.buttons.ok,
				function: 'events.closeDialog(); tracking.login(\''+site+'\', '+(fromConfig ? 'true' : 'false')+');',
			}
		],
	});
}

// Search functions
function searchDialog(site)
{
	const siteData = trackingSites.site(site);

	if(!handlebarsContext.tracking) handlebarsContext.tracking = {};
	handlebarsContext.tracking.serachIn = hb.compile(language.dialog.tracking.serachIn)({siteName: siteData.name});

	const title = extractFolderTitleCandidates()[0] || getTitle();

	handlebarsContext.trackingTitle = title;
	handlebarsContext.trackingSiteKey = site;

	events.dialog({
		header: false,
		width: 500,
		height: 600,
		content: template.load('dialog.tracking.search.html'),
		buttons: false,
	});

	events.focus('.input-search');
	events.eventInput();

	searchComic(site, title);
}

async function searchComic(site, title = false, _return = false)
{
	if(!title)
		title = extractFolderTitleCandidates()[0] || getTitle();

	loadSiteScript(site);

	handlebarsContext.trackingSiteKey = site;

	let results = await sitesScripts[site].searchComic(title);
	if(results === null) return; // Invalid session

	results = results.map(function(result){

			let authors = result.authors;
			if(!Array.isArray(authors))
			{
				authors = authors ? [String(authors)] : [];
			}

			const last = authors.length ? authors.pop() : '';
			authors = authors.length ? authors.join(', ')+' '+language.global.and+' '+last : last || '';
			result.authors = authors;

			return result;
	});

	if(_return)
		return results;

	handlebarsContext.trackingResults = results;

	$('.tracking-search').html(template.load('dialog.tracking.search.results.html'));
}

var searchInputST = false;

function searchInput(site)
{
	clearTimeout(searchInputST);

	$('.tracking-search').html(template.load('loading.html'));

	searchInputST = setTimeout(function(site){

		const title = $('.input-search').val();
		searchComic(site, title);

	}, 300, site);
}

function setTrackingId(site, siteId)
{
    const _tracking = storage.getKey('tracking', dom.history.mainPath) || {};

    _tracking[site] = {
        id: siteId,
        active: true,
    };

    storage.updateVar('tracking', dom.history.mainPath, _tracking);

	if(site === 'anilist')
	{
		(async function() {
			try
			{
				loadSiteScript('anilist');
				const metadata = await (sitesScripts.anilist.getComicMetadata ? sitesScripts.anilist.getComicMetadata(siteId) : {});
				const chapters = +(metadata?.chapters || 0);
				const estimatedReadingMinutes = chapters > 0 ? Math.round(chapters * 7) : 0;
				const genreClusters = Array.isArray(metadata?.genres) ? metadata.genres.map(function(genre) {
					return String(genre || '').toLowerCase().trim();
				}).filter(Boolean).slice(0, 6) : [];

				setFolderMetadata(dom.history.mainPath, {
					anilistId: siteId,
					title: metadata?.title || '',
					author: metadata?.author || '',
					seriesType: metadata?.seriesType || '',
					demographic: metadata?.demographic || '',
					genres: metadata?.genres || [],
					description: metadata?.description || '',
					serializationYear: metadata?.serializationYear || 0,
					rating: metadata?.rating || 0,
					recommendation: {
						readingTimeMinutes: estimatedReadingMinutes,
						genreClusters: genreClusters,
					},
					source: 'anilist',
					confidence: 100,
				});
			}
			catch(error)
			{
				console.error(error);
			}
		})();
	}

    if(tracked[dom.history.mainPath] && tracked[dom.history.mainPath][site])
        tracked[dom.history.mainPath][site] = [];

    // close the search dialog and show the current tracking dialog so user can mark chapters/volumes
    events.closeDialog();
    currentTrackingDialog(site);
}

function setTrackingData(site, data)
{
	const _tracking = storage.getKey('tracking', dom.history.mainPath) || {};
	_tracking[site] = {...(_tracking[site] ?? {}), ...data};
	storage.updateVar('tracking', dom.history.mainPath, _tracking);
}

function setTrackingChapters(site, options = {}, path = dom.history.mainPath)
{
	const _tracking = storage.getKey('tracking', path) || {};
	let data = _tracking[site] || {}

	data = {
		...data,
		chapters: options.chapters || data.chapters || false,
		volumes: options.volumes || data.volumes || false,
		progress: {
			chapters: options.progress?.chapters ?? data.progress?.readChapters ?? false,
			volumes: options.progress?.volumes ?? data.progress?.readVolumes ?? false,
		},
		lastUpdatedChapters: Date.now(),
	};

	_tracking[site] = data;
	storage.updateVar('tracking', path, _tracking);
}

// Others dialogs
function addChapterNumberDialog(done = false, onlySite = false)
{
	if(done)
	{
		let chapter = +$('.input-chapter').val();
		let volume = +$('.input-volume').val();

		// `event` may be passed as third parameter from onclick; detect modifier keys
		const evt = arguments.length >= 3 ? arguments[2] : false;
		const force = !!(evt && (evt.ctrlKey || evt.metaKey || evt.shiftKey));

		if(chapter < 1)
			chapter = false;

		if(volume < 1)
			volume = false;

		if(chapter !== false || volume !== false)
		{
			tracking.track(chapter, volume, onlySite, false, false, force);
		}
	}
	else
	{
		if($('#tracking-sites, .bar-right-buttons .button-tracking-sites').length >= 2)
		{
			reading.magnifyingGlassControl(2);
			events.desactiveMenu('#tracking-sites', '.bar-right-buttons .button-tracking-sites');
		}

		// Build OK button callback so we can pass the current `onlySite` value and the click event
		const okFunction = 'events.closeDialog(); tracking.addChapterNumberDialog(true, '+(onlySite ? ('"'+String(onlySite).replace(/"/g, '\"')+'"') : 'false')+', event);';

		events.dialog({
			header: language.dialog.tracking.setHeader,
			width: 400,
			height: false,
			content: template.load('dialog.tracking.sites.chapter.number.html'),
			buttons: [
				{
					text: language.buttons.cancel,
					function: 'events.closeDialog();',
				},
				{
					text: language.buttons.ok,
					function: okFunction,
				}
			],
		});

		events.focus('.input-chapter');
		events.eventInput();
	}
}

function getStatus()
{
	const tracking = storage.getKey('tracking', dom.history.mainPath);

	return tracking;
}

function getFolderMetadataPath(path = false)
{
	path = path || dom.history.mainPath || reading.readingCurrentPath();
	if(!path) return '';

	const type = fileManager.getPathType(path);

	if(type.folder)
		return p.normalize(path);

	return p.normalize(p.dirname(path));
}

function getFolderMetadata(path = false)
{
	const folderPath = getFolderMetadataPath(path);
	if(!folderPath) return false;

	const metadata = relative.get('trackingFolderMetadata')?.[folderPath];

	return metadata ? folderMetadataSchema.sanitizeFolderMetadata(metadata) : false;
}

function validateFolderMetadata(metadata = {})
{
	return folderMetadataSchema.validateFolderMetadata(metadata);
}

function setFolderMetadata(path = false, metadata = {})
{
	const folderPath = getFolderMetadataPath(path);
	if(!folderPath) return false;

	const key = relative.path(folderPath);
	const current = storage.getKey('trackingFolderMetadata', key) || false;
	const now = Date.now();
	const previous = current ? folderMetadataSchema.sanitizeFolderMetadata(current, now) : false;

	const merged = {
		...(current || {}),
		...(metadata || {}),
		createdAt: current?.createdAt || metadata?.createdAt || now,
		updatedAt: now,
	};

	const sanitized = folderMetadataSchema.sanitizeFolderMetadata(merged, now);
	storage.updateVar('trackingFolderMetadata', key, sanitized);

	if(sanitized.anilistId > 0)
		allowMetadataId(metadataScrapeCacheKey(folderPath), sanitized.anilistId);

	// The scrape for a folder is started at the end of reading.read(), so on the first open of a
	// series the reading-mode defaults could not be resolved yet. Apply them now that the series
	// type is known instead of waiting for the next app start.
	if(sanitized.seriesType && previous?.seriesType !== sanitized.seriesType)
	{
		try
		{
			if(typeof reading !== 'undefined' && reading && typeof reading.applyTrackedSeriesReadingDefaultsForFolder === 'function')
				reading.applyTrackedSeriesReadingDefaultsForFolder(folderPath);
		}
		catch(error)
		{
			console.error('Failed to apply reading defaults after metadata scrape:', error);
		}
	}

	if(shouldRefreshMetadataUi(folderPath, previous, sanitized))
		queueMetadataUiRefresh();

	return sanitized;
}

function clearFolderMetadata(path = false)
{
	const folderPath = getFolderMetadataPath(path);
	if(!folderPath) return false;

	storage.deleteVar('trackingFolderMetadata', relative.path(folderPath));
	return true;
}

function extractFolderTitleCandidates(path = false)
{
	const sourcePath = path || reading.readingCurrentPath();
	const folderPath = getFolderMetadataPath(sourcePath);

	if(!folderPath)
		return [];

	const extraTitles = [];

	if(sourcePath)
	{
		const sourceBaseName = p.basename(sourcePath).replace(/\.[^/.]+$/, '');
		if(sourceBaseName)
			extraTitles.push(sourceBaseName);
	}

	const folderBaseName = p.basename(folderPath);
	if(folderBaseName)
		extraTitles.push(folderBaseName);

	const parentBaseName = p.basename(p.dirname(folderPath));
	if(parentBaseName)
		extraTitles.push(parentBaseName);

	if(sourcePath)
	{
		const firstCompressedFile = fileManager.firstCompressedFile(sourcePath);
		const metadata = fileManager.compressedMetadata(firstCompressedFile);

		if(metadata)
		{
			if(metadata.series) extraTitles.push(metadata.series);
			if(metadata.localizedSeries) extraTitles.push(metadata.localizedSeries);
			if(metadata.title) extraTitles.push(metadata.title);
		}
	}

	return folderTitle.extractCandidatesFromFolderPath(folderPath, extraTitles);
}

async function scrapeFolderMetadata(path = false, force = false)
{
	const sourcePath = path || reading.readingCurrentPath();
	const folderPath = getFolderMetadataPath(sourcePath);

	if(!folderPath)
		return false;

	const cacheKey = folderPath.toLowerCase();

	if(metadataScrapeInFlight.has(cacheKey))
		return metadataScrapeInFlight.get(cacheKey);

	const scrapePromise = (async function() {
		const startedAt = Date.now();
		metadataScrapeStats.started++;
		metadataScrapeStats.lastFolder = folderPath;

		try
		{
		const now = Date.now();
		const current = getFolderMetadata(folderPath);
		const cooldownUntil = metadataScrapeCooldown.get(cacheKey) || 0;
		// Rating/seriesType backfill only ever applies to an AniList match: MAL's own metadata
		// lookup (getComicMetadata() in tracking/myanimelist/myanimelist.js) already sets
		// seriesType directly from its media_type field with no separate call needed, and a 0
		// rating there just means MAL has none for that title, not that anything is missing.
		const needsRatingBackfill = !!(current && current.source === 'anilist' && current.anilistId && (current.rating || 0) <= 0);
		const needsSeriesTypeBackfill = !!(current && current.source === 'anilist' && current.anilistId && !current.seriesType);
		const hasConfirmedMatch = !!(current && ((current.source === 'anilist' && current.anilistId) || (current.source === 'myanimelist' && current.malId)));

		if(!force && current && (current.source === 'manual' || current.source === 'import'))
			return current;

		if(!force && !needsRatingBackfill && !needsSeriesTypeBackfill && hasConfirmedMatch && current.updatedAt && (now - current.updatedAt) < METADATA_SCRAPE_TTL)
			return current;

		if(!force && !needsRatingBackfill && !needsSeriesTypeBackfill && cooldownUntil && now < cooldownUntil)
		{
			metadataScrapeStats.retryBlocked++;
			logMetadataScrape('cooldown', {
				path: folderPath,
				retryInMs: cooldownUntil - now,
			});
			return current || false;
		}

		const siteData = trackingSites.site('anilist');
		if(!siteData)
			return current || false;

		const candidates = extractFolderTitleCandidates(sourcePath);
		if(!candidates.length)
		{
			metadataScrapeCooldown.set(cacheKey, now + METADATA_SCRAPE_RETRY_COOLDOWN);
			// Durable, cross-session record that this was tried and did not match - see
			// METADATA_SCRAPE_NO_MATCH_COOLDOWN / needsMetadataScrape() above.
			setFolderMetadata(folderPath, { lastAttemptAt: now });
			metadataScrapeStats.unmatched++;
			logMetadataScrape('unmatched:no-candidates', {
				path: folderPath,
			});
			return current || false;
		}

		loadSiteScript('anilist');

		const resultById = new Map();
		const searchCandidates = force ? candidates.slice(0, 2) : candidates.slice(0, 1);

		for(let i = 0, len = searchCandidates.length; i < len; i++)
		{
			const candidate = searchCandidates[i];
			let results = [];

			try
			{
				results = await sitesScripts.anilist.searchComic(candidate);
			}
			catch(error)
			{
				console.error(error);
				metadataScrapeStats.failed++;
				metadataScrapeStats.lastError = String(error?.message || error || 'search failed');
				logMetadataScrape('search-error', {
					path: folderPath,
					candidate: candidate,
					error: metadataScrapeStats.lastError,
				});
			}

			for(let r = 0, rlen = (results || []).length; r < rlen; r++)
			{
				const result = results[r];
				if(!result?.id) continue;

				if(!resultById.has(result.id))
					resultById.set(result.id, result);
			}
		}

		const rejectedIds = Array.from(getMetadataRejectedIds(cacheKey));
		const ranked = folderTitle.rankSearchResults(searchCandidates, Array.from(resultById.values()), {
			referenceYear: +(current?.serializationYear || 0),
			excludedIds: rejectedIds,
		});
		let best = ranked[0] || false;
		let matchSource = 'anilist';

		// AniList found nothing for any candidate title - either a genuine no-match, or its
		// search silently came back empty because this session is being blocked (Cloudflare
		// bot-management 403s; see the AniList client's own retry/backoff, which already
		// exhausted its retries before returning here). Either way, try the same candidates
		// against MyAnimeList before giving up on this folder entirely - it needs no login for
		// a search or a lookup by id, same as AniList's own anonymous requests.
		if(!best)
		{
			try
			{
				loadSiteScript('myanimelist');

				const malResultById = new Map();

				for(let i = 0, len = searchCandidates.length; i < len; i++)
				{
					const candidate = searchCandidates[i];
					let results = [];

					try
					{
						results = await sitesScripts.myanimelist.searchComic(candidate);
					}
					catch(error)
					{
						console.error(error);
					}

					for(let r = 0, rlen = (results || []).length; r < rlen; r++)
					{
						const result = results[r];
						if(!result?.id) continue;

						if(!malResultById.has(result.id))
							malResultById.set(result.id, result);
					}
				}

				const malRanked = folderTitle.rankSearchResults(searchCandidates, Array.from(malResultById.values()), {
					referenceYear: +(current?.serializationYear || 0),
					excludedIds: rejectedIds,
				});

				if(malRanked[0])
				{
					best = malRanked[0];
					matchSource = 'myanimelist';
				}
			}
			catch(error)
			{
				console.error(error);
			}
		}

		if(!best)
		{
			metadataScrapeCooldown.set(cacheKey, now + METADATA_SCRAPE_RETRY_COOLDOWN);
			// Durable, cross-session record that this was tried and did not match - see
			// METADATA_SCRAPE_NO_MATCH_COOLDOWN / needsMetadataScrape() above.
			setFolderMetadata(folderPath, { lastAttemptAt: now });
			metadataScrapeStats.unmatched++;
			logMetadataScrape('unmatched:no-result', {
				path: folderPath,
				rejectedIds: rejectedIds,
			});
			return current || false;
		}

		// Fetch full metadata for the best candidate from whichever site matched it. If that
		// site explicitly provides a `seriesType` (AniList via tags/country, MAL via its own
		// media_type field directly), accept the match even if the search confidence is below
		// the usual threshold.
		const matchedSite = matchSource === 'anilist' ? sitesScripts.anilist : sitesScripts.myanimelist;
		const metadata = await (matchedSite.getComicMetadata ? matchedSite.getComicMetadata(best.id) : {});
		const hasSeriesType = !!(metadata && metadata.seriesType);

		if((best.score || 0) < METADATA_SCRAPE_MIN_CONFIDENCE && !hasSeriesType)
		{
			metadataScrapeCooldown.set(cacheKey, now + METADATA_SCRAPE_RETRY_COOLDOWN);
			// Durable, cross-session record that this was tried and did not match - see
			// METADATA_SCRAPE_NO_MATCH_COOLDOWN / needsMetadataScrape() above.
			setFolderMetadata(folderPath, { lastAttemptAt: now });
			metadataScrapeStats.unmatched++;
			logMetadataScrape('unmatched:low-confidence', {
				path: folderPath,
				topScore: best?.score || 0,
				candidate: best?.matchedCandidate || '',
				matchedTitle: best?.matchedTitle || '',
				rejectedIds: rejectedIds,
			});
			return current || false;
		}
		const chapters = +(metadata?.chapters || 0);
		const estimatedReadingMinutes = chapters > 0 ? Math.round(chapters * 7) : 0;
		const genreClusters = Array.isArray(metadata?.genres) ? metadata.genres.map(function(genre) {
			return String(genre || '').toLowerCase().trim();
		}).filter(Boolean).slice(0, 6) : [];

		const saved = setFolderMetadata(folderPath, {
			// anilistId/malId are separate id spaces (see folder-metadata.js) - only the one for
			// whichever site actually matched is set, the other left at its existing value (0,
			// normally, since a folder is only ever matched once).
			...(matchSource === 'anilist' ? { anilistId: best.id } : { malId: best.id }),
			title: metadata?.title || best.title || '',
			author: metadata?.author || '',
			seriesType: metadata?.seriesType || '',
			demographic: metadata?.demographic || '',
			genres: metadata?.genres || [],
			description: metadata?.description || '',
			serializationYear: metadata?.serializationYear || best.serializationYear || 0,
			rating: metadata?.rating || best.rating || 0,
			recommendation: {
				readingTimeMinutes: estimatedReadingMinutes,
				genreClusters: genreClusters,
			},
			source: matchSource,
			confidence: best.score || 0,
		});
		allowMetadataId(cacheKey, best.id);

		metadataScrapeCooldown.delete(cacheKey);
		metadataScrapeStats.success++;
		logMetadataScrape('success', {
			path: folderPath,
			anilistId: best.id,
			score: best.score || 0,
			matchedTitle: best.matchedTitle || '',
			candidate: best.matchedCandidate || '',
		});

		return saved;
		}
		catch(error)
		{
			metadataScrapeStats.failed++;
			metadataScrapeStats.lastError = String(error?.message || error || 'scrape failed');
			logMetadataScrape('failed', {
				path: folderPath,
				error: metadataScrapeStats.lastError,
			});
			throw error;
		}
		finally
		{
			metadataScrapeStats.lastDurationMs = Date.now() - startedAt;
		}
	})();

	metadataScrapeInFlight.set(cacheKey, scrapePromise);

	try
	{
		return await scrapePromise;
	}
	finally
	{
		metadataScrapeInFlight.delete(cacheKey);
	}
}

async function refetchFolderMetadataFromAniList(path = false, anilistId = 0, force = false, titleOverride = '')
{
	const folderPath = getFolderMetadataPath(path);
	if(!folderPath)
		return false;

	const current = getFolderMetadata(folderPath);
	let resolvedAnilistId = +(anilistId || current?.anilistId || 0);
	const normalizedTitle = String(titleOverride || '').trim();
	const siteData = trackingSites.site('anilist');
	const cacheKey = metadataScrapeCacheKey(folderPath);
	const startedAt = Date.now();

	if(!siteData)
		return current || false;

	loadSiteScript('anilist');

	if(resolvedAnilistId > 0)
		allowMetadataId(cacheKey, resolvedAnilistId);

	if(resolvedAnilistId <= 0 && normalizedTitle && sitesScripts.anilist.searchComic)
	{
		try
		{
			const results = await sitesScripts.anilist.searchComic(normalizedTitle);
			const ranked = folderTitle.rankSearchResults([normalizedTitle], results || [], {
				referenceYear: +(current?.serializationYear || 0),
				excludedIds: Array.from(getMetadataRejectedIds(cacheKey)),
			});
			const best = ranked[0] || (results && results[0]) || false;

			if(best?.id)
				resolvedAnilistId = +best.id;
		}
		catch(error)
		{
			console.error(error);
		}
	}

	if(resolvedAnilistId > 0 && sitesScripts.anilist.getComicMetadata)
	{
		try
		{
			const metadata = await sitesScripts.anilist.getComicMetadata(resolvedAnilistId);

			if(metadata && metadata.id)
			{
				const chapters = +(metadata?.chapters || 0);
				const estimatedReadingMinutes = chapters > 0 ? Math.round(chapters * 7) : 0;
				const genreClusters = Array.isArray(metadata?.genres) ? metadata.genres.map(function(genre) {
					return String(genre || '').toLowerCase().trim();
				}).filter(Boolean).slice(0, 6) : [];

				const saved = setFolderMetadata(folderPath, {
					anilistId: resolvedAnilistId,
					title: metadata?.title || current?.title || '',
					author: metadata?.author || '',
					seriesType: metadata?.seriesType || '',
					demographic: metadata?.demographic || '',
					genres: metadata?.genres || [],
					description: metadata?.description || '',
					serializationYear: metadata?.serializationYear || 0,
					rating: metadata?.rating || 0,
					recommendation: {
						readingTimeMinutes: estimatedReadingMinutes,
						genreClusters: genreClusters,
					},
					source: 'anilist',
					confidence: 100,
				});

				allowMetadataId(cacheKey, resolvedAnilistId);
				metadataScrapeCooldown.delete(cacheKey);
				metadataScrapeStats.success++;
				metadataScrapeStats.lastDurationMs = Date.now() - startedAt;
				logMetadataScrape('refetch-success', {
					path: folderPath,
					anilistId: resolvedAnilistId,
				});

				return saved;
			}
		}
		catch(error)
		{
			console.error(error);
			metadataScrapeStats.failed++;
			metadataScrapeStats.lastError = String(error?.message || error || 'refetch failed');
			logMetadataScrape('refetch-error', {
				path: folderPath,
				anilistId: resolvedAnilistId,
				error: metadataScrapeStats.lastError,
			});
		}
	}

	return scrapeFolderMetadata(folderPath, true);
}

async function reportWrongFolderMetadataMatch(path = false, retry = true)
{
	const folderPath = getFolderMetadataPath(path);
	if(!folderPath)
		return false;

	const current = getFolderMetadata(folderPath) || {};
	const cacheKey = metadataScrapeCacheKey(folderPath);

	// AniList and MyAnimeList ids share the same rejection set (see the excludedIds passed to
	// folderTitle.rankSearchResults() for both in scrapeFolderMetadata()) - they are different
	// id spaces, so this only ever risks skipping an unrelated numeric coincidence, not a real
	// collision.
	if(current.anilistId > 0)
		rejectMetadataId(cacheKey, current.anilistId);

	if(current.malId > 0)
		rejectMetadataId(cacheKey, current.malId);

	const fallbackTitle = current.title || p.basename(folderPath) || '';
	setFolderMetadata(folderPath, {
		anilistId: 0,
		malId: 0,
		title: fallbackTitle,
		author: '',
		seriesType: '',
		demographic: '',
		genres: [],
		description: '',
		serializationYear: 0,
		rating: 0,
		recommendation: {
			readingTimeMinutes: 0,
			genreClusters: [],
		},
		source: '',
		confidence: 0,
	});

	metadataScrapeCooldown.delete(cacheKey);
	logMetadataScrape('wrong-match', {
		path: folderPath,
		rejectedAnilistId: +(current.anilistId || 0),
		rejectedMalId: +(current.malId || 0),
		retry: !!retry,
	});

	if(retry)
		return scrapeFolderMetadata(folderPath, true);

	return true;
}

// Scraping functions
function getTitle(full = false)
{
	const path = reading.readingCurrentPath();
	if(!path) return '';

	const candidates = extractFolderTitleCandidates(path);
	let title = candidates[0] || '';

	if(!title)
	{
		try {
			const parent = p.basename(p.dirname(path));
			if(parent)
				title = parent;
			else
				title = compatible.compressed(path) ? p.basename(path).replace(/\.[^/.]+$/, '') : (dom.history.mainPath ? p.basename(dom.history.mainPath) : '');
		}
		catch (e) {
			title = compatible.compressed(path) ? p.basename(path).replace(/\.[^/.]+$/, '') : (dom.history.mainPath ? p.basename(dom.history.mainPath) : '');
		}
	}

	title = title.replace(/(?:[\.\-_:;]|\sv[0-9]+).*/, '', title).trim();

	if(!full)
		title = title.split(/\s+/).splice(0, 4).join(' ');

	return title;
}

function getTitlesAndMetadata()
{
	const path = reading.readingCurrentPath();
	if(!path) return;

	const name = p.basename(path);
	// Also include the parent folder (series folder) which often contains the actual manga name
	const parentName = p.basename(p.dirname(path));

	const titles = [
		...extractFolderTitleCandidates(path),
		parentName,
		name,
	].filter(Boolean);

	const firstCompressedFile = fileManager.firstCompressedFile(path);
	const metadata = fileManager.compressedMetadata(firstCompressedFile);

	if(metadata.title)
		titles.push(metadata.title);

	if(firstCompressedFile)
	{
		const compressedName = p.basename(firstCompressedFile);

		if(compressedName !== name)
			titles.push(compressedName);
	}

	const uniqueTitles = [];
	const titleKeys = new Set();

	for(let i = 0, len = titles.length; i < len; i++)
	{
		const title = String(titles[i] || '').trim();
		const key = folderTitle.normalizeString(title);

		if(!title || !key || titleKeys.has(key))
			continue;

		titleKeys.add(key);
		uniqueTitles.push(title);
	}

	return {
		titles: uniqueTitles,
		images: currentImages,
		chapter: 0, // metadata.bookNumber ?? 0,
		volume: metadata.volume ?? 0,
		metadata,
	};
}

var currentImages = [];

function getImagesChapter()
{
	const images = [];
	let index = 0;

	for(let i = 0, len = handlebarsContext.comics?.length; i < len; i++)
	{
		const comic = handlebarsContext.comics[i];

		if(comic.name)
		{
			images.push({
				i: index++,
				name: p.basename(comic.path),
				chapter: getChapter(comic.name),
				volume: getVolume(comic.name),
			});
		}
	}

	currentImages = images;
	trackImageChapters = new Set();
	trackImage();

	return images;
}

const regexs = {
	chapter: regexChapter(),
	volume: regexVolume(),
};

function regexChapter()
{
	const regexs = [
		/chapters?|episodes?|issues?/, // English
		/caps?|cap[íi]tulos?|episodios/, // Spanish
		/cap[íi]tols?|episodis?/, // Catalan
	];

	const regexsEnd = [
		/話/, // Japanese
	];

	const regexsMin = [
		/ch?|ep?/, // English
	];

	const reliablePatterns = [
		// Match common patterns like Chapter 5, Capítulo-5, etc.
		new RegExp('(?:'+joinRegexs(regexs).source+')'+/[\.\-_:;\(\)\[\]\s]*((?:\d+\.)?\d+)/.source, 'iu'),

		// Match ending patterns like 5話
		new RegExp(/((?:\d+\.)?\d+)/.source+'(?:'+joinRegexs(regexsEnd).source+')', 'iu'),

		// Match Ch. 5, Ep 3, etc.
		new RegExp(/(?:^|[\.\-_:;\(\)\[\]\s])/.source+'(?:'+joinRegexs(regexsMin).source+')'+/[\.\-_:;\(\)\[\]\s]*((?:\d+\.)?\d+)/.source, 'iu'),
	];

	const patterns = [
		...reliablePatterns,

		// Range chapters
		/[0-9]{1,4}-([0-9]{1,4})/iu,
	];

	const patternsLast = [
		// Match only a number at the start of the title
		/^\s*([0-9]+)/iu
	];

	return {
		reliablePatterns,
		patterns,
		patternsLast,
	};
}

function getChapter(string = false)
{
	if(string)
	{
		for(const regex of regexs.chapter.reliablePatterns)
		{
			const number = app.extract(regex, string, 1);
			if(number) return +number;
		}

		return false;
	}

	const data = getTitlesAndMetadata();
	if(!data) return false;

	let number = data.chapter;

	for(const title of data.titles)
	{
		if(number) break;

		for(const regex of regexs.chapter.patterns)
		{
			number = app.extract(regex, title, 1);
			if(number) break;
		}
	}

	// Find in image names
	for(const image of data.images)
	{
		if(number) break;

		if(image.chapter)
		{
			number = image.chapter;
			break;
		}
	}

	// Run this patters after the main patterns
	for(const title of data.titles)
	{
		if(number) break;

		for(const regex of regexs.chapter.patternsLast)
		{
			number = app.extract(regex, title, 1);
			if(number) break;
		}

		if(!number)
		{
			const volume = getVolume();

			if(!volume) // Has a 1 or 4 digit number (Only if no volume are detected)
				number = app.extract(/\s([0-9]{1,4})(?:\s|\.|$)/iu, title, 1);
		}

		if(!number && /^\d+$/.test(title)) // the folder name is numeric
			number = title;
	}

	return number > 0 ? +number : false;
}

function getChapterImage(fallback = false)
{
	const image = reading.getImage(reading.currentPage());

	if(image)
	{
		const name = p.basename(image.path);
		const current = currentImages.find((image) => image.name === name);

		if(current.chapter)
			return current.chapter;
	}

	return fallback ? getChapter() : null;
}

function regexVolume()
{
	const regexs = [
		/volumes?/, // English
		/tomos?|volumen|volumenes/, // Spanish
		/toms?/, // Catalan
	];

	const regexsEnd = [
		/巻/, // Japanese
	];

	const regexsMin = [
		/vo?|vol/, // English
	];

	const reliablePatterns = [
		// Match common patterns like volume 5, Tom-5, etc.
		new RegExp('(?:'+joinRegexs(regexs).source+')'+/[\.\-_:;\(\)\[\]\s]*((?:\d+\.)?\d+)/.source, 'iu'),

		// Match ending patterns like 5巻
		new RegExp(/((?:\d+\.)?\d+)/.source+'(?:'+joinRegexs(regexsEnd).source+')', 'iu'),

		// Match Vo. 5, Vol 3, etc.
		new RegExp(/(?:^|[\.\-_:;\(\)\[\]\s])/.source+'(?:'+joinRegexs(regexsMin).source+')'+/[\.\-_:;\(\)\[\]\s]*((?:\d+\.)?\d+)/.source, 'iu'),
	];

	const patterns = [
		...reliablePatterns,
	];

	return {
		reliablePatterns,
		patterns,
	};
}

function getVolume(string = false)
{
	if(string)
	{
		for(const regex of regexs.volume.reliablePatterns)
		{
			const number = app.extract(regex, string, 1);
			if(number) return +number;
		}

		return false;
	}

	const data = getTitlesAndMetadata();
	if(!data) return false;

	let number = data.volume;

	for(const title of data.titles)
	{
		if(number) break;

		for(const regex of regexs.volume.patterns)
		{
			number = app.extract(regex, title, 1);
			if(number) break;
		}
	}

	// Find in image names
	for(const image of data.images)
	{
		if(number) break;

		if(image.volume)
		{
			number = image.volume;
			break;
		}
	}

	return number > 0 ? +number : false;
}

function getVolumeImage(fallback = false)
{
	const image = reading.getImage(reading.currentPage());

	if(image)
	{
		const name = p.basename(image.path);
		const current = currentImages.find((image) => image.name === name);

		if(current.volume)
			return current.volume;
	}

	return fallback ? getVolume() : null;
}

function handleOpenUrl(url = false)
{
	if(!getRedirectResultResolve) return;
	if(!url) url = new URL('opencomic://tracking');

	getRedirectResultResolve(url);
	getRedirectResultResolve = false;
}

function openTrackingPage(e, site, id)
{
	// allow being called as openTrackingPage(event, site, id)
	if(e && e.stopPropagation)
		e.stopPropagation();

	const siteData = trackingSites.site(site);
	if(!siteData) return;
	const url = siteData.pageUrl.replace('{{siteId}}', id);
	require('electron').shell.openExternal(url);
}

function scriptsPath(site = '')
{
	return p.join(appDir, '.dist/tracking/'+site);
}

function start()
{
	refreshTokens();
	setInterval(refreshTokens, 60 * 60 * 12 * 1000); // Every 12 hours
}

module.exports = {
	scriptsPath: scriptsPath,
	configTracking: configTracking,
	setSessionToken: setSessionToken,
	invalidateSession: invalidateSession,
	addChapterNumberDialog: addChapterNumberDialog,
	getRedirectResult: getRedirectResult,
	getTokenDialog: getTokenDialog,
	invalidTokenDialog: invalidTokenDialog,
	searchDialog: searchDialog,
	getTitle: getTitle,
	login: login,
	refreshTokens: refreshTokens,
	searchInput: searchInput,
	setTrackingId: setTrackingId,
	setTrackingChapters: setTrackingChapters,
	track: track,
	trackImage: trackImage,
	trackST: function(){return trackST},
	autoPrompt,
	setAutoPrompt,
	getChapter: getChapter,
	getVolume: getVolume,
	getChapterImage: getChapterImage,
	getVolumeImage: getVolumeImage,
	getTitlesAndMetadata,
	getImagesChapter,
	getStatus,
	getFolderMetadataPath,
	extractFolderTitleCandidates,
	scrapeFolderMetadata,
	refetchFolderMetadataFromAniList,
	reportWrongFolderMetadataMatch,
	needsMetadataScrape,
	getMetadataScrapeStats,
	queueFolderMetadataScrape,
	queueFolderMetadataScrapeMany,
	getFolderMetadata,
	validateFolderMetadata,
	setFolderMetadata,
	clearFolderMetadata,
	activeAndDeactivateTrackingSite: activeAndDeactivateTrackingSite,
	tracked: function(){return tracked},
	handleOpenUrl: handleOpenUrl,
	openTrackingPage: openTrackingPage,
	start: start,
};
