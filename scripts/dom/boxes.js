
const recommendations = require(p.join(appDir, '.dist/tracking/recommendations.js'));
const opdsTrending = require(p.join(appDir, '.dist/opds/trending.js'));
const RECOMMENDATION_SUPPRESS_DISLIKES = 200;
const RECOMMENDATION_FAIRNESS_DISLIKE_START = 35;
const RECOMMENDATION_RECENT_HISTORY_LIMIT = 120;
const RECOMMENDATION_POOL_MULTIPLIER = 4;
let recentRecommendationHistory = [];

function normalizeRecommendationKey(path = '')
{
	if(!path)
		return '';

	return String(p.normalize(path)).toLowerCase();
}

function buildRecommendationFeedbackLookup(feedback = {})
{
	const lookup = {};

	for(const path in feedback)
	{
		const key = normalizeRecommendationKey(path);
		if(!key)
			continue;

		const item = feedback[path] || {};
		const prev = lookup[key] || {};

		lookup[key] = {
			shown: Math.max(0, +(prev.shown || 0), +(item.shown || 0)),
			liked: Math.max(0, +(prev.liked || 0), +(item.liked || 0)),
			disliked: Math.max(0, +(prev.disliked || 0), +(item.disliked || 0)),
			rating: +(item.rating || prev.rating || 0),
			lastRating: +(item.lastRating || prev.lastRating || 0),
			updatedAt: Math.max(+(prev.updatedAt || 0), +(item.updatedAt || 0)),
		};
	}

	return lookup;
}

function getBoxMaxItems()
{
	return 20;
}

function normalizeRecommendationPath(path = '')
{
	if(!path)
		return '';

	return p.normalize(path);
}

function rememberShownRecommendations(comics = [])
{
	if(!Array.isArray(comics) || !comics.length)
		return;

	for(let i = 0, len = comics.length; i < len; i++)
	{
		const key = normalizeRecommendationKey(comics[i]?.path || '');
		if(!key)
			continue;

		recentRecommendationHistory.push(key);
	}

	if(recentRecommendationHistory.length > RECOMMENDATION_RECENT_HISTORY_LIMIT)
		recentRecommendationHistory = recentRecommendationHistory.slice(-RECOMMENDATION_RECENT_HISTORY_LIMIT);
}

function selectRecommendedComicsForDisplay(comics = [], maxItems = 20)
{
	if(!Array.isArray(comics) || !comics.length)
		return [];

	const poolSize = Math.min(comics.length, Math.max(maxItems, maxItems * RECOMMENDATION_POOL_MULTIPLIER));
	const pool = comics.slice(0, poolSize);
	const recentSet = new Set(recentRecommendationHistory);

	let candidates = pool.filter(function(comic){
		return !recentSet.has(normalizeRecommendationKey(comic?.path || ''));
	});

	if(candidates.length < maxItems)
		candidates = pool;

	const sorted = candidates.slice().sort(function(a, b){
		if((a.recommendationFeedbackShown || 0) !== (b.recommendationFeedbackShown || 0))
			return (a.recommendationFeedbackShown || 0) - (b.recommendationFeedbackShown || 0);

		if((b.recommendationDisplayScore || 0) !== (a.recommendationDisplayScore || 0))
			return (b.recommendationDisplayScore || 0) - (a.recommendationDisplayScore || 0);

		return (Math.random() > 0.5) ? 1 : -1;
	});

	const selected = sorted.slice(0, maxItems);
	rememberShownRecommendations(selected);

	return selected;
}

function getRecommendationStats(feedback = {}, path = '', feedbackLookup = false)
{
	const normalizedPath = normalizeRecommendationPath(path);
	const key = normalizeRecommendationKey(normalizedPath);
	const item = feedback[normalizedPath] || feedback[path] || (feedbackLookup ? feedbackLookup[key] : {}) || {};

	let shown = Math.max(0, +(item.shown || 0));
	let liked = Math.max(0, +(item.liked || 0));
	let disliked = Math.max(0, +(item.disliked || 0));

	const legacyRating = +(item.rating || 0);
	if(legacyRating > 0)
	{
		shown = Math.max(shown, 1);
		liked = Math.max(liked, 1);
	}
	else if(legacyRating < 0)
	{
		shown = Math.max(shown, 1);
		disliked = Math.max(disliked, 1);
	}

	if(liked > shown)
		shown = liked;

	if(disliked > shown)
		shown = disliked;

	return {
		normalizedPath,
		shown,
		liked,
		disliked,
	};
}

