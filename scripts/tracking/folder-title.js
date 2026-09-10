function normalizeString(value = '')
{
	value = String(value || '').toLowerCase();

	if(value.normalize)
		value = value.normalize('NFKD');

	// Remove accents
	value = value.replace(/[\u0300-\u036f]/g, '');
	value = value.replace(/['`´’]/g, '');
	value = value.replace(/[^a-z0-9]+/g, ' ');
	value = value.replace(/\s+/g, ' ').trim();

	return value;
}

function tokenize(value = '')
{
	const normalized = normalizeString(value);
	if(!normalized) return [];

	return normalized.split(' ').filter(Boolean);
}

function isGenericFolderName(value = '')
{
	const normalized = normalizeString(value);
	if(!normalized) return true;

	if(/^\d+$/.test(normalized))
		return true;

	const generic = new Set([
		'manga',
		'comic',
		'comics',
		'books',
		'library',
		'series',
		'completed',
		'ongoing',
		'dropped',
		'paused',
		'reading',
		'unread',
		'wanted',
		'backlog',
		'planned',
		'favorites',
		'favourites',
		'wishlist',
		'chapters',
		'chapter',
		'volumes',
		'volume',
	]);

	if(generic.has(normalized))
		return true;

	// A user's own top-level reading-status folders ("1. Completed Series", "2. Paused Series",
	// "3. Reading", "4. Planned to Read", "5. Time Pass Series", and no doubt others shaped like
	// them) are not series titles, but nothing before this stopped one being sent to AniList/MAL
	// as a search candidate like any other folder - "reading" and "planned to read" in particular
	// were not caught by the single-word Set above at all. A false match here is worse than a
	// missed one: scrapeFolderMetadata() writes it as this *folder's own* tracked metadata, and
	// since these are read from *inside* by every real series folder below them,
	// resolveTrackedSeriesFolder() (reading.js) walks up into exactly this folder looking for a
	// tracked seriesType - a wrong manga/manhua/manhwa classification here silently overrides the
	// reading mode for every series nested underneath it, not just this folder's own (nonexistent)
	// header card.
	if(/^(?:\d+\s*)?(?:completed|ongoing|dropped|paused|reading|unread|wanted|backlog|time\s*pass|planned(?:\s+to\s+read)?|plan\s+to\s+read|want(?:ing)?\s+to\s+read)(?:\s+(?:series|list))?$/.test(normalized))
		return true;

	return false;
}

function cleanCandidateTitle(value = '')
{
	value = String(value || '');

	// File extension (if any). Excludes whitespace from the extension body, not just '.'/'/'/'\' -
	// a real extension never contains a space, but without that exclusion this matched (and ate)
	// the tail of any title ending in "<abbreviation>. <word up to 6 chars>" - "Dr. Stone" losing
	// everything but "Dr" to this being treated as a 6-character extension, most visibly.
	value = value.replace(/\.[^./\\\s]{1,6}$/g, '');

	// Common release / technical tags
	value = value.replace(/[\[\(](?:\s*(?:\d{3,4}p|x26[45]|web[- ]?dl|raws?|v\d+|vol(?:ume)?\s*\d+|ch(?:apter)?\s*\d+|episode\s*\d+)[^\]\)]*)[\]\)]/giu, ' ');
	value = value.replace(/[\[\(][^\]\)]{1,40}[\]\)]/g, ' ');

	value = value.replace(/[_]+/g, ' ');
	value = value.replace(/[.]+/g, ' ');
	value = value.replace(/\s+-\s+/g, ' ');

	// Remove obvious chapter/volume suffixes from folder names
	value = value.replace(/\b(?:chapter|chap|ch|episode|ep|volume|vol|v|issue|part)\s*[-_.:]?\s*\d+(?:\.\d+)?\b/giu, ' ');
	value = value.replace(/\b(?:tomo|tomo\.|capitulo|cap|tome)\s*[-_.:]?\s*\d+(?:\.\d+)?\b/giu, ' ');

	value = value.replace(/\s+/g, ' ').trim();
	return value;
}

function uniqueStrings(values = [])
{
	const output = [];
	const seen = new Set();

	for(let i = 0, len = values.length; i < len; i++)
	{
		const value = String(values[i] || '').trim();
		const key = normalizeString(value);

		if(!value || !key || seen.has(key))
			continue;

		seen.add(key);
		output.push(value);
	}

	return output;
}

