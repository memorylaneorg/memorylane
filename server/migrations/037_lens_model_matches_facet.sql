-- media.lens_model (shown in the Viewer's info panel, and used to build its
-- "see every photo with this lens" link to Reports) and media_exif.lens_id
-- (what Reports' own lens facet actually groups by) disagreed on which EXIF
-- tag to prefer - media.lens_model preferred LensModel, media_exif.lens_id
-- preferred LensID. On Canon bodies these are often genuinely different
-- strings ("RF35mm F1.8 MACRO IS STM" vs "Canon RF 35mm F1.8 MACRO IS STM"),
-- so a link built from the displayed value silently matched zero photos in
-- Reports even though 107 photos used exactly that lens. Both already exist
-- in the database for every already-scanned photo, so this is a plain
-- backfill, not a re-scan - server/src/media/media-processor.ts is changed
-- alongside this migration so newly scanned photos store the same value in
-- both places going forward.
UPDATE media
SET lens_model = (SELECT lens_id FROM media_exif WHERE media_exif.media_id = media.id)
WHERE EXISTS (SELECT 1 FROM media_exif WHERE media_exif.media_id = media.id AND media_exif.lens_id IS NOT NULL);
