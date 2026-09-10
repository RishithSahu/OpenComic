const fs = require('fs');
const asar = require('@electron/asar');

function exists(path, permissions = false, fix = false)
{
	if(!fs.existsSync(path))
		throw new Error('Not exists! '+path+(fix ? '\n\nTry: '+fix : '')+'\n');

	if(permissions !== false)
	{
		try
		{
			fs.accessSync(path, permissions);
		}
		catch (error)
		{
			throw new Error('No access! '+path+', '+error.message);
		}
	}
}

// electron-builder's asar creation has, at least once, produced an archive whose internal file
// offsets point at the wrong bytes - package.json read back as another file's tail entirely - with
// no error at build time; electron only discovers it at launch ("Unable to parse ...package.json:
// Bad control character..."), a dialog that shipped straight to a real user. The one time this was
// caught, the build log had logged an antivirus/indexer holding a lock on the output file mid-write
// ("output file is locked for writing (maybe by virus scanner) => waiting for unlock..."), a
// plausible way to corrupt a file being written and finalized at the same time. Reading package.json
// back out of the built archive and checking it both parses and actually names this app is the only
// way to catch that kind of corruption before it ships, since every other postbuild check here only
// ever looks at app.asar.unpacked, never at the archive itself.
function verifyAsar(asarPath)
{
	exists(asarPath, fs.constants.R_OK);

	let raw;

	try
	{
		raw = asar.extractFile(asarPath, 'package.json').toString('utf8');
	}
	catch(error)
	{
		throw new Error('Could not read package.json out of '+asarPath+' - the archive is likely corrupt (something else, e.g. an antivirus scanner, may have written to it mid-build). Delete dist/ and rebuild.\n\n'+error.message);
	}

	let parsed;

	try
	{
		parsed = JSON.parse(raw);
	}
	catch(error)
	{
		throw new Error('package.json read out of '+asarPath+' is not valid JSON - the archive is corrupt (its internal file offsets point at the wrong bytes, a known symptom of something else writing to app.asar mid-build). Delete dist/ and rebuild.\n\n'+error.message);
	}

	if(parsed.name !== 'opencomic')
		throw new Error('package.json read out of '+asarPath+' does not name this app (name="'+parsed.name+'") - the archive is corrupt.');
}

const darwinAsar = './dist/mac/OpenComic.app/Contents/Resources/app.asar';
const darwinArmAsar = './dist/mac-arm/OpenComic.app/Contents/Resources/app.asar';
const darwinMasAsar = './dist/mas-universal/OpenComic.app/Contents/Resources/app.asar';
const linuxAsar = './dist/linux-unpacked/resources/app.asar';
const linuxArmAsar = './dist/linux-arm64-unpacked/resources/app.asar';
const windowsAsar = './dist/win-unpacked/resources/app.asar';
const windowsArmAsar = './dist/win-arm64-unpacked/resources/app.asar';

const darwin = './dist/mac/OpenComic.app/Contents/Resources/app.asar.unpacked/node_modules';
const darwinArm = './dist/mac-arm/OpenComic.app/Contents/Resources/app.asar.unpacked/node_modules';
const darwinMas = './dist/mas-universal/OpenComic.app/Contents/Resources/app.asar.unpacked/node_modules';
const linux = './dist/linux-unpacked/resources/app.asar.unpacked/node_modules';
const linuxArm = './dist/linux-arm64-unpacked/resources/app.asar.unpacked/node_modules';
const windows = './dist/win-unpacked/resources/app.asar.unpacked/node_modules';
const windowsArm = './dist/win-arm64-unpacked/resources/app.asar.unpacked/node_modules';

let checkSome = false;

