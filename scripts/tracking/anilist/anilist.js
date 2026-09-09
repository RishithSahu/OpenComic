var site = {}, controller = false;

// Simple rate-limit and retry helpers to avoid AniList 429s
let _lastRequestTime = 0;
let _rateLimitedUntil = 0;
let _requestChain = Promise.resolve();
const _minRequestInterval = 1800; // milliseconds between requests
const _maxRetryAfterMs = 120000;
const _searchCache = {}; // cache search results for this session

async function _sleep(ms){
	if(typeof app !== 'undefined' && app.sleep) return await app.sleep(ms);
	return new Promise((r) => setTimeout(r, ms));
}

function _clampInteger(value, min = 0, max = Number.MAX_SAFE_INTEGER)
{
	value = Math.floor(Number(value) || 0);

	if(value < min) value = min;
	if(value > max) value = max;

	return value;
}

function _retryAfterToMs(retryAfter = '')
{
	retryAfter = String(retryAfter || '').trim();
	if(!retryAfter) return 0;

	// Retry-After can be either seconds or a date.
	if(/^\d+$/.test(retryAfter))
		return _clampInteger(retryAfter, 0, Math.floor(_maxRetryAfterMs / 1000)) * 1000;

	const date = new Date(retryAfter).getTime();
	if(Number.isFinite(date))
		return _clampInteger(date - Date.now(), 0, _maxRetryAfterMs);

	return 0;
}

async function _queuedRequest(request)
{
	const run = async function() {
		const now = Date.now();
		const waitMs = Math.max(
			Math.max(0, _rateLimitedUntil - now),
			Math.max(0, _minRequestInterval - (now - _lastRequestTime))
		);

		if(waitMs > 0)
			await _sleep(waitMs);

		const response = await request();
		_lastRequestTime = Date.now();

		return response;
	};

	const promise = _requestChain.then(run, run);
	_requestChain = promise.catch(function() {});

	return promise;
}

async function _graphQLFetch(body, headers = {}, retries = 3, signal = null)
{
	const options = {
		method: 'POST',
		headers: Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json' }, headers),
		body: JSON.stringify(body),
	};

	if (signal)
		options.signal = signal;

	try {
		const response = await _queuedRequest(function() {
			return fetch('https://graphql.anilist.co', options);
		});

		if(response && response.status === 403)
		{
			// A bare 403 with no Retry-After is Cloudflare's bot-management gate, not AniList's
			// own documented rate limit - and, in every case observed against this session's own
			// requests, one that does not clear within the couple of minutes an in-place retry
			// ladder would spend waiting it out. Retrying here anyway meant every single scrape
			// attempt paid up to a minute of backoff before scrapeFolderMetadata() (tracking.js)
			// could fall through to its MyAnimeList backup - stacked across every folder in a
			// large, newly-scraped category, that reads as nothing ever finishing at all. Fail
			// this one attempt immediately instead; the shared queue pacing below
			// (_rateLimitedUntil) still keeps subsequent calls from bursting on top of it.
			const headerRetryMs = _retryAfterToMs(response.headers?.get('retry-after'));
			const retryMs = _clampInteger(Math.max(headerRetryMs, 60000), 60000, _maxRetryAfterMs);
			_rateLimitedUntil = Math.max(_rateLimitedUntil, Date.now() + retryMs);

			return response;
		}

		if(response && response.status === 429)
		{
			const headerRetryMs = _retryAfterToMs(response.headers?.get('retry-after'));
			const exponentialRetryMs = 1500 * Math.pow(2, Math.max(0, 3 - retries));
			const retryMs = _clampInteger(Math.max(headerRetryMs, exponentialRetryMs), 1000, _maxRetryAfterMs);
			_rateLimitedUntil = Math.max(_rateLimitedUntil, Date.now() + retryMs);

			if(retries > 0)
			{
				await _sleep(retryMs);
				return _graphQLFetch(body, headers, retries - 1, signal);
			}
		}

		if(response && response.status >= 500 && retries > 0)
		{
			const retryMs = _clampInteger(1000 * Math.pow(2, Math.max(0, 3 - retries)), 500, 10000);
			await _sleep(retryMs);
			return _graphQLFetch(body, headers, retries - 1, signal);
		}

		return response;
	} catch (err) {
		if(err && err.name === 'AbortError')
			throw err;

		if (retries > 0) {
			await _sleep(1000);
			return _graphQLFetch(body, headers, retries - 1, signal);
		}
		throw err;
	}
}

