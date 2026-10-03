# TV Photo Sharing plugin — DLNA design specification

## Status and intent

Implementation specification, dated 2026-10-03. Initial implementation is in development; hardware interoperability and production release remain unverified.

Allow a household to discover MemoryLane on any TV or media client that supports DLNA photo browsing, browse explicitly shared photo folders with its remote, and use its native photo slideshow without installing a TV app, copying originals, or using a paid cloud service. The implementation must be vendor-neutral and standards-based. LG 65UR9000PUA is only the first available test device, not the product target or a required brand. LG lists it as webOS 23; record its installed firmware during testing. DLNA photo support and slideshow controls differ across clients, so the broad compatibility goal is distinct from the verified-device list.

## Recommended first release

Optional plugin named TV Photo Sharing (DLNA), proposed ID com.memorylane.tv-sharing. Installation does not enable sharing. The first release serves photos through UPnP AV/DLNA-style network browsing; the TV owns its browsing UI, slideshow timing and transitions.

Settings → Plugins → TV Photo Sharing: enable/disable, friendly server name, network interface, explicitly selected indexed folders, include subfolders, 1080p/4K image quality, cache usage/limit, and service status. Default: disabled, no selected folders, 1080p. A folder selection includes future eligible photos within that scope; state this in the UI. No implicit whole-library sharing.

Each shared folder includes a virtual “All photos — including subfolders” collection.
The plugin walks the existing authorized folder API, deduplicates photos, and exposes
a flat paginated list for the TV slideshow. Only permitted descendants are included.
Collections are bounded to 40,000 photos, 10,000 queued folders and 2,000 API pages;
traversal has an eight-second budget. Larger trees fail rather than silently truncate.
The plugin caches up to eight collections for 30 seconds, invalidating on core config
or catalog revision changes; original photo delivery remains authorized by core.

User flow: install → choose folders and interface → enable sharing → open the TV’s network-media browser → select MemoryLane → folder → photo → TV slideshow. Document generic setup first, with tested model-specific menu examples in a separate compatibility guide.

First release supports indexed filesystem photos, including NAS-backed folders and RAW/HEIC formats that MemoryLane can decode. Exclude videos, Live Photo motion, Apple Photos sources, hidden/trashed/missing media and unsupported conversions. Show a shared-photo count and conversion failures in Settings.

## Scope boundaries and alternatives

No phone-initiated casting, TV power control, custom captions/transitions, native webOS app, remote internet access, Cast, AirPlay, or cross-subnet discovery in v1. Favorites, date-based collections and saved selections are follow-ups; they require explicit collection ownership and visibility rules.

An integrated plugin is recommended because it can reuse MemoryLane’s index and selected-content policy. A standalone UPnP server such as Gerbera is an established reference and possible prototype peer, but would introduce packaging and catalog integration work plus its own license obligations. Do not embed third-party server code under the project’s MIT license without checking the exact component license.

A dedicated webOS/browser receiver is a future option if a custom slideshow experience matters more than native TV browsing. Google Cast is a separate ecosystem and is not assumed to be supported by this TV.

## Architecture and required core extensions

Existing code: server/src/plugin-platform supervises signed optional plugins; plugin-sdk/src/capabilities.ts defines a closed set of capabilities. No TV-sharing capability or generic catalog-browsing contract currently exists. Core owns SQLite, source visibility and media conversion; the plugin must not open core SQLite or independently scan originals.

The implementation is a module plugin with two separate planes: plugin-identity-bound IPC to the core broker, and an explicitly configured LAN HTTP listener plus SSDP discovery. Existing service plugins retain their authenticated loopback contract. The broker authorizes only the TV plugin and returns no source paths. Module plugins remain trusted installed code, not an OS sandbox.

Add a versioned core broker contract for paginated shared-container browsing, media eligibility, catalog revisions and generated JPEG retrieval. Broker authentication is plugin-scoped; it must not reuse a browser session or expose administrative endpoints. Exact transport and schema are implementation-plan decisions. This is a core-plus-plugin change, not a plugin-only drop-in.