function extractYearsFromString(value = '')
{
	const years = [];
	const seen = new Set();
	const matches = String(value || '').match(/\b(1[0-9]{3}|2[0-9]{3}|3000)\b/g) || [];

	for(let i = 0, len = matches.length; i < len; i++)
	{
		const year = +matches[i];
		if(!year || year < 1000 || year > 3000 || seen.has(year))
			continue;

		seen.add(year);
		years.push(year);
	}

	return years;
}

function getReferenceYear(candidates = [], options = {})
{
	const preferred = Math.floor(Number(options?.referenceYear || 0));
	if(preferred >= 1000 && preferred <= 3000)
		return preferred;

	for(let i = 0, len = candidates.length; i < len; i++)
	{
		const years = extractYearsFromString(candidates[i]);
		if(years.length)
			return years[0];
	}

	return 0;
}

function yearProximityScore(resultYear = 0, referenceYear = 0)
{
	resultYear = Math.floor(Number(resultYear) || 0);
	referenceYear = Math.floor(Number(referenceYear) || 0);

	if(resultYear < 1000 || resultYear > 3000 || referenceYear < 1000 || referenceYear > 3000)
		return 0;

	const delta = Math.abs(resultYear - referenceYear);

	if(delta === 0) return 10;
	if(delta <= 1) return 8;
	if(delta <= 3) return 6;
	if(delta <= 5) return 4;
	if(delta <= 10) return 2;
	if(delta <= 20) return 1;

	return -6;
}

function extractCandidatesFromFolderPath(folderPath = '', extraTitles = [])
{
	const rawSegments = String(folderPath || '').split(/[\\/]/g).filter(Boolean);
	const segments = rawSegments.slice(-4).reverse(); // leaf first

	const candidates = [];

	for(let i = 0, len = segments.length; i < len; i++)
	{
		const raw = segments[i];
		const cleaned = cleanCandidateTitle(raw);

		if(cleaned && !isGenericFolderName(cleaned) && cleaned.length > 1)
			candidates.push(cleaned);
	}

	if(Array.isArray(extraTitles))
	{
		for(let i = 0, len = extraTitles.length; i < len; i++)
		{
			const cleaned = cleanCandidateTitle(extraTitles[i]);

			if(cleaned && !isGenericFolderName(cleaned) && cleaned.length > 1)
				candidates.push(cleaned);
		}
	}

	return uniqueStrings(candidates).slice(0, 6);
}

// Iterative Levenshtein distance (single-row DP - O(len(a)*len(b)) time, O(min(len(a),len(b)))
// space). Tokens here are individual words out of a manga title, so a handful of characters each;
// there is no need for anything smarter.
function levenshteinDistance(a = '', b = '')
{
	if(a === b) return 0;
	if(!a.length) return b.length;
	if(!b.length) return a.length;

	if(a.length < b.length) { const swap = a; a = b; b = swap; }

	let previousRow = new Array(b.length + 1);
	for(let j = 0; j <= b.length; j++) previousRow[j] = j;

	for(let i = 0; i < a.length; i++)
	{
		const currentRow = [i + 1];
		const aChar = a.charCodeAt(i);

		for(let j = 0; j < b.length; j++)
		{
			const cost = aChar === b.charCodeAt(j) ? 0 : 1;
			currentRow.push(Math.min(
				previousRow[j + 1] + 1, // deletion
				currentRow[j] + 1, // insertion
				previousRow[j] + cost, // substitution
			));
		}

		previousRow = currentRow;
	}

	return previousRow[b.length];
}

// 1 for an exact match down to 0 for two tokens sharing nothing; tuned so a single typo'd/swapped
// character in a mid-length word ("colour"/"color", "kimetsu"/"kimtsu") still scores close to 1,
// while two genuinely different short words score close to 0.
function tokenSimilarity(a = '', b = '')
{
	if(a === b) return 1;

	const maxLen = Math.max(a.length, b.length);
	if(!maxLen) return 1;

	// A distance-based ratio on very short tokens ("a", "no", "wo") is far too forgiving (one
	// substitution on a 2-character token is already "50% different" but reads as a completely
	// different word) - fuzzy credit only kicks in once there is enough token to meaningfully
	// diverge.
	if(maxLen < 4) return 0;

	return 1 - (levenshteinDistance(a, b) / maxLen);
}

// Best fuzzy-matched token overlap between two token lists: each token in `from` is credited up
// to 1 for its best match in `to` (1 for an exact match, partial credit above the similarity
// threshold for a near-miss, 0 otherwise), summed - the same shape as a set intersection count,
// just fractional instead of integer, so titles differing by a typo, an alternate romanization,
// or a singular/plural word still register as the near-match they are instead of losing that
// word's worth of score entirely.
const FUZZY_TOKEN_THRESHOLD = 0.75;

