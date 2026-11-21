-- OPTIONAL: apply only to a separately approved database. Never auto-migrated.
CREATE TABLE private_image_objects(
 object_key TEXT PRIMARY KEY CHECK(length(object_key) BETWEEN 1 AND 80),
 content_type TEXT NOT NULL CHECK(content_type IN ('image/png','image/jpeg','image/webp')),
 body BLOB NOT NULL CHECK(typeof(body)='blob' AND length(body) BETWEEN 1 AND 524288),
 created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE TRIGGER private_image_object_cap BEFORE INSERT ON private_image_objects
 WHEN (SELECT count(*) FROM private_image_objects)>=200
 BEGIN SELECT RAISE(ABORT,'IMAGE_COUNT_LIMIT'); END;
CREATE TRIGGER private_image_objects_immutable BEFORE UPDATE ON private_image_objects
 BEGIN SELECT RAISE(ABORT,'IMAGE_IMMUTABLE'); END;