function rankRecommendedComicsForDisplay(comics = [], feedback = {})
{
	const ranked = [];
	const feedbackLookup = buildRecommendationFeedbackLookup(feedback);

	for(let i = 0, len = comics.length; i < len; i++)
	{
		const comic = comics[i];
		const stats = getRecommendationStats(feedback, comic?.path || '', feedbackLookup);
		const shown = stats.shown;
		const liked = stats.liked;
		const disliked = stats.disliked;

		if(disliked >= RECOMMENDATION_SUPPRESS_DISLIKES)
			continue;

		const likeRatio = (liked + 1) / (shown + 2);
		const exposurePenalty = Math.min(45, shown * 6);
		const dislikePenalty = Math.min(30, disliked * 7);
		const likeBoost = Math.round(likeRatio * 30);
		const fairnessBoost = (disliked >= RECOMMENDATION_FAIRNESS_DISLIKE_START) ? Math.min(4, 1 + Math.floor((disliked - RECOMMENDATION_FAIRNESS_DISLIKE_START) / 45)) : 0;
		const refreshJitter = Math.random() * 7;

		const recommendationDisplayScore = Math.max(1, Math.round((comic.recommendationScore || 0) + likeBoost + fairnessBoost - exposurePenalty - dislikePenalty + refreshJitter));

		ranked.push({
			...comic,
			recommendationDisplayScore,
			recommendationFeedbackShown: shown,
			recommendationFeedbackLiked: liked,
			recommendationFeedbackDisliked: disliked,
		});
	}

	ranked.sort(function(a, b){
		if((b.recommendationDisplayScore || 0) !== (a.recommendationDisplayScore || 0))
			return (b.recommendationDisplayScore || 0) - (a.recommendationDisplayScore || 0);

		if((b.recommendationScore || 0) !== (a.recommendationScore || 0))
			return (b.recommendationScore || 0) - (a.recommendationScore || 0);

		return (Math.random() > 0.5) ? 1 : -1;
	});

	return ranked;
}

function clamp(value = 0, min = 0, max = 100)
{
	return Math.max(min, Math.min(max, value));
}

function buildInternalRankingSidebar(comics = [], trackingFolderMetadata = {}, recommendationFeedback = {})
{
	const recommendationCandidates = buildRecommendationCandidates(comics, trackingFolderMetadata);
	const feedbackLookup = buildRecommendationFeedbackLookup(recommendationFeedback);
	const ranked = [];
	const seen = new Set();

	for(let i = 0, len = recommendationCandidates.candidates.length; i < len; i++)
	{
		const comic = recommendationCandidates.candidates[i];
		const path = normalizeRecommendationPath(comic?.path || '');
		if(!path)
			continue;

		const key = normalizeRecommendationKey(path);
		if(!key || seen.has(key))
			continue;

		seen.add(key);

		const metadata = trackingFolderMetadata[path] || trackingFolderMetadata[comic.path] || {};
		const stats = getRecommendationStats(recommendationFeedback, path, feedbackLookup);
		const anilistRating = clamp(+(metadata?.rating || 0), 0, 100);
		const likes = stats.liked;
		const dislikes = stats.disliked;

		if(dislikes >= RECOMMENDATION_SUPPRESS_DISLIKES)
			continue;

		if(anilistRating <= 0 && likes <= 0 && dislikes <= 0)
			continue;

		const totalVotes = likes + dislikes;
		const voteBalance = (likes - dislikes) / Math.max(1, totalVotes);
		const voteConfidence = Math.min(1, totalVotes / 30);
		const feedbackScore = clamp(50 + (voteBalance * 50 * voteConfidence), 0, 100);
		const finalRanking = clamp((anilistRating * 0.78) + (feedbackScore * 0.22), 0, 100);

		ranked.push({
			path,
			name: metadata?.title || comic?.name || p.basename(path),
			author: metadata?.author || comic?.subname || '',
			anilistRating: +anilistRating.toFixed(1),
			likes,
			dislikes,
			finalRanking: +finalRanking.toFixed(1),
			totalVotes,
		});
	}

	ranked.sort(function(a, b){
		if((b.finalRanking || 0) !== (a.finalRanking || 0))
			return (b.finalRanking || 0) - (a.finalRanking || 0);

		if((b.anilistRating || 0) !== (a.anilistRating || 0))
			return (b.anilistRating || 0) - (a.anilistRating || 0);

		return (b.likes || 0) - (a.likes || 0);
	});

	for(let i = 0, len = ranked.length; i < len; i++)
		ranked[i].rank = i + 1;

	return ranked.slice(0, 20);
}