function setSiteData(siteData)
{
	site = siteData;
}

// Search comic/manga in site
async function searchComic(title)
{
	if(controller) controller.abort();
	controller = new AbortController();

	const query = `
	query ($id: Int, $page: Int, $perPage: Int, $search: String) {
		Page (page: $page, perPage: $perPage) {
			pageInfo {
				total
				currentPage
				lastPage
				hasNextPage
				perPage
			}
			media (id: $id, type: MANGA, search: $search) {
				id
				averageScore
				coverImage {
					medium
					large
					extraLarge
				}
				title {
					romaji
					english
					native
					userPreferred
				}
				synonyms
				startDate {
					year
				}
				staff {
					edges {
						role
						node {
							name {
								full
							}
						}
					}
			    }
			}
		}
	}
	`;

	const variables = {
		search: title,
		page: 1,
		perPage: 10
	};

	// normalize title key for cache
	const cacheKey = (title || '').trim().toLowerCase();
	// cache simple search results per title in-session
	if(cacheKey && _searchCache[cacheKey])
	{
		try {
			handlebarsContext.trackingResults = _searchCache[cacheKey];
			$('.tracking-search').html(template.load('dialog.tracking.search.results.html'));
		} catch(e) {}
		return _searchCache[cacheKey];
	}

	const body = { query: query, variables: variables };

	try
	{
		const response = await _graphQLFetch(body, {}, 3, controller.signal);

		if(response && response.status == 200)
		{
			const json = await response.json();
			const results = (json.data?.Page?.media || []).map(function(media) {

				const authors = (media?.staff?.edges || []).map(function(author) {

					if(['Story', 'Art', 'Story & Art', 'Original Story'].includes(author.role))
						return author.node.name.full;

					return false;

				}).filter(Boolean);

				return {
					id: media.id,
					title: media?.title?.romaji || media?.title?.english || media?.title?.native || media?.title?.userPreferred || '',
					titleRomaji: media?.title?.romaji || '',
					titleEnglish: media?.title?.english || '',
					titleNative: media?.title?.native || '',
					titleUserPreferred: media?.title?.userPreferred || '',
					synonyms: Array.isArray(media?.synonyms) ? media.synonyms : [],
					serializationYear: +(media?.startDate?.year || 0),
					rating: +(media?.averageScore || 0),
					image: (media?.coverImage?.medium || media?.coverImage?.large || media?.coverImage?.extraLarge || ''),
					authors: authors,
				};
			});

			if(cacheKey) _searchCache[cacheKey] = results;
			try {
				handlebarsContext.trackingResults = results;
				$('.tracking-search').html(template.load('dialog.tracking.search.results.html'));
			} catch(e) {}
			return results;
		}
	}
	catch(error) {}

	// ensure UI is cleared on error
	try {
		handlebarsContext.trackingResults = [];
		$('.tracking-search').html(template.load('dialog.tracking.search.results.html'));
	} catch(e) {}

	return [];
}

function normalizeDemographic(tags = [])
{
	const order = ['shounen', 'shonen', 'seinen', 'shoujo', 'shojo', 'josei', 'kodomomuke'];
	const map = {
		shonen: 'shonen',
		shounen: 'shonen',
		seinen: 'seinen',
		shojo: 'shojo',
		shoujo: 'shojo',
		josei: 'josei',
		kodomomuke: 'kodomomuke',
	};

	const tagNames = (Array.isArray(tags) ? tags : []).map(function(tag) {
		return String(tag?.name || '').toLowerCase();
	});

	for(let i = 0, len = order.length; i < len; i++)
	{
		const key = order[i];

		if(tagNames.includes(key))
			return map[key];
	}

	return '';
}

