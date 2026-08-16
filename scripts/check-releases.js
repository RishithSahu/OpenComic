const sanitizeHtml = require('sanitize-html'),
	marked = require('marked');

// This fork's own releases. Checking upstream here would be actively harmful: this fork's
// version is ahead of upstream's, so upstream releases would either never register as newer or,
// once they overtake, would send users to a download that has none of the fork's features and
// would overwrite this build.
const RELEASES_REPO = 'RishithSahu/OpenComic';
const RELEASES_URL = 'https://github.com/'+RELEASES_REPO+'/releases';

function showReleaseDialog(release)
{
	release.releases_url = RELEASES_URL;
	release.html_url = RELEASES_URL;

	const parsed = marked.parse(release.body).replace(/(\<a\s)\s*/ig, '$1 target="_blank"').replace(/\<h5\>/ig, '<h5 class="title-small">');

	const releaseNotes = sanitizeHtml(parsed, {
		allowedClasses: {
			h5: ['title-small'],
		},
		allowedAttributes: {
			a: ['href', 'target', 'data-function'],
		},
	});

	events.dialog({
		header: hb.compile(language.dialog.release.title)({releaseName: release.name}),
		width: 'max-content',
		height: false,
		content: '<div class="release-notes">'+releaseNotes+'</div>',
		buttons: [
			{
				text: language.buttons.dismiss,
				function: 'events.closeDialog(); checkReleases.setLastCheckedRelease(\''+release.name+'\')',
			},
			{
				text: language.buttons.download,
				function: 'electron.shell.openExternal(\''+release.releases_url+'\');',
			}
		],
	});
}

function setLastCheckedRelease(name)
{
	storage.updateVar('config', 'lastCheckedRelease', name);
}

function versionIsHigher(lowest, highest)
{
	let l = lowest.replace(/^[a-z]+/iu, '').split(/[.-]/);
	let h = highest.replace(/^[a-z]+/iu, '').split(/[.-]/);

	for(let key in l)
	{
		if(l[key] > h[key] || (h[key] === undefined && !isNaN(l[key])))
			break;
		else if(h[key] === undefined || l[key] < h[key])
			return true;
	}

	return false;
}

function check(force = false)
{
	let now = Date.now();

	if(now - config.lastCheckedReleaseTime < 3600000 && !force) // Check at most once an hour
		return;

	storage.updateVar('config', 'lastCheckedReleaseTime', now);

	let options = {
		headers:{
			'User-Agent': window.navigator.userAgent,
		},
	};

	console.log('Checking for new release');

	fetch('https://api.github.com/repos/'+RELEASES_REPO+'/releases', options).then(async function(response){

		let json = await response.json();
		if(json.message) return console.log(json.message);

		let lastRelease = false;

		for(let key in json)
		{
			let release = json[key];

			if(!release.draft && (config.checkPreReleases || !release.prerelease))
			{
				lastRelease = release;
				break;
			}
		}

		if(lastRelease)
		{
			if((lastRelease.name != config.lastCheckedRelease && lastRelease.name != _package.version && versionIsHigher(_package.version, lastRelease.name)) || force)
			{
				showReleaseDialog(lastRelease);

				console.log('New release available');
			}
			else
			{
				console.log('Not new release available');
			}
		}

	});
}

module.exports = {
	check: check,
	setLastCheckedRelease: setLastCheckedRelease,
};
