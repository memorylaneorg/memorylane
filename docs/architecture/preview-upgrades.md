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

Background upgrades reserve 512 MiB free space. TV settings exposes a separate
RAW preview directory limit (`previewCacheMiB`, default 4096 MiB, range 1024–1048576
MiB); the TV delivery cache remains independent. The worker checks the limit before
conversion and the projected directory size before atomic replacement. Existing
previews are never evicted when a limit is reached or lowered. Storage limits pause
jobs as `blocked`, with a recorded budget or disk-space reason.

TV settings shows usage, disk space, failure counts by reason, and an estimated
larger limit when needed. The estimate uses remaining eligible RAW photos and mean
observed completed preview size (8 MiB fallback, 1 MiB minimum), adds 25% headroom,
and rounds up to GiB. Free space minus the 512 MiB reserve and the maximum setting
bound the suggestion; no suggestion is offered when no increase fits. The estimate
is advisory and may need revision as more cameras/formats are processed. Selecting
a suggestion only edits the form; Save applies it. Increasing the saved limit marks
currently eligible budget-blocked previews for retry automatically.

The authenticated `POST /api/tv-sharing/preview-retry` action requests a single retry
of currently shared, eligible failed or blocked RAW previews. Migration 040 stores
retry requests independently of the 1,000-job queue; the existing preparation timer
admits them in batches and resumes them after restart. Admission clears each request,
so a new failure does not loop. Both admission and dispatch recheck current sharing
eligibility. Ready and limited previews are excluded from bulk retry; limited previews
can still be retried individually in the viewer.

Worker failures retain a bounded error message and category (source unavailable,
decode, timeout, worker, file I/O, disk space or budget) in core SQLite. Diagnostics
expose category counts, not original file paths. Old failures keep an unknown cause
until explicitly retried. Browser diagnostics cache directory usage for 30 seconds;
replacement checks always measure current size. Initial indexing also preserves native preview
resolution and is counted in this directory. Settings Storage reports RAW previews
and TV delivery cache separately, both included in the total. TV delivery has its
own configured LRU budget: new settings default to 4K and 2 GiB, existing explicit
choices are preserved.

The viewer polls per-photo status, displays generation/limited/failure state and
Retry, and refreshes the image when its version changes. TV Settings polls aggregate
queue counts and storage diagnostics, and offers bulk retry. The TV's native media player cannot show this custom progress UI.
Plugin properties are behind a Settings disclosure while lifecycle actions remain
visible. Original photo files are always read-only.

TV preview status leads with whether action is needed. Queued retry requests are
counted as remaining work, not actionable failures. Retry is offered after current
work finishes if unscheduled failures remain; failure details stay available, and
failed status polling is explicitly reported instead of presenting stale progress
as current.

The compact panel shows processed progress and read-only RAW usage/limit.
The limit editor and free-disk/suggestion details are under Change limit.
The progress bar counts completed attempts (including failures), while the status
separately identifies unresolved failures; it is not a success percentage.

Settings offers Clear DLNA cache via authenticated `DELETE /api/tv-sharing/cache`.
It removes all generated TV delivery JPEGs, reports freed bytes, and leaves originals,
indexed thumbnails and shared RAW previews intact. Reads can regenerate delivery
images on demand. Cache writes and deletion are serialized; conversions already
in flight at clearing time may finish their response but cannot refill the cache.
No per-folder cleanup or automatic share-removal cleanup is performed.

Settings provides immediate Pause/Resume controls. Pausing persists `upgradePreviews=false`,
terminates the active decoder, and retains queued work and completed previews. An interrupted
job resumes without being recorded as a failure. Sharing/plugin disablement also pauses work.
Active jobs recheck authorization every 250 ms and before replacement. Removing a share stops
only photos no longer authorized by any selected folder or collection; pending work and deferred
retry flags for those photos are removed. Re-sharing them permits preparation again. Collections
are recommended in Settings for explicitly choosing the TV selection.

Progress and retry/failure diagnostics are scoped to currently selected, eligible RAW photos,
including Favorites membership changes. Counts include photos awaiting admission to the bounded
queue; obsolete fingerprints count as pending. Historical results for removed shares remain
stored for reuse if re-shared, but do not inflate current progress. Storage usage still reports
all retained RAW preview files because those continue to occupy disk space.
