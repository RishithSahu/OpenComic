
function middleClick(event, key, data)
{
	if(event.button !== 1) return;

	let title = '';
	let tabData = {
		file: false,
		indexLabel: {},
		isComic: false,
		mainPath: false,
		page: false,
		path: false,
		recentlyOpened: false,
		root: true,
	};

	let history = [];

	switch(key)
	{
		case 'page':

			tabData = {
				...tabData,
				...pageData(data),
			};

			break;

		case 'library':

			tabData = {
				...tabData,
				title: language.global.library,
			};

			break;

		case 'recently-opened':

			tabData = {
				...tabData,
				title: language.global.recentlyOpened,
				recentlyOpened: true,
			};

			break;

		case 'favorites':

			tabData = {
				...tabData,
				indexLabel: favoritesData(),
			};

			break;

		case 'opds':

			tabData = opdsData(data ?? {}).map(item => ({
				...tabData,
				indexLabel: item,
			}));

			break;

		case 'master-folder':

			tabData = {
				...tabData,
				indexLabel: masterFolderData(data),
			};

			break;

		case 'server':

			tabData = {
				...tabData,
				indexLabel: serverData(data),
			};

			break;

		case 'label':

			tabData = {
				...tabData,
				indexLabel: labelData(data),
			};

			break;

	}

	if(Array.isArray(tabData))
		history = tabData;
	else
		history = [tabData];

	const last = history[history.length - 1];
	title = last.title ?? last.name ?? last.indexLabel.title ?? last.indexLabel.name ?? '';

	const materialIcon = event.currentTarget.querySelector('.material-icon');
	const icon = materialIcon ? materialIcon.innerHTML : 'indeterminate_question_box';

	tabs.openTab(title, icon, history);

}

function pageData(page)
{
	const titles = {
		language: language.global.language,
		theme: language.global.theme,
		settings: language.global.settings,
	};

	return {
		page,
		title: titles[page],
	};
}

function masterFolderData({folder, index})
{
	return {masterFolder: folder, index: index, name: p.basename(folder)};
}

function masterFolder(folder, index)
{
	const data = masterFolderData({folder, index});

	dom.setIndexLabel(data);
	dom.loadIndexPage(true);
}

function setFavorite(path)
{
	path = relative.path(path);
	let favorites = storage.get('favorites');

	if(favorites[path])
		delete favorites[path];
	else
		favorites[path] = {added: time()};

	storage.set('favorites', favorites);

	let prevIndexLabel = dom.prevIndexLabel();

	if(prevIndexLabel.favorites)
		dom.reload();
}

function setHideFromContinueReading(path)
{
	path = relative.path(path);
	let hidden = storage.get('hideFromContinueReading');

	if(hidden[path])
		delete hidden[path];
	else
		hidden[path] = true;

	storage.set('hideFromContinueReading', hidden);

	dom.reload();
}

function isHiddenFromContinueReading(path)
{
	const hidden = relative.get('hideFromContinueReading');
	return !!hidden[path];
}

function favoritesData()
{
	return {favorites: true, name: language.global.favorites};
}

function favorites()
{
	const data = favoritesData();

	dom.setIndexLabel(data);
	dom.loadIndexPage(true);
}

function opdsData({url = false, index = false, title = false})
{
	const data = [{opds: true, index: index, name: language.global.catalogs}];

	if(url)
		data.push({opds: true, index: index, name: title});

	return data;
}

async function _opds(url = false, index = false, title = false)
{
	dom.setIndexLabel({opds: true, index: index, name: language.global.catalogs});
	await dom.loadIndexPage(true);

	if(url)
	{
		dom.setIndexLabel({opds: true, index: index, name: title});

		const base64 = opds.opds.base64(url);
		opds.addPathName(base64, title);

		const path = 'opds:'+p.sep+base64;
		await dom.loadIndexPage(true, path, false, false, path);
	}
}

function labelData({name, index})
{
	return {label: name, index: index, name: name};
}

function label(name, index)
{
	const data = labelData({name, index});

	dom.setIndexLabel(data);
	dom.loadIndexPage(true);
}

function serverData({server, index, name})
{
	return {server, index, name};
}

