# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## v1.8.1 (04-08-2026)

##### Bug Fixes

- Fix pages flickering for a moment after every page turn when an AI tool is enabled. Each render pointed the image element at the raw AI output first and then overwrote it with the correctly sized blob a few milliseconds later, so one unscaled intermediate frame was displayed every time. The reader already waits for the render to finish before showing a page, so that priming step bought nothing; the fallback to the raw file if the resize fails is unchanged.
- Fix every AI tool (Artifact Removal, Descreen, Upscale) failing on PDFs with `Input file is missing: .../page-XXXX.jpg`. PDF pages are rasterised straight to blobs and are never written to disk — opening a PDF only makes the PDF file itself available, not its pages — but the AI pipeline reads its input from a file path, so it had nothing to work on. The page is now extracted on demand, and only when an AI step is actually enabled.
- Fix AI-processed PDF pages rendering blurry. The on-demand extraction has to say what resolution it wants: `extractPdf()` rasterises at exactly `config.width`, whose default is only `devicePixelRatio * 300` (it exists for vector thumbnails), so the AI was fed a ~300px wide page that then had to be blown up to full size. Pages are now extracted at the width they will actually be displayed at (capped by `renderMaxWidth`) — measured 300x375 before, 1280x1600 after on a 1920px viewport.
- Fix the AI page extraction silently doing nothing, which left the AI reading whichever low-resolution copy thumbnail generation had already written. Two causes: the page name from `imagesData` has no extension (`page-0001`) while the extraction filter and file-status map are keyed by the real filename (`page-0001.jpg`), so the filter matched nothing; and `extract()` short-circuits on `checkIfAlreadyExtracted()` whenever any file is present, so the stale copy was never replaced.
- Fix global reading settings never reaching a series that had been auto-configured from its AniList type. The automatic reading mode stored a copy of the *entire* reading config for that series, which pinned every unrelated setting (AI tools, filters, margins) to whatever it was at the time, so later changes in Settings silently had no effect there. Only the reading-mode keys are stored now, and configs written by earlier builds are reduced to that form on next open.
- Fix AniList-driven reading modes never being applied for libraries organised into category folders. The lookup resolved against the library entry (e.g. "3. Reading"), but AniList metadata is stored per series folder, so it missed for every series. The series folder is now resolved by walking up from the file being read to the nearest ancestor that has metadata, which also handles deeper nesting such as `Series/Volume 1/Chapter 3`.
- Fix every series inside a category folder sharing one per-series reading configuration, for the same reason: untracked series now also get their own config keyed by series folder instead of by the category folder.
- Fix AniList-driven reading modes (double page + right-to-left for manga, webtoon/scroll for manhwa and manhua) only taking effect after restarting the app. The metadata scrape for a folder was started at the *end* of opening a file, so on the first open the series type was not known yet and nothing was applied. The scrape is now requested up front, and the mode is applied live as soon as the metadata arrives (deferred until the chapter finishes loading if it lands mid-open).
- Fix the auto-applied reading mode being indistinguishable from a manual choice, which meant it was only ever applied once per folder and never corrected when the AniList series type changed. Auto-applied configs are now marked as such, and the marker is cleared the moment the reading mode is changed by hand so a manual choice always wins.
- Fix opened files showing only their first page until their cache was cleared by hand. Generating a thumbnail stamped "thumbnail mode" onto the shared compressed-file object's *default* config (`config` and `_config` were the same object), so every later read of that file re-inherited it and kept returning the synthetic single-page list. Thumbnail-only page lists are now explicitly tagged and can never be persisted to the on-disk index, stored in the shared in-memory index, or handed to the reader; already-poisoned caches are detected and rebuilt automatically instead of needing a manual "clear file cache".
- Fix file sizes and original filenames never being recorded for any archive whose thumbnail was generated first, because the synthetic single-page read consumed the one-shot in-memory index slot for that path.
- Fix "Clear temporary files" wiping the entire library, tracking, reading progress, bookmarks, favorites, labels, master folders and servers during an automatic version migration; the interactive reset path is no longer triggered on startup.
- Fix "Clear temporary files" running without confirmation and silently discarding all user-added data; it now asks for confirmation before performing a full reset, and uses an in-app notification instead of a blocking native alert.
- Fix the whole UI going blank after clearing cache/temp files: clearing the template cache emptied the precompiled template registry (which nothing repopulates at runtime), so every subsequent screen rendered empty until a manual reload.
- Fix looping/jumping back to the top during continuous scroll reading caused by treating a cleared internal scroll marker as position zero.
- Fix EPUB pagination getting permanently stuck on the loading screen with no way to recover when a chapter failed to render or an internal pagination call stalled; a timeout and error recovery are now in place again.
- Fix next/prev chapter navigation re-extracting and re-reading the whole archive on every single page turn, and single-image archives (e.g. one-page CBZ/CBR files) being needlessly re-extracted on every open.
- Fix AI-upscaled PDF pages leaking memory (unreleased blob URLs) during long reading sessions.
- Fix page prefetching direction being backwards in manga (right-to-left) reading mode.
- Fix the changing custom cache/tmp folder location in Settings not taking effect for image resizing, poster generation, AI models and remote server downloads, which kept writing to the old location.
- Fix the Pepper & Carrot sample reappearing in the library after every update even after being explicitly deleted, and "recommended for you" like/dislike counts resetting after every update.
- Fix corrupted/unreadable thumbnails being retried forever, pinning a CPU core; recovery is now capped at a few attempts per item.
- Fix "Recommended for you" impression counts climbing on every page reload/navigation instead of real views, which suppressed recommendations and reset user feedback too aggressively; also fix like/dislike state being lost on re-render.
- Fix the library search overlay hanging indefinitely if any folder in the library could not be read.
- Fix the library search freezing typing on large libraries by debouncing search instead of re-scanning the whole index on every keystroke.
- Fix the first-time tutorial launching over a comic opened directly from the command line or an in-progress reading session, and getting stuck due to a leaked internal timer that kept firing after the tutorial was closed.
- Fix `toOpenFile`, the About window and the Guides window breaking (or opening as an invisible/blank window) when the file path or template content contained backslashes or backticks.
- Fix a startup crash window being capped to 512MB of memory, which could cause out-of-memory crashes when processing large PDFs, EPUBs or high-resolution scans.
- Fix the in-app update check pointing at upstream's releases. This fork's version is ahead of upstream's, so an upstream release either never registered as newer or — once upstream overtakes this version number — would have offered users a download containing none of this fork's features, which installing would overwrite. It now checks this fork's own releases. "Report a bug" in the Help menu likewise pointed at upstream's issue tracker, which cannot act on code it does not have.

##### Optimizations & Stability

- Budget the rendered-page blob cache in bytes rather than in pages. Pages are encoded to PNG at `compressionLevel: 0`, which is essentially raw — a 1280px page measures 6.63MB — and the rendered width is `originalWidth * scale * devicePixelRatio` capped by `renderMaxWidth`, which defaults to **12000**. Keeping "24 to 48 pages" therefore meant anywhere from ~160MB at a normal window size to several gigabytes on a HiDPI display or when zoomed in, with nothing in the reader aware of the difference. The count limits are unchanged and still bind at normal page sizes; the byte budget (256MB, 384MB in scroll view) only takes over when pages are genuinely large, which is exactly what the count could not see. Eviction now continues until both budgets are satisfied instead of dropping a fixed number of entries, since one oversized page can exceed the budget on its own.
- Read and extract CBZ archives in-process instead of spawning 7-Zip. A CBZ is a ZIP whose images are almost always STOREd rather than deflated, so a page is a plain byte range — but listing an archive and pulling a page each spawned a `7z.exe` subprocess. Measured standalone on a 279MB / 192-page CBZ: listing **420ms to 23ms (18x)**, single page **126ms to 14ms (9x)**, full page-to-1280px-JPEG pipeline **281ms to 174ms**. Only ZIP-family archives take this path, and any failure (encrypted entries, unusual variants, malformed archives) falls back to the existing 7-Zip implementation, so CBR/CB7/RAR are untouched.
- Load only the modules needed to paint the library at startup, and pull the rest in lazily once the UI is up. The renderer previously `require`d its entire module graph synchronously before the document was even parsed — including sharp, the AI runtime, epubjs/foliate-js and the whole remote-server stack (`@aws-sdk/client-s3`, `ssh2`, `smb2`, `webdav`, `basic-ftp`) — so every one of those was time spent staring at an empty window. Measured on a packaged x64 build (warm, same machine): **time to `dom-ready` went from 5.5–8.0s down to ~0.65s**. The deferred modules are then warmed in the background during idle time so the first action needing one does not pay for it.
- Stop rebuilding the whole library page every few seconds while AniList metadata is being scraped. Each refresh was a full `dom.reload()`, which also resets the thumbnail queue, so on a large library thumbnails restarted from scratch over and over and the page kept being torn down underneath the user. The refresh is now deferred until the scrape queue drains, then applied once.
- Build the library box/recommendation candidate list once per render instead of four times (Continue reading, Recommended, Recently added and the ranking sidebar each rebuilt it independently), and cache the per-folder filesystem timestamps it needs. Measured on a 234-folder library this cut a library render from ~1,872 synchronous filesystem calls and ~82ms of blocking work down to 0 calls and ~8ms once warm.
- Remove the periodic `webFrame.clearCache()` memory sweep. It dropped Chromium's entire resource cache — including every decoded page image — forcing the reader to re-read and re-decode whatever was still on screen, which showed up as a recurring stall. The remaining idle garbage collection now also skips running during an active reading session.
- Fix PDF render thrashing: the reader queued 10 pages before and 10 after every turn while only keeping 3–4 rendered pages alive, so most of that expensive rasterisation was evicted before it could ever be shown and had to be redone on the next turn. The prefetch window and the blob budget are now sized consistently (3 before / 6 after, 12–16 kept).
- Reduce per-page-turn work: image source priming was a symmetric 10-before/10-after window, i.e. up to 21 lookups and decodes on every turn, mostly for pages already behind the reader. It is now asymmetric and much smaller.
- Reduce eager image decoding in webtoon/scroll mode from ~10 screens of lookahead to ~3, cutting both decode time and resident bitmap memory.
- Stop the background thumbnail warm-up from competing with the reader: it now pauses entirely while reading, ticks less often, and uses smaller batches and a smaller share of the worker pool.
- Avoid re-walking every `<img>` in the document once per evicted blob when trimming rendered page blobs.
- Stop deleting the archive index and re-listing the whole file on every next/prev chapter change. This was a workaround for the single-page bug above; with the root cause fixed, chapter navigation reuses the cached index again.
- Add opt-in window startup phase timings (`ready-to-show` / `dom-ready` / `did-finish-load`) to the startup log to make a slow, blank first paint diagnosable.
- Reduce renderer console noise from startup timing, EPUB pagination and tracking metadata debug logging left enabled by default; these are now opt-in via environment variables.
- Harden folder-thumbnail scrolling and warmup against running while the library view is mid-transition.
- Harden the settings storage schema so recommendation feedback and sample-deletion state survive future updates.