if(process.platform == 'darwin')
{
	if(fs.existsSync(darwin))
	{
		verifyAsar(darwinAsar);

		// Node ZSTD All
		exists(darwin+'/@toondepauw/node-zstd/index.js', fs.constants.R_OK);
		exists(darwin+'/@toondepauw/node-zstd-darwin-x64/node-zstd.darwin-x64.node', fs.constants.R_OK);

		// Sharp x64
		exists(darwin+'/@img/sharp-libvips-darwin-x64/lib/libvips-cpp.8.17.3.dylib', fs.constants.R_OK, 'npm install --cpu=x64 --os=darwin sharp');
		exists(darwin+'/@img/sharp-darwin-x64/lib/sharp-darwin-x64.node', fs.constants.R_OK, 'npm install --cpu=x64 --os=darwin sharp');

		// 7zip
		exists(darwin+'/7zip-bin-full/mac/x64/7zz', fs.constants.X_OK | fs.constants.R_OK);

		// OpenComicAI
		exists(darwin+'/opencomic-ai-bin/mac/x64/realcugan/realcugan-ncnn-vulkan.app', fs.constants.X_OK | fs.constants.R_OK);
		exists(darwin+'/opencomic-ai-bin/mac/x64/waifu2x/waifu2x-ncnn-vulkan.app', fs.constants.X_OK | fs.constants.R_OK);
		exists(darwin+'/opencomic-ai-bin/mac/x64/upscayl/upscayl-bin.app', fs.constants.X_OK | fs.constants.R_OK);

		checkSome = true;
	}

	if(fs.existsSync(darwinArm))
	{
		verifyAsar(darwinArmAsar);

		// Node ZSTD All
		exists(darwinArm+'/@toondepauw/node-zstd/index.js', fs.constants.R_OK);
		exists(darwinArm+'/@toondepauw/node-zstd-darwin-arm64/node-zstd.darwin-arm64.node', fs.constants.R_OK);

		// Sharp arm64
		exists(darwinArm+'/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.17.3.dylib', fs.constants.R_OK, 'npm install --cpu=arm64 --os=darwin sharp');
		exists(darwinArm+'/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node', fs.constants.R_OK, 'npm install --cpu=arm64 --os=darwin sharp');

		// 7zip
		exists(darwinArm+'/7zip-bin-full/mac/arm64/7zz', fs.constants.X_OK | fs.constants.R_OK);

		// OpenComicAI
		exists(darwinArm+'/opencomic-ai-bin/mac/arm64/realcugan/realcugan-ncnn-vulkan.app', fs.constants.X_OK | fs.constants.R_OK);
		exists(darwinArm+'/opencomic-ai-bin/mac/arm64/waifu2x/waifu2x-ncnn-vulkan.app', fs.constants.X_OK | fs.constants.R_OK);
		exists(darwinArm+'/opencomic-ai-bin/mac/arm64/upscayl/upscayl-bin.app', fs.constants.X_OK | fs.constants.R_OK);

		checkSome = true;
	}

	if(fs.existsSync(darwinMas))
	{
		verifyAsar(darwinMasAsar);

		// Node ZSTD All
		exists(darwinMas+'/@toondepauw/node-zstd/index.js', fs.constants.R_OK);
		exists(darwinMas+'/@toondepauw/node-zstd-darwin-x64/node-zstd.darwin-x64.node', fs.constants.R_OK);
		exists(darwinMas+'/@toondepauw/node-zstd-darwin-arm64/node-zstd.darwin-arm64.node', fs.constants.R_OK);

		// Sharp x64
		exists(darwinMas+'/@img/sharp-libvips-darwin-x64/lib/libvips-cpp.8.17.3.dylib', fs.constants.R_OK, 'npm install --cpu=x64 --os=darwin sharp');
		exists(darwinMas+'/@img/sharp-darwin-x64/lib/sharp-darwin-x64.node', fs.constants.R_OK, 'npm install --cpu=x64 --os=darwin sharp');

		// Sharp arm64
		exists(darwinMas+'/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.17.3.dylib', fs.constants.R_OK, 'npm install --cpu=arm64 --os=darwin sharp');
		exists(darwinMas+'/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node', fs.constants.R_OK, 'npm install --cpu=arm64 --os=darwin sharp');

		// 7zip
		exists(darwinMas+'/7zip-bin-full/mac/arm64/7zz', fs.constants.X_OK | fs.constants.R_OK);
		exists(darwinMas+'/7zip-bin-full/mac/x64/7zz', fs.constants.X_OK | fs.constants.R_OK);

		// OpenComicAI
		exists(darwinMas+'/opencomic-ai-bin/mac/arm64/realcugan/realcugan-ncnn-vulkan.app', fs.constants.X_OK | fs.constants.R_OK);
		exists(darwinMas+'/opencomic-ai-bin/mac/arm64/waifu2x/waifu2x-ncnn-vulkan.app', fs.constants.X_OK | fs.constants.R_OK);
		exists(darwinMas+'/opencomic-ai-bin/mac/arm64/upscayl/upscayl-bin.app', fs.constants.X_OK | fs.constants.R_OK);
		exists(darwinMas+'/opencomic-ai-bin/mac/x64/realcugan/realcugan-ncnn-vulkan.app', fs.constants.X_OK | fs.constants.R_OK);
		exists(darwinMas+'/opencomic-ai-bin/mac/x64/waifu2x/waifu2x-ncnn-vulkan.app', fs.constants.X_OK | fs.constants.R_OK);
		exists(darwinMas+'/opencomic-ai-bin/mac/x64/upscayl/upscayl-bin.app', fs.constants.X_OK | fs.constants.R_OK);

		checkSome = true;
	}
}
else if(process.platform == 'linux')
{
	if(fs.existsSync(linux))
	{
		verifyAsar(linuxAsar);

		// Node ZSTD All
		exists(linux+'/@toondepauw/node-zstd/index.js', fs.constants.R_OK);
		exists(linux+'/@toondepauw/node-zstd-linux-x64-gnu/node-zstd.linux-x64-gnu.node', fs.constants.R_OK);

		// Sharp x64
		exists(linux+'/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.17.3', fs.constants.R_OK);
		exists(linux+'/@img/sharp-linux-x64/lib/sharp-linux-x64.node', fs.constants.R_OK);

		// 7zip
		exists(linux+'/7zip-bin-full/linux/x64/7zz', fs.constants.X_OK | fs.constants.R_OK);

		// OpenComicAI
		exists(linux+'/opencomic-ai-bin/linux/x64/realcugan/realcugan-ncnn-vulkan', fs.constants.X_OK | fs.constants.R_OK);
		exists(linux+'/opencomic-ai-bin/linux/x64/waifu2x/waifu2x-ncnn-vulkan', fs.constants.X_OK | fs.constants.R_OK);
		exists(linux+'/opencomic-ai-bin/linux/x64/upscayl/upscayl-bin', fs.constants.X_OK | fs.constants.R_OK);

		checkSome = true;
	}

	if(fs.existsSync(linuxArm))
	{
		verifyAsar(linuxArmAsar);

		// Node ZSTD All
		exists(linuxArm+'/@toondepauw/node-zstd/index.js', fs.constants.R_OK);
		exists(linuxArm+'/@toondepauw/node-zstd-linux-arm64-gnu/node-zstd.linux-arm64-gnu.node', fs.constants.R_OK);

		// Sharp arm64
		exists(linuxArm+'/@img/sharp-libvips-linux-arm64/lib/libvips-cpp.so.8.17.3', fs.constants.R_OK);
		exists(linuxArm+'/@img/sharp-linux-arm64/lib/sharp-linux-arm64.node', fs.constants.R_OK);

		// 7zip
		exists(linuxArm+'/7zip-bin-full/linux/arm64/7zz', fs.constants.X_OK | fs.constants.R_OK);

		// OpenComicAI
		exists(linuxArm+'/opencomic-ai-bin/linux/arm64/realcugan/realcugan-ncnn-vulkan', fs.constants.X_OK | fs.constants.R_OK);
		exists(linuxArm+'/opencomic-ai-bin/linux/arm64/waifu2x/waifu2x-ncnn-vulkan', fs.constants.X_OK | fs.constants.R_OK);
		exists(linuxArm+'/opencomic-ai-bin/linux/arm64/upscayl/upscayl-bin', fs.constants.X_OK | fs.constants.R_OK);

		checkSome = true;
	}
}
else if(process.platform == 'win32')
{
	if(fs.existsSync(windows))
	{
		verifyAsar(windowsAsar);

		// Node ZSTD All
		exists(windows+'/@toondepauw/node-zstd-win32-x64-msvc/node-zstd.win32-x64-msvc.node', fs.constants.R_OK);

		// Sharp x64
		exists(windows+'/@img/sharp-win32-x64/lib/libvips-42.dll', fs.constants.R_OK);
		exists(windows+'/@img/sharp-win32-x64/lib/libvips-cpp-8.17.3.dll', fs.constants.R_OK);
		exists(windows+'/@img/sharp-win32-x64/lib/sharp-win32-x64.node', fs.constants.R_OK);

		// 7zip
		exists(windows+'/7zip-bin-full/win/x64/7z.exe', fs.constants.X_OK | fs.constants.R_OK);
		exists(windows+'/7zip-bin-full/win/x64/7z.dll', fs.constants.X_OK | fs.constants.R_OK);

		// OpenComicAI
		exists(windows+'/opencomic-ai-bin/win/x64/realcugan/realcugan-ncnn-vulkan.exe', fs.constants.X_OK | fs.constants.R_OK);
		exists(windows+'/opencomic-ai-bin/win/x64/waifu2x/waifu2x-ncnn-vulkan.exe', fs.constants.X_OK | fs.constants.R_OK);
		exists(windows+'/opencomic-ai-bin/win/x64/upscayl/upscayl-bin.exe', fs.constants.X_OK | fs.constants.R_OK);

		checkSome = true;
	}

	if(fs.existsSync(windowsArm))
	{
		verifyAsar(windowsArmAsar);

		// Node ZSTD All
		// exists(windowsArm+'/@toondepauw/node-zstd-win32-x64-msvc/node-zstd.win32-x64-msvc.node', fs.constants.R_OK);

		// Sharp arm64
		exists(windowsArm+'/@img/sharp-win32-arm64/lib/libvips-42.dll', fs.constants.R_OK);
		exists(windowsArm+'/@img/sharp-win32-arm64/lib/libvips-cpp-8.17.3.dll', fs.constants.R_OK);
		exists(windowsArm+'/@img/sharp-win32-arm64/lib/sharp-win32-arm64.node', fs.constants.R_OK);

		// 7zip
		exists(windowsArm+'/7zip-bin-full/win/arm64/7z.exe', fs.constants.X_OK | fs.constants.R_OK);
		exists(windowsArm+'/7zip-bin-full/win/arm64/7z.dll', fs.constants.X_OK | fs.constants.R_OK);

		// OpenComicAI
		exists(windowsArm+'/opencomic-ai-bin/win/arm64/upscayl/upscayl-bin.exe', fs.constants.X_OK | fs.constants.R_OK);

		checkSome = true;
	}
}

if(!checkSome)
	throw new Error('No folders have been checked');

console.log('Runed postbuild tests: Ok');