function internalRankingSidebar(comics = [])
{
	const trackingFolderMetadata = relative.get('trackingFolderMetadata') || {};
	const recommendationFeedback = storage.get('recommendationFeedback') || {};

	return buildInternalRankingSidebar(comics, trackingFolderMetadata, recommendationFeedback);
}

// The library page re-renders on every navigation, reload and filter change. Counting each
// of those as an impression drove `shown` (and therefore the exposure penalty) to its cap
// within a handful of clicks, so impressions are collapsed into a cooldown window.
const RECOMMENDATION_IMPRESSION_COOLDOWN_MS = 10 * 60 * 1000;

function registerRecommendationsShown(comics = [])
{
	if(!comics.length)
		return;

	const feedback = storage.get('recommendationFeedback') || {};
	const now = Date.now();
	let changed = false;

	for(let i = 0, len = comics.length; i < len; i++)
	{
		const comic = comics[i];
		const path = normalizeRecommendationPath(comic?.path || '');
		if(!path)
			continue;

		const previous = feedback[path] || feedback[comic.path] || {};

		if(previous.updatedAt && (now - +previous.updatedAt) < RECOMMENDATION_IMPRESSION_COOLDOWN_MS)
			continue;

		const stats = getRecommendationStats(feedback, path);

		feedback[path] = {
			shown: stats.shown + 1,
			liked: stats.liked,
			disliked: stats.disliked,
			// Must be carried over: dropping it wiped the user's thumbs up/down state every
			// time the card was rendered again.
			lastRating: +(previous.lastRating || previous.rating || 0),
			updatedAt: now,
		};

		changed = true;
	}

	if(changed)
		storage.update('recommendationFeedback', feedback);
}

async function box(_comics, single, title, order, orderKey = false, orderKey2 = false, variant = '')
{
	const viewModuleSize = handlebarsContext.page.viewModuleSize || 150;

	let comics = [];

	for(let i = 0, len = _comics.length; i < len; i++)
	{
		comics.push(_comics[i]);
	}

	comics.sort(function(a, b){
		return -(dom.orderBy(a, b, order, orderKey, orderKey2));
	});

	// Top sections render 3 boxes side-by-side, so cap items per box based on
	// estimated box width to keep title/author readable.
	const maxItems = getBoxMaxItems();

	comics = app.copy(comics.slice(0, maxItems));
	const len = comics.length;

	// Find images here
	for(let i = 0; i < len; i++)
	{
		const hasLoadedImages = !!(comics[i].poster || (Array.isArray(comics[i].images) && comics[i].images.length));

		if(!hasLoadedImages || comics[i].addToQueue === 2 || (viewModuleSize !== 100 && viewModuleSize !== 150))
		{
			const images = await dom.getFolderThumbnails(comics[i].path, viewModuleSize);

			comics[i].poster = images.poster;
			comics[i].images = images.images;
			comics[i].progress = images.progress;
		}
	}

	if(len)
	{
		comics[0] = app.copy(comics[0]);
		comics[0].noHighlight = true;
	}

	const box = {
		title: title,
		boxes: true,
		size: viewModuleSize,
		comics: comics,
		variant: variant,
	};

	// Guard: only push one box per variant — concurrent loadIndexPage calls can
	// otherwise accumulate duplicate sections before reset() is called again.
	const alreadyExists = variant && handlebarsContext.boxes.some(function(b){ return b.variant === variant; });

	if(!alreadyExists && (len > 1 || (single && len > 0)))
		handlebarsContext.boxes.push(box);

	return comics;
}

