const OpenComicAI = require('opencomic-ai-bin');
const sharp = require('sharp');

OpenComicAI.setDirname(asarToAsarUnpacked(OpenComicAI.__dirname));

let currentPath = false;

function setModelsPath()
{
	const path = p.join(tempFolder, 'ai-models');

	if(!fs.existsSync(path))
		fs.mkdirSync(path, {recursive: true});

	if(currentPath !== path)
	{
		OpenComicAI.setModelsPath(path);
		currentPath = path;
	}
}

function upscale(src, imageSize, options = {})
{
	const toUpscale = reading.ai.toUpscale(imageSize);

	if(toUpscale)
	{
		const folderSha = sha1(p.dirname(src));
		const imageSha = sha1(`${src}|${toUpscale.model}|${toUpscale.scale}`);

		const folderPath = p.join(tempFolder, 'ai-upscale', folderSha);
		const path = p.join(folderPath, imageSha+'.jpg');

		if(fs.existsSync(path))
		{
				fileManager.setTmpUsage(path);
				return path;
		}

		if(options.generate === false)
			return;

		if(options.toUpscale)
			options.toUpscale(toUpscale);

		(async function(){

			await threads.job('aiPipeline', {key: imageSha, resolveDuplicated: true, useThreads: threads.SINGLE}, async function() {

				if(fs.existsSync(path))
					return;

				const ext = app.extname(src);
				let image = src, convertPath = false;

				// Images that are not jpg, png or webp are not supported by RealESRGAN
				if(!compatible.image.jpg.has(ext) && !compatible.image.png.has(ext) && !compatible.image.webp.has(ext))
				{
					convertPath = p.join(folderPath, imageSha+'.png');
					await image.rawToPng(src, convertPath);
					image = convertPath;
				}

				await OpenComicAI.pipeline(image, path, [
					{
						model: toUpscale.model,
						scale: toUpscale.scale,
					}
				], options.onProgress || false);

				if(convertPath)
					fs.rmSync(convertPath, {force: true});

				return;

			});

			if(options.onUpscale)
				options.onUpscale(path);

		})();
	}

	return false;
}

function pipeline()
{

}

const downloading = {
	start: function() {

		events.snackbar({
			key: 'downloadingAiModel',
			text: 'Downloading AI model',
			duration: events.INFINITY,
			buttons: [
				{
					text: 'AA', // language.buttons.download,
					function: 'events.closeSnackbar();',
					className: 'ai-model-downloading-button',
				},
			],
		});

		const button = document.querySelector('.snackbar .ai-model-downloading-button');
		//events.buttonLoading(button, true);
		events.buttonLoading(button, 0.01);

	},
	progress: function(progress) {

		const button = document.querySelector('.snackbar .ai-model-downloading-button');
		events.buttonLoading(button, progress);

	},
	end: function() {

		const button = document.querySelector('.snackbar .ai-model-downloading-button');
		events.buttonLoading(button, 1);

		events.closeSnackbar();

	},
};

// Whether image() would actually build a pipeline for this page. Callers use it to avoid
// paying for work (such as materialising a PDF page on disk) when no AI step is enabled.
function willProcess(imageSize)
{
	if(_config?.readingAi?.artifactRemoval?.active || _config?.readingAi?.descreen?.active)
		return true;

	return !!reading.ai.toUpscale(imageSize);
}