Core evaluates the selected-folder policy on browsing and on every new image request, including cached requests. Responses expose stable opaque IDs, display titles and generated-image references, never absolute filesystem paths. The plugin translates these into UPnP catalog objects and LAN URLs.

Core generates bounded JPEG derivatives using existing RAW/media services. Store derivatives under the configured MemoryLane data directory, preserving external-drive placement and data-move behavior. Plugin configuration/state stays in its managed directory; no full-resolution cache on the system disk by default. No duplicate scan or persistent copy of originals.

## Protocol and network behavior

Support SSDP discovery/advertisements on the selected private LAN interface, a persistent device UUID, device/service XML descriptions, ContentDirectory Browse metadata/direct children with pagination, ConnectionManager protocol information, and required eventing/state behavior for the advertised UPnP service versions. Advertise only operations and image profiles actually implemented; validate against OCF UPnP AV specifications.

Serve JPEGs over a dedicated HTTP endpoint with correct MIME type, content length, GET/HEAD and any range behavior advertised. Include thumbnails and truthful dimensions/protocol metadata. Escape filenames in DIDL-Lite XML, use deterministic ordering and stable object IDs, bound request sizes, and disable XML external entity resolution.

Select a stable configurable TCP port after checking existing port allocation. Surface bind conflicts and firewall/multicast problems. Do not open router ports or enable UPnP Internet Gateway port mapping. Initial scope is one explicitly selected private IPv4 LAN interface, with HTTP and subscription peers restricted to that interface’s local subnet. Exclude VPN/tunnel/public interfaces by default, and re-evaluate binding/admission after address changes. No WAN listener, reverse-proxy publication or automatic router forwarding. Do not trust forwarded headers for peer checks. Users must not forward this port externally; LAN-only behavior cannot guarantee privacy against a router or proxy deliberately configured to relay traffic. Discovery across guest networks/VLANs is not promised.

On disable/uninstall: stop advertisements, close the LAN listener and deny new image requests immediately. On restart, network change or wake: restore selected-interface binding and re-advertise only if sharing is still enabled. A plugin crash must leave the main app usable. Catalog changes increment update state; TV refresh/caching behavior needs real-device verification.

## Access and privacy contract

DLNA discovery, browsing and generated-photo delivery are intentionally unauthenticated and available only on the selected local network. The normal MemoryLane web UI/API and the plugin control channel retain their existing authentication. Enabling sharing must clearly explain that any device on that LAN can access selected photos and their titles; there is no per-TV identity, login or pairing guarantee. Do not present discovery or an IP address as secure identity or claim PIN pairing without a supported protocol.

Expose only the selected eligible photos, including through guessed object IDs and cached URLs. Opaque IDs are defense in depth, not authorization. Restrict requests and event subscription callbacks to the selected network; callbacks must not access unrelated hosts/services. Bound subscriptions, parsing, concurrency and response sizes.

Removing a folder or disabling sharing invalidates future access to its cached derivatives. Already delivered photos cannot be recalled from a TV. Derived JPEGs strip GPS and other EXIF metadata; catalog titles remain visible. Use sanitized diagnostic logs and never return source paths or service tokens.

## Image quality, caching and failure behavior

Generate oriented sRGB JPEGs fitted within 1920×1080 by default; offer 3840×2160 after target-TV validation. Preserve aspect ratio, avoid crop/upscale, and use a baseline JPEG encoding compatible with the tested TV. A 4K panel does not by itself verify 4K network-photo decoding.

Use a persistent bounded LRU derivative cache; proposed initial budget 1 GiB, configurable, with a low-disk guard. Key by media identity, source/thumbnail revision, output profile and encoder version. Never bypass current share eligibility because a derivative exists.

Prepare small browse thumbnails promptly and generate display images through a bounded queue, proposed two concurrent conversions. Reuse sufficient existing previews where practical; do not advertise a thumbnail as full-resolution output. Cold RAW/NAS reads may be slower than warm playback.