##### Packaging

- Fix installed Windows x64 builds failing to start with `Could not load the "sharp" module using the win32-x64 runtime`, followed by a cascading `ReferenceError: shortcuts is not defined`. Only `@img/sharp-win32-arm64` was present in `node_modules`, so the x64 build shipped without a usable sharp binary; the second error was collateral, because the failed `require` aborts the renderer's global import chain and leaves every later global unassigned.
- Add `npm run sharp-native` (`scripts/sharp-install-native.js`) and run it before every Windows build target. npm only ever installs the sharp binary matching the build machine's own CPU, and installing another architecture prunes the previous one — but a single `node_modules` is used to produce both the x64 and arm64 installers, so one of them silently shipped an unusable sharp. The script installs every architecture sharp declares for the current OS, reading the versions from sharp's own `optionalDependencies` so it cannot drift when sharp is upgraded (a mismatched version is its own failure, since the bundled libvips DLL is named after the libvips version).
- Fix `templates/guides.html` being excluded from packaged builds, which broke Help > Guides in every installed build (the file is loaded from disk at runtime, unlike the other guide templates which are compiled into the template bundle).
- Point the package metadata at this fork: `repository`, `homepage` and a new `bugs` URL, all of which still referenced upstream. `build.buildVersion` was also left at `1.7.7` while the package version had moved to `1.8.1`, so installers reported a build version two releases behind the app they contained.
- Credit the fork maintainer in `contributors` rather than replacing the `author`, so the About window keeps naming Oleguer Llopart as copyright holder and adds "contributed by" underneath. The GPL-3 link in that window now points at this repository's own copy of the licence, which is the one the build ships.

##### Documentation

- Rewrite README.md for this fork: state that it is a fork of ollm/OpenComic, add a "Fork additions" section covering the AniList metadata and automatic per-series reading modes, home sections, recommendation feedback, tutorial, rename and the full power-search syntax, and move the tutorial/saved-search entries out of the upstream feature list where they did not belong.
- Restructure README.md around what a visitor actually asks first: a "Why this fork" section and a grouped "What's new since v1.7.0" now come before the upstream feature list, with a Performance section carrying the measured before/after numbers and their measurement conditions.
- Correct the Download section, which advertised upstream v1.7.7 binaries as if they were this fork's builds.
- Document all Windows build targets and add a troubleshooting section for the sharp native binary and `npm run sharp-native`.

##### Bug Fixes


- Fix AI-processed images not displaying in reader by implementing proper cache bypass logic: when AI output is available, skip cached PDF blob URLs that would overwrite the AI-processed result.
- Fix AI image quality regression where AI-processed pages displayed blurry by applying CSS-based `imageRendering` scaling kernels to AI images immediately upon loading, ensuring proper interpolation (upscaling/downscaling) is applied consistent with normal rendering.
- Fix page rendering control flow issue where AI images routed through `srcToImage()` would skip downstream CSS scaling code blocks, preventing interpolation kernels from being applied.
- Fix Continue Reading bookmark entries limiting navigation to a single chapter by ensuring `mainPath` is correctly passed from the reading session, allowing next/prev chapter navigation to work properly when opened from bookmarks.
- Fix series type detection in AniList-backed reading defaults by using AniList series type instead of confidence scores.
- Fix looping during continuous scrolling by preventing the scroll reader from re-entering the same navigation state.
- Fix temporary-file cleanup by reloading the app after clearing temp files so all transient files are removed.

##### Optimizations & Stability

- Improve AI rendering pipeline robustness by consolidating AI image handling to ensure CSS-based scaling is applied uniformly across all imageRendering modes.
- Add AI render diagnostics for scale and image dimensions to help trace blur and upscaling mismatches.

##### Packaging

- Build the Windows installer with the NSIS target for the v1.8.0 release.

## v1.7.7 (25-03-2026)

##### New Features

- Add rich folder metadata header in Continue Reading pages (series title, subname, genres as clickable chips, and description).
- Improve Continue Reading presentation with updated card/list styling and better metadata prominence.
- Add AniList-format-aware reading defaults per tracked series folder: manga now defaults to manga reading + double page, while manhwa/manhua now default to webtoon reading.
- Add per-series folder reading-mode memory so each series keeps its own last-used reading options instead of sharing one global state across different titles.
- Add power-user library search syntax with field filters (`author:`, `genre:`, `status:`, `tag:`, `label:`, `source:`, `type:`), numeric comparisons (`rating`, `year`, `confidence`, `progress`, `reading time`), keyword tokens (`unread`, `reading`, `read`, `favorite`, `tracked`) and negation.
- Add saved searches in the search overlay with one-click save/remove actions and quick recall from the suggestion list.

##### Bug Fixes

- Fix cache/temporary clear not fully resetting session data: now clears Continue Reading/recommendation-related state, tracked folder metadata, reading progress/pages, recents, and stored comics paths.
- Fix stale template rendering after storage cleanup by flushing template/theme caches during temporary file cleanup.
- Fix intermittent unstyled Continue Reading/metadata area after cleanup by hardening theme stylesheet reload/re-attachment logic.
- Fix critical CSS parse break in theme styles caused by malformed `.content-view-module-* .v-img img` blocks; this restored later CSS rules (including Continue Reading and folder metadata styles) from being ignored.
- Fix grid-size slider regressions where module-card frames resized but cover images and folder poster slots did not scale with them.
- Fix preloaded library card covers using raw local file paths instead of the same encoded image path flow used by async thumbnail updates, which could leave cards stuck on broken-image placeholders.
- Fix folder poster placeholder binding in module cards (`poster.sha` vs `sha`) that prevented async thumbnail updates from reaching the correct DOM node.
- Fix persistent blank folder thumbnails while scrolling by hardening virtualized queue state transitions and allowing proper retry when background jobs are interrupted.
- Fix repeated broken-image requests from empty module-card `img src` placeholders by avoiding empty `src` emission until a real thumbnail path exists.
- Fix thumbnail fallback instability when image resize fails (e.g. malformed JPEG): fallback now stores a stable cache file path instead of relying on transient temp paths.
- Fix reader preload starvation where focus changes repeatedly cleared the render queue, causing near-future pages to stay blank while scrolling/turning pages.
- Fix intermittent next-page blank states by deduplicating in-flight page renders and reliably clearing render-in-progress flags after completion/failure.
- Fix insufficient nearby prefetching by enforcing a symmetric around-focus preload window (at least 10 pages before and 10 pages after) in reading queues.
- Fix AniList tracked-series reading defaults being skipped when a folder had saved reading config with only unrelated overrides; defaults now still apply unless reading mode was explicitly customized.
- Fix hidden top-bar center toggle not triggering in webtoon/scroll reading so the same center tap/click zone works across all reading modes.
- Fix webtoon center-zone cursor feedback/hit-area mismatch by aligning pointer-hover geometry with the same effective area used in other reading modes.
- Fix duplicated/unclean search history entries by normalizing and de-duplicating saved recent-search terms.
- Fix Settings > Shortcuts occasionally appearing empty by hardening tab content regeneration and container checks during tab activation.
- Fix tutorial step progression race conditions when opening Pepper & Carrot and Episode 1 by improving async state detection and step auto-routing.
- Fix tutorial overlay/dialog disappearing or appearing off-screen when step targets are temporarily hidden during tab/view transitions.
- Fix tutorial getting stuck around the hidden top-bar onboarding by adding an explicit center-zone guidance card and non-blocking progression behavior.
- Fix Pepper & Carrot bundled sample memory across startup and temporary-file cleanup, while preserving explicit user deletion intent unless manually re-added.
- Fix scroll reading line-preservation state typo (`heigth` -> `height`) that could cause unstable position restoration.
- Fix chapter-skip/touch-hover timer callbacks using string-based timeouts, preventing brittle runtime behavior with escaped path/code strings.
- Fix eval-based click execution in random pick, OPDS context, and gamepad back navigation paths by dispatching native click handlers directly.

##### Optimizations & Stability

- Harden renderer startup stylesheet path handling for `theme.css` to reduce stale stylesheet state after cache/temp operations.
- Add safer fallback behavior around theme stylesheet availability after cleanup and reload.
- Improve thumbnail queue robustness for large folders with background warmup loading, visible-card self-healing requeue, and in-folder poster rehydration while browsing.
- Add thumbnail load recovery for library cards so visible broken posters/covers clear bad `src` state, invalidate stale folder thumbnail cache entries when needed, and automatically requeue/regenerate with throttled retries.
- Improve module-view virtualization accuracy after resize/style drift by calculating visible ranges from live DOM geometry instead of only fixed size presets.
- Improve image resize resilience for corrupted JPEG streams by using safer Sharp retry options (`sequentialRead`, tolerant retries with `failOn: none`).
- Improve reading smoothness on large chapters/PDFs with stronger source priming and queue stability changes that reduce visible loading gaps without increasing startup overhead.
- Improve page-turn responsiveness in non-scroll reading modes by prioritizing an immediate near-page render window and deferring wider prefetch so stale jobs no longer block the next page.
- Improve rapid page-turn smoothness by coalescing queued transition requests and applying adaptive shorter transition durations during high-speed navigation input.
- Improve end-of-chapter handoff smoothness by preloading first pages of the next inferred chapter after a short idle delay, with cancellation guards and bounded preload tracking.
- Improve tutorial resilience with fail-safe cleanup/snackbar behavior when a step render throws, preventing stuck dark-overlay states.
- Improve runtime safety by replacing active string-evaluated timeout callbacks with direct function callbacks in reading/events flows.

## v1.7.6 (05-03-2026)

##### New Features

