# MemoryLane repository knowledge base

## Purpose and maintenance

Use this file as the starting map for work in this repository. It records architecture,
capabilities, implementation entry points, and technical notes from external feedback.
Reviewed against source at `bfde20a` on 2026-10-03; this is a source review, not runtime
reproduction of the reported issues. Recheck the relevant files when implementing a
change, rather than rediscovering the entire repository. Update this file when those
contracts or capabilities change. Feedback below is not an instruction to implement
all items or a set of approved designs.

Read `CLAUDE.md` for existing contributor guidance. Supporting documentation:
`README.md`, `docs/architecture/overview.md`, `docs/architecture/plugins.md`,
`docs/architecture/ai.md`, `docs/deployment.md`, and `docs/localization.md`.
Historical plan/spec references in source comments may refer to documents intentionally
excluded from this public repository; use current code and the documents above.

## Architecture at a glance

MemoryLane is a local-first browser application indexing existing photo/video folders
in place. A Node server owns the catalog, filesystem access, media processing, and
background work. The desktop application is a Go supervisor opening a normal browser,
not an embedded webview. NAS folders can be scanned when accessible to the server's OS.

| Area | Responsibility and starting points |
| --- | --- |
| `client/` | React 18, TypeScript, Vite, Tailwind, React Router. `client/src/App.tsx` defines routes and setup/auth/onboarding gates; `client/src/components/Layout.tsx` owns navigation; `client/src/api/client.ts` wraps the API. |
| `server/` | Fastify 5 and better-sqlite3. `server/src/server.ts` composes services and starts workers/listener; `server/src/context.ts` defines dependencies; `server/src/app.ts` registers routes and serves the built SPA. |
| `shared/` | Browser/server DTOs in `shared/src/types.ts`, Zod request schemas in `shared/src/validation.ts`, exports in `shared/src/index.ts`. Keep API changes aligned across these and both consumers. |
| `plugin-sdk/` | First-party plugin contracts, manifests, capability APIs, and runtime protocol. |
| `plugins/optional/` | AI Runtime, AI Search & Similar, People, Apple Photos. Source manifests and runtime implementations. |
| `tray-go/` | Packaged Node supervision, browser launch, tray, launch-at-login, core updates. See `tray-go/README.md`. |
| `scripts/` | Boundary checks, runtime preparation, package/catalog building, signing, release versioning and publishing. See deployment docs before release work. |

Request flow: React page → API client → authenticated Fastify route → core service /
SQLite or plugin capability. Background flow: scan roots → folder/media records →
metadata and thumbnails/previews → analysis queue → EXIF, hashes, embeddings, faces,
and grouping. Scan completion kicks analysis; plugin-dependent startup is coordinated
in `server/src/server.ts`.

## Catalog, file identity, and storage

- Core owns the SQLite connection and migrations. `server/src/db/connection.ts` enables
  WAL, foreign keys, and NORMAL synchronous mode. `server/src/db/migrate.ts` applies
  numbered SQL files in `server/migrations/`, with backups before pending migrations.
- Important schema areas: scan roots/folders/media/scan runs, users/sessions/settings,
  EXIF and analysis state, stacks, embeddings, faces/persons, favorites/engagement,
  tags, trash, and Apple Photos catalog data. Read later migrations as well as table
  creation SQL; the schema evolves across them.
- `server/src/scanner/scanner-service.ts` finds filesystem media by `absolute_path`.
  `server/src/scanner/fingerprint.ts` uses size + rounded mtime for change detection,
  **not a content hash or move-stable identity**. `server/src/scanner/folder-repo.ts`
  owns folder persistence.
- Unseen records in successfully covered scan roots are marked `missing`; a normal
  scan does not simply delete all old rows. A renamed path can create new records
  while the old ones become missing. Removing a scan root is different: its route
  deletes the root and cascades associated database records.
- `server/src/config/paths.ts` resolves core storage with precedence
  `MEMORYLANE_DATA_DIR` → platform-default `data-location.txt` pointer → OS default.
  Defaults: macOS `~/Library/Application Support/MemoryLane`, Windows
  `%LOCALAPPDATA%/MemoryLane`, Linux `$XDG_DATA_HOME/MemoryLane` or
  `~/.local/share/MemoryLane`.