function continueReading(comics, single = false)
{
	const hideFromContinueReading = relative.get('hideFromContinueReading') || {};
	const candidates = buildIndexedBoxCandidates(comics).filter(function(comic){
		if(!comic?.path)
			return true;

		return !(hideFromContinueReading[comic.path] || hideFromContinueReading[p.normalize(comic.path)]);
	});

	let readingCandidates = candidates.filter(function(comic){
		return +(comic?.readingProgress?.lastReading || 0) > 0;
	});

	if(!readingCandidates.length)
		readingCandidates = candidates;

	// Show continue-reading even when there is only one candidate so the
	// user sees the "Continue reading" card immediately after starting.
	return box(readingCandidates, true, language.comics.continueReading, 'real-numeric', 'readingProgress', 'lastReading', 'continue');
}

function recentlyAdded(comics, single = false)
{
	const candidates = buildIndexedBoxCandidates(comics);
	return box(candidates, single, language.comics.recentlyAdded, 'real-numeric', 'added', false, 'recent');
}

function buildIndexedBoxCandidates(comics = [])
{
	const trackingFolderMetadata = relative.get('trackingFolderMetadata') || {};
	const readingProgress = relative.get('readingProgress') || {};
	const recommendationCandidates = buildRecommendationCandidates(comics, trackingFolderMetadata);

	const filtered = [];

	for(let i = 0, len = recommendationCandidates.candidates.length; i < len; i++)
	{
		const comic = recommendationCandidates.candidates[i];

		// Items sourced from trackingFolderMetadata are always real manga — keep them.
		if(comic.fromMasterFolder === true)
		{
			comic.readingProgress = readingProgress[comic.path] || { lastReading: 0 };
			filtered.push(comic);
			continue;
		}

		// Items from the current page that are NOT plain folders are real content — keep them.
		if(!comic.folder || compatible.compressed(comic.path))
		{
			comic.readingProgress = readingProgress[comic.path] || { lastReading: 0 };
			filtered.push(comic);
			continue;
		}

		// Plain folder items from the current page: keep if they have direct tracking metadata
		// (meaning they ARE a manga, not just a category container like "3 Reading") OR the user
		// has actually read from them. Tracking metadata alone missed any series AniList can't
		// match (an obscure title, a fan translation, a typo'd folder name) - which meant a manga
		// read many times could never reach "Continue reading" while still showing up in Recents,
		// since Recents has no such dependency. Real reading progress is an unambiguous signal on
		// its own that this is a real series folder, metadata match or not.
		//
		// progress.save() writes an entry at every folder between the file actually read and
		// dom.history.mainPath (see reading/progress.js), not just the series folder - so a
		// category container that merely holds a recently-read series (e.g. "3 Reading") gets an
		// entry too, purely because mainPath was stuck at it for a library organised deeper than
		// category/series. `pages` alone cannot tell the two apart: progress.save() zeroes it on
		// any entry flagged `isParent`, but that is also true of a perfectly real series whose
		// chapters are themselves archives/PDFs. What does tell them apart is the entry's own
		// `role` tag (see reading/progress.js and isGenuineSeriesProgress() above) - fixed at the
		// moment it was written, so it stays reliable even once whichever entry it once shared a
		// read with has long since been overwritten by something else.
		const normalizedPath = p.normalize(comic.path || '');
		const hasDirectMetadata = !!(trackingFolderMetadata[normalizedPath] || trackingFolderMetadata[comic.path]);
		const progressForPath = readingProgress[comic.path] || readingProgress[normalizedPath];
		const hasReadingProgress = !!progressForPath?.path
			&& fileManager.isParentPath(normalizedPath, progressForPath.path)
			&& isGenuineSeriesProgress(normalizedPath, progressForPath, readingProgress);

		if(hasDirectMetadata || hasReadingProgress)
		{
			comic.readingProgress = progressForPath || { lastReading: 0 };
			filtered.push(comic);
		}
	}

	return filtered;
}

