// AniList-powered discovery rows for the Catalogs page ("Trending Now" / "Popular").
//
// This is a small, deliberately isolated module: cache in the app's existing cache folder (via
// cache.js, which already purges/bounds it), nothing new added to storage.js, no persistence
// mechanism of its own. Loaded and refreshed only when the Catalogs page is actually opened —
// never touched at startup — so it cannot add to cold-launch time.
const anilist = require(p.join(appDir, '.dist/tracking/anilist/anilist.js'));

const ROWS = [
	{ key: 'anilist-trending', sort: 'TRENDING_DESC', variant: 'anilist-trending', titleKey: 'anilistTrendingNow' },
	{ key: 'anilist-popular', sort: 'POPULARITY_DESC', variant: 'anilist-popular', titleKey: 'anilistPopular' },
];

function readCached(key)
{
	try
	{
		const stored = cache.readJson(key);
		return (stored && Array.isArray(stored.items)) ? stored.items : false;
	}
	catch(error)
	{
		return false;
	}
}

async function refreshOne(row)
{
	const items = await anilist.getTrending(row.sort, 20);

	// A failed or empty fetch (offline, AniList down, rate limited) must not overwrite a good
	// cached list with nothing - the whole point of caching this is that the row still shows
	// something on a bad connection.
	if(items.length)
		cache.writeJson(row.key, { fetchedAt: Date.now(), items: items });

	return items;
}

/**
 * Returns whatever is cached for both rows immediately (each `false` if there is nothing yet),
 * and separately kicks off a real fetch for both in the background. `onUpdate(fresh)` — fresh
 * being `{key: items}` for whichever rows returned real data — fires once that background fetch
 * settles, so the caller can re-render with current data. Never awaited by the caller for the
 * network part: the Catalogs page must render immediately from cache, not wait on AniList.
 */
function loadAndRefresh(onUpdate)
{
	const cached = {};

	for(let i = 0, len = ROWS.length; i < len; i++)
	{
		const row = ROWS[i];
		cached[row.key] = readCached(row.key);
	}

	Promise.all(ROWS.map(function(row) { return refreshOne(row).then(function(items) { return { key: row.key, items: items } }) }))
		.then(function(results) {

			const fresh = {};

			for(let i = 0, len = results.length; i < len; i++)
			{
				if(results[i].items.length)
					fresh[results[i].key] = results[i].items;
			}

			if(Object.keys(fresh).length && onUpdate)
				onUpdate(fresh);

		})
		.catch(function(error) { console.error('AniList discovery refresh failed:', error) });

	return cached;
}

function rows()
{
	return ROWS;
}

module.exports = {
	rows: rows,
	loadAndRefresh: loadAndRefresh,
};