- Core data includes `memorylane.sqlite`, thumbnails, RAW previews, vectors, face
  crops, transcode working files, and logs. Thumbnail/preview filenames are sharded
  by numeric media ID, making identity preservation relevant to relocation work.
  Installed plugin state/code have separate platform paths in
  `server/src/plugin-platform/paths.ts`.
- Settings already supports moving generated core data: `server/src/config/data-dir-move.ts`
  pauses work, backs up SQLite, copies selected cache directories, creates a fresh
  logs directory, writes the pointer, and requires restart. It retains the old copy.
  This is **not** original-folder relocation, a complete plugin-install migration,
  or a multi-host shared-database protocol. Environment overrides take precedence.
- Do not treat the catalog as valueless just because previews are rebuildable:
  names, face corrections, favorites and other user-maintained state need preservation.
- Multi-device browser access to one server is supported through Settings → Network
  (restart required; bind override available). This reuses that server's index/cache.
  Multiple independent servers sharing one SQLite file have no supported coordination
  workflow identified in this review; do not present that as equivalent to LAN access.

## Existing capabilities and where to work

| Capability | Implementation map |
| --- | --- |
| Folder scan/browse and ignored paths | `server/src/scanner/`; `server/src/api/scan-roots-routes.ts`, `folders-routes.ts`, `scans-routes.ts`, `ignored-paths-routes.ts`; `client/src/components/ScanFoldersManager.tsx`, `client/src/pages/FolderPage.tsx`. |
| Metadata, RAW, thumbnails, video/Live Photos | `server/src/media/`, `server/src/exif/`, `server/src/capabilities/native-media-tools.ts`; `client/src/components/Viewer.tsx`. ExifTool, Sharp, FFmpeg/FFprobe are core dependencies. |
| Search, facets, reports, favorites, rediscovery | Matching route files in `server/src/api/`; `server/src/query/media-query.ts` centralizes shared visibility predicates; pages under `client/src/pages/`. |
| Locations | `client/src/pages/LocationsPage.tsx`, `client/src/utils/location-map.ts`, `client/src/assets/ne_110m_land.json`; `server/src/api/location-routes.ts`, `server/src/locations/`. OpenStreetMap tiles via `client/src/components/LocationBasemap.tsx`, offline SVG fallback, and viewport/zoom-dependent location cells (zoom 0–17). |
| EXIF timeline | `client/src/pages/TimelinePage.tsx` and `TimelineMonthPage.tsx`; `server/src/api/timeline-routes.ts`. Uses only `media_exif.captured_at_precise`, accepts all media types, limits dates to 1990 through the current moment, skips empty months, and selects five chronologically distributed month samples. |
| EXIF moments | `client/src/pages/MomentsPage.tsx`, `MomentDetailPage.tsx`, and `MomentDayPage.tsx`; `server/src/api/moments-routes.ts`; grouping rules in `server/src/moments/detect.ts`. Broad, Balanced, and Detailed presets detect active days and combine runs of at least three active days separated by no more than one inactive day. Dates are limited to 1990 through the current moment, and representative samples are distributed across each event. |
| Gear Museum and Timeline | Both implemented in `client/src/pages/GearMuseumPage.tsx`; `GearTimelinePage.tsx` is a re-export. `server/src/api/gear-routes.ts` exposes camera/lens summaries and enrichment. |
| Background analysis | `server/src/analysis/analysis-worker.ts`, `analysis-repo.ts`, `registry.ts`, and `analyzers/`. Track pending/done/error/unsupported outcomes and analyzer versions rather than equating scan completion with successful analysis. |
| People | `server/src/analysis/analyzers/faces.ts`, `server/src/persons/face-repo.ts`, `person-service.ts`, `server/src/api/persons-routes.ts`; `client/src/pages/PeoplePage.tsx`, `PersonPage.tsx`. |
| AI search and similarity | `server/src/providers/`, `server/src/vectors/`, analysis embedding analyzer, search/similar routes and UI. |
| Bursts/stacks and cleanup | `server/src/stacks/`, `server/src/cleanup/trash-service.ts`, stacks/cleanup routes; `client/src/pages/CleanupPage.tsx`. Trash handling groups associated originals/companions and supports restoration. |
| Apple Photos | Optional local macOS catalog integration: `server/src/plugins/apple-photos/` and `plugins/optional/com.memorylane.apple-photos/`; source visibility also lives in `server/src/plugins/registry.ts`. |
| Settings/auth/update | `server/src/db/settings-repo.ts`, settings/auth/core-update routes, `server/src/auth/`, `client/src/pages/SettingsPage.tsx`, `server/src/plugin-platform/`, and tray updater. |