// `added` comes from the filesystem ctime, which effectively never changes for an existing
// series. Caching it avoids a pair of synchronous existsSync/statSync calls per tracked folder
// on every library render — with a few hundred tracked series that was the single most
// expensive thing on the page-load path, and it blocks rendering because it is synchronous.
//
// This used to also persist across app restarts, keyed by path, in a new storage.js entry. That
// is reverted: it introduced unbounded, ever-growing state with no proven benefit large enough
// to justify the risk, and it landed at the same time as reports of the app hanging on
// navigation and starting up slower. The in-memory, per-session cache below is the version that
// was measured and is well understood; nothing here writes to disk or reads from it.
const CANDIDATE_STAT_TTL = 2 * 60 * 1000;
const candidateStatCache = new Map();

function getCandidateStat(path = '')
{
	const now = Date.now();
	const cached = candidateStatCache.get(path);

	if(cached && (now - cached.checkedAt) < CANDIDATE_STAT_TTL)
		return cached;

	const stat = {checkedAt: now, exists: false, added: 0};

	stat.exists = fileManager.simpleExists(path);

	if(stat.exists)
	{
		let statsPath = path;

		try
		{
			const firstCompressedFile = fileManager.firstCompressedFile(path, 0, false);
			if(firstCompressedFile)
				statsPath = firstCompressedFile;
		}
		catch(error){}

		try
		{
			if(!fileManager.isServer(path))
				stat.added = Math.round(fs.statSync(statsPath).ctimeMs / 1000);
		}
		catch(error){}
	}

	candidateStatCache.set(path, stat);

	while(candidateStatCache.size > 2000)
		candidateStatCache.delete(candidateStatCache.keys().next().value);

	return stat;
}

// progress.save() writes the same read at up to three readingProgress keys (see
// reading/progress.js) and tags each with which of the three it is: 'series' for the folder in
// between mainPath and a chapter (present only when a library is organised deeper than plain
// category/series), 'chapter' for the read file's immediate parent, and 'mainPath' for
// dom.history.mainPath itself. Earlier this compared *entries* to spot the pattern instead of
// trusting that tag, by grouping keys that shared an exact (path, lastReading) signature - but
// entries at different keys are NOT overwritten together: mainPath and the series folder get
// overwritten by every subsequent read anywhere in the same series, while a chapter's own key
// is unique to it and never touched again once you move on from it. A chapter read weeks ago,
// once its one-time group-mates have since been overwritten by a more recent read, becomes a
// permanent, ordinary-looking lone entry - which is exactly how individual chapter files ended
// up in Continue reading. `role` does not have this problem: it is fixed at the moment an entry
// is written and never needs another entry to still exist to mean anything.
//
// A 'mainPath'-tagged entry is genuine series evidence only if nothing more specific (a
// 'series' or 'chapter' tagged entry somewhere inside it) was *ever* recorded under it - that
// still being true is what tells apart a flat two-level library (mainPath already is the
// series, nothing deeper ever gets tagged) from mainPath having been a category all along.
function isGenuineSeriesProgress(normalizedPath, entry, readingProgress)
{
	if(!entry || +(entry.lastReading || 0) <= 0)
		return false;

	if(entry.role === 'series')
		return true;

	if(entry.role === 'chapter')
		return false;

	// role === 'mainPath', or absent on an entry written before this tag existed.
	const key = normalizedPath.toLowerCase();

	for(const otherKey in readingProgress)
	{
		const other = readingProgress[otherKey];

		if(!other || (other.role !== 'series' && other.role !== 'chapter'))
			continue;

		const normalizedOtherKey = p.normalize(otherKey);

		if(normalizedOtherKey.toLowerCase() === key)
			continue;

		if(fileManager.isParentPath(normalizedPath, normalizedOtherKey))
			return false;
	}

	return true;
}

// A single library render calls this four times (continue reading, recently added,
// recommended, ranking sidebar) with the same inputs. Memoise per render instead of
// recomputing the whole candidate list — and re-walking the metadata map — each time.
var recommendationCandidatesCache = false;

function buildRecommendationCandidates(comics = [], trackingFolderMetadata = {})
{
	if(recommendationCandidatesCache
		&& recommendationCandidatesCache.comics === comics
		&& recommendationCandidatesCache.metadata === trackingFolderMetadata)
		return recommendationCandidatesCache.result;

	const result = _buildRecommendationCandidates(comics, trackingFolderMetadata);

	recommendationCandidatesCache = {
		comics: comics,
		metadata: trackingFolderMetadata,
		result: result,
	};

	return result;
}

