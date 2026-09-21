-- CLIP text similarity alone labeled ordinary photographs as screenshots.
-- Keep user and imported screenshot tags, which have independent provenance.
DELETE FROM media_tags
WHERE source = 'ai' AND tag_id IN (SELECT id FROM tags WHERE name = 'screenshot');

-- The remaining scene-v1 labels remain valid after removing this one candidate.
-- Migrate their version in place so existing libraries do not reprocess every
-- image embedding merely to remove an obsolete label.
UPDATE media_tags
SET model_version = substr(model_version, 1, length(model_version) - length('scene-v1')) || 'scene-v2'
WHERE source = 'ai' AND model_version LIKE '%:scene-v1';

UPDATE media_analysis
SET model_version = substr(model_version, 1, length(model_version) - length('scene-v1')) || 'scene-v2'
WHERE analyzer = 'ai_tags' AND status = 'done' AND model_version LIKE '%:scene-v1';
