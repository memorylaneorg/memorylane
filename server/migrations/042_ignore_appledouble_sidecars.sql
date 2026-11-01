-- AppleDouble ._* files are filesystem metadata, not image/video originals.
-- Retain catalog identity and associations, but retire these accidental entries.
-- No source files are deleted or modified.
UPDATE media SET status = 'missing'
WHERE filename GLOB '._*' AND (source_kind IS NULL OR source_kind != 'apple-photos');