function _buildRecommendationCandidates(comics = [], trackingFolderMetadata = {})
{
	const candidates = [];
	const indexedPaths = {};
	const currentPaths = {};

	for(let i = 0, len = comics.length; i < len; i++)
	{
		const comic = comics[i];
		if(!comic?.path)
			continue;

		const path = p.normalize(comic.path);
		const key = String(path).toLowerCase();

		if(indexedPaths[key])
			continue;

		indexedPaths[key] = true;
		currentPaths[key] = true;
		candidates.push(comic);
	}

	for(const metadataPath in trackingFolderMetadata)
	{
		const path = p.normalize(metadataPath);
		const key = String(path).toLowerCase();

		if(indexedPaths[key])
			continue;

		const stat = getCandidateStat(path);

		if(!stat.exists)
			continue;

		indexedPaths[key] = true;

		const metadata = trackingFolderMetadata[metadataPath] || {};
		let added = stat.added;

		if(!added && metadata.updatedAt)
			added = Math.round(+metadata.updatedAt / 1000);

		candidates.push({
			name: metadata.title || p.basename(path),
			subname: metadata.author || false,
			path: path,
			mainPath: path,
			added: added,
			folder: true,
			compressed: compatible.compressed(path),
			fromMasterFolder: true,
		});
	}

	// A series with genuine reading progress but no AniList match (an obscure title, a fan
	// translation, a typo'd folder name) is invisible above: it is not on trackingFolderMetadata,
	// and it only appears in `comics` at all when the page currently being rendered happens to be
	// its own parent folder - never from the library root, several folders up. progress.save()
	// now leaves a 'series'-tagged entry at the actual series folder regardless of nesting depth
	// (see reading/progress.js), so add it here the same way a tracking match is added above -
	// only ever from a 'series'-tagged entry, never a 'chapter' or plain 'mainPath' one, so an
	// individual chapter file can never surface as its own card here.
	const readingProgress = relative.get('readingProgress') || {};

	for(const progressPath in readingProgress)
	{
		if(readingProgress[progressPath]?.role !== 'series' || +(readingProgress[progressPath]?.lastReading || 0) <= 0)
			continue;

		const path = p.normalize(progressPath);
		const key = String(path).toLowerCase();

		if(indexedPaths[key])
			continue;

		const stat = getCandidateStat(path);

		if(!stat.exists)
			continue;

		indexedPaths[key] = true;

		candidates.push({
			name: p.basename(path),
			path: path,
			mainPath: path,
			added: stat.added,
			folder: true,
			compressed: compatible.compressed(path),
			fromMasterFolder: true,
		});
	}

	return {
		candidates,
		currentPaths,
	};
}

function applyRecommendationFeedbackButtonState(button = false)
{
	if(!button || !button.classList)
		return;

	const container = button.parentElement;
	if(container)
	{
		const siblings = container.querySelectorAll('.recommendation-feedback-button');

		for(let i = 0, len = siblings.length; i < len; i++)
			siblings[i].classList.remove('fill');
	}

	button.classList.add('fill');
}

function setRecommendationFeedback(path = '', rating = 0, event = false, button = false)
{
	if(event)
	{
		event.preventDefault();
		event.stopPropagation();
	}

	const normalizedPath = normalizeRecommendationPath(path);
	if(!normalizedPath)
		return;

	const feedback = storage.get('recommendationFeedback') || {};
	const nextRating = +(rating || 0);
	const stats = getRecommendationStats(feedback, normalizedPath);

	if(nextRating !== 1 && nextRating !== -1)
		return;

	feedback[normalizedPath] = {
		shown: stats.shown,
		liked: stats.liked + (nextRating > 0 ? 1 : 0),
		disliked: stats.disliked + (nextRating < 0 ? 1 : 0),
		lastRating: nextRating,
		updatedAt: Date.now(),
	};

	storage.update('recommendationFeedback', feedback);
	applyRecommendationFeedbackButtonState(button);

	if(nextRating < 0)
		dom.reload();
}

