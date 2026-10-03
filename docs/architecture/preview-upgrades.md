# Background RAW viewing previews

RAW previews retain the native dimensions of the largest valid embedded image,
selected by pixel area across ExifTool tags. Grid thumbnails remain 500 pixels.
Previously generated previews remain usable while upgrades run.

The TV plugin setting `upgradePreviews` (off by default) opts into a persistent
SQLite queue that prepares only DLNA-shared RAW photos. Turning it off prevents
new work and discards queued work at dispatch; running output is not applied.
Explicit shared collections precede folder batches; photos requested by the TV have
higher priority. Opening the web viewer or polling status does not enqueue work.
Retry and worker dispatch/replacement recheck current DLNA sharing eligibility. One low-priority worker runs at a time, with a 60-second deadline and
at most 1,000 pending jobs. Source fingerprints and thumbnail revisions guard
replacement. Jobs interrupted by shutdown resume on the next start. Disabled-root
and missing-source queued jobs are removed when admitting new work.

If embedded images cannot satisfy a 4K fit, the worker tries native decoding:
macOS uses its installed sips/ImageIO decoder; other platforms use available
Sharp/libvips format support. Camera/OS support varies. No new decoder is bundled.
Unsupported full decoding is explicitly reported as limited quality, with retry.
Existing previews are never upscaled, deleted on failure, or replaced with fewer
pixels. Successful atomic replacement increments the existing thumbnail version,
invalidating TV derivatives; browser preview responses require revalidation.

Background upgrades reserve 512 MiB free space and stop growth at a 4 GiB RAW
preview directory budget. They do not evict existing RAW previews; failed upgrades
can be retried after space is freed. Initial indexing also preserves native preview
resolution and is counted in this directory. Settings Storage reports RAW previews
and TV delivery cache separately, both included in the total. TV delivery has its
own configured LRU budget: new settings default to 4K and 2 GiB, existing explicit
choices are preserved.

The viewer polls per-photo status, displays generation/limited/failure state and
Retry, and refreshes the image when its version changes. TV Settings polls aggregate
queue counts. The TV's native media player cannot show this custom progress UI.
Plugin properties are behind a Settings disclosure while lifecycle actions remain
visible. Original photo files are always read-only.
