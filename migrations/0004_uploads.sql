-- ZIP uploads. A repository is either a public GitHub repository or an
-- uploaded archive. For uploads, gh_owner is '' and gh_repo is the upload's
-- name (unique per owner through the existing UNIQUE constraint); each
-- version's ref is the archive's file name and commit_sha its content
-- fingerprint. Existing rows are GitHub repositories.
ALTER TABLE repos ADD COLUMN source TEXT NOT NULL DEFAULT 'github';