function server(path, index, name)
{
	const data = serverData({server: path, index, name});

	dom.setIndexLabel(data);
	dom.loadIndexPage(true);
}

function filter(filter = {})
{
	const label = dom.prevIndexLabel() || {};
	dom.setPrevIndexLabel({...label, filter: filter});
	dom.reload();
}

function filterFavorite()
{
	const currentFilter = dom.prevIndexLabel()?.filter || {};
	const favorites = !currentFilter.favorites;

	dom.query('.button-favorite').class(favorites, 'fill');
	filter({
		...currentFilter,
		favorites,
	});
}

function loadLabels()
{
	const label = dom.prevIndexLabel() || {};
	const filter = label.filter || {};

	const labels = getLabels();

	for(const label of labels)
	{
		label.active = filter.labels && filter.labels.includes(label.name);
		label.without = filter.withoutLabels && filter.withoutLabels.includes(label.name);
	}

	handlebarsContext.filterLabels = labels;
	document.querySelector('#index-labels .menu-simple-content').innerHTML = template.load('index.elements.menus.labels.html');

	events.events();
}

function filterLabels(key = 0)
{
	const currentFilter = dom.prevIndexLabel()?.filter || {};

	currentFilter.labels = currentFilter.labels || [];
	currentFilter.withoutLabels = currentFilter.withoutLabels || [];

	const labels = getLabels();
	const label = labels[key];

	let isLabel = false;
	let isWithoutLabel = false;

	if(currentFilter.labels.includes(label.name))
	{
		currentFilter.labels = currentFilter.labels.filter(name => name !== label.name);
		currentFilter.withoutLabels.push(label.name);
		isWithoutLabel = true;
	}
	else if(currentFilter.withoutLabels.includes(label.name))
	{
		currentFilter.withoutLabels = currentFilter.withoutLabels.filter(name => name !== label.name);
	}
	else
	{
		currentFilter.labels.push(label.name);
		isLabel = true;
	}

	currentFilter.labels = currentFilter.labels.length ? currentFilter.labels : false;
	currentFilter.withoutLabels = currentFilter.withoutLabels.length ? currentFilter.withoutLabels : false;

	const menu = dom.query('.menu-label-'+key).class((isLabel || isWithoutLabel), 's');
	menu.find('i').class((isLabel || isWithoutLabel), 'fill').html(isWithoutLabel ? 'label_off' : 'label');

	currentFilter.hasLabels = currentFilter.labels || currentFilter.withoutLabels;
	dom.query('.button-labels').class(currentFilter.hasLabels, 'fill');

	filter(currentFilter);
}

function filterRequireAllLabels(active = false)
{
	const currentFilter = dom.prevIndexLabel()?.filter || {};
	filter({
		...(currentFilter || {}),
		requireAllLabels: active,
	});
}

function filterOnlyRoot()
{
	const currentFilter = dom.prevIndexLabel()?.filter || {};
	const onlyRoot = !currentFilter.onlyRoot;

	dom.query('.button-only-root').class(onlyRoot, 'fill');
	filter({
		...currentFilter,
		onlyRoot,
	});
}

