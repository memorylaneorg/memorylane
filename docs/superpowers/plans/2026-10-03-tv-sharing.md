# Optional TV Photo Sharing Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** An optional, default-off DLNA photo server for generic TV clients, with selected-folder sharing on one local network.

**Architecture:** Isolate protocol/discovery in `plugins/optional/com.memorylane.tv-sharing`, loaded only through the plugin manager. Core remains the sole catalog/policy/conversion owner. Use the existing supervised Node module host and a narrowly scoped asynchronous core bridge; this preserves IPC control isolation without adding a second executable or weakening existing loopback service authentication.

**Tech Stack:** Node HTTP/UDP/crypto/filesystem primitives; pinned MIT-licensed @xmldom/xmldom 0.9.12 within the optional package; existing core SQLite/Sharp; React Settings UI.

**Spec:** `docs/architecture/tv-sharing-plugin-spec.md`.

## Global constraints

- Vendor-neutral UPnP AV photo browsing; LG 65UR9000PUA is only the first hardware test.
- Optional installation; sharing disabled until an explicit interface/folder selection.
- Unauthenticated selected-photo access on one private IPv4 subnet; ordinary web/API authentication unchanged.
- No direct plugin SQLite access, original mutation, public interface, router port mapping, TV-brand allowlist, paid account, or cloud dependency.
- Metadata-stripped oriented JPEGs: 1920×1080 default, optional 3840×2160; cache on configured core data drive, initial budget 1 GiB and two conversion jobs.
- MIT-compatible licenses and notices; no AI authorship credits.
- Do not publish this plugin in a production catalog until the core integration and hardware gate pass.

## Review focus

- Removed selections must invalidate cached-image access (task 2).
- Stale DHCP/interface addresses must stop serving on the former network (tasks 1, 3).
- Malformed XML, oversized pagination and cross-subnet callbacks must be rejected without unbounded work (task 1).
- NAS outages/large RAW files must not block metadata browsing or unrelated app work (task 2).
- Missing plugin or failed activation must leave ordinary core startup/settings operational (task 3).

## Task 1: Isolated protocol engine and optional plugin lifecycle

Files: new plugin `manifest.template.json`, `module/{index,network,protocol,server,discovery}.mjs`, `vendor/xmldom/`, `licenses/`, `test/*.test.mjs`; update third-party notices and package build exclusions where needed.

Interfaces: adapter `browse({objectId,flag,start,count,sort}) -> {items,total,updateId}` and `image(id,profile) -> {bytes,contentType}`. Every adapter call must enforce current policy in task 2. Catalog items contain opaque IDs, parent IDs, title, kind (container/photo), optional childCount and JPEG dimensions. Server takes a selected {address,netmask}, port, persistent UUID, friendlyName and adapter. It returns {port,stop}; no socket opens at import/activation.

- [ ] Write failing tests for private-subnet checks, XML escaping/parsing and pagination limits; run `node --test plugins/optional/com.memorylane.tv-sharing/test/*.test.mjs`.
- [ ] Pin parser and preserve its MIT license; record archive hash and no runtime dependencies. Use Node UDP for SSDP, avoiding a second third-party dependency.
- [ ] Implement device/SCPD XML, ContentDirectory Browse, required simple actions, ConnectionManager, bounded HTTP image GET/HEAD, event subscription validation, and SSDP advertisements/search responses. Reject XML declarations with DTD/entities, unsupported actions and nonlocal peers.
- [ ] Test unauthenticated photo delivery through a fake allowlisted adapter, HEAD, denied objects, malformed SOAP, event callback restrictions, stop/restart and no sockets on activation.
- [ ] Add optional manifest (`required:false`, no dependencies) and versioned bridge availability check. Stop sockets on disable/unload. Validate manifest via SDK and production packaging; keep engine disconnected from real catalogs until task 2.
- [ ] Commit this independently tested foundation. This stage alone is not a usable TV library feature.

## Task 2: Core sharing policy, catalog bridge and derivative cache

Files: new `server/src/tv-sharing/{settings,broker,images}.ts`, tests under `server/test/tv-sharing/`; extend `server/src/plugin-platform/{module-host,module-host-client,manager}.ts`; contract in `plugin-sdk/src/tv-sharing.ts`.

Interfaces: `TvSharingBroker.call(pluginId, operation, payload)` supports versioned config, browse and image operations only for the installed/enabled TV plugin. Plugin context receives `callCore(operation,payload)` over IPC; host validates plugin identity/operation and limits outstanding requests. Image bytes are transferred with bounded size, never source paths. Broker reads core settings on every call and returns denied when sharing/plugin is disabled.