- Added a tutorial.
- Add horizontal scrollbar to Continue Reading, Recommended for You, and Recently Added boxes so all series are accessible regardless of window size.
- Increase maximum items displayed in box sections from 6 to 20.
- Replace Material Icon thumbs up/down feedback buttons with emoji equivalents (👍/👎) and remove button background styling.
- Add internal ranking sidebar (toggleable from library options) showing AniList rating, personal likes/dislikes, and a final weighted score.
- Add recommendation feedback press animations and persistent visual button state.

##### Bug Fixes

- Fix recently opened tracking not updating when browsing manga from the library (only worked via File > Open).
- Fix Recents showing only the parent folder instead of the actual file (e.g. compressed manga) that was opened.
- Fix Continue Reading showing the last-read manga from a different folder; it now only appears if a manga from the current folder has been read.
- Fix Continue Reading box showing parent category folder name instead of the actual manga series name.
- Fix Continue Reading progress not being saved for series accessed via compressed files (cbz/cbr).
- Fix ENOENT errors caused by stale stored paths after renaming manga files.
- Fix blank thumbnails in Continue Reading when cached poster references a renamed/missing compressed file; stale cache entries are now automatically invalidated.
- Fix author name (`v-secondary-text`) not being centered for grid sizes 200, 250, and 300.
- Fix visible text overflow (partial 3rd line) between title and author name in box item cards.
- Fix "Set image as poster" failing with a generic "Error" snackbar; added proper error handling and try/catch around the poster-setting flow.
- Fix folder thumbnails not updating after setting a new poster or clearing file cache; folder thumbnail cache is now invalidated so the new poster takes effect immediately.
- Fix cover images (e.g. `cover.jpg`) in manga folders being ignored when a stale cached thumbnail from inside a compressed/PDF file existed; cache is now invalidated when a cover image is detected in the folder.
- Fix `.tbn` poster files (created by "Set as poster") not being picked up as folder thumbnails.
- Adjust folder poster thumbnails to avoid over-zoomed image display in library cards.
- Fix recommendation feedback buttons visibility/placement across all module sizes and scale thumbs with card size.
- Fix dislike behavior to remove only the selected recommendation card instead of reloading the entire recommendation section.
- Fix recommendation repetition by adding anti-repeat rotation logic so reloads no longer keep showing the same set.
- Fix top-box card sizing to use the same module-size path as library cards for consistent thumbnail sizing.

##### Optimizations & Stability

- Add AniList rating display (`averageScore`) in tracking search/current-tracking dialogs and in top metadata cards.
- Add metadata backfill logic to rescrape AniList data when older tracked entries are missing rating.
- Fix crashes in file-info metadata parsing when non-string values are passed to comma-separated parsing logic.
- Add end-to-end EPUB debug instrumentation across reading, file-manager, and EPUB modules to isolate open/read/pagination stages.
- Prioritize local extracted chapter HTML reads in EPUB chapter loading and reduce dependency on fragile section URL fetches.
- Updated the Guide.
- Improve recommendation scoring robustness: normalize feedback counters/paths, apply fairness bonus for heavily disliked series, suppress series after 200 dislikes, and prompt user with a delete dialog when threshold is reached.

## v1.7.5 (04-03-2026)

##### Bug Fixes

- Fix Continue Reading and Recently Added boxes showing category/container folders (e.g. "3 Reading", "4 Yet to Read Series") instead of — or alongside — the actual manga inside them. Only items with direct tracking metadata or non-folder content are now included.
- Fix duplicate box sections (multiple "Continue reading", "Recommended for you", "Recently added" blocks) appearing when concurrent page-load calls raced during async thumbnail fetching. Added a per-variant dedup guard in the box builder and `contentRightIndex` abort checks between each box call.

## v1.7.5 (04-03-2026)

##### New Features

- Add a dedicated genre filter menu in Library and Recently opened (including gamepad menu), using tracked metadata genres instead of opening the text search overlay from the filter icon.
- Expand recommendation generation to use the full indexed tracking metadata pool, so "Recommended for you" can still appear even when the current page has no directly tracked manga items.

##### Bug Fixes

- Fix missing thumbnails in metadata-backed recommendation cards by forcing thumbnail/poster resolution when cards do not have preloaded images.
- Restore recommendation feedback controls (thumbs up / thumbs down) in the "Recommended for you" section and persist feedback to recommendation scoring.
- Restore author/subname visibility in recommendation cards generated from indexed metadata fallback entries.
- Fix metadata description/top-info genre display to show all available genres (remove previous 3-genre cap).

## v1.7.1 (02-03-2026)

##### New Features

- Add a renaming option in the right-click context menu for manga folders/files.
- Folder rename now updates only the cached display name in the app (does not rename system folders).
- Add a right-click option to delete custom catalog tabs.

- Tracking improvements: prefer chapter/volume detected by the reader and suggest series title from the parent folder when prompting to track.
- Manual tracking override: require holding Ctrl/Cmd/Shift while confirming to allow lowering remote progress; dialog shows an explicit hint.

- AniList tracker enhancements: search results now display with an "Open on site" globe icon for direct access; search defaults to a new page when tracking a new manga.

##### Optimizations & Stability

- Reduce installer and application package size by excluding build output directories.
- Optimize folder thumbnail selection to avoid scanning all files, prioritizing `cover` image files and first-page thumbnail fallbacks.
- Improve cache/thumbnail extraction resilience to reduce UI stalls and repeated background failures.

- AniList integration: added a rate-limited GraphQL wrapper with exponential backoff and retries to reduce 429 (Too Many Requests) errors.
- AniList search: abortable requests, in-session search cache for faster UI updates, improved error handling for search result rendering, and enhanced search result interactivity.
- Fixed a recursion bug in the AniList GraphQL helper that could prevent search results from rendering.

## v1.7.0 (01-03-2026)

##### 🚀 New Features

