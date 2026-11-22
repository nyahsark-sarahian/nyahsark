CREATE TRIGGER IF NOT EXISTS calibration_never_publish
BEFORE INSERT ON catalog_publish_commands
BEGIN
 SELECT RAISE(ABORT,'CALIBRATION_NO_PUBLISH');
END;

CREATE TRIGGER IF NOT EXISTS calibration_never_set_published_head
BEFORE UPDATE OF published_revision_id ON catalog_artwork_heads
WHEN NEW.published_revision_id IS NOT NULL
BEGIN
 SELECT RAISE(ABORT,'CALIBRATION_NO_PUBLISH');
END;