function fuzzyTokenOverlap(from = [], to = [])
{
	const toSet = new Set(to);
	let overlap = 0;

	for(let i = 0, len = from.length; i < len; i++)
	{
		const token = from[i];

		if(toSet.has(token))
		{
			overlap += 1;
			continue;
		}

		let best = 0;

		for(let j = 0, tlen = to.length; j < tlen; j++)
		{
			const similarity = tokenSimilarity(token, to[j]);
			if(similarity > best) best = similarity;
		}

		if(best >= FUZZY_TOKEN_THRESHOLD)
			overlap += best;
	}

	return overlap;
}

function scoreTitleMatch(query = '', target = '')
{
	const q = normalizeString(query);
	const t = normalizeString(target);

	if(!q || !t)
		return 0;

	if(q === t)
		return 100;

	const qTokens = tokenize(q);
	const tTokens = tokenize(t);

	if(!qTokens.length || !tTokens.length)
		return 0;

	const qUnique = Array.from(new Set(qTokens));
	const tUnique = Array.from(new Set(tTokens));

	const qCoverage = fuzzyTokenOverlap(qUnique, tUnique) / qUnique.length;
	const tCoverage = fuzzyTokenOverlap(tUnique, qUnique) / tUnique.length;
	const contains = (q.length >= 4 && t.includes(q)) || (t.length >= 4 && q.includes(t));
	const startsWith = t.startsWith(q) || q.startsWith(t);

	let score = 0;
	score += qCoverage * 50;
	score += tCoverage * 30;
	if(contains) score += 15;
	if(startsWith) score += 5;

	if(score > 100) score = 100;
	return Math.round(score);
}

function flattenResultTitles(result = {})
{
	const titles = [];

	if(result.title) titles.push(result.title);
	if(result.titleRomaji) titles.push(result.titleRomaji);
	if(result.titleEnglish) titles.push(result.titleEnglish);
	if(result.titleNative) titles.push(result.titleNative);
	if(result.titleUserPreferred) titles.push(result.titleUserPreferred);

	if(Array.isArray(result.synonyms))
		titles.push(...result.synonyms);

	return uniqueStrings(titles);
}

function rankSearchResults(candidates = [], results = [], options = {})
{
	const safeCandidates = uniqueStrings(candidates);
	if(!safeCandidates.length)
		return [];

	const excludedIds = new Set((Array.isArray(options?.excludedIds) ? options.excludedIds : []).map(function(id) {
		return +id;
	}).filter(Boolean));
	const referenceYear = getReferenceYear(safeCandidates, options);
	const ranked = [];

	for(let i = 0, len = results.length; i < len; i++)
	{
		const result = results[i] || {};
		const resultId = +(result.id || 0);
		if(resultId && excludedIds.has(resultId))
			continue;

		const titles = flattenResultTitles(result);
		let bestScore = 0;
		let bestCandidate = '';
		let bestTitle = '';

		for(let c = 0, clen = safeCandidates.length; c < clen; c++)
		{
			const candidate = safeCandidates[c];

			for(let t = 0, tlen = titles.length; t < tlen; t++)
			{
				const title = titles[t];
				const score = scoreTitleMatch(candidate, title);

				if(score > bestScore)
				{
					bestScore = score;
					bestCandidate = candidate;
					bestTitle = title;
				}
			}
		}

		const yearScore = yearProximityScore(result.serializationYear, referenceYear);
		const totalScore = Math.max(0, Math.min(100, bestScore + yearScore));

		ranked.push({
			...result,
			score: totalScore,
			titleScore: bestScore,
			yearScore: yearScore,
			referenceYear: referenceYear,
			matchedCandidate: bestCandidate,
			matchedTitle: bestTitle,
		});
	}

	ranked.sort(function(a, b) {
		if((b.score || 0) !== (a.score || 0))
			return (b.score || 0) - (a.score || 0);

		if((b.titleScore || 0) !== (a.titleScore || 0))
			return (b.titleScore || 0) - (a.titleScore || 0);

		return (a.id || 0) - (b.id || 0);
	});

	return ranked;
}

module.exports = {
	normalizeString,
	tokenize,
	isGenericFolderName,
	cleanCandidateTitle,
	extractYearsFromString,
	getReferenceYear,
	yearProximityScore,
	extractCandidatesFromFolderPath,
	levenshteinDistance,
	tokenSimilarity,
	scoreTitleMatch,
	flattenResultTitles,
	rankSearchResults,
};