### Optional TV photo sharing (development)

- `plugins/optional/com.memorylane.tv-sharing/` implements generic UPnP AV photo
  browsing, SSDP, eventing and JPEG delivery. It is a module plugin; protocol code
  and the MIT XML parser load only with that optional plugin. Installation leaves
  sharing disabled. Selected private IPv4 interface and folders are required.
- `server/src/tv-sharing/` owns authenticated settings, catalog visibility and
  derivatives. Module-host IPC binds requests to the plugin ID; core owns SQLite
  and rechecks selection for every image, including cached images. LAN clients
  are unauthenticated and restricted to the selected subnet; normal app login stays.
- JPEG conversions use bounded child processes with deadlines and revocation,
  existing RAW previews/BMP decoding, and `dataDir/tv-sharing-cache`. Data directory
  migration copies that cache. Originals are read-only; generated JPEGs strip EXIF.
- Plugin `module/catalog.mjs` adds an All photos collection inside each folder by
  paging existing authorized core browse calls. Virtual photo IDs resolve only within
  that collection; core rechecks delivery. Traversal/cache limits bound large trees.
  No core recursive-query API or database schema change is needed.
- `TvSharingSettings.tsx` is visible only for an active installed plugin. Settings
  include folders/recursion, interface, 1080p/4K, cache budget and diagnostics.
- The manifest's `developmentOnly` build flag excludes this plugin from production
  catalogs until interoperability testing and minimum supported core version are
  finalized. Development catalog scanning strips that build-only field.
- See `docs/architecture/tv-sharing-plugin-spec.md` and
  `docs/superpowers/plans/2026-10-03-tv-sharing.md`. LG is a test device, never an
  implementation dependency. Real-TV validation and formal certification are not
  implied by passing software tests.

### Collections

- `server/src/collections/collection-repo.ts` and migration `038_collections.sql`
  store stable, never-reused collection IDs and explicit photo membership. These
  collection-specific tags are independent of imported/AI tags. Favorites uses the
  existing engagement flag. Original files are never moved or changed.
- Authenticated `/api/collections` routes support creation, rename, deletion,
  paginated photos and batch membership. Folder additions are atomic snapshots of
  currently visible photos, optionally recursive; future scans do not add members.
  Normal source, deletion-mark and companion visibility rules apply.
- Your Library → Folders / Collections tabs are in `HomePage.tsx`; `/collections`
  opens the Collections tab. `CollectionsPage.tsx` embeds `CollectionPhotoPicker.tsx`
  to add individual photos immediately on click, with a separate explicit folder-snapshot
  action. Collections open as folder-style cards; the picker reuses FolderCard thumbnails.
  Successful additions persist when the picker closes; stack members are expanded.
  `CollectionCard.tsx` uses a bounded six-photo membership page for covers and the
  shared hover-preview rotation; empty collections retain their icon.
  `CollectionPicker.tsx` also adds folder
  snapshots, selected photos, or a photo from Viewer → Info. Client batches explicit
  selections in groups of 1000. Repeating additions/removals is safe.
- TV settings explicitly select stable collection IDs or `favorites`. Core broker
  API v2 provides selected names and authorized membership pages. The optional
  plugin presents `c:<id>` and `c:<id>:p:<mediaId>` DLNA aliases. Delivery rechecks
  the originating collection even if another share also grants the photo. Renaming
  retains links; deleting a collection prunes its saved selection on settings load.
