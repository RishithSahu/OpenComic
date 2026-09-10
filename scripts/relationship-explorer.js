// Series Relationship Explorer - prequel/sequel/spin-off/side-story/adaptation for one series,
// reached from its folder's right-click menu ("View relationships"). Data comes from
// tracking.getSeriesRelations() (an on-demand AniList/MAL relations query, not part of routine
// metadata scraping); this only lays it out and wires clicks - a local relation opens directly
// (dom.loadIndexPage()), an external one (never locally owned, or an anime adaptation, which
// never is one) opens its AniList/MAL page in the system browser instead.

function escapeHtml(value = '')
{
	return String(value || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

const MAX_PER_BUCKET = 4;

function buildNodeCard(relation)
{
	const title = escapeHtml(relation.title);
	const image = relation.image
		? ('<img src="' + escapeHtml(relation.image) + '" loading="lazy">')
		: '<div class="relationship-node-noimg material-icon">menu_book</div>';

	if(relation.localPath)
	{
		return ''
			+ '<div class="relationship-node relationship-node-local gamepad-item" data-path="' + escapeHtml(relation.localPath) + '" tabindex="0" title="' + title + '">'
			+ image
			+ '<div class="relationship-node-title">' + title + '</div>'
			+ '</div>';
	}

	return ''
		+ '<div class="relationship-node relationship-node-external gamepad-item" data-url="' + escapeHtml(relation.siteUrl) + '" tabindex="0" title="' + title + ' (opens in your browser)">'
		+ image
		+ '<div class="relationship-node-external-badge material-icon">open_in_new</div>'
		+ '<div class="relationship-node-title">' + title + '</div>'
		+ '</div>';
}

function buildColumn(list)
{
	if(!list.length) return '';

	const shown = list.slice(0, MAX_PER_BUCKET).map(buildNodeCard).join('');
	const overflow = list.length > MAX_PER_BUCKET ? ('<div class="relationship-more body-small">+' + (list.length - MAX_PER_BUCKET) + ' more</div>') : '';

	return '<div class="relationship-column">' + shown + overflow + '</div>';
}

function renderDiagram(data)
{
	const buckets = { prequel: [], sequel: [], adaptation: [], spinoff: [], sidestory: [], other: [] };

	for(let i = 0, len = data.relations.length; i < len; i++)
	{
		const relation = data.relations[i];
		(buckets[relation.bucket] || buckets.other).push(relation);
	}

	const centerCard = ''
		+ '<div class="relationship-node relationship-node-center" title="' + escapeHtml(data.center.title) + '">'
		+ '<div class="relationship-node-title">' + escapeHtml(data.center.title) + '</div>'
		+ '</div>';

	let html = '<div class="relationship-diagram">';

	if(buckets.adaptation.length)
	{
		html += '<div class="relationship-row relationship-row-top">' + buildColumn(buckets.adaptation) + '</div>';
		html += '<div class="relationship-arrow relationship-arrow-down">↓</div>';
	}

	html += '<div class="relationship-row relationship-row-main">';

	if(buckets.prequel.length)
		html += buildColumn(buckets.prequel) + '<div class="relationship-arrow">→</div>';

	html += centerCard;

	if(buckets.sequel.length)
		html += '<div class="relationship-arrow">→</div>' + buildColumn(buckets.sequel);

	html += '</div>';

	const bottom = buckets.spinoff.concat(buckets.sidestory, buckets.other);

	if(bottom.length)
	{
		html += '<div class="relationship-arrow relationship-arrow-down">↓</div>';
		html += '<div class="relationship-row relationship-row-bottom">' + bottom.slice(0, MAX_PER_BUCKET * 2).map(buildNodeCard).join('') + '</div>';
	}

	html += '</div>';

	return html;
}

function wireClicks(container)
{
	if(!container) return;

	container.querySelectorAll('.relationship-node-local').forEach(function(node) {
		node.addEventListener('click', function() {
			const path = node.getAttribute('data-path');
			if(path)
				dom.loadIndexPage(true, path, false, false, path);
		});
	});

	container.querySelectorAll('.relationship-node-external').forEach(function(node) {
		node.addEventListener('click', function() {
			const url = node.getAttribute('data-url');
			if(url)
				electron.shell.openExternal(url);
		});
	});
}

async function start(path)
{
	const folderPath = tracking.getFolderMetadataPath(path);
	const metadata = folderPath ? tracking.getFolderMetadata(folderPath) : false;

	handlebarsContext.relationshipCenterTitle = (metadata && metadata.title) || (folderPath ? p.basename(folderPath) : '');

	template.loadContentRight('relationship-explorer.content.right.html', true);
	events.events();

	if(!folderPath)
		return;

	const data = await tracking.getSeriesRelations(folderPath);
	const container = template._contentRight();
	const body = container ? container.querySelector('.relationship-explorer-body') : false;

	if(!body)
		return; // the user has already navigated away

	if(data.unsupported)
	{
		body.innerHTML = '<div class="relationship-explorer-empty body-medium">This folder has no confirmed AniList or MyAnimeList match yet, so there is nothing to ask about relations - match it first (right-click &gt; Edit metadata, or Set format) and try again.</div>';
		return;
	}

	if(!data.relations.length)
	{
		body.innerHTML = '<div class="relationship-explorer-empty body-medium">No known prequels, sequels, spin-offs, side stories or adaptations for this series.</div>';
		return;
	}

	body.innerHTML = renderDiagram(data);
	wireClicks(body);
}

module.exports = {
	start: start,
};
