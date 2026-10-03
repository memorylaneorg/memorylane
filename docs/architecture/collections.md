# Collections

Collections are named, explicit sets of indexed photos. A photo can belong to many
collections. Adding a folder takes a snapshot of its currently visible photos,
optionally including descendants; future scans do not change that membership.
Favorites is a built-in collection using the existing favorite flag.

Core owns stable collection IDs and a many-to-many membership table. These act as
collection-specific tags, separate from imported/AI tags so analysis cannot change
membership. Renaming retains the ID. Removing membership or deleting a collection
never changes an original file. Existing source/deletion/companion visibility rules
apply to additions and browsing.

The optional TV plugin exposes explicitly shared collections and Favorites as flat
containers. Core provides authorized paginated membership; the plugin creates DLNA
containers and photo aliases. Sharing a collection grants access to its eligible
members independently of folder sharing. Every delivery rechecks current membership,
selection, source availability and plugin state, including cached derivatives.
New explicit members of a shared collection become shared; this is stated in settings.

No new dependency or external service is required. Existing folder browsing and
All photos shortcuts remain supported. UI strings are localized in English, Spanish
and French. Work and validation use external storage; no production catalog reset.

## Collection-first browsing

Your Library has Folders and Collections tabs. The Collections tab offers creation
and opens each collection with an Add photos picker. The picker browses existing
folders and displays individual photo thumbnails (including expanded stack members).
Selections persist across folder navigation until explicitly added or cleared.
A separate Add all photos from this folder action takes an indexed snapshot, with
an explicit optional Include subfolders checkbox. Merely opening a folder adds nothing.
Both photo and child-folder pages can be loaded incrementally. Favorites remains
managed using the existing star controls.