- Collection sharing includes future explicit additions (and future favorite stars),
  independently of folder shares. TV still excludes video, Apple Photos, unavailable
  sources and marked photos. See `docs/architecture/collections.md`.

### Photo viewer loading

- `client/src/components/ProgressiveImage.tsx` shows the indexed thumbnail while
  `utils/loadImage.ts` loads and decodes the original or RAW preview selected by
  `utils/mediaSrc.ts`. Navigation cancels pending updates; errors retain the cached
  thumbnail and trigger the existing unavailable-original notice.
- Thumbnail paint alone must not trigger the viewer's next-photo preload or People
  requests. Release that gate after the larger image is ready, or after it fails
  with an available thumbnail. Keep navigation controls above the image hit area.
- Validate delayed success, failed originals, and navigation during decoding, using
  isolated local data/cache. Video and Live Photo playback use their existing paths.

### AI and face grouping details

- AI Runtime is a Python service receiving JPEG bytes/text over authenticated
  loopback HTTP. It does not receive original media paths or open core SQLite.
  `server/src/providers/plugin-ai-provider.ts` and
  `server/src/vectors/plugin-vector-index.ts` bridge core to plugins.
- Runtime code: `plugins/optional/com.memorylane.ai-runtime/python/memorylane_ai/`.
  Start with `main.py`, `face_model.py`, `cluster.py`, `clip_model.py`, and `config.py`.
- Default faces: YuNet detector + SFace embeddings (`yunet-sface`). Optional ArcFace:
  SCRFD-10G detector + ArcFace-R50 embeddings (`buffalo_l`), loaded through ONNX Runtime.
  Source already uses model repository `immich-app/buffalo_l`. This does not establish
  equivalent preprocessing, thresholds, clustering, or results to the Immich app.
- Default CLIP model is `Xenova/clip-vit-base-patch32`. Model downloads occur as needed;
  loading, runtime health, and model availability are separate failure points.
- `server/src/media/analysis-input.ts` produces oriented image JPEGs up to 1600px;
  RAW uses an existing preview with thumbnail fallback. Face analysis applies to
  image/RAW records with completed thumbnails, not video.
- `faces.ts` checks runtime/model availability, stores detected rows and vectors in
  model-specific spaces, and calls incremental person assignment. An empty detection
  result can still be marked done. Changing the selected model changes analyzer
  version and causes stale analysis to be requeued.
- `person-service.ts` combines nearest-neighbor assignment and centroid checks with
  discovery of unassigned quality faces. Python `cluster.py` uses Chinese Whispers
  over thresholded cosine similarities. Settings control assignment/link thresholds
  and minimum cluster size. Regrouping preserves user-confirmed assignments,
  names, and rejections; keep those semantics when improving grouping.
- AI Search and People depend on optional plugins and settings; check both capability
  availability and feature enablement. Plugin lifecycle lives in
  `server/src/plugin-platform/`; distinguish it from feature-specific plugin adapters.

## Backlog source of truth

Use the existing, already-triaged MemoryLane issues for scope, priority and status.
The personal `$membacklog` skill records the connector, account and workspace details.
Keep those private connection details out of this public repository and PR descriptions.
Do not recreate or re-triage the chat feedback list unless requested. Chat item numbers
can differ from ticket numbers; read live tickets before starting work or reporting status.

Technical investigation pointers (not a separate backlog):

- Maps: online tiles are implemented in the current working tree, with attribution,
  an offline switch and Natural Earth fallback. Keep map attribution visible;
  Settings → About contains additional map credits and license/policy links.
  Validate before treating as released.
  Apple source options remain static; inspect plugin visibility before changing them.
- Faces: reproduce detection failures separately from split/merged identities. Review
  the face pipeline above, quality thresholds and confirmed-assignment preservation.
  An Immich-hosted model alone does not imply equivalent recognition behavior.
