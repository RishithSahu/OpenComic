var site = {}, controller = false;

function setSiteData(siteData)
{
	site = siteData;
}

// Search comic/manga in site
async function searchComic(title)
{
	if(controller) controller.abort();
	controller = new AbortController();

	const variables = new URLSearchParams({
		// MAL's manga search takes `q`/`limit`/`offset`/`fields` - not the `page`/`perPage`
		// AniList's own API uses, which this had been sending instead. MAL's API rejects the
		// request outright (400) rather than just ignoring the unrecognised parameters.
		q: title.slice(0, 64), // MAL 400s on a query much longer than this
		limit: 10,
		fields: 'title,alternative_titles,main_picture,authors{first_name,last_name}',
	});

	const options = {
		method: 'GET',
		headers: {
			'X-MAL-CLIENT-ID': site.auth.clientId,
			'Accept': 'application/json',
		},
		signal: controller.signal,
	};

	try
	{
		const response = await fetch('https://api.myanimelist.net/v2/manga?'+variables.toString(), options);

		if(response.status == 200)
		{
			const json = await response.json();
			const results = (json.data || []).map(function(item) {

				const node = item.node || {};

				const authors = (node.authors || []).map(function(author){

					if(['Story', 'Art', 'Story & Art', 'Original Story'].includes(author.role))
						return author.node.first_name+' '+author.node.last_name;

					return false;

				}).filter(Boolean);

				return {
					id: node.id,
					// The same shape scripts/tracking/anilist/anilist.js's searchComic() returns,
					// so folderTitle.rankSearchResults() (tracking/folder-title.js) can score a
					// MAL result exactly like an AniList one without knowing which site it came
					// from - MAL's search endpoint just does not carry a year or score to fill
					// serializationYear/rating with, so those stay at their default of 0.
					title: node.title || '',
					titleRomaji: node.title || '',
					titleEnglish: node?.alternative_titles?.en || '',
					titleNative: node?.alternative_titles?.ja || '',
					titleUserPreferred: node.title || '',
					synonyms: Array.isArray(node?.alternative_titles?.synonyms) ? node.alternative_titles.synonyms : [],
					serializationYear: 0,
					rating: 0,
					image: node?.main_picture?.medium || node?.main_picture?.large || '',
					authors: authors,
				};

			});

			return results;
		}
	}
	catch(error) {}

	return [];
}

// Full metadata for one manga, keyed by its own id, using only the app's client id - unlike
// getComicData() below this needs no logged-in session, since it is used for the same
// automatic, unattended lookup searchComic() above already does without one (a backup for
// scrapeFolderMetadata() in tracking.js when AniList has no match or is blocking this
// session's requests).
async function getComicMetadata(siteId)
{
	const options = {
		method: 'GET',
		headers: {
			'X-MAL-CLIENT-ID': site.auth.clientId,
			'Accept': 'application/json',
		},
	};

	const seriesTypes = { manga: 'manga', manhwa: 'manhwa', manhua: 'manhua' };

	try
	{
		const response = await fetch('https://api.myanimelist.net/v2/manga/'+siteId+'?fields=title,alternative_titles,authors{first_name,last_name},genres,media_type,mean,start_date,synopsis,num_chapters,num_volumes', options);

		if(response.status !== 200)
			return {};

		const json = await response.json();
		if(!json.id)
			return {};

		const authors = (json.authors || []).map(function(author) {

			if(['Story', 'Art', 'Story & Art', 'Original Story'].includes(author.role))
				return author.node.first_name+' '+author.node.last_name;

			return false;

		}).filter(Boolean);

		return {
			id: json.id,
			title: json.title || '',
			titleRomaji: json.title || '',
			titleEnglish: json?.alternative_titles?.en || '',
			titleNative: json?.alternative_titles?.ja || '',
			titleUserPreferred: json.title || '',
			synonyms: Array.isArray(json?.alternative_titles?.synonyms) ? json.alternative_titles.synonyms : [],
			author: authors[0] || '',
			// MAL's media_type distinguishes manga/manhwa/manhua directly (unlike AniList, which
			// only implies it via country of origin or tags) - no inference needed here.
			seriesType: seriesTypes[json.media_type] || '',
			demographic: '', // Not exposed by MAL's v2 API
			genres: (json.genres || []).map(function(genre) { return genre?.name; }).filter(Boolean),
			description: String(json.synopsis || ''),
			serializationYear: +(String(json?.start_date || '').slice(0, 4)) || 0,
			rating: Math.round(+(json.mean || 0) * 10), // MAL scores out of 10, this schema is out of 100
			chapters: +json.num_chapters || 0,
			volumes: +json.num_volumes || 0,
		};
	}
	catch(error) {}

	return {};
}

