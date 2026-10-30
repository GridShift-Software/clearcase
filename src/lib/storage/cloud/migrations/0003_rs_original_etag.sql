-- GRS-250: what the original-serving route reads without probing bytes. `etag` is the R2 object's ETag, for conditional
-- ranged reads (`onlyIf`); `media_family` is one of 'pdf', 'image', 'email-text', 'download', from the asset's media type
-- (src/lib/case-package/media.ts), so the delivery family is chosen without opening the object. Both are nullable: a
-- row written by the browser intake carries neither, and the bulk loader (scripts/originals/) fills them in.
ALTER TABLE rs_original ADD COLUMN etag TEXT;
ALTER TABLE rs_original ADD COLUMN media_family TEXT CHECK (media_family IS NULL OR media_family IN ('pdf', 'image', 'email-text', 'download'));