function image(src, imageSize, options = {})
{
	setModelsPath();

	const toUpscale = reading.ai.toUpscale(imageSize);
	const _pipeline = [];

	// Validate selected models belong to the correct model type list.
	function modelIsValidFor(key, modelKey)
	{
		const queryKey = key === 'artifactRemoval' ? 'artifact-removal' : key;
		const list = OpenComicAI.modelsTypeList[queryKey] || [];
		return list.includes(modelKey);
	}

	if(_config.readingAi.artifactRemoval.active)
	{
		let modelKey = _config.readingAi.artifactRemoval.model;
		if(!modelIsValidFor('artifactRemoval', modelKey))
		{
			console.warn('[ai.image] artifactRemoval model invalid for artifactRemoval:', modelKey);
			const fallback = (OpenComicAI.modelsTypeList['artifact-removal'] || [])[0];
			if(fallback)
			{
				console.warn('[ai.image] falling back to', fallback);
				modelKey = fallback;
			}
		}

		_pipeline.push({ model: modelKey });
	}

	if(_config.readingAi.descreen.active)
	{
		let modelKey = _config.readingAi.descreen.model;
		if(modelKey === 'opencomic-ai-descreen-hard-compact')
		{
			console.warn('[ai.image] descreen compact model selected; switching to opencomic-ai-descreen-hard-lite for quality');
			modelKey = 'opencomic-ai-descreen-hard-lite';
		}
		if(!modelIsValidFor('descreen', modelKey))
		{
			console.warn('[ai.image] descreen model invalid for descreen:', modelKey);
			const fallback = (OpenComicAI.modelsTypeList['descreen'] || [])[0];
			if(fallback)
			{
				console.warn('[ai.image] falling back to', fallback);
				modelKey = fallback;
			}
		}

		_pipeline.push({ model: modelKey });
	}

	if(toUpscale)
	{
		_pipeline.push({
			model: toUpscale.model,
			scale: toUpscale.scale,
			noise: toUpscale.noise,
		});
	}

	if(!_pipeline.length)
		return;

	const folderSha = sha1(p.dirname(src));
	const imageSha = sha1(`${src}|${JSON.stringify(_pipeline)}`);

	const folderPath = p.join(tempFolder, 'ai', folderSha);
	const path = p.join(folderPath, imageSha+'.jpg');

	if(fs.existsSync(path))
	{
		fileManager.setTmpUsage(path);
		return path;
	}

		if(!options.run)
		{
			return;
		}

	if(options.start)
		options.start(pipeline);

	(async function(){

		for(const step of _pipeline)
		{
			const modelInfo = OpenComicAI.model(step.model);

			for(const file of modelInfo.files)
			{
				fileManager.setTmpUsage(p.join(modelInfo.path, file));
			}
		}

		await threads.job('aiPipeline', {key: imageSha, useThreads: threads.SINGLE}, async function() {
			if(fs.existsSync(path))
			{
				if(options.end)
					options.end(path);

				return;
			}

			const ext = app.extname(src);
			let image = src, convertPath = false;

			// Images that are not jpg, png or webp are not supported by OpenComicAI
			if(!compatible.image.jpg.has(ext) && !compatible.image.png.has(ext) && !compatible.image.webp.has(ext))
			{
				convertPath = p.join(folderPath, imageSha+'.png');
				await image.rawToPng(src, convertPath);
				image = convertPath;
			}

			OpenComicAI.keepIccProfile(sharp, 'rgb16');

			try {
				await OpenComicAI.pipeline(image, path, _pipeline, options.progress || false, downloading);

				if (fs.existsSync(path))
					fileManager.setTmpUsage(path);
				else
					console.error('[ai.image] pipeline completed but output missing for', path);
			}
			catch (err) {
				console.error('[ai.image] pipeline error for', path, err && err.stack ? err.stack : err);
			}
			finally {
				if (convertPath)
					fs.rmSync(convertPath, {force: true});
			}

			return;
		});

		if(options.end)
			options.end(path);

	})();

	return;
}

let prevOptionsKey = false;

function clean(force = false)
{
	if(force)
		return threads.clean('aiPipeline');

	const optionsKey = sha1(`${JSON.stringify(_config.readingAi)}`);

	// Not clean if options didn't change
	if(prevOptionsKey !== optionsKey)
		threads.clean('aiPipeline');

	prevOptionsKey = optionsKey;
}

module.exports = {
	upscale,
	pipeline,
	image,
	willProcess,
	clean,
};