function extractPrimaryAuthor(staffEdges = [])
{
	const preferredRoles = ['Story', 'Story & Art', 'Original Story', 'Original Creator', 'Art'];

	for(let i = 0, len = preferredRoles.length; i < len; i++)
	{
		const role = preferredRoles[i];
		const match = staffEdges.find(function(edge) {
			return edge?.role === role && edge?.node?.name?.full;
		});

		if(match)
			return match.node.name.full;
	}

	const first = staffEdges.find(function(edge) {
		return edge?.node?.name?.full;
	});

	return first?.node?.name?.full || '';
}

function normalizeSeriesType(countryOfOrigin = '')
{
	const country = String(countryOfOrigin || '').trim().toUpperCase();

	if(country === 'JP')
		return 'manga';
	if(country === 'KR')
		return 'manhwa';
	if(country === 'CN' || country === 'TW' || country === 'HK')
		return 'manhua';

	return '';
}

// Manga discovery for the Catalogs page. Unlike getComicMetadata() this isn't looking up one
// known title — it asks AniList's own ranking for what belongs in a "Trending"/"Popular" row,
// so it returns a normalized *list* rather than one media entry, and skips the fields that only
// matter once a specific title has been picked (description, chapters/volumes, staff).
async function getTrending(sort = 'TRENDING_DESC', perPage = 20)
{
	const query = `
	query ($sort: [MediaSort], $perPage: Int) {
		Page (page: 1, perPage: $perPage) {
			media (type: MANGA, sort: $sort, isAdult: false) {
				id
				averageScore
				countryOfOrigin
				coverImage {
					medium
					large
					extraLarge
				}
				title {
					romaji
					english
					native
					userPreferred
				}
			}
		}
	}
	`;

	const variables = {
		sort: [sort],
		perPage: perPage,
	};

	const body = { query: query, variables: variables };

	try
	{
		const response = await _graphQLFetch(body, {}, 3);
		if(!response || response.status !== 200)
			return [];

		const json = await response.json();
		const media = json?.data?.Page?.media || [];

		return media.map(function(item) {

			return {
				id: item.id,
				// Named `name`, not `title`: every comic-shaped object rendered by the box
				// templates uses `name` for its display title, and these go through that same
				// rendering path (see index.content.right.trending.item.html).
				name: item?.title?.userPreferred || item?.title?.romaji || item?.title?.english || item?.title?.native || '',
				image: item?.coverImage?.large || item?.coverImage?.extraLarge || item?.coverImage?.medium || '',
				// Built here rather than in the template: AniList redirects /manga/<id> to the
				// full slugged URL on its own, so the id alone is a complete, valid link.
				url: 'https://anilist.co/manga/' + item.id,
				rating: +(item?.averageScore || 0),
				seriesType: normalizeSeriesType(item?.countryOfOrigin),
			};

		}).filter(function(item) { return item.id && item.name });
	}
	catch(error) {}

	return [];
}

