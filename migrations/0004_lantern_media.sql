CREATE TABLE lantern_media (
  lantern_id  TEXT    NOT NULL REFERENCES lanterns(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  media_key   TEXT    NOT NULL,
  media_type  TEXT    NOT NULL,
  PRIMARY KEY (lantern_id, position)
);

CREATE INDEX idx_lantern_media_lantern ON lantern_media(lantern_id);

INSERT INTO lantern_media (lantern_id, position, media_key, media_type)
SELECT id, 0, media_key, COALESCE(media_type, 'image/jpeg')
FROM lanterns
WHERE media_key IS NOT NULL AND media_key <> '';