async function recommended(comics, single = false)
{
	const trackingFolderMetadata = relative.get('trackingFolderMetadata') || {};
	const recommendationFeedback = storage.get('recommendationFeedback') || {};
	const recommendationCandidates = buildRecommendationCandidates(comics, trackingFolderMetadata);

	let recommendedComics = recommendations.buildRecommendations(recommendationCandidates.candidates, {
		trackingFolderMetadata,
		readingProgress: relative.get('readingProgress') || {},
		readingPages: storage.get('readingPages') || {},
		recommendationFeedback,
	});

	recommendedComics = recommendedComics.filter(function(comic){
		const key = String(p.normalize(comic?.path || '')).toLowerCase();
		if(!key)
			return false;

		return !recommendationCandidates.currentPaths[key];
	});

	if(!recommendedComics.length)
		return;

	recommendedComics = rankRecommendedComicsForDisplay(recommendedComics, recommendationFeedback);

	const selectedComics = selectRecommendedComicsForDisplay(recommendedComics, getBoxMaxItems());
	registerRecommendationsShown(selectedComics);

	return box(selectedComics, single, language.comics.recommendedForYou || 'Recommended for you', 'real-numeric', 'recommendationDisplayScore', false, 'recommended');
}

// Trending/Popular rows on the Catalogs page. Not a library box - the items are AniList
// entries the user does not own, not comics/folders - so this pushes the same {title, boxes,
// comics, variant} shape box() produces, but skips everything box() does that only makes sense
// for local content: thumbnail generation, reading-progress sort, per-folder stat lookups.
// index.content.right.boxes.html renders these through a dedicated item partial (matched by
// `variant`) rather than the shared library item template, because that template points its
// image through shortWindowsPath/encodeSrcURI - path helpers that corrupt a plain https:// URL
// (they split on path separators and percent-encode the result), so it can only ever be used
// for local files.
function pushTrendingBox(title, items, variant)
{
	if(!items || !items.length)
		return;

	// Replace rather than skip: the refresh callback calls this again for the same variant once
	// real data lands, and that has to overwrite the row built from cache, not be dropped
	// because a "same variant" entry already exists.
	handlebarsContext.boxes = handlebarsContext.boxes.filter(function(b) { return b.variant !== variant });

	handlebarsContext.boxes.push({
		title: title,
		boxes: true,
		comics: items,
		variant: variant,
	});
}

/**
 * Renders whatever is already cached for the AniList discovery rows immediately (nothing, on a
 * first-ever run), then refreshes in the background and re-renders the boxes section in place
 * once real data arrives. Deliberately not awaited by callers past the cache read - opds.js
 * calls this without awaiting the network part, so opening the Catalogs page is never gated on
 * AniList responding.
 */
function trending()
{
	const cached = opdsTrending.loadAndRefresh(function(fresh) {

		// .opds-boxes alone is not a safe "still on this page?" check: opds.content.right.
		// browse.html (browsing into one specific catalog) has its own, unrelated .opds-boxes
		// wrapper for that catalog's continue-reading/recently-added rows. .opds-page-title only
		// exists on the Catalogs home page, so requiring both is what actually confirms the user
		// has not navigated to a different OPDS page (or away from OPDS) before this resolved.
		if(!document.querySelector('.opds-page-title'))
			return;

		const container = document.querySelector('.opds-boxes');
		if(!container)
			return;

		for(const row of opdsTrending.rows())
		{
			if(fresh[row.key])
				pushTrendingBox(language.global[row.titleKey] || row.key, fresh[row.key], row.variant);
		}

		container.innerHTML = template.load('index.content.right.boxes.html');

	});

	for(const row of opdsTrending.rows())
	{
		if(cached[row.key])
			pushTrendingBox(language.global[row.titleKey] || row.key, cached[row.key], row.variant);
	}
}

function reset()
{
	handlebarsContext.boxes = [];

	// Called at the start of every library render, so this is where the per-render candidate
	// memo is dropped (it also stops it holding the previous page's comic list alive).
	recommendationCandidatesCache = false;
}

module.exports = {
	continueReading: continueReading,
	recentlyAdded: recentlyAdded,
	recommended: recommended,
	setRecommendationFeedback: setRecommendationFeedback,
	internalRankingSidebar: internalRankingSidebar,
	trending: trending,
	reset: reset,
};