function normalizeGenreFilterValue(value = '')
{
	if(typeof value !== 'string')
		value = String(value || '');

	return app.stripTagsWithDOM(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function formatGenreFilterValue(value = '')
{
	if(typeof value !== 'string')
		value = String(value || '');

	value = app.stripTagsWithDOM(value).replace(/\s+/g, ' ').trim();

	if(!value)
		return '';

	return value.replace(/\b\w/g, function(match){
		return match.toUpperCase();
	});
}

function getFilterGenres(filter = {})
{
	const genres = [];

	if(Array.isArray(filter.genres))
		genres.push(...filter.genres);
	else if(filter.genre)
		genres.push(filter.genre);

	const normalizedGenres = [];
	const normalizedGenresSet = {};

	for(let i = 0, len = genres.length; i < len; i++)
	{
		const genre = normalizeGenreFilterValue(genres[i]);
		if(!genre || normalizedGenresSet[genre])
			continue;

		normalizedGenresSet[genre] = true;
		normalizedGenres.push(genre);
	}

	return normalizedGenres;
}

function getAvailableGenres()
{
	const genresByNormalized = {};
	const trackingFolderMetadata = relative.get('trackingFolderMetadata') || {};

	for(const key in trackingFolderMetadata)
	{
		const metadata = trackingFolderMetadata[key];
		if(!metadata || !Array.isArray(metadata.genres))
			continue;

		for(let i = 0, len = metadata.genres.length; i < len; i++)
		{
			const genre = metadata.genres[i];
			const normalized = normalizeGenreFilterValue(genre);

			if(!normalized || genresByNormalized[normalized])
				continue;

			genresByNormalized[normalized] = formatGenreFilterValue(genre) || formatGenreFilterValue(normalized);
		}
	}

	const comics = Array.isArray(handlebarsContext.comics) ? handlebarsContext.comics : [];

	for(let i = 0, len = comics.length; i < len; i++)
	{
		const comicGenres = getComicGenres(comics[i], trackingFolderMetadata);

		for(let j = 0, len2 = comicGenres.length; j < len2; j++)
		{
			const normalized = comicGenres[j];
			if(!normalized || genresByNormalized[normalized])
				continue;

			genresByNormalized[normalized] = formatGenreFilterValue(normalized);
		}
	}

	const genres = Object.keys(genresByNormalized).map(function(normalized){
		return {
			normalized,
			name: genresByNormalized[normalized],
		};
	});

	genres.sort(function(a, b){
		if(a.name === b.name)
			return 0;

		return a.name > b.name ? 1 : -1;
	});

	return genres;
}

function loadGenres()
{
	const label = dom.prevIndexLabel() || {};
	const filter = label.filter || {};
	const activeGenres = getFilterGenres(filter);
	const activeGenresSet = {};

	for(let i = 0, len = activeGenres.length; i < len; i++)
		activeGenresSet[activeGenres[i]] = true;

	const genres = getAvailableGenres().map(function(genre, index){
		return {
			key: index,
			name: genre.name,
			normalized: genre.normalized,
			active: !!activeGenresSet[genre.normalized],
		};
	});

	handlebarsContext.filterGenres = genres;
	handlebarsContext.filterHasGenres = activeGenres.length > 0;

	const element = document.querySelector('#index-genres .menu-simple-content');
	if(element)
		element.innerHTML = template.load('index.elements.menus.genres.html');

	events.events();
}

function filterGenres(genre = '')
{
	const currentFilter = dom.prevIndexLabel()?.filter || {};
	const normalized = normalizeGenreFilterValue(genre);

	if(!normalized)
		return;

	let genres = getFilterGenres(currentFilter);

	if(genres.includes(normalized))
		genres = genres.filter(value => value !== normalized);
	else
		genres.push(normalized);

	const hasGenre = genres.length > 0;

	dom.query('.button-genre-filter').class(hasGenre, 'fill');

	filter({
		...currentFilter,
		genre: false,
		genres: hasGenre ? genres : false,
		hasGenre,
	});

	loadGenres();
}

function clearFilterGenres()
{
	const currentFilter = dom.prevIndexLabel()?.filter || {};

	dom.query('.button-genre-filter').class(false, 'fill');

	filter({
		...currentFilter,
		genre: false,
		genres: false,
		hasGenre: false,
	});

	loadGenres();
}

function getComicGenres(comic, trackingFolderMetadata = {})
{
	const genres = [];

	if(Array.isArray(comic?.metadataGenres))
		genres.push(...comic.metadataGenres);

	if(Array.isArray(comic?.genres))
		genres.push(...comic.genres);

	if(!genres.length && comic?.path)
	{
		const normalizedPath = p.normalize(comic.path);
		let metadata = trackingFolderMetadata[normalizedPath];

		if(!metadata)
			metadata = trackingFolderMetadata[p.normalize(p.dirname(comic.path))];

		if(metadata && Array.isArray(metadata.genres))
			genres.push(...metadata.genres);
	}

	const normalizedGenres = [];
	const seen = {};

	for(let i = 0, len = genres.length; i < len; i++)
	{
		const genre = normalizeGenreFilterValue(genres[i]);
		if(!genre || seen[genre])
			continue;

		seen[genre] = true;
		normalizedGenres.push(genre);
	}

	return normalizedGenres;
}

function filterList(comics, filter = {favorites: false, labels: false, withoutLabels: false, requireAllLabels: false}, options = {})
{
	const genreFilterValues = [];

	if(!options.ignoreGenre)
	{
		if(Array.isArray(filter.genres))
			genreFilterValues.push(...filter.genres);
		else if(filter.genre)
			genreFilterValues.push(filter.genre);
	}

	const normalizedGenres = [];
	const normalizedGenresSet = {};

	for(let i = 0, len = genreFilterValues.length; i < len; i++)
	{
		const genre = normalizeGenreFilterValue(genreFilterValues[i]);
		if(!genre || normalizedGenresSet[genre])
			continue;

		normalizedGenresSet[genre] = true;
		normalizedGenres.push(genre);
	}

	if(!filter.favorites && !filter.labels && !filter.withoutLabels && !normalizedGenres.length)
		return comics;

	const favorites = relative.get('favorites');
	const comicLabels = relative.get('comicLabels');
	const trackingFolderMetadata = normalizedGenres.length ? (relative.get('trackingFolderMetadata') || {}) : {};

	return comics.filter(function(comic){

		if(filter.favorites && !favorites[comic.path])
			return false;

		if(filter.labels || filter.withoutLabels)
		{
			const labels = comicLabels[comic.path] || false;
			if(!labels && filter.labels) return false;

			if(filter.labels)
			{
				if(filter.requireAllLabels)
				{
					const every = filter.labels.every(value => labels.includes(value));
					if(!every) return false;
				}
				else
				{
					const some = labels.some(value => filter.labels.includes(value));
					if(!some) return false;
				}
			}

			if(filter.withoutLabels && labels)
			{
				const some = labels.some(value => filter.withoutLabels.includes(value));
				if(some) return false;
			}
		}

		if(normalizedGenres.length)
		{
			const comicGenres = getComicGenres(comic, trackingFolderMetadata);
			if(!comicGenres.length)
				return false;

			const some = comicGenres.some(value => normalizedGenres.includes(value));
			if(!some)
				return false;
		}

		return true;

	});
}

function deleteFromSortAndView(name, index)
{
	let sortAndView = {};

	let regex = new RegExp('^'+pregQuote(name));

	for(let key in config.sortAndView)
	{
		if(regex.test(key))
		{
			let _index = +app.extract(/([0-9]+)/, key, 1);

			if(_index !== index)
			{
				if(_index < index)
					sortAndView[key] = config.sortAndView[key];
				else
					sortAndView[name+'-'+(_index - 1)] = config.sortAndView[key];
			}
		}
		else
		{
			sortAndView[key] = config.sortAndView[key];
		}
	}

	storage.updateVar('config', 'sortAndView', sortAndView);
}

var labelsDialogPath = false;

function getLabels(comicLabels = [])
{
	comicLabels = comicLabels || [];

	const labels = (storage.get('labels') || []).map(function(label, i){

		return {
			key: i,
			name: label,
			active: comicLabels.includes(label),
		};

	});

	labels.sort(function(a, b){

		if(a.name === b.name)
			return 0;

		return a.name > b.name ? 1 : -1;

	});

	return labels;
}

function setLabels(path, save = false)
{
	if(save)
	{
		let labels = storage.get('labels');
		let comicLabels = storage.get('comicLabels');

		let _labels = [];

		let inputs = template._globalElement().querySelectorAll('.dialog .checkbox input');

		for(let i = 0, len = inputs.length; i < len; i++)
		{
			let input = inputs[i];
			let key = +input.dataset.key;
			let value = +input.value;

			if(value && labels[key])
				_labels.push(labels[key]);
		}

		if(!_labels.length)
			delete comicLabels[labelsDialogPath];
		else
			comicLabels[labelsDialogPath] = _labels;

		storage.set('comicLabels', comicLabels);

		labelsDialogPath = false;

		let prevIndexLabel = dom.prevIndexLabel();

		if(prevIndexLabel.label)
			dom.reload();
	}
	else
	{
		labelsDialogPath = relative.path(path);

		const comicLabels = relative.get('comicLabels');
		const labels = getLabels(comicLabels[path] || []);

		handlebarsContext.labels = labels;

		events.dialog({
			header: language.global.labels,
			width: 400,
			height: false,
			content: template.load('dialog.labels.set.html'),
			buttons: [
				{
					text: language.buttons.cancel,
					function: 'events.closeDialog();',
				},
				{
					text: language.buttons.save,
					function: 'events.closeDialog(); dom.labels.setLabels(false, true);',
				}
			],
		});

		// events.eventCheckbox();
	}
}

function newLabel(save = false, fromEditLabels = false)
{
	if(save)
	{
		let name = document.querySelector('.input-new-label').value;
		if(!name) return;

		let labels = storage.get('labels');

		let exists = false;

		for(let i = 0, len = labels.length; i < len; i++)
		{
			let label = labels[i];

			if(label == name)
			{
				exists = true;
				break;
			}
		}

		if(!exists)
		{
			labels.push(name);
			storage.set('labels', labels);

			if(fromEditLabels)
				editLabels();
			else if(labelsDialogPath)
				setLabels(labelsDialogPath);
			else if(labelsShortcutPageConfig)
				setShortcutPageConfigLabels();

			if(!labelsShortcutPageConfig) dom.loadIndexContentLeft(true, false);
		}
		else
		{
			events.snackbar({
				key: 'labelExists',
				text: language.dialog.labels.labelExists,
				duration: 6,
				update: true,
				buttons: [
					{
						text: language.buttons.dismiss,
						function: 'events.closeSnackbar();',
					},
				],
			});
		}
	}
	else
	{
		handlebarsContext.labelName = '';

		events.dialog({
			header: language.global.labels,
			width: 400,
			height: false,
			content: template.load('dialog.labels.new.html'),
			onClose: fromEditLabels ? 'dom.labels.editLabels();' : '',
			buttons: [
				{
					text: language.buttons.cancel,
					function: 'events.closeDialog();'+(fromEditLabels ? 'dom.labels.editLabels();' : ''),
				},
				{
					text: language.buttons.save,
					function: 'dom.labels.newLabel(true, '+(fromEditLabels ? 'true' : 'false')+');',
				}
			],
		});

		events.focus('.input-new-label');
		events.eventInput();
	}
}

function editLabels()
{
	const labels = getLabels();
	handlebarsContext.labels = labels;

	events.dialog({
		header: language.global.labels,
		width: 400,
		height: false,
		content: template.load('dialog.labels.edit.html'),
		buttons: [
			{
				text: language.buttons.close,
				function: 'events.closeDialog();',
			}
		],
	});
}

function editLabel(key, save = false)
{
	if(save)
	{
		let name = document.querySelector('.input-new-label').value;
		if(!name) return;

		let labels = storage.get('labels');
		let comicLabels = storage.get('comicLabels');
		let readingShortcutPagesConfig = storage.get('readingShortcutPagesConfig');

		let prevName = labels[key];
		let exists = false;

		for(let i = 0, len = labels.length; i < len; i++)
		{
			let label = labels[i];

			if(label == name)
			{
				exists = true;
				break;
			}
		}

		if(!exists || prevName === name)
		{
			labels[key] = name;

			// Update label name in comicLabels
			for(let path in comicLabels)
			{
				const _labels = [];

				for(let i = 0, len = comicLabels[path].length; i < len; i++)
				{
					const label = comicLabels[path][i];

					if(label === prevName)
						_labels.push(name);
					else
						_labels.push(label);
				}

				if(!_labels.length)
					delete comicLabels[path];
				else
					comicLabels[path] = _labels;
			}

			// Update label name in readingShortcutPagesConfig
			for(let index in readingShortcutPagesConfig)
			{
				const _labels = [];

				for(let i = 0, len = readingShortcutPagesConfig[index].labels.length; i < len; i++)
				{
					const label = readingShortcutPagesConfig[index].labels[i];

					if(label === prevName)
						_labels.push(name);
					else
						_labels.push(label);
				}

				readingShortcutPagesConfig[index].labels = _labels;
			}

			storage.set('labels', labels);
			storage.set('comicLabels', comicLabels);
			storage.set('readingShortcutPagesConfig', readingShortcutPagesConfig);

			editLabels();

			dom.loadIndexContentLeft(true, false);
		}
		else
		{
			events.snackbar({
				key: 'labelExists',
				text: language.dialog.labels.labelExists,
				duration: 6,
				update: true,
				buttons: [
					{
						text: language.buttons.dismiss,
						function: 'events.closeSnackbar();',
					},
				],
			});
		}
	}
	else
	{
		let labels = storage.get('labels');
		handlebarsContext.labelName = labels[key];

		events.dialog({
			header: language.global.labels,
			width: 400,
			height: false,
			content: template.load('dialog.labels.new.html'),
			onClose: 'dom.labels.editLabels();',
			buttons: [
				{
					text: language.buttons.cancel,
					function: 'events.closeDialog(); dom.labels.editLabels();',
				},
				{
					text: language.buttons.save,
					function: 'dom.labels.editLabel('+key+', true);',
				}
			],
		});

		events.focus('.input-new-label');
		events.eventInput();
	}
}

function deleteLabel(key, confirm = false)
{
	if(confirm)
	{
		let labels = storage.get('labels');
		let comicLabels = storage.get('comicLabels');
		let readingShortcutPagesConfig = storage.get('readingShortcutPagesConfig');

		let name = labels[key];
		labels.splice(key, 1);

		// Delete label name in comicLabels
		for(let path in comicLabels)
		{
			const _labels = [];

			for(let i = 0, len = comicLabels[path].length; i < len; i++)
			{
				if(comicLabels[path][i] !== name)
					_labels.push(comicLabels[path][i]);
			}

			if(!_labels.length)
				delete comicLabels[path];
			else
				comicLabels[path] = _labels;
		}

		// Delete label name in readingShortcutPagesConfig
		for(let index in readingShortcutPagesConfig)
		{
			const _labels = [];

			for(let i = 0, len = readingShortcutPagesConfig[index].labels.length; i < len; i++)
			{
				const label = readingShortcutPagesConfig[index].labels[i];

				if(label !== name)
					_labels.push(label);
			}

			readingShortcutPagesConfig[index].labels = _labels;
		}

		deleteFromSortAndView('label', key);

		storage.set('labels', labels);
		storage.set('comicLabels', comicLabels);
		storage.set('readingShortcutPagesConfig', readingShortcutPagesConfig);

		dom.loadIndexContentLeft(true, false);

		let prevIndexLabel = dom.prevIndexLabel();

		if(prevIndexLabel.label && prevIndexLabel.label === name)
			dom.loadIndexPage(true);

		editLabels();

		reading.purgeGlobalReadingPagesConfig();
	}
	else
	{
		events.dialog({
			header: language.dialog.labels.deleteLabel,
			width: 400,
			height: false,
			content: language.dialog.labels.confirmDelete,
			onClose: 'dom.labels.editLabels();',
			buttons: [
				{
					text: language.buttons.cancel,
					function: 'events.closeDialog(); dom.labels.editLabels();',
				},
				{
					text: language.buttons.remove,
					function: 'dom.labels.deleteLabel('+key+', true);',
				}
			],
		});
	}
}

function menuItemSelector(labels)
{
	if(labels.favorites)
		return 'favorites';
	else if(labels.opds)
		return 'opds'+(labels.index !== false ? '-'+labels.index : '');
	else if(labels.masterFolder)
		return 'master-folder-'+labels.index;
	else if(labels.label)
		return 'label-'+labels.index;
	else if(labels.server)
		return 'server-'+labels.index;

	return '';
}

function getName(indexLabel, recentlyOpened)
{
	if(indexLabel?.has)
		return indexLabel.name;
	else if(recentlyOpened)
		return language.global.recentlyOpened;

	return language.global.library;
}

function has(path, parents = false)
{
	const comicLabels = relative.get('comicLabels');

	if(comicLabels[path])
		return comicLabels[path];

	if(parents)
	{
		const len = path.split(p.sep).filter(Boolean).length;

		for(let i = 0; i < len; i++)
		{
			path = p.dirname(path);

			if(comicLabels[path])
				return comicLabels[path];

			const sections = path.split(p.sep).filter(Boolean);

			if(sections.length <= 1)
				break;
		}
	}

	return false;
}

// Labels functions related to reading shortcut page config
var labelsShortcutPageConfig = false;

function setShortcutPageConfigLabels(save = false)
{
	if(save)
	{
		const labels = storage.get('labels');
		const _labels = [];

		const inputs = template._globalElement().querySelectorAll('.dialog .checkbox input');

		for(let i = 0, len = inputs.length; i < len; i++)
		{
			const input = inputs[i];
			const key = +input.dataset.key;
			const value = +input.value;

			if(value && labels[key])
				_labels.push(labels[key]);
		}

		labelsShortcutPageConfig = false;

		reading.updateReadingPagesConfig('labels', _labels);
		reading.updateConfigLabels();
		reading.purgeGlobalReadingPagesConfig();
	}
	else
	{
		const labels = storage.get('labels');
		const _labels = [];

		for(let i = 0, len = labels.length; i < len; i++)
		{
			const label = labels[i];

			_labels.push({
				key: i,
				name: label,
				active: _config.labels.includes(label),
			});
		}

		_labels.sort(function(a, b){

			if(a.name === b.name)
				return 0;

			return a.name > b.name ? 1 : -1;

		});

		handlebarsContext.labels = _labels;

		events.dialog({
			header: language.global.labels,
			width: 400,
			height: false,
			content: template.load('dialog.labels.set.html'),
			buttons: [
				{
					text: language.buttons.cancel,
					function: 'events.closeDialog();',
				},
				{
					text: language.buttons.save,
					function: 'events.closeDialog(); dom.labels.setShortcutPageConfigLabels(true);',
				}
			],
		});

		labelsShortcutPageConfig  = true;

		// events.eventCheckbox();
	}
}

function removeLabelFromShortcutPageConfig(label = '')
{
	const labels = [];

	for(let i = 0, len = _config.labels.length; i < len; i++)
	{
		const _label = _config.labels[i];

		if(_label !== label)
			labels.push(_label);
	}

	reading.updateReadingPagesConfig('labels', labels);
	reading.updateConfigLabels();
	reading.purgeGlobalReadingPagesConfig();
}

function applyShortcutPageConfigToAll(label = '', apply = false)
{
	if(apply)
	{
		const readingPagesConfig = storage.get('readingPagesConfig');

		for(let path in readingPagesConfig)
		{
			const labels = has(path);

			if(labels && labels.includes(label))
				delete readingPagesConfig[path];
		}

		storage.set('readingPagesConfig', readingPagesConfig);
	}
	else
	{
		events.dialog({
			header: language.dialog.pages.readingConfigApplyToAllLabel,
			width: 400,
			height: false,
			content: language.dialog.pages.readingConfigApplyToAllLabelDescription,
			buttons: [
				{
					text: language.buttons.cancel,
					function: 'events.closeDialog();',
				},
				{
					text: language.buttons.apply,
					function: 'events.closeDialog(); dom.labels.applyShortcutPageConfigToAll(\''+escapeQuotes(escapeBackSlash(label), 'simples')+'\', true);',
				}
			],
		});
	}
}

module.exports = {
	middleClick,
	masterFolder,
	setFavorite,
	favorites,
	setHideFromContinueReading,
	isHiddenFromContinueReading,
	opds: _opds,
	label,
	server,
	filter,
	filterFavorite,
	loadLabels,
	loadGenres,
	filterLabels,
	filterGenres,
	clearFilterGenres,
	filterRequireAllLabels,
	filterOnlyRoot,
	filterList,
	setLabels,
	newLabel,
	editLabels,
	editLabel,
	deleteLabel,
	deleteFromSortAndView,
	has,
	menuItemSelector,
	getName,
	setShortcutPageConfigLabels,
	removeLabelFromShortcutPageConfig,
	applyShortcutPageConfigToAll,
};