// Return data of comic/manga
async function getComicData(siteId)
{
	const options = {
		method: 'GET',
		headers: {
			'Authorization': 'Bearer '+site.config.session.token,
			'Accept': 'application/json',
		},
	};

	try
	{
		const response = await fetch('https://api.myanimelist.net/v2/manga/'+siteId+'?fields=title,main_picture,num_chapters,num_volumes,synopsis,my_list_status,status', options);

		if(response.status == 400 || response.status == 401)
		{
			tracking.invalidateSession(site.key, true);
			return null;
		}
		else if(response.status == 200)
		{
			const json = await response.json();

			if(json.id)
			{
				return {
					title: json.title,
					image: json.main_picture.medium,
					// synopsis: synopsis,
					chapters: +json.num_chapters || 0,
					volumes: +json.num_volumes || 0,
					progress: {
						chapters: +json?.my_list_status?.num_chapters_read || 0,
						volumes: +json?.my_list_status?.num_volumes_read || 0,
						// status: json?.my_list_status?.status || '',
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
	const challenge = crypto.hash('sha512', crypto.randomUUID(), 'hex');
	const url = await tracking.getRedirectResult(site.key, 'https://myanimelist.net/v1/oauth2/authorize?response_type=code&client_id='+site.auth.clientId+'&code_challenge='+challenge+'&redirect_uri=opencomic://tracking/myanimelist&response_type=code');
	const code = url.searchParams.get('code') || url.searchParams.get('token');

	if(!code)
		return {valid: false};

	const variables = new URLSearchParams({
		grant_type: 'authorization_code',
		client_id: site.auth.clientId,
		redirect_uri: 'opencomic://tracking/myanimelist',
		code: code,
		code_verifier: challenge,
	});

	const options = {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'Accept': 'application/json',
		},
		body: variables.toString(),
	};

	try
	{
		const response = await fetch('https://myanimelist.net/v1/oauth2/token', options);

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
	const variables = new URLSearchParams({
		grant_type: 'refresh_token',
		client_id: site.auth.clientId,
		refresh_token: site.config.session.refreshToken,
	});

	const options = {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'Accept': 'application/json',
		},
		body: variables.toString(),
	};

	try
	{
		const response = await fetch('https://myanimelist.net/v1/oauth2/token', options);

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
	const options = {
		method: 'GET',
		headers: {
			'Authorization': 'Bearer '+site.config.session.token,
			'Accept': 'application/json',
		},
	};

	try
	{
		const response = await fetch('https://api.myanimelist.net/v2/manga/'+toTrack.id+'?fields=title,main_picture,num_chapters,num_volumes,my_list_status,status', options);

		if(response.status == 400 || response.status == 401)
		{
			tracking.invalidateSession(site.key, true);
		}
		else if(response.status == 200)
		{
			const json = await response.json();

			const totalChapters = +json.num_chapters || 0;
			const totalVolumes = +json.num_chapters || 0;
			const {status: userStatus, num_chapters_read: userChapters, num_volumes_read: userVolumes} = json?.my_list_status || {};

			let status, chapters, volumes;

			// Status
			if((totalChapters && toTrack.chaptersInt && toTrack.chaptersInt == totalChapters) || (totalVolumes && toTrack.volumesInt && toTrack.volumesInt == totalVolumes))
				status = 'completed';

			// Chapters
			if(toTrack.chaptersInt && (!userChapters || toTrack.chaptersInt > userChapters))
				chapters = toTrack.chaptersInt;

			// Volumes
			if(toTrack.volumesInt && (!userVolumes || toTrack.volumesInt > userVolumes))
				volumes = toTrack.volumesInt;

			const variables = new URLSearchParams();
			if(status && (chapters || volumes)) variables.append('status', status);
			if(chapters) variables.append('num_chapters_read', chapters);
			if(volumes) variables.append('num_volumes_read', volumes);

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

			const options = {
				method: 'PUT',
				headers: {
					'Authorization': 'Bearer '+site.config.session.token,
					'Content-Type': 'application/x-www-form-urlencoded',
					'Accept': 'application/json',
				},
				body: variables.toString(),
			};

			fetch('https://api.myanimelist.net/v2/manga/'+toTrack.id+'/my_list_status', options);
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
	getComicMetadata: getComicMetadata,
	getComicData: getComicData,
	login: login,
	refreshToken: refreshToken,
	track: track,
};