If the NAS is offline, permit a valid previously generated derivative for still-eligible media; otherwise return a clean failure and log a diagnostic. Failed conversions must not stall other images. Stop generation for removed shares; unsupported files are omitted or reported consistently.

## Validation and acceptance criteria

Hardware gate: on the LG 65UR9000PUA, record firmware, host OS and wired/Wi-Fi topology. Discover MemoryLane, browse nested folders, open portrait/landscape images, navigate back/next, and run a 30-minute slideshow. Verify 1080p, then optional 4K, rotation, aspect ratio and color. Do not declare support before this passes.

Use the existing small directly indexed NAS sample for JPEG and RAW tests; add separately authorized HEIC samples when available. Keep originals read-only and generated data on the configured external SSD. Record cold and warm timings; proposed warm targets are discovery within 10 seconds of opening the TV media browser, a 100-item browse response under 1 second, and a displayed cached photo under 2 seconds on a healthy LAN. TV timing and network conditions must be recorded.

Automated coverage: XML escaping, pagination/stable IDs, catalog changes, direct-ID authorization, cached-item revocation, invalid requests, callback restrictions, conversion/cache invalidation, bounded resources, plugin enable/disable/restart and failures. Verify default-disabled state exposes no TV listener or catalog.

Manual resilience checks: host sleep/wake, TV restart, NAS outage, interface change, port conflict, large folders, non-ASCII names, source deletion, share removal and two TVs browsing concurrently. Main app scanning/viewing must remain responsive.

Acceptance requires a vendor-neutral implementation with no LG-specific discovery, user-agent allowlist or mandatory LG API; no paid account or TV app; no original modification or unselected-photo exposure; clear settings/status/errors; compatible licenses/notices; and signed packaging for supported desktop platforms. Validate the LG plus an independent UPnP photo client before the initial release, and track additional TV makes/models as hardware becomes available. Describe the product as supporting DLNA photo clients while publishing which devices were actually tested; do not equate conformance with verified support for every television.

## Delivery stages and unresolved evidence

Stage 1: review this spec and verify target-TV discovery/browsing using a minimal standards-compliant prototype with a few generated JPEGs. Confirm profiles, eventing and media-player slideshow behavior before building the full integration.

Stage 2: implement core sharing policy/broker and opt-in network permission, then plugin discovery/catalog/HTTP delivery and Settings integration. Stage 3: add derivatives/cache and lifecycle tests; perform hardware validation; package and document.

Before implementation, settle broker transport/SDK versioning, exact port/profile declarations and dependency versions. Hardware answers still needed: installed TV firmware, behavior of native slideshow and catalog refresh, supported JPEG sizes, and measured LAN performance. These are validation tasks, not reasons to claim complete compatibility now.

Prefer MIT/BSD/Apache-licensed components where practical and check all transitive dependencies. node-ssdp (MIT) was considered for discovery; built-in Node UDP avoids adding that dependency. Do not claim formal DLNA certification or use certification marks without the corresponding authorization. The implementation uses Node built-in HTTP/UDP and a pinned vendored @xmldom/xmldom 0.9.12 (MIT, no runtime dependencies). Its license and provenance are included in the plugin. Core reuses existing Sharp/bmp-js decoding; no additional image library or third-party DLNA server is bundled.

## Sources

- [LG 65UR9000PUA official support/model identification](https://www.lg.com/us/support/product/lg-65UR9000PUA.AUS?tab=1)
- [LG webOS 23 sharing guide (general platform reference, not a target-model certification)](https://kr.eguide.lgappstv.com/manual/w23_mr2/global/Apps/w23_mr2_eu08/e_eng/share.html)
- [LG network file sharing guidance](https://www.lg.com/ae/support/product-help/CT20076005-1343800415347)
- [OCF UPnP MediaServer/MediaRenderer specifications](https://openconnectivity.org/developer/specifications/upnp-resources/upnp/mediaserver4-and-mediarenderer3/)
- [node-ssdp source and MIT license](https://github.com/diversario/node-ssdp)
- [Gerbera upstream project and licensing](https://github.com/gerbera/gerbera)
