-- Retrieval quality.
-- 1. Identifier-aware keyword search: chunks keep the words split out of
--    camelCase/snake_case identifiers, indexed in a second FTS column, and
--    the porter stemmer matches word forms ("verified" ~ "verify").
-- 2. When vectors were last written, to detect Vectorize's indexing delay.

ALTER TABLE chunks ADD COLUMN ident TEXT NOT NULL DEFAULT '';
ALTER TABLE versions ADD COLUMN vectors_upserted_at INTEGER NOT NULL DEFAULT 0;

DROP TABLE chunks_fts;
CREATE VIRTUAL TABLE chunks_fts USING fts5 (text, ident, tokenize = 'porter unicode61');
-- Existing chunks keep keyword search; their identifier words fill in on re-index.
INSERT INTO chunks_fts (rowid, text, ident) SELECT rowid, text, ident FROM chunks;