- [ ] Test default-off/no selections, recursive vs direct selected folders, overlapping selections, guessed media IDs, hidden/deleted/missing/Apple/video exclusion, and cache revocation after removal.
- [ ] Implement validated persisted settings and stable opaque catalog IDs with deterministic pagination. Reuse existing media visibility and source predicates. Folder selection explicitly covers future eligible images.
- [ ] Test orientation, JPEG metadata removal, quality profiles, stale source revisions, cache budget/low disk, concurrency 2 and NAS unavailable fallback.
- [ ] Implement core-owned derivative generation/cache, within dataDir, using existing RAW preview and Sharp paths; measure warm/cold timings.
- [ ] Test authenticated bridge identity and reject unknown methods/plugin IDs; wire config/browse/image callbacks and catalog update revision to plugin.
- [ ] Verify data-move integration and no runtime parser/DLNA load when plugin absent; run SDK/core tests and typecheck; commit.

## Task 3: Settings, activation and packaging

Files: new `server/src/tv-sharing/routes.ts`, `client/src/components/TvSharingSettings.tsx`; integrate AppContext/app/server, settings page and API client; en/es/fr translations; optional plugin packaging and docs.

- [ ] Test route auth, invalid/public/interface addresses, missing plugin, empty selections and enabling without explicit configuration.
- [ ] Add authenticated settings endpoints plus private-interface enumeration; expose friendly name, selected indexed folders/recursion, quality/cache limit, diagnostics and sharing toggle. Explain that any LAN device can view selected photos.
- [ ] Implement live plugin configuration and disable/revoke semantics. Persist UUID, reconcile startup/address changes/wake, report port errors and stop serving if configured interface disappears.
- [ ] Test installation alone opens no listener, enable/disable/restart/uninstall closes/reopens exactly the intended sockets, plugin failures do not fail main startup, and UI localization parity.
- [ ] Build signed-development artifacts for supported platforms with parser/license included and tests/source excluded. Set minimum core version to the first release containing the bridge before publishing; no misleading compatibility with older core.
- [ ] Update architecture/AGENTS, run build/typecheck/targeted tests, review the whole branch, commit and create PR.

## Task 4: Interoperability and release gate

- [ ] Software integration tests with an independent UPnP client and catalog containing nested folders/non-ASCII names/large counts; validate advertised service/profile versions.
- [ ] On LG test device record firmware and verify discovery, remote browse, portrait/landscape images and 30-minute slideshow at 1080p; separately verify 4K.
- [ ] Test host sleep/wake, TV restart, NAS outage, address change, guest-network isolation, two clients, port conflict and sharing revocation. Record warm targets (10 s discovery, 1 s/100-item browse, 2 s photo) and cold observations.
- [ ] Publish tested-device matrix and generic setup instructions, with model-specific menus only as examples. Mark untested devices unverified; no formal DLNA certification claim.
- [ ] Release only when protocol, permission, packaging and real-TV gates pass. Keep issue In Progress until merge; do not equate merge with release.

## Execution status

User authorized planning and implementation together. Proceed inline through software tasks; record hardware checks as pending until the TV is available. No LAN sharing is enabled as part of writing this plan.


## Implementation checkpoint — 2026-10-03

Implemented the protocol engine, module IPC broker, current-folder authorization,
JPEG worker/cache, optional Settings panel and translations. This follows the module
plugin decision above; no separate loopback service or shared SQLite access was added.
The implementation files are `broker.ts`, `images.ts`, `image-worker.ts`, and `routes.ts`;
there is no separate settings service or SDK TV transport module.

Verified so far:
- 28 targeted server tests, including IPC identity/denial, RAW visibility, stale-folder
  disable, BMP conversion, stalled-read cancellation, parent-disconnect termination and data-directory cache migration.
- 32 client tests and workspace typechecks; server and client builds pass.
- Signed development packages build for macOS arm64 and Windows x64. Archive checks
  confirm parser/license inclusion and test exclusion. Windows runtime is untested.
- Production catalog excludes the plugin through `developmentOnly`; before removing
  this gate, set `requiresCore` to the first released core containing the broker.
- Browser installation in an isolated local library displays the panel with sharing
  off and no selected folders. Subsequent hardware testing used user-enabled LAN
  sharing; originals remain unmodified.

Remaining before release: independent UPnP-client interoperability, SSDP/network fault
scenarios, extended LG slideshow/4K/sleep-wake tests, timings, device matrix, and release
version/compatibility review. The detailed unchecked acceptance items above remain
open where they contain these broader scenarios; software unit coverage is not a
substitute for them. No production plugin was published.


## Hardware feedback and final software validation

On the LG 65UR9000PUA, the user confirmed discovery, folder browsing, photo playback
and native slideshow controls. The user also confirmed the new All photos entry is
visible. Continuous recursive slideshow across all pagination boundaries has not yet
been confirmed on the TV. The plugin-only collection has automated coverage for
more than 100 nested photos, scoped aliases, revocation and normal-folder offsets.
A live SOAP client verified a 60-photo recursive collection and JPEG delivery.

Final targeted checks: 28 server tests, 32 client tests and 12 plugin tests; workspace
typecheck passes. Save controls now distinguish pending edits from confirmed settings.
Production publishing stays gated; this development feature is ready for PR review,
not a declaration of support for every DLNA TV or completion of all release gates.