async function getComicMetadata(siteId)
{
	const query = `
	query ($id: Int, $type: MediaType) {
		Media (id: $id, type: $type) {
			id
			averageScore
			title {
				romaji
				english
				native
				userPreferred
			}
			synonyms
			description(asHtml: false)
			genres
			countryOfOrigin
			tags {
				name
				rank
			}
			startDate {
				year
			}
			chapters
			volumes
			staff(sort: [RELEVANCE], perPage: 20) {
				edges {
					role
					node {
						name {
							full
						}
					}
				}
			}
		}
	}
	`;

	const variables = {
		id: siteId,
		type: 'MANGA',
	};

	const body = { query: query, variables: variables };

	try
	{
		const response = await _graphQLFetch(body, {}, 3);
		if(!response || response.status !== 200)
			return {};

		const json = await response.json();
		const media = json?.data?.Media;
		if(!media)
			return {};

		const staffEdges = media?.staff?.edges || [];

		// Determine seriesType: prefer explicit AniList tags, fall back to country
		let seriesType = normalizeSeriesType(media?.countryOfOrigin);
		try {
			const tagNames = (Array.isArray(media?.tags) ? media.tags.map(t => String(t?.name || '').toLowerCase()) : []);
			if(!seriesType) {
				if(tagNames.includes('manhwa')) seriesType = 'manhwa';
				else if(tagNames.includes('manhua')) seriesType = 'manhua';
				else if(tagNames.includes('manga')) seriesType = 'manga';
			}
		} catch(e) {}

		return {
			id: media.id,
			title: media?.title?.userPreferred || media?.title?.romaji || media?.title?.english || media?.title?.native || '',
			titleRomaji: media?.title?.romaji || '',
			titleEnglish: media?.title?.english || '',
			titleNative: media?.title?.native || '',
			titleUserPreferred: media?.title?.userPreferred || '',
			synonyms: Array.isArray(media?.synonyms) ? media.synonyms : [],
			author: extractPrimaryAuthor(staffEdges),
			seriesType: seriesType,
			demographic: normalizeDemographic(media?.tags || []),
			genres: Array.isArray(media?.genres) ? media.genres : [],
			description: String(media?.description || ''),
			serializationYear: +(media?.startDate?.year || 0),
			rating: +(media?.averageScore || 0),
			chapters: +(media?.chapters || 0),
			volumes: +(media?.volumes || 0),
		};
	}
	catch(error) {}

	return {};
}

// Return data of comic/manga
async function getComicData(siteId)
{
	const query = `
	query ($id: Int, $type: MediaType) {
		Media (id: $id, type: $type) {
			id
			chapters
			volumes
			averageScore
			mediaListEntry {
				status
				progress
				progressVolumes
			}
			coverImage {
				large
			}
			title {
				romaji
			}
		}
	}
	}
	`;

	const variables = {
		id: siteId,
		type: 'MANGA'
	};

	const body = { query: query, variables: variables };

	try
	{
		const response = await _graphQLFetch(body, { 'Authorization': 'Bearer '+site.config.session.token }, 3);

		if(!response) return {};

		if(response.status == 400 || response.status == 401)
		{
			tracking.invalidateSession(site.key, true);
			return null;
		}
		else if(response.status == 200)
		{
			const json = await response.json();

			if(json.data?.Media)
			{
				const {title, coverImage, chapters, volumes, averageScore, mediaListEntry} = json.data.Media;

				return {
					title: title.romaji,
					image: coverImage.large,
					chapters: +chapters || 0,
					volumes: +volumes || 0,
					rating: +averageScore || 0,
					progress: {
						chapters: +mediaListEntry?.progress || 0,
						volumes: +mediaListEntry?.progressVolumes || 0,
					},
				};
			}
		}
	}
	catch(error) {}

	return {};
}

// Loging to site
async function login()
{
	const url = await tracking.getRedirectResult(site.key, 'https://anilist.co/api/v2/oauth/authorize?client_id='+site.auth.clientId+'&redirect_uri=opencomic://tracking/anilist&response_type=code');
	const code = url.searchParams.get('code') || url.searchParams.get('token');

	if(!code)
		return {valid: false};

	const options = {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json',
		},
		body: JSON.stringify({
			grant_type: 'authorization_code',
			client_id: site.auth.clientId,
			client_secret: site.auth.clientSecret,
			redirect_uri: 'opencomic://tracking/anilist',
			code: code,
		})
	};

	try
	{
		const response = await fetch('https://anilist.co/api/v2/oauth/token', options);

		if(response.status == 200)
		{
			const json = await response.json();
			return {valid: true, token: json.access_token, refreshToken: json.refresh_token, expiresIn: json.expires_in};
		}
	}
	catch(error) {}

	return {valid: false};
}