- Gear: `gearMinPhotos` is a saved default (50; 0 disables filtering) under
  Settings → Plugins → Gear Museum, shared by camera/lens listings. Museum and
  Timeline allow per-visit overrides even with empty results. For the small local
  validation library use 1. Timeline years currently descend. The timeline header
  uses `z-20`; the global navigation uses `z-40` so its dropdown remains above it. Lens
  summaries and camera/lens switches exist in both Museum and Timeline. Lens museum
  cards open a photo detail panel and link to lens-filtered reports. Both views use
  the saved gear threshold. Optional enrichment requests time out after five seconds.
- Portability: one server can serve multiple browser devices. Shared SQLite writers,
  folder renames and original-root relocation require identity-preserving designs.
  `/api/scan-roots/:id/move` changes display order, not original file locations.
- Keyboard zoom: the map handles +/- and arrows; the photo viewer's key handler
  currently handles navigation, close and slideshow, not zoom.

## Development and verification

Requirements: Node 20+, npm 10+; Go 1.25+ for tray development; Python 3.11–3.13
for optional runtime development. Use an isolated test data directory/library when
running work that scans, migrates, or mutates application data.

| Command | Purpose |
| --- | --- |
| `npm install` | Install workspace dependencies. |
| `npm run dev` / `npm run dev:client` | API on 4280 / Vite on 5173 in separate terminals; Vite proxies API requests. |
| `npm run build` / `npm start` | Build SDK → shared → client → server, then run built server. Client output is `server/public`. |
| `npm run build --workspace=client` | Refresh UI served by a production-style server after UI-only edits. |
| `npm run typecheck` | Boundary check, dependency builds and workspace typechecks. |
| `npm test` | Builds/tests plugin SDK and runs server Vitest tests; **does not run client tests**. |
| `npm test --workspace=client` | Client Vitest tests, including localization parity. |
| `npm run boundaries:check` | Core/plugin architecture boundary validation. |
| `go -C tray-go test ./...` | Tray tests when applicable. |
| `npm run ai` | Prepare private Python environment and launch AI Runtime for source development. |

Python test setup/command: see
`plugins/optional/com.memorylane.ai-runtime/python/README.md` (`.venv/bin/pytest -q`
from that Python directory after installing development dependencies).

Useful existing regression coverage:

- Map: `client/src/utils/location-map.test.ts`, `server/test/locations/`,
  `server/test/api/location-routes.test.ts`.
- EXIF timeline: `server/test/api/timeline-routes.test.ts`.
- EXIF moments: `server/test/moments/detect.test.ts`,
  `server/test/api/moments-routes.test.ts`.
- People: `server/test/analysis/faces-analyzer.test.ts`, `server/test/persons/`,
  `server/test/api/persons-routes.test.ts`, `client/src/pages/PeoplePage.test.tsx`,
  runtime Python `tests/test_faces.py`, `tests/test_arcface.py`, `tests/test_contract.py`.
- Storage/scanning: `server/test/api/data-dir.test.ts`, `server/test/scanner/`,
  `server/test/db/migrations.test.ts`.
- Plugin integration: `server/test/plugin-platform/`, `server/test/providers/`,
  `server/test/api/apple-photos-visibility.test.ts`.
- Run checks appropriate to the change. UI overlap, focus, zoom and timeline changes
  also need browser verification; passing typechecks alone do not validate rendering.

## Private local photo validation set

`local-test-library/` is Git-ignored personal test data, not a redistributable fixture
or a CI dependency. Its `originals/` subdirectory contains 60 unmodified photo copies
with source-relative folders preserved. The set spans embedded capture years
1995–2026, 23 camera models, and six GPS-tagged files. Extensions: JPG/JPEG, PNG,
NEF, CR2, CR3, ORF, ARW, RAF, DNG, TIF/TIFF. HEIC/HEIF were not found in the source
archive and remain a coverage gap. Do not fabricate them by changing extensions.

