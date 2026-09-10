// Library Weather - a deliberately unserious dashboard (see CHANGELOG), not real analytics.
// Every number here comes from data already stored locally: readingProgress's own lastReading
// timestamp (scripts/reading/progress.js) for *when* a series was last touched, combined with
// reading.progress.getFolderItemProgress() - the same aggregate the library grid's own "12/34"
// tile badge already computes - for whether it's actually finished, since a 'series'/'mainPath'
// -tagged readingProgress entry's own page/pages/percent/completed fields are always zeroed by
// save() itself (see its own comment: "Calculate from childrens if is parent" - a series folder
// is, by definition, a parent of the chapter actually being read, so those fields were never
// meant to be read directly off this entry). No new tracking, no new storage key.

const ACTIVELY_READING_WINDOW = 1000 * 60 * 60 * 24 * 14; // 14 days
const UNTOUCHED_WINDOW = 1000 * 60 * 60 * 24 * 365; // 1 year

// readingProgress is keyed by path with entries tagged 'chapter'/'series'/'mainPath' (see the
// long comment on save(), reading/progress.js) - 'series' is the tag that function was already
// built to identify the real series folder regardless of how deep the library is nested, so this
// reuses it rather than re-deriving the same thing a second way. A flat library (no folder level
// above the series itself) never produces a 'series'-tagged entry at all, only 'mainPath' ones -
// so a 'mainPath' entry is included too, unless it is a strict path-ancestor of some 'series'
// entry already found (which makes it a category folder above a nested library, not a series).
function collectSeriesPaths()
{
	const readingProgress = relative.get('readingProgress') || {};
	const keys = Object.keys(readingProgress);
	const seriesPaths = new Set();

	for(let i = 0, len = keys.length; i < len; i++)
	{
		const entry = readingProgress[keys[i]];
		if(entry && entry.role === 'series')
			seriesPaths.add(p.normalize(keys[i]));
	}

	const result = [];

	for(let i = 0, len = keys.length; i < len; i++)
	{
		const key = keys[i];
		const entry = readingProgress[key];
		if(!entry) continue;

		if(entry.role === 'series')
		{
			result.push({ path: key, lastReading: entry.lastReading || 0 });
			continue;
		}

		if(entry.role === 'mainPath')
		{
			const normalized = p.normalize(key);
			let isAncestorOfSeries = false;

			for(const seriesPath of seriesPaths)
			{
				if(seriesPath !== normalized && seriesPath.startsWith(normalized + p.sep))
				{
					isAncestorOfSeries = true;
					break;
				}
			}

			if(!isAncestorOfSeries)
				result.push({ path: key, lastReading: entry.lastReading || 0 });
		}
	}

	return result;
}

function countMissingMetadata()
{
	const trackingFolderMetadata = relative.get('trackingFolderMetadata') || {};
	let count = 0;

	for(const key in trackingFolderMetadata)
	{
		const metadata = trackingFolderMetadata[key];
		if(!metadata) continue;

		const hasConfirmedMatch = (metadata.source === 'anilist' && metadata.anilistId)
			|| (metadata.source === 'myanimelist' && metadata.malId)
			|| metadata.source === 'manual'
			|| metadata.source === 'import';

		if(!hasConfirmedMatch)
			count++;
	}

	return count;
}

async function computeStats()
{
	const seriesEntries = collectSeriesPaths();
	const now = Date.now();
	const currentMonthKey = new Date(now).getFullYear() + '-' + new Date(now).getMonth();

	const progressList = await Promise.all(seriesEntries.map(function(entry) {
		return reading.progress.getFolderItemProgress(entry.path, true, true).catch(function() { return false; });
	}));

	let unfinished = 0, completedThisMonth = 0, activelyReading = 0, untouchedOverYear = 0;

	for(let i = 0, len = seriesEntries.length; i < len; i++)
	{
		const progress = progressList[i];
		// total === 0 means the folder read back empty (moved/deleted since it was last read,
		// or genuinely has nothing readable in it) - not the same as "0 of N read".
		if(!progress || progress.total === 0)
			continue;

		const lastReading = seriesEntries[i].lastReading;
		const age = now - lastReading;
		const started = progress.read > 0 || progress.completed;

		if(!started)
			continue;

		if(progress.completed)
		{
			const entryMonthKey = new Date(lastReading).getFullYear() + '-' + new Date(lastReading).getMonth();
			if(entryMonthKey === currentMonthKey)
				completedThisMonth++;
		}
		else
		{
			unfinished++;

			if(age <= ACTIVELY_READING_WINDOW)
				activelyReading++;
		}

		if(age > UNTOUCHED_WINDOW)
			untouchedOverYear++;
	}

	return {
		unfinished: unfinished,
		completedThisMonth: completedThisMonth,
		activelyReading: activelyReading,
		untouchedOverYear: untouchedOverYear,
		missingMetadata: countMissingMetadata(),
	};
}

async function start()
{
	handlebarsContext.libraryWeather = await computeStats();

	template.loadContentRight('weather.content.right.html', true);

	events.events();
}

module.exports = {
	start: start,
};
