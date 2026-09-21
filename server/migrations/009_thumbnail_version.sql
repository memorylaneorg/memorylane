-- The /thumbnail and /preview routes serve at a stable per-media URL with a
-- 1-year immutable Cache-Control header, so once a browser has fetched a
-- photo's thumbnail it will never re-request that URL again - even after the
-- file on disk is regenerated (e.g. by the orientation fix in migration 008).
-- Add a version counter that bumps every time the thumbnail/preview is
-- regenerated, so the client can cache-bust by appending it as a query param.
ALTER TABLE media ADD COLUMN thumbnail_version INTEGER NOT NULL DEFAULT 0;