Read `local-test-library/README.md` for use and coverage counts. The private
`manifest.json` records selected source paths, EXIF metadata, byte sizes and verified
SHA-256 hashes. Keep it and all personal photos out of commits and published artifacts.
Use the external-disk test storage configured in the ignored local `.env` as
`MEMORYLANE_DATA_DIR`, with `MEMORYLANE_PLUGIN_DIR` set to its `Plugins/` subfolder.
Keep index/cache, plugin data, npm cache and temporary build files on that external
disk. Do not reset data directories without explicit user authorization.
It also sets `MEMORYLANE_PLUGIN_CATALOG_URL` to the official stable darwin-arm64
catalog so this checkout can install released native plugins. Without a catalog,
source development discovers plugin manifests but requires their native executables
to be built separately; missing `bin/` executables caused startup error -2 here.
Use source-mode plugins only when intentionally developing/building those runtimes.
Scan only `local-test-library/originals/`, not the enclosing repository. Use separate
working copies for folder rename/relocation/trash experiments. This set supports
manual format, date, gear and location validation; it is not a labeled face benchmark,
and is not a substitute for a reviewed identity baseline. Initial core scan: all 60
files indexed and thumbnails generated, zero scan errors (32 RAW, 28 standard images).
Signed Apple Photos, AI Runtime, AI Search and People plugins are installed/enabled
for this local setup. Analysis feature settings are separate from plugin enablement;
model inference quality has not been validated. Private test credentials and validation results
are stored in the ignored test-library folder.

## Constraints to preserve

- Choose free projects, libraries, models, datasets and services whose licenses and
  usage terms are compatible with MemoryLane's MIT-licensed distribution and intended
  use. Verify the actual terms, including attribution, redistribution, commercial-use
  restrictions and service limits; a free tier is not the same as an open-source
  license. Check code, data/model licenses and hosted-service terms separately.
  When an established industry-standard option is relevant, suggest it alongside
  the compatible free choices and explain the practical benefits, costs and license
  tradeoffs. Suggesting an option does not authorize adopting incompatible terms or
  incurring charges. Document chosen dependencies in `THIRD_PARTY_NOTICES.md`.
- Normal scanning/indexing must leave originals untouched. Existing explicit mutation
  workflows include video-modernization replacement and reversible cleanup/trash.
  `CLAUDE.md` states a stricter original-read-only rule mentioning only video;
  preserve the existing cleanup behavior and treat new folder mutations as a product
  decision, not an incidental extension of scanning.
- Core owns shared SQLite/migrations; plugins use core APIs and may own separate data.
  Preserve shared source visibility rules, especially disabled Apple Photos records.
- Service plugins bind to loopback and authenticate with host-provided tokens. Do not
  expose plugin bearer tokens to the browser or replace byte-based AI input with paths.
- Keep generated runtimes, installers, model caches, catalogs, virtual environments,
  executables and credentials out of Git. Update `THIRD_PARTY_NOTICES.md` for added
  dependencies, native tools, models and redistributable fixtures. Optional InsightFace
  pretrained models have non-commercial research restrictions and require explicit
  selection/terms before download; do not silently make them the default.
- New UI text follows `docs/localization.md`: semantic translation keys, English source
  plus Spanish/French resources, locale-aware formatting, and parity checks.
- Verify the user-requested Git identity before publishing. Do not change global
  identity or store credentials here.
- Never credit AI tools or providers (including Claude, OpenAI, ChatGPT or Codex) as
  developers, authors or co-authors in commits or PRs. Do not add AI `Co-authored-by`
  trailers, bot authorship, or generated-by attribution. Use the user's configured
  human Git identity and verify commit author/committer and PR text before publishing.

### Background RAW preview upgrades

- Native-resolution embedded previews are selected by pixel area, not tag order.
  `media/preview-upgrades.ts` owns the persistent priority queue (migration 039);
  its child worker performs extraction/native decoding with a 60-second deadline.
  Old previews remain until an atomic larger replacement succeeds. Version bumps
  invalidate TV derivatives; the Viewer polls progress and refreshes its source.
- New TV settings default to 4K/2048 MiB; saved settings are preserved.
  Settings Storage includes separate RAW preview and TV delivery cache sizes.
  See `docs/architecture/preview-upgrades.md` for bounds and decoder limitations.