- Categorize AI Models in the UI context menus as "Power Efficient", "Balanced", and "Quality" modes for better UX.
- Option in Settings to wipe permanent 0/1 page states from the library (Cache Clear).
- Support for multiple instances (Open multiple OpenComic windows) [`bbf6f56`](https://github.com/ollm/OpenComic/commit/bbf6f56f282d51379b26e2a64b50c3f80846dfad)
- Add option to open files from outside OpenComic in a new window [`906a5b7`](https://github.com/ollm/OpenComic/commit/906a5b758685e0df2d67102856c1f3f74c53760c)
- Add setting to use a custom folder for cache and temporary files [`5b7a3a1`](https://github.com/ollm/OpenComic/commit/5b7a3a150d65eef9ed92b4265c72818c30a29ec9)
- AI image upscaling tool [`566295e`](https://github.com/ollm/OpenComic/commit/566295e86c3ecd0af95b022ddf7fbeab9ce7477d)
- AI image descreen tool [`aa88777`](https://github.com/ollm/OpenComic/commit/aa88777d5a57c1e8819bed8284d844b3b05fdaf1)
- AI image artifact removal tool [`f27e851`](https://github.com/ollm/OpenComic/commit/f27e85168f485d1e0a904fbd3b87d0345fbdf96e)
- Cache the folder's thumbnails/poster file lists to reduce disk I/O [`01a962b`](https://github.com/ollm/OpenComic/commit/01a962bd245ce1ad427fcca8e1c547e531bee0b1)
- Hide file extension by default [`ad33247`](https://github.com/ollm/OpenComic/commit/ad332470f47b1f110f22ee85a4384f75a19bce99)
- Support playing background music on a specific page [`23aae8a`](https://github.com/ollm/OpenComic/commit/23aae8abdc8c1bd983411f0f9eeac974218694fa)
- Options in OPDS to auto-download files from the catalog [`594d69f`](https://github.com/ollm/OpenComic/commit/594d69f81e3740c0be32e284dac3aed1aba69de9)
- Support for tabs [`d9f7fa0`](https://github.com/ollm/OpenComic/commit/d9f7fa048b743c918c44e077e0bae08705e7b8c0)

##### �️ Optimizations & Stability

- Disabled recursive deep-search indexing for compressed archives (ZIP/CBZ/PDF) to prevent extreme lag and memory crashes during library searches.
- Implemented robust auto-recovery/retry logic for PDF.js worker collisions, resolving "Invalid page request" and "Worker destroyed" crashes during concurrent background processing.
- Optimized RAM management by preventing redundant extraction of PDF files inside other archives.
- Suppressed background file-lock errors (EPERM/ENOENT) during rapid folder navigation.

##### �🐛 Bug Fixes

- Fixed a bug where single-page PDF thumbnails were incorrectly cached as full documents, causing reading view to stick on page 1.
- Adding or changing poster not working when the drive is different from the system drive [`8ce3d5f`](https://github.com/ollm/OpenComic/commit/8ce3d5f01a7694c26fa1e6d477c1eab99c299a0e)
- Hiding cursor in fullscreen mode fails in some cases [`828d504`](https://github.com/ollm/OpenComic/commit/828d504e700e43ab1f6d9e5081195ad496f65920)
- Save/Copy uses the image under the mouse cursor instead of the active page [`26c5923`](https://github.com/ollm/OpenComic/commit/26c5923d5dc920b691be5db591c20b8b92d9f320)
- Error saving the progress of the final page in epub files [`ff42c18`](https://github.com/ollm/OpenComic/commit/ff42c181e7a6a324ef1065c836dc0ed175e1b623)
- Prevent crash when retrieving metadata with Sharp for many large images (Linux only) [`d5616d8`](https://github.com/ollm/OpenComic/commit/d5616d86bd38841e02bf70d4a2e2502063c45328)
- Extract files when the file in it starts with the '-' character [`3806516`](https://github.com/ollm/OpenComic/commit/38065169d0a7583a7543154fad44351af221a23c)
- Use reading sort for thumbnail/poster generation [`cca841e`](https://github.com/ollm/OpenComic/commit/cca841e3eacc88b60ca55d619a5f67beeef7f646)

## [v1.6.5](https://github.com/ollm/OpenComic/releases/tag/v1.6.5) (31-10-2025)

##### 🚀 New Features

- Go prev/next chapter with auto-scroll (Moving the cursor in the middle of the screen) [`d9dfaa0`](https://github.com/ollm/OpenComic/commit/d9dfaa0e609cd268c7bec459646d09da634b8805)

##### 🐛 Bug Fixes

- Cancelling prev/next chapter breaks the magnifier tool [`d851178`](https://github.com/ollm/OpenComic/commit/d8511789dbb63f2cf0b3ef043dca2619d1e6ed60)
- Downgrade Electron to 37.8.0 to fix font rendering issues on Linux [`fbdff55`](https://github.com/ollm/OpenComic/commit/fbdff5543cc8b120aa518a31b00c200e801128f4)

## [v1.6.4](https://github.com/ollm/OpenComic/releases/tag/v1.6.4) (11-10-2025)

##### 🐛 Bug Fixes

- Downgrade Electron to 38.0.0 to resolve Linux release freezes on Wayland [`43a6e85`](https://github.com/ollm/OpenComic/commit/43a6e8575d2720a7592a7b2975d2876a942fc872)

## [v1.6.3](https://github.com/ollm/OpenComic/releases/tag/v1.6.3) (07-10-2025)

##### 🐛 Bug Fixes

- Add error handling for reading progress in comic context menu [`b3a6bbf`](https://github.com/ollm/OpenComic/commit/b3a6bbf012beaca669839594675c8faac55d8085)
- Error handling for corrupted JSON/ZSTD files in cache and remove them [`978e281`](https://github.com/ollm/OpenComic/commit/978e281cca7c6b7e6aff78357a15275ea7fc746b)
- Header bar buttons don't register start/end of chapter if scrolled with scrollbar [`b9cb5ea`](https://github.com/ollm/OpenComic/commit/b9cb5ea8d034fbca72c53212bc5faf9f144a879d)
- Asynchronous progress check in the context menu (Mark as read/unread) [`ca51b12`](https://github.com/ollm/OpenComic/commit/ca51b122372c89b4414572b31f7bf05ac7800c22)
- The application loops and freezes when opening files on the network (UNC paths) [`7ca4d20`](https://github.com/ollm/OpenComic/commit/7ca4d200730d5b2814e24cad4b34969ab38a2857)
- Prevent concurrent reads of the same file [`cefa1c5`](https://github.com/ollm/OpenComic/commit/cefa1c552309a27e04ec6c6c5b7d2549028eeed5)
- Memory leak in blob files when browsing extremely quickly while reading [`ccdcdbc`](https://github.com/ollm/OpenComic/commit/ccdcdbc7194e3703c16f0ae5c979f1947d3b7517)
- TypeError by ensuring countries is an array [`4fb987d`](https://github.com/ollm/OpenComic/commit/4fb987d50d299d8b5c58a979f35eaef11e4c3be0)
- High memory usage on Linux due to a compatibility issue between Sharp and Electron [`2bf74ee`](https://github.com/ollm/OpenComic/commit/2bf74ee89ad68fcbd4ca8855b9f80a1be45cdf0f)
- Incorrect page is being set as a poster in manga mode [`3e90c82`](https://github.com/ollm/OpenComic/commit/3e90c82b47f80d0e804987f43d60c6a1d08fa0eb)
- Image breaks sometimes in PDF render [`a184b0c`](https://github.com/ollm/OpenComic/commit/a184b0c54376d0f5bc8b95265e71a9c3aeed41c8)

## [v1.6.2](https://github.com/ollm/OpenComic/releases/tag/v1.6.2) (08-09-2025)

##### 🚀 New Features

- Option to change labels from app bar [`bea5b5c`](https://github.com/ollm/OpenComic/commit/bea5b5cbd7c8785c56624b7d16192aa23050eb4f)
- Context menu in continue reading bar [`b2637c2`](https://github.com/ollm/OpenComic/commit/b2637c26cad23f421f86374f24d8013e67432fd5)
- Support multi-layer folder labeling in servers [`3eeabc5`](https://github.com/ollm/OpenComic/commit/3eeabc552930fa34f405843a51622122d449d0d3)

##### 🐛 Bug Fixes

- Prevent app freeze when relative path receives undefined value [`2d9cca5`](https://github.com/ollm/OpenComic/commit/2d9cca5581fac5f8818bf5b0f008ae68b50d31d5)
- Error on start directly in last reading [`9c20ba0`](https://github.com/ollm/OpenComic/commit/9c20ba00b1ed69ea5897ef01f11898ce4300d4e7)

## [v1.6.1](https://github.com/ollm/OpenComic/releases/tag/v1.6.1) (26-08-2025)

##### 🚀 New Features

- Extract tracking chapter/volume also from image names [`2218bfb`](https://github.com/ollm/OpenComic/commit/2218bfbb76f14fb5c53414ddef489a16198914d5)
- Tracking also by current page/image chapter/volume [`5ff5932`](https://github.com/ollm/OpenComic/commit/5ff59327b1ea7f2c8cc76d228bcf7ca27e9da702)
- Pick at random button [`6423fe9`](https://github.com/ollm/OpenComic/commit/6423fe93ea8cef5624a8ad97a61ff599d58688f0)
- Separate order of browsing and reading [`e08faea`](https://github.com/ollm/OpenComic/commit/e08faea31038fc51c207a940d853734a45b32c7a)
- Sort option to list compressed files first, separated from folders [`508fd1a`](https://github.com/ollm/OpenComic/commit/508fd1aa1886f11aee0ca6559754200d312da706)
- Auto-prompt to track [`30608da`](https://github.com/ollm/OpenComic/commit/30608da602868c9e8c2ea2d528868c9b6464fc61)
- Improve relative path support for folder portable [`0e3b2a8`](https://github.com/ollm/OpenComic/commit/0e3b2a8799daa1e4ae3a53e7fe205990d953266d)

##### 🐛 Bug Fixes

- Show page number doesn't work properly on scroll reading [`c72814b`](https://github.com/ollm/OpenComic/commit/c72814bcb6508646ec2abf669b191cf266ee75f7)
- Some tap zones events not working [`225de43`](https://github.com/ollm/OpenComic/commit/225de437284d4db2b10b5a42bd90ddfe8711c001)
- Thumbnails and progress missing when filtering current page [`beb5f90`](https://github.com/ollm/OpenComic/commit/beb5f908deb81606269aff9a6b041e7511006a2e)
- Rare cases of blank images during reading [`e1f27b3`](https://github.com/ollm/OpenComic/commit/e1f27b315bc9023e35c7ea52122d3c918564f5e3)
- Show magnifying glass instantaneous when enabled from shortcuts [`43bc73d`](https://github.com/ollm/OpenComic/commit/43bc73dcf85d80e756f1b674a64c66c7ce75529c)
- goBack not working if OpenComic starts directly on reading [`2f6e2fc`](https://github.com/ollm/OpenComic/commit/2f6e2fc0ccb6d6d22eaa2c543a87d3a8b91bfc46)
- Error on migrating some config [`3b4e1ce`](https://github.com/ollm/OpenComic/commit/3b4e1ceb8c167bb76a7355a4085a09e2173c520d)
- Server connections do not work in some cases on Windows [`65ecdf6`](https://github.com/ollm/OpenComic/commit/65ecdf6e5ef94170cce3ebcf0062fd2b3ebac2fe)
- Some compressed files wouldn't open from the servers [`b1c7aef`](https://github.com/ollm/OpenComic/commit/b1c7aef929666ebe0f8b5283cdb8bde19051ba91)

## [v1.6.0](https://github.com/ollm/OpenComic/releases/tag/v1.6.0) (27-07-2025)

##### 🚀 New Features

- Allow disabling `Do not enlarge more than its original size` in Webtoon mode [`7519ac5`](https://github.com/ollm/OpenComic/commit/7519ac5cd0ac4407a4d0edec7e7a3e2a76832f84)
- Improved rotation and support for rotating in PDF [`cb90771`](https://github.com/ollm/OpenComic/commit/cb907714ca7d713bcbf3471564e48a3e67c8ca40)
- PDFs are rendered to a blob image instead of a canvas [`554c1ef`](https://github.com/ollm/OpenComic/commit/554c1ef88adf358acae14f9bf28f0e1f4f626d8f)
- Optimized sidebar thumbnails [`02b67c6`](https://github.com/ollm/OpenComic/commit/02b67c620b6b13810c778beca1052a9b28829548)
- Support Discord Rich Presence [`a19f9eb`](https://github.com/ollm/OpenComic/commit/a19f9eb6dd99350037b7c77f14e706223256af4c)
- Get Calibre `series` and `series_index` metadata in PDF and ePub [`da739de`](https://github.com/ollm/OpenComic/commit/da739ded8ff1cdbc2b5da39662e85e725cd71545)
- Increase and decrease horizontal margin shortcuts [`0bae05f`](https://github.com/ollm/OpenComic/commit/0bae05f210018120b56210797cd5850e13254aa9)
- Use single thread in HDD extractions [`a4874a6`](https://github.com/ollm/OpenComic/commit/a4874a6d5b92d29df845625ddfc45e2f7a95f82b)
- Auto-hide mouse cursor in fullscreen mode [`fbfa9f8`](https://github.com/ollm/OpenComic/commit/fbfa9f88c225ee2125535efaa6332d1e1b45d55e)
- Show progress bar, pages and percentage in library/browsing [`d0002d9`](https://github.com/ollm/OpenComic/commit/d0002d9da5b27543fe4702b273240093975ad8f4)
- Progressive thumbnail/progress generation based on scroll position [`1d22f22`](https://github.com/ollm/OpenComic/commit/1d22f2290e81785f3c785af9d2eef132cea2935f)
- Option to mark as read and unread [`82ae5ef`](https://github.com/ollm/OpenComic/commit/82ae5ef7e24afc47a6e817b6df5ef6d81099eeb5)
- Option to show page number in the top right-hand corner [`35e44c6`](https://github.com/ollm/OpenComic/commit/35e44c6e271e545a09de4f66ecd0bd289e217447)
- Add support for labels in master folders (auto config only) [`50e42cd`](https://github.com/ollm/OpenComic/commit/50e42cd27b8127ed63e07f008d15279639cd1c7b)
- Option to show shadow effect between pages in double page mode [`5bfee80`](https://github.com/ollm/OpenComic/commit/5bfee8068b4e45d6817e610c8c35fb175262f5bb)

##### 🐛 Bug Fixes

- Error opening files from the system file explorer [`cecc15d`](https://github.com/ollm/OpenComic/commit/cecc15d44c15545fddb932ee87d99213015f295e)
- Invert tap zones in manga reading [`08a4d10`](https://github.com/ollm/OpenComic/commit/08a4d10115b4687631bd23695d2accff7933ba81)
- Error opening an OPDS Catalog [`d80c2da`](https://github.com/ollm/OpenComic/commit/d80c2dae6f18f3244aa17805f04bbb852181e112)
- Correct support Komga OPDS server [`0ae69bf`](https://github.com/ollm/OpenComic/commit/0ae69bf29612ef667cf944bf07ab8e7e488fd60c)
- Some mime types are not correct detected [`baa8397`](https://github.com/ollm/OpenComic/commit/baa8397da5f33b5129607bbcc368c4eb782bc4e9)
- Update electron to fix white lines in Webtoon mode [`2b98eb3`](https://github.com/ollm/OpenComic/commit/2b98eb3af7c1651149063e6176a5ae7e6b3d1c81)
- Navigation back not working with shortcuts and gamepad [`ba8641f`](https://github.com/ollm/OpenComic/commit/ba8641f96ed3c8bdef8e35ce98af55b7e6d10bc8)
- Correct invert some shortcuts in manga reading [`208fee6`](https://github.com/ollm/OpenComic/commit/208fee6d48c1dab69b131e45f997326323ac8625)
- Optimized poster handling in file image retrieval [`53b5c42`](https://github.com/ollm/OpenComic/commit/53b5c42ee98ade28ad72c492bd9f6e67b119cd50)
- Do not use the ignore pattern when searching for poster/images [`7b52b28`](https://github.com/ollm/OpenComic/commit/7b52b28952cf2b6140541087c88e6278de32824c)

## [v1.5.0](https://github.com/ollm/OpenComic/releases/tag/v1.5.0) (19-06-2025)

##### 🚀 New Features

- Improve chapter detection in tracking [`ad05a23`](https://github.com/ollm/OpenComic/commit/ad05a2364882227688cccfa2fdf58a21f8e9615c)
- Support for `JP2` image format [`e11046b`](https://github.com/ollm/OpenComic/commit/e11046b4eca758f8b15c1caeb831a235a5f3d62c)
- Support for `JXR` image format [`0e24922`](https://github.com/ollm/OpenComic/commit/0e2492264e1dbc94126c7d79e3e3c50fc426846c)
- Support for `JXL` image format [`bd6fb0a`](https://github.com/ollm/OpenComic/commit/bd6fb0a8c8be3685b48c88fa21bbe2d3c384a491)
- Thumbnail generation speed has been improved [`155f064`](https://github.com/ollm/OpenComic/commit/155f064b4c9716c050a6231e44323169686997ea)
- Support for `HEIC` image format [`4f4b5a1`](https://github.com/ollm/OpenComic/commit/4f4b5a16572ea2bd5aff2e519d473b42d80312fb)
- Option to apply configuration profile based on folder/file label [`71d9ff5`](https://github.com/ollm/OpenComic/commit/71d9ff5655f934e4d710e1833b081e4fddf8d428)
- Option to disable `Align with next horizontal` when reading on double page [`97d8ecd`](https://github.com/ollm/OpenComic/commit/97d8ecdde04c2a5c418440d8fbbf06496b16c8ba)
- Option in setting to adjust gamepad sensitivity [`f309c27`](https://github.com/ollm/OpenComic/commit/f309c27195ccf91b0d20600c06f1af03deee5611)
- Copy image to clipboard [`bb96cef`](https://github.com/ollm/OpenComic/commit/bb96cef97ee1783fc27f3600548a91bb37a96045)
- OPDS support [`b72f32f`](https://github.com/ollm/OpenComic/commit/b72f32f2445b90f13f5e2cc45865c2c17a72af82)
- Button to enable/disable full screen from the more options menu [`5d2ac36`](https://github.com/ollm/OpenComic/commit/5d2ac367c61da97d04cd67526470fb7885c1b3bf)
- Show package versions in About OpenComic [`888d9ba`](https://github.com/ollm/OpenComic/commit/888d9ba2e23241b1868b6a360e7bca1a0bef9586)
- Custom mouse wheel shortcuts [`1db0fc7`](https://github.com/ollm/OpenComic/commit/1db0fc7721e33e0e423f0b57590fd65b80cd5df7)
- Option to configure mouse wheel sensitivity when zooming [`8a80d0a`](https://github.com/ollm/OpenComic/commit/8a80d0acee57daa693ae7029c3f48127958b6a79)
- Option to ignore files and folders that match Regex or File pattern [`670bced`](https://github.com/ollm/OpenComic/commit/670bced3ed7413145119b401f974e15ea482ddf5)
- Authentication support for OPDS (Basic and Digest) [`11c3aa8`](https://github.com/ollm/OpenComic/commit/11c3aa88efbff8adcc3fabbf4b066dcb7120b10a)
- Use safeStorage for passwords and tokens [`6178ded`](https://github.com/ollm/OpenComic/commit/6178dedf1afe13c56b68bd3bd68010d80d30fdc6)
- Change extraction of `RAR` and `TAR` to 7zip to improve performance [`c0c2d6d`](https://github.com/ollm/OpenComic/commit/c0c2d6d61016241e70d4ee475e8d19567b8e71db)
- Add suport for compressed `LZH`, `ACE`, `TAR.GZ`, `TAR.XZ`, `TAR.BZIP2` and `TAR.ZSTD` [`e7e7815`](https://github.com/ollm/OpenComic/commit/e7e7815d7a841c02354f9b5219fcdf348c10543b)
- Support compressed files with password [`9a6ef8e`](https://github.com/ollm/OpenComic/commit/9a6ef8e0a363e72e98634e827c50189bb2841047)
- Show release notes in new version dialog [`e572128`](https://github.com/ollm/OpenComic/commit/e572128aecad5811fb2f1a7b1690bbfe1ebabe82)
- Improved extract performance of big files [`5c50739`](https://github.com/ollm/OpenComic/commit/5c507391939c9e56cb1d304df9b3824116de67f4)
- Support MyAnimeList tracking [`5f40b4a`](https://github.com/ollm/OpenComic/commit/5f40b4af1b70e8cfaad0beb79fec676c9c1c83fe)
- Multi-layer folder labeling/favoriting and header bar filter options [`652a6a5`](https://github.com/ollm/OpenComic/commit/652a6a522b32fb9bf77a8dbfebafc0496050c634)
- Option to disable tap zones [`aa7bb3c`](https://github.com/ollm/OpenComic/commit/aa7bb3cc4350616bc527c622be5ed7ddf2d5d611)
- Refactored navigation history logic (`goBack`, `goForward`, etc.) [`a4b6c3d`](https://github.com/ollm/OpenComic/commit/a4b6c3db4fbd447f6c129da1329d05d16b891074)
- Count images/pages in file info if they are not in the metadata [`fdf8eaf`](https://github.com/ollm/OpenComic/commit/fdf8eaf4cb12d6b6b826b12dbe16bd58d7571142)

##### 🐛 Bug Fixes

- Hide toolbar in full screen [`7dbc3c2`](https://github.com/ollm/OpenComic/commit/7dbc3c297f7d92aa209ca8bf901368e47b63e3a3)
- Gamepad menus do not work correctly [`b997d6b`](https://github.com/ollm/OpenComic/commit/b997d6bb6e05c597306169cb4fbbe035a4ab12d1)
- Sharp crashes on Arch Linux and other distributions [`d60620a`](https://github.com/ollm/OpenComic/commit/d60620a2d3a446fef51cd86eff2dc80b22ccf6ba)
- Add cMap support for PDF.js [`3da7b8e`](https://github.com/ollm/OpenComic/commit/3da7b8ec651964209d1df04248dad2bb8ab693bd)
- Page jumps during zoom animation in vertical reading [`d9f94e7`](https://github.com/ollm/OpenComic/commit/d9f94e7eb5e757a28c6b92f0c3a791fc3be61282)
- Stuttering when decode big images (From sync decode to async when possible) [`d320aad`](https://github.com/ollm/OpenComic/commit/d320aad1d95e886d531dcab5721dc44c125cf028)
- Move zoom using cursor after turning a pages not working property [`3012715`](https://github.com/ollm/OpenComic/commit/30127150751b1de611f95069e748eab68fcd2f51)
- Turn page forward in manga mode (Only on non-arrow keys) [`bdbc0dc`](https://github.com/ollm/OpenComic/commit/bdbc0dc31ab37bdfcef570bf8f2130e39c08861e)
- Check if the file is written to disk when extracting using 7zip [`66d4897`](https://github.com/ollm/OpenComic/commit/66d48977b4ef33b320676d39656d48ea41aff653)
- Wrong size detection for animated AVIF images [`b741e52`](https://github.com/ollm/OpenComic/commit/b741e52c1fffac842a782fc45536eada123edeba)
- Compressed files with unsupported chars in Windows are not correct displayed [`120c86b`](https://github.com/ollm/OpenComic/commit/120c86b847259e4a6d8c1302f6691edd75fcae21)
- Error `Failed to retrieve track metadata` in some images [`1439b9b`](https://github.com/ollm/OpenComic/commit/1439b9b584aa4a3e1703b641c1e7f36f890dff07)

## [v1.4.1](https://github.com/ollm/OpenComic/releases/tag/v1.4.1) (08-02-2025)

##### 🐛 Bug Fixes

- Error saving images with dialog [`f2445de`](https://github.com/ollm/OpenComic/commit/f2445de4af8e515fe9dda2ed7dc71e3213922b8e)
- Drag and Drop not working due an Electron breaking change [`a830bf8`](https://github.com/ollm/OpenComic/commit/a830bf8a11f62eb9daeafcf56fd59e0489ce42d0)
- Move to trash not working in Windows [`8c34a31`](https://github.com/ollm/OpenComic/commit/8c34a318fabd4dc34d5e6143c044d2f631a674dc)

## [v1.4.0](https://github.com/ollm/OpenComic/releases/tag/v1.4.0) (26-01-2025)

##### 🚀 New Features

- Turn pages with mouse wheel [`f164068`](https://github.com/ollm/OpenComic/commit/f16406851b7adee7609004c95d4a0fec25f2f025)
- Custom name in image saving function [`4b01440`](https://github.com/ollm/OpenComic/commit/4b01440b70b52e10c3cbcb37f1379081242c523f)
- Option to save bookmarked images [`7def9ec`](https://github.com/ollm/OpenComic/commit/7def9eca58ceb24fb3444a3daf3ed81178a13fd1)
- Improved opening behavior options for files and folders [`07ee1f5`](https://github.com/ollm/OpenComic/commit/07ee1f5007576016a709e45d4649319129f75911)
- Make the Ignore single folders option work for images too [`cc9f9c7`](https://github.com/ollm/OpenComic/commit/cc9f9c727ec11b1a12fd4c8dac90506f7e01b378)
- Scroll by screen percentage in webtoon mode [`9a86a30`](https://github.com/ollm/OpenComic/commit/9a86a30ab5e599734503812ff274122bca103ac0)
- Shortcuts for saving images [`05c9b31`](https://github.com/ollm/OpenComic/commit/05c9b315788fec63aee2333b0bfb0588cfcf536a)
- Personalize save images template and save automatically to custom folder [`47e8de7`](https://github.com/ollm/OpenComic/commit/47e8de7b73b1ec354000c1455ff651039abd49e1)
- Multiple poster/folder sizes [`c64222a`](https://github.com/ollm/OpenComic/commit/c64222a1b697f6de3f64f0ed79f1a7f293337bcf)
- Implement header scrolling functionality [`cf5615e`](https://github.com/ollm/OpenComic/commit/cf5615eee312dcc4e1239528866bfcbfb86e0b23)
- Clear cache for individual files [`45e2e99`](https://github.com/ollm/OpenComic/commit/45e2e99114c031f64c3b4ba218f3412273a7a169)
- Add support in server settings for show in library the files in subfolders [`e2fa97a`](https://github.com/ollm/OpenComic/commit/e2fa97aea24424499910eb90843150f93e6e0c12)
- Option to show only one page at a time in Vertical Reader [`65f83db`](https://github.com/ollm/OpenComic/commit/65f83db6269717d2b798d49c2a3cb4190547b14f)
- Show files that have lost access on macOS (Store) [`7964d79`](https://github.com/ollm/OpenComic/commit/7964d797f891c1e6c0f09190789ce48f2082d2ca)

##### 🐛 Bug Fixes

- Save image not saving the correct page in manga mode [`b14a26e`](https://github.com/ollm/OpenComic/commit/b14a26eacdc77d37cdeb578fc203438058c7c5e2)
- Sometimes right click on reading fails [`b14a26e`](https://github.com/ollm/OpenComic/commit/1a8e145a997c67494e1a6c70c5f73acee7720000)
- Avoid generating thumbnails of images that are still being extracted (Extractions with 7-Zip) [`c415b3f`](https://github.com/ollm/OpenComic/commit/c415b3f0f6eb4bd6eb1bdd6cdd8a191b809df91e)
- Error attempting to open the bookmarks menu after navigating to a bookmark [`80c1b0e`](https://github.com/ollm/OpenComic/commit/80c1b0eb7ea441e1f55a86713d04fe835089ef3d)
- Can't override font in some epub files [`3265e1f`](https://github.com/ollm/OpenComic/commit/3265e1f2079f3b824047e5134e3b08938ae2e832)

## [v1.3.1](https://github.com/ollm/OpenComic/releases/tag/v1.3.1) (05-10-2024)

##### 🐛 Bug Fixes

- Dependency file-type not working [`7730e46`](https://github.com/ollm/OpenComic/commit/7730e46c8eb9e43196e50bd557f03132968eb534)
- Open file location not working in some cases [`a4bc25b`](https://github.com/ollm/OpenComic/commit/a4bc25b3005c097a7852a96c8c41fd866b28ed1c)

## [v1.3.0](https://github.com/ollm/OpenComic/releases/tag/v1.3.0) (04-10-2024)

##### 🚀 New Features

- Shortcut to go next/prev chapter [`9cda79e`](https://github.com/ollm/OpenComic/commit/9cda79e24dab1116c734e5a3773f74e13071c219)
- Option to rotate horizontal images [`20258ff`](https://github.com/ollm/OpenComic/commit/20258ff0ebf57d5a8064dec821ce745b7d9242a3)
- Setting to force black background and white blank page in night mode [`e7190f7`](https://github.com/ollm/OpenComic/commit/e7190f768a99f00bff07f46709870f94ab89c89e)
- Setting to disable gamepad input [`5a2285f`](https://github.com/ollm/OpenComic/commit/5a2285f6d750280584455f55da0249686cecc153)
- Page turn transitions and fade [`3592392`](https://github.com/ollm/OpenComic/commit/3592392b512c7767b916a7fa1b5bbd92a50e5bc9)
- Improved search performance [`ca26c55`](https://github.com/ollm/OpenComic/commit/ca26c55c7c0c0374d104de60ba0d0628ccf85809)
- Setting to force app Color Profile [`c7d479a`](https://github.com/ollm/OpenComic/commit/c7d479abeed6638c39ec413abd68ccfcacf6d5d5)
- WebDAV server support [`b6f4439`](https://github.com/ollm/OpenComic/commit/b6f4439d8953b3855fbc3d7ff476bfd6230a51a1)
- Library Navigation using side mouse buttons [`96f4bb8`](https://github.com/ollm/OpenComic/commit/96f4bb8e0033bd58b78e9ec29155ae332c72ec8b)
- Move to trash and Delete permanently options [`2737fbe`](https://github.com/ollm/OpenComic/commit/2737fbe2b9a318c9e5a8b27885e153caa5e9b327)
- Improved reading load and memory usage [`f12cbdb`](https://github.com/ollm/OpenComic/commit/f12cbdbade5e487f5c608e253a6c82b8e7c554a4)
- Option to set an image from the folder as a poster [`0a952da`](https://github.com/ollm/OpenComic/commit/0a952da7d4d79de384a327695377dae9b5ad073b)
- Multiple configurable tap zones from settings [`c7ee38f`](https://github.com/ollm/OpenComic/commit/c7ee38f2b85d85896bd197a8be4a68abd8bb300f)
- More available shortcuts [`9201e1f`](https://github.com/ollm/OpenComic/commit/9201e1fcf06401e498d3996bb45be314905b0fde)
- Custom gamepad death zone [`1b364c9`](https://github.com/ollm/OpenComic/commit/1b364c93974e4ccb5f3011653d05e543fa171188)
- Play background music also from parent folder [`6caf9f4`](https://github.com/ollm/OpenComic/commit/6caf9f4b27768fc3e604b4769afb3d7d97697846)
- Show library, favorites, labels, etc in header path [`123cd2c`](https://github.com/ollm/OpenComic/commit/123cd2cfc15956a2c8bed4531c6448774a6d3c71)
- Continue reading and Recently added section in library, favorites, labels, etc [`6938f19`](https://github.com/ollm/OpenComic/commit/6938f199fab46aee0fa454effecd3238038daac0)
- Sound effect on page turn [`d9957da`](https://github.com/ollm/OpenComic/commit/d9957da8c3266127802a03812f158f06e831dffd)
- Setting to set the number of items in recent [`386a4f5`](https://github.com/ollm/OpenComic/commit/386a4f5bfeb38bc3752695fd8482a6c61c543491)
- Reading context menu and save images [`64f7fc9`](https://github.com/ollm/OpenComic/commit/64f7fc9a0f3204effc9ac4243bc360427d4e7663)

##### 🐛 Bug Fixes

- Scroll does not work correctly when zooming and then resizing the window [`65a447c`](https://github.com/ollm/OpenComic/commit/65a447c1ce395214b1f787e5eb0824f003655f11)
- Support S3 path connection [`ec1340d`](https://github.com/ollm/OpenComic/commit/ec1340dc9cd29f6ed73e95d6776e406d2ba75d6e)
- S3 connection does not work correctly in Windows [`9352e3a`](https://github.com/ollm/OpenComic/commit/9352e3a388a4a1aea2f45155d72d057172808d56)
- Don't show drag menu if the event comes from the app [`383f9fe`](https://github.com/ollm/OpenComic/commit/383f9fe30d535260e6f6091242289d99ac4d755b)
- PDF zoom not work if device pixel ratio is upper 1 [`d318cfc`](https://github.com/ollm/OpenComic/commit/d318cfc071b5e8d919b4c8acef89b85e8ef40cc8)
- Optimized index loading and folder navigation [`0e6000f`](https://github.com/ollm/OpenComic/commit/0e6000f00e445de98eab7cdfbf72ee9b0016bf26)
- Error extracting files with 7zip if the file name contained UTF8 characters [`27c863b`](https://github.com/ollm/OpenComic/commit/27c863b6a9abd434e8855216100e5f8087ed1e73)
- Fullscreen error [`d72813a`](https://github.com/ollm/OpenComic/commit/d72813abbb0320a94bee5b2881c2bfcd1f2084cf)
- Files shared over a network in Windows do not open [`bab197f`](https://github.com/ollm/OpenComic/commit/bab197fa11f89ae07a707e4f42ea144a5416f25f)
- Long paths not working in Windows (paths equal or greater than 260 characters) [`884bccd`](https://github.com/ollm/OpenComic/commit/884bccd153a4cb2775fbfb5f0e7c6575188ec073)
- Extracting 7zip in separate stacks to avoid errors when extracting many files [`061827f`](https://github.com/ollm/OpenComic/commit/061827fc737aa8edfde14e7b092a8b44e571bf08)
- Prevent scroll event while reading is loading [`4c93a72`](https://github.com/ollm/OpenComic/commit/4c93a724220fc820347464a988727ef4649052fe)
- Multiple errors managing cache of files in servers [`7e739da`](https://github.com/ollm/OpenComic/commit/7e739dae8cbcef9691efd0a0cfbfbfa62ce192a4)
- 7zip binary does not have correct permissions on macOS arm64 [`91c8d1d`](https://github.com/ollm/OpenComic/commit/91c8d1d798e2b11b3f9d1cfdfe5698774dd00f05)
- Avoid extracting the same file multiple times at the same time [`98de350`](https://github.com/ollm/OpenComic/commit/98de35047700ba973e416c6b1540ccde51bdd7b0)

## [v1.2.0](https://github.com/ollm/OpenComic/releases/tag/v1.2.0) (29-03-2024)

##### 🚀 New Features

- Show error message if continue reading file does not exist [`7aee55c`](https://github.com/ollm/OpenComic/commit/7aee55ca5dac6b937824728b7ded116dc00c28df)
- Support background music from folder: MP3, M4A, WEBM, WEBA, OGG, OPUS, WAV, FLAC [`26947a2`](https://github.com/ollm/OpenComic/commit/26947a297868e86069cc6daca77e1a3f016d0705)
- Now when applying Webtoon mode the vertical margin is 0 [`683a08a`](https://github.com/ollm/OpenComic/commit/683a08aad3a6d947004ad77476184d613718b098)
- Show the current reading title in app window [`9520faa`](https://github.com/ollm/OpenComic/commit/9520faa7486e4494bb878ffe2430e9fd198ee33a)
- Option to open file location of current reading from the file menu [`c9215dc`](https://github.com/ollm/OpenComic/commit/c9215dc5cb29a3b5a759d80d21f7ff734053f23c)
- Setting to enable/disable go next/previous chapter with mouse scroll (Vertical reading) [`37612bf`](https://github.com/ollm/OpenComic/commit/37612bfdce13ce73348bda997bf3aeb32b8915af)
- About this file dialog [`38f72f3`](https://github.com/ollm/OpenComic/commit/38f72f3c573aaa2a1923f3e6704261a9b600b3ab)
- Delete downloaded compressed files for thumbnail generation if they exceed 50% of the maximum tmp size [`2a50079`](https://github.com/ollm/OpenComic/commit/2a500790d2251f0a447aae2f08050af56c4a6659)
- Change extraction of zip to 7z to improve performance and support partial extraction of corrupted files [`d07feac`](https://github.com/ollm/OpenComic/commit/d07feac608903ef7ba582273bca06abaded4f4df)
- S3 server support [`ae8c133`](https://github.com/ollm/OpenComic/commit/ae8c13323a1edf618923c40b600fc5dd43c61276)

##### 🐛 Bug Fixes

- node-zstd not have native dependencies in arm64 build (Linux and macOS) [`e906f21`](https://github.com/ollm/OpenComic/commit/e906f212dae36c43d514beda44fba62e5ca26be5)
- Manga mode not working in epub [`a901754`](https://github.com/ollm/OpenComic/commit/a901754a4274687cddbfa3820ca3667b8b80e6ee)
- eBook not working with decimal device pixel ratio (1.5, 2.5, etc) [`4962724`](https://github.com/ollm/OpenComic/commit/496272442747e466638e890a187f84b100deda14)
- Blurry cover/poster images [`23ae46d`](https://github.com/ollm/OpenComic/commit/23ae46d3d77847f5262f10799a21d7ee0141b226)
- Using the first image as a poster does not work [`fd6c748`](https://github.com/ollm/OpenComic/commit/dfd6c748090088109416b847a5e7581d80e36ea7)
- Some errors in scroll reading [`a4887c3`](https://github.com/ollm/OpenComic/commit/a4887c3bfe3f0ec8b75d3cdceedfaae8684fe6df)
- Stuck in a loop trying to read an epub file when the epub or zip is corrupt [`6388a9e`](https://github.com/ollm/OpenComic/commit/6388a9ef8eb118e1d337fb6becd68ec64b5defc3)
- Next chapter button not work inscroll mode if last page is smaller than the window and "Adjust to width" is enabled [`2bbd49e`](https://github.com/ollm/OpenComic/commit/2bbd49e43f9bb96c2dc00f21494acd7a92820331)
- PDF.js does not load files that have a hash (#) in the name [`5691073`](https://github.com/ollm/OpenComic/commit/56910730d1b0241370565bce787508ba0811b9a9)
- Context menu does not appear in the inputs (Can't copy or paste) [`91cf4c8`](https://github.com/ollm/OpenComic/commit/91cf4c8fb4d4ca357e21041d6d761029638fb817)

## [v1.1.0](https://github.com/ollm/OpenComic/releases/tag/v1.1.0) (13-01-2024)

##### 🚀 New Features

- Option to set maximum size of temporary files, preserving them when closing the app [`a727249`](https://github.com/ollm/OpenComic/commit/a7272499407191064f9d6bd7c42ecf3bb1231a83)
- Label to display only the contents of a master folder [`ff35144`](https://github.com/ollm/OpenComic/commit/ff351447829641de32e59a7332f354d945df88fa)
- Support favorite label [`86039e6`](https://github.com/ollm/OpenComic/commit/86039e6d9f90d77b9671068d520c8bc2fa635f30)
- Custom labels support [`1185d82`](https://github.com/ollm/OpenComic/commit/1185d82790a764e63d1d223362e4b44e203ff0e1)
- Option to not enlarge images more than its original size [`e2f8598`](https://github.com/ollm/OpenComic/commit/e2f85983352529162822576bbb8e7da41cd31f39)
- New image interpolation methods available: lanczos3, lanczos2, mitchell, cubic, nearest and others [`86cd705`](https://github.com/ollm/OpenComic/commit/86cd7053011b09b1a0a0b898775e32ede8cf5296)
- Server connection support: smb://, ftp://, ftps://, scp://, sftp://, ssh:// [`52a09a9`](https://github.com/ollm/OpenComic/commit/52a09a9aad601a2e70b8f0011a6fddc7d3e9023a)
- Compress json files from cache to zstd to reduce used space [`3ae7cb7`](https://github.com/ollm/OpenComic/commit/3ae7cb721fb964fa1a41f8a5170b775d2182e8a9)

##### 🐛 Bug Fixes

- Error on detect file type from binary [`0f81947`](https://github.com/ollm/OpenComic/commit/0f819470d42ce996cd4f1f0a31665a605d2bc39a)
- Zoom bug in vertical reading if global zoom disabled [`f83d17f`](https://github.com/ollm/OpenComic/commit/f83d17fbf3cb581d8b8735050cb919fca623d8aa)

## [v1.0.0](https://github.com/ollm/OpenComic/releases/tag/v1.0.0) (09-12-2023)

##### 🚀 New Features

- Delete bookmarks from the bookmark list [`3792f7d`](https://github.com/ollm/OpenComic/commit/3792f7db319cf885f398836aefe983e56fe5ef2a)
- Save and show also the current folder progress apart from the main folder [`86f094b`](https://github.com/ollm/OpenComic/commit/86f094b7a216982ae7799950234be233113143e7)
- Instead of the file name it shows the title of EPUB, PDF and Compressed Files with ComicInfo.xml [`0d3e4ba`](https://github.com/ollm/OpenComic/commit/0d3e4ba489f616d862c4b52e2f2498f1a203d218)

##### 🐛 Bug Fixes

- Error when resizing after exit comic opened from recents [`8291730`](https://github.com/ollm/OpenComic/commit/829173058bb3dde12d35b726070c19ec43a63be3)
- When reloading, change view or sorting a folder opens reading mode in some cases [`e8e2c16`](https://github.com/ollm/OpenComic/commit/e8e2c16a18d8f0c03b6b00b09a7c0d1bf8a24032)
- Reading shortcuts remain active when going back to recently opened [`716c10b`](https://github.com/ollm/OpenComic/commit/716c10b3a6b3ec17352952bba6a19b3b1a4dd66a)
- Some errors on go back before comic load [`99fb29d`](https://github.com/ollm/OpenComic/commit/99fb29dab7b07a94883199665167a1301774f4e8)
- Blank page keep white color in dark theme [`8d1a5b7`](https://github.com/ollm/OpenComic/commit/8d1a5b741855fd0bae6a7efd9579c7ddecbfd3d1)
- Open with OpenComic not working in macOS and some fixes in Windows and Linux [`ea90063`](https://github.com/ollm/OpenComic/commit/ea9006309eee995c92571e0bc4c919d50de8e55b)
- Error opening an epub when OpenComic is closed [`84c838a`](https://github.com/ollm/OpenComic/commit/84c838a17a32b3f50e9b25bf016ea810c91d95e6)
- Performance issues when generating some thumbnails [`1a07d2d`](https://github.com/ollm/OpenComic/commit/1a07d2d9ad462e56fbd5e592b71868013d10aa12)

## [v1.0.0-beta.5](https://github.com/ollm/OpenComic/releases/tag/v1.0.0-beta.5) (24-11-2023)

##### 🚀 New Features

- Preliminary support for the `EPUB` format (Alpha) [`24b6494`](https://github.com/ollm/OpenComic/commit/24b6494c00f35dcb5fcea4f2e4cb713a8a130cd9)
- Option to use the first image in the folder/file as a poster [`a5cf998`](https://github.com/ollm/OpenComic/commit/a5cf998786b17e451ce7d1a8fa24ac287779de44)
- Option to open folder/file directly in first image or in continue reading [`6a20160`](https://github.com/ollm/OpenComic/commit/6a20160bcd96291c14d16d025baf7aef7ebe13c9)
- Change page using an input range [`527999c`](https://github.com/ollm/OpenComic/commit/527999ccacf16beea2387f7eef2f6cb7648fb2d5)
- Go to page writing it in a dialog [`2d7a028`](https://github.com/ollm/OpenComic/commit/2d7a02853d27752094555275e77cdc7ad2ca3771)
- Global zoom in the slide reading [`da36774`](https://github.com/ollm/OpenComic/commit/da3677414846e04d9d540ad9ed79f9e66b1175a2)
- Switch to night/light mode when the OS does it [`3d80403`](https://github.com/ollm/OpenComic/commit/3d804032f0766b111888878a220039711161d94b)

##### 🐛 Bug Fixes

- Remove button in library not showing [`24ba9ba`](https://github.com/ollm/OpenComic/commit/24ba9ba787130c8f92b098cfefefdb7d37d18549)
- Window buttons not showing in About OpenComic (macOS only) [`40ae6d1`](https://github.com/ollm/OpenComic/commit/40ae6d1caa80bb404d4986af1d0853e2bbec5eed)
- Thumbnails not generated by wrong sharp install (Windows only) [`40ae6d1`](https://github.com/ollm/OpenComic/commit/40ae6d1caa80bb404d4986af1d0853e2bbec5eed)

## [v1.0.0-beta.4](https://github.com/ollm/OpenComic/releases/tag/v1.0.0-beta.4) (17-10-2023)

##### 🚀 New Features

- Option to open directly in continue reading instead of the file list [`78646fe`](https://github.com/ollm/OpenComic/commit/78646fe6f4a17be6fc9fd0c940fd97d438c812c1)
- Option to start reading in full screen [`cf3de6e`](https://github.com/ollm/OpenComic/commit/cf3de6ed737189b53474a30e277245b988ee5d99)
- Option to start OpenComic directly in last reading [`00cb8c7`](https://github.com/ollm/OpenComic/commit/00cb8c7da9eb8345aaec8faa3b5c91953c2350dd)
- Recently opened page [`d2f3065`](https://github.com/ollm/OpenComic/commit/d2f30653f506993a45e49ad5e7e5e8434c33a9be)
- Option to move zoom and scroll whit mouse [`e8cc79c`](https://github.com/ollm/OpenComic/commit/e8cc79cbddd23ff7d47b7046190cecbad199d3c2)
- Improved touch screen navigation (swipe gesture, 2 finger zoom and reset zoom with 2 finger click) [`f848463`](https://github.com/ollm/OpenComic/commit/f84846399f1521c736b9b6e048f204513ac304da)
- Improved detection of image edges when zoom is applied [`e7ec771`](https://github.com/ollm/OpenComic/commit/e7ec77104360b1e2ac2aa96d97b6c1d2cc2d6d01)
- Frameless window (Full only in Windows and macOS) [`9c7346c`](https://github.com/ollm/OpenComic/commit/9c7346cb37fe3c7aed9200d49e27ed4c5bdbfc96)
- Translate page names in PDFs [`8855fbe`](https://github.com/ollm/OpenComic/commit/8855fbefd498352cc86e014677b19c160fcc8da5)

##### 🐛 Bug Fixes

- Error opening some images [`8b97435`](https://github.com/ollm/OpenComic/commit/8b974356dfcbb7222bdef5ace604caeda93e4663)
- Wrong cache folder in windows causing some bugs [`8b97435`](https://github.com/ollm/OpenComic/commit/dd6facaf67343185fa06b2377fdc64e66ad9090d)
- Extract large RAR and ZIP files blocks the app for a while [`adbdced`](https://github.com/ollm/OpenComic/commit/adbdceda278e6184bc477581be9a25b8fc0f166b)
- RAR error on extract with files some special chars (Changed unrar to node-unrar-js) [`694fe27`](https://github.com/ollm/OpenComic/commit/694fe274982c0a9ad2421c6b226abceae1602c3a)
- Cannot open filtered files with the keyboard [`f831749`](https://github.com/ollm/OpenComic/commit/f8317499a40e6fa45a75988ee1bea31a9135c9bf)
- Some display errors when applying global zoom [`92b28c2`](https://github.com/ollm/OpenComic/commit/92b28c24f1a00544264fac03a336ad8268553fd5)
- Reading progress was saved in different location when activating show full path [`72e8cc1`](https://github.com/ollm/OpenComic/commit/72e8cc146b364d7772d6494a1e2390900505de7a)

## [v1.0.0-beta.3](https://github.com/ollm/OpenComic/releases/tag/v1.0.0-beta.3) (09-10-2023)

##### 🚀 New Features

- Open file location in context menu [`339bcc0`](https://github.com/ollm/OpenComic/commit/339bcc0b21eab52228b7762c92c993d06489aa48)
- Option in the context menu to add and remove posters using local artwork assets [`e8a1745`](https://github.com/ollm/OpenComic/commit/e8a1745904cd563336e1e27c02841a33e9cdc536)
- Show image in its original size [`30df2fc`](https://github.com/ollm/OpenComic/commit/30df2fc70dbaefecfe1942bc8032686e083e7d53)
- Show in first/last page buttons if has next/prev comic and go to next/prev comics scrolling [`2a3796e`](https://github.com/ollm/OpenComic/commit/2a3796eb82cdc86c70c69cae62e48da9baf41aa0)
- Improve the detection of the type of compressed files if the file extension is not correct [`b39605c`](https://github.com/ollm/OpenComic/commit/b39605c5d5ab72742cf32f14a23004976cccec7c)
- Option to start OpenComic in startup (Windows and macOS only) [`7b9b8ec`](https://github.com/ollm/OpenComic/commit/7b9b8ec4457445ad9bb3a761face8403ff507b7f)
- Buttons in library to go next and prev chapter [`c41ecde`](https://github.com/ollm/OpenComic/commit/c41ecde33a3b0b2361b9ccdcbec92d848b48077d)
- Adjust the brightness, saturation, contrast, sepia and colorize black and white images [`04b1caa`](https://github.com/ollm/OpenComic/commit/04b1caa5d28a468df6e94893bd943518da762030)
- Master folder support from settings [`9edd70e`](https://github.com/ollm/OpenComic/commit/9edd70ec871855cf2b43fa5cebea4bdf83baae7f)
- Ignore single folders in browsing [`7507563`](https://github.com/ollm/OpenComic/commit/75075631fcad5fb269427c178e9bac86bc352971)
- Search and filter in library/browsing [`8393903`](https://github.com/ollm/OpenComic/commit/8393903117981bea2b8a79e2e50b77d02334aa05)
- Tracking at the end of the chapter/volume setting option [`39f1954`](https://github.com/ollm/OpenComic/commit/39f19546b2fd363d321f9c423e706c3dc773aa4f)
- View size and remove cache and temporary files from settings [`8114336`](https://github.com/ollm/OpenComic/commit/8114336ef2c70748e3b1d87618903ef34cb58f0a)
- Max cache size and max cache old [`fe679d4`](https://github.com/ollm/OpenComic/commit/fe679d43b290c809b79125cbaf31a362531aa555)

##### 🐛 Bug Fixes

- Gamepad icons not showing in distribution version [`249640d`](https://github.com/ollm/OpenComic/commit/249640d57f3d5768661b63c0ddf8525a02e44d25)
- Go back in gamepad menus [`b2719e5`](https://github.com/ollm/OpenComic/commit/b2719e5e782659f249ce7a6ba6c8b94fe40a3407)
- Wrong detection of folder images in some cases [`425a137`](https://github.com/ollm/OpenComic/commit/425a137333114739cb4f0b1e92e4606f2c9da87c)
- Ignore first gamepad and keyboard event in browsing [`9347fbe`](https://github.com/ollm/OpenComic/commit/9347fbe628143e688f956ed0950510a2265c02e2)
- Blurry image when zooming [`0732f3f`](https://github.com/ollm/OpenComic/commit/0732f3f76923f2a50541139e58fb8343e7c20083)
- Progress was not saved in some cases [`964bb64`](https://github.com/ollm/OpenComic/commit/964bb64ee765d3830615e78413bf520b17549b0c)
- Error on opening file in OpenComic [`cb56ccf`](https://github.com/ollm/OpenComic/commit/cb56ccfd032ebfdd60be19a4a9fed82f6b60d0d5)
- Some memory leaks [`6569e8e`](https://github.com/ollm/OpenComic/commit/6569e8e1f054243a04657e2ce05ef20dda6e14df)

## [v1.0.0-beta.2](https://github.com/ollm/OpenComic/releases/tag/v1.0.0-beta.2) (03-09-2023)

##### 🚀 New Features

- Reload button in file list [`31675a5`](https://github.com/ollm/OpenComic/commit/31675a5a8334abedc056a09a5107f718dc5304e0)
- Check if there is a new version when starting OpenComic [`82f1abd`](https://github.com/ollm/OpenComic/commit/82f1abdac5c1ae6f26e88f5f2374c54edcfcaae7)
- Custom keyboard and gamepad shortcuts [`0a4a459`](https://github.com/ollm/OpenComic/commit/0a4a4597883c7c6c837acdd61e4d80dc8c0a0ec1)
- Navigation via gamepad/keyboard has been improved, you can navigate in settings, theme, language, menus in reading, etc. [`d1290f5`](https://github.com/ollm/OpenComic/commit/d1290f53fc99af0dc660052568c827d07dab74ca)

##### 🐛 Bug Fixes

- Improved local artwork assets support [`f21cccd`](https://github.com/ollm/OpenComic/commit/f21cccd9c2c943f7ad8735e106afff453397cfbf)
- Some errors on Tracking feature [`50d8487`](https://github.com/ollm/OpenComic/commit/50d84874ea99cdace27f2c3bfc994b3338f23a42)
- Updated snackbar to Material 3 [`ae8e195`](https://github.com/ollm/OpenComic/commit/ae8e1955dd10b9f54166dddd1af8281c67bb841a)
- Bug in Magnifying glass introduced in version v1.0.0-beta.1

## [v1.0.0-beta.1](https://github.com/ollm/OpenComic/releases/tag/v1.0.0-beta.1) (22-08-2023)

##### 🚀 New Features

- AVIF support [`8a0d274`](https://github.com/ollm/OpenComic/commit/8a0d2741793598f3728a52ba1e24f90c34100375)
- Improved PDF rendering performance and quality [`a55312d`](https://github.com/ollm/OpenComic/commit/a55312d0ba46c9773b405f6528bd0b4f055e17b9)
- Code of reading compressed files has been rewritten, improving thumbnail generation performance, especially in PDF files [`c1259bb`](https://github.com/ollm/OpenComic/commit/c1259bb512983751fe41304c7c642966b204aea1)
- Global zoom in the vertical reader [`c94ac75`](https://github.com/ollm/OpenComic/commit/c94ac75d5f247a1f423b4192d1b1cab2c066be6f)
- Support for gamepads [`759ee60`](https://github.com/ollm/OpenComic/commit/759ee6085399087408d6aec91cab25e732a53c15)
- Navigate in the library using the keyboard [`922e6ee`](https://github.com/ollm/OpenComic/commit/922e6ee0fe1509f2dfae0003406e24ce26aa49fb)
- Clip image option on read [`71fad97`](https://github.com/ollm/OpenComic/commit/71fad9748289af6624256e3c34fde422284fc750)
- Updated electron to v25.5.0 [`41214a5`](https://github.com/ollm/OpenComic/commit/41214a50bc9b0bce56f12b302d47f6d44f12fd81)
- Update theme to Material 3 [`0f537fb`](https://github.com/ollm/OpenComic/commit/0f537fb37d9108986f1cdac41cc56e6c51d51428)
- Settings page to set some default values [`12907bc`](https://github.com/ollm/OpenComic/commit/12907bcb84dccc5c8f0a65c78c65915f55e8cb0f)
- Drag and Drop support [`91933a9`](https://github.com/ollm/OpenComic/commit/91933a998885a2579592566d7773549085495e4e)
- Local Artwork Assets [`f774ed4`](https://github.com/ollm/OpenComic/commit/f774ed41eaa459c69f1b7d5a9f82ef83c067ceb2)

##### 🐛 Bug Fixes

- Error on scrolling in vertical reading [`9a34df4`](https://github.com/ollm/OpenComic/commit/9a34df43be9fee21cda115b5729cfd72c6bd3fb5)
- Detect signature 0x21726152 as a rar file [`aa39a6a`](https://github.com/ollm/OpenComic/commit/aa39a6a8b2e9d37d6ea5572d283d615c64d8250f)