// Refresh session token
async function refreshToken()
{
	const options = {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json',
		},
		body: JSON.stringify({
			grant_type: 'refresh_token',
			client_id: site.auth.clientId,
			client_secret: site.auth.clientSecret,
			refresh_token: site.config.session.refreshToken,
		})
	};

	try
	{
		const response = await fetch('https://anilist.co/api/v2/oauth/token', options);

		if(response.status == 200)
		{
			const json = await response.json();
			return {valid: true, token: json.access_token, refreshToken: json.refresh_token, expiresIn: json.expires_in};
		}
	}
	catch(error) {}

	return {valid: false};
}

// Track comic/manga
async function track(toTrack)
{
	const query = `
	query ($id: Int, $type: MediaType) {
		Media (id: $id, type: $type) {
			id
			chapters
			volumes
			mediaListEntry {
				status
				progress
				progressVolumes
			}
		}
	}
	`;

	const variables = {
		id: toTrack.id,
		type: 'MANGA'
	};

	const options = {
		'Authorization': 'Bearer '+site.config.session.token,
	};
	const body = { query: query, variables: variables };

	try
	{
		const response = await _graphQLFetch(body, options, 2);

		if(response.status == 400 || response.status == 401)
		{
			tracking.invalidateSession(site.key, true);
		}
		else if(response.status == 200)
		{
			const json = (await response.json()).data?.Media || {};

			const totalChapters = +json.chapters || 0;
			const totalVolumes = +json.volumes || 0;
			const {status: userStatus, progress: userChapters, progressVolumes: userVolumes} = json?.mediaListEntry || {};

			let status, chapters, volumes;

			// Status
			if((totalChapters && toTrack.chaptersInt && toTrack.chaptersInt == totalChapters) || (totalVolumes && toTrack.volumesInt && toTrack.volumesInt == totalVolumes))
				status = 'COMPLETED';
			else if(!userStatus || userStatus !== 'CURRENT')
				status = 'CURRENT';

			// Chapters: allow manual override (`force`) or only increase by default
			if(toTrack.chaptersInt && (toTrack.force || !userChapters || toTrack.chaptersInt > userChapters))
				chapters = toTrack.chaptersInt;

			// Volumes: allow manual override (`force`) or only increase by default
			if(toTrack.volumesInt && (toTrack.force || !userVolumes || toTrack.volumesInt > userVolumes))
				volumes = toTrack.volumesInt;

			const variables = {mediaId: toTrack.id};
			if(status && (chapters || volumes)) variables.status = status;
			if(chapters) variables.progress = chapters;
			if(volumes) variables.volumes = volumes;

			if(!status && !chapters && !volumes)
				return; // Nothing to update

			tracking.setTrackingChapters(site.key, {
				chapters: totalChapters,
				volumes: totalVolumes,
				progress: {
					chapters: (chapters || userChapters),
					volumes: (volumes || userVolumes),
				},
			}, toTrack.mainPath);

			const query = `
			mutation ($mediaId: Int, $status: MediaListStatus, $progress: Int, $volumes: Int) {
				SaveMediaListEntry (mediaId: $mediaId, status: $status, progress: $progress, progressVolumes: $volumes) {
					id
					status
					progress
					progressVolumes
				}
			}
			`;

			const body2 = { query: query, variables: variables };
			// fire-and-forget with retry/backoff
			_graphQLFetch(body2, { 'Authorization': 'Bearer '+site.config.session.token }, 1).catch(()=>{});
		}
	}
	catch(error)
	{
		console.error(error);
	}
}

module.exports = {
	setSiteData: setSiteData,
	searchComic: searchComic,
	getTrending: getTrending,
	getComicMetadata: getComicMetadata,
	getComicData: getComicData,
	login: login,
	refreshToken: refreshToken,
	track: track,
};
