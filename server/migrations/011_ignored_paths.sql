-- Global (not per-scan-root) list of absolute folder paths the scanner should
-- never walk into - e.g. a Lightroom cache or a junk folder someone doesn't
-- want indexed. Global rather than tied to a scan_root_id since a path is
-- unambiguous on its own and the common case (ignoring a folder while
-- browsing it) shouldn't require the user to think about which scan root
-- it happens to fall under.
CREATE TABLE ignored_paths (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
