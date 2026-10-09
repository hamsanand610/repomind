# ADR 0002: Capacity-based repository admission

- **Status:** **Proposed**, 2026-10-09. Not implemented. Production limits are unchanged.
- **Evidence:** [E1 results](../e1-results.md).
- **Supersedes, if accepted:** the fixed "1,500 files / 1,500 chunks / 400 KB / 40–80 lines" limits from Phase 0/1.

## Problem (measured in E1)

| Proposed limit | Conflict found |
|---|---|
| 1,500 files **and** 1,500 chunks | Files average 4.0–11.9 chunks, so the chunk cap runs out after about 130–375 files. The file cap never binds. |
| ~400 tokens **and** 40–80 lines | The token budget binds first: median chunks are 26–34 lines and only 0–0.3% reach 80. |
| 400 KiB per file **vs.** the repository budget | One 405 KB file needs 356 chunks, about 24% of the repository budget. The cap applies to raw bytes, so a CRLF copy of a near-limit file can exceed it while the LF copy does not. |
| Vectorize 5M stored dimensions **vs.** "N repositories" | 1,500 chunks use 7.7% of the Free storage at 256 dims and 30.7% at 1024. The number of repositories that fit depends on dimensions and on each repository's size, so no fixed number can be promised. |
| `ChunkBudget` counter in the pipeline | Which file overflows depends on processing order. With concurrent queue consumers the outcome would be nondeterministic. |

## Decision (proposed)

### 1. One primary budget: chunks per repository

- The repository's capacity is a **chunk budget `C_repo`**, provisionally 1,500. Files are not a separate product limit, because every non-empty file needs at least one chunk.
- A **planning ceiling** remains purely as CPU/memory protection, for example on the number of tree entries considered. Its value is set from the E2 `plan` stage. It is an operational guard, not a promise.

### 2. Chunk shape is a character budget with a line ceiling

- **Character budget:** 1,400 characters, which is about 400 estimated tokens. 1,792 characters (about 512 tokens) is the candidate.
- **Line ceiling:** 80 lines.
- **Boundary preference:** "40 lines" stops being a target. It only governs whether a structural cut is preferred.
- **When decided:** the character budget is chosen in **M3 by retrieval evaluation**. Admission estimates are recomputed from it.

### 3. Per-file limits relative to the budget

A file is skipped, with its reason recorded, if either:
- its raw bytes exceed `F_bytes` (400 KiB now; 200 KiB is under consideration, affecting about 1–2% of files); or
- its estimated chunks exceed **`S` = 10% of `C_repo`** (150 chunks at 1,500, about 170 KB of code). The reason recorded is `exceeds_repository_share`.

A file is never partially indexed.

### 4. Global capacity ledger (account-wide)

The ledger tracks:
- Vectorize stored dimensions in use: active vectors × dimensions;
- today's estimated Neurons;
- D1 rows written today.

A repository is admitted only if its *conservative* estimate fits under each remaining allowance minus a **10% reserve**. When capacity is short, the answer is **"capacity unavailable"**, not "repository too large". The user is told what would free capacity, such as deleting an index or waiting until 00:00 UTC.

### 5. Admission algorithm (before any content is fetched or embedded)

The inputs are paths and sizes: from the GitHub tree API (sizes per blob) or from a ZIP's central directory. ZIP sizes are untrusted and are re-checked during extraction; a mismatch skips the file.

1. **Plan:** normalise and classify the paths (existing `planRepository`).
2. **Estimate per file:** `est_i = ceil(bytes_i / B_low)`, where **`B_low` = 950 bytes per chunk**.
   - This is deliberately below the lowest measured mean of 1,127, so estimates run about 19–28% high on the E1 corpora (1,127, 1,147 and 1,219 B per chunk).
   - A range is also reported using `B_high` = 1,250.
3. **Apply per-file limits** (section 3).
4. **Sum** the conservative and range estimates.
5. **Decide:**

   | Outcome | When |
   |---|---|
   | **Full** | conservative estimate ≤ `C_repo` and the ledger fits it |
   | **Partial (offered)** | `C_repo` < estimate ≤ 4 × `C_repo`. Files are selected by **priority tier**, then in path order, first fit. The user must confirm. |
   | **Rejected: too large** | estimate > 4 × `C_repo`, planning ceiling exceeded, or no indexable files |
   | **Deferred: capacity** | the selection does not fit the global ledger |

6. **Record the plan before processing:** store the admitted file set, the per-file estimates and the budget in D1, under the index version. This record is the contract.

### 6. Deterministic enforcement under concurrency

This replaces the shared `ChunkBudget` counter.

- **Text stage** (parallel): every admitted file is chunked and its rows are stored. Nothing is embedded yet.
- **Finalise step** (one invocation):
  - Walk files in **priority-then-path order** and accept them while the actual chunk total ≤ `C_repo`.
  - Overflow files are excluded with `over_repository_budget`, and their rows are deleted.
- **Embed stage:** runs only for accepted chunks, so no Neurons or vectors are spent on excluded files.
- **Result:** the same commit and settings always produce the same indexed set, regardless of queue order or retries.

### 7. Priority tiers (path-based and deterministic)

| Tier | Contents |
|---|---|
| T0: orientation | Root README/LICENSE/CONTRIBUTING; manifests (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, …); root build and config files; `docs/**/*.md` |
| T1: primary source | Code outside test, example, fixture and benchmark paths |
| T2: tests | `test/`, `tests/`, `__tests__/`, `spec/`, `e2e/`, `*.test.*`, `*.spec.*`, `*_test.go`, `test_*.py` |
| T3: auxiliary | `examples/`, `samples/`, `fixtures/`, `benchmarks/`, `scripts/`, other text |

### 8. Explainable admission report (stored and shown)

- **Decision and reasons,** for example:
  > "Needs about 4,800–6,300 chunks; the per-repository budget is 1,500. RepoMind can index the README, docs, manifests and `src/` (about 1,420 chunks). It will skip `tests/` and `examples/` (about 3,900 chunks). Answers will not cite skipped files."
- **Counts:** tree entries, indexable files, and skips by reason.
- **Totals:** indexable bytes, the estimate range, and the budget used.
- **Excluded files:** listed with reason and estimate, plus totals per directory.
- **After ingestion:** the report is updated with actual counts. Admission is an estimate; enforcement is exact.

## Guarantees vs. estimates

| Guaranteed (enforced in code) | Estimated (communicated as ranges, never promised) |
|---|---|
| Never more than `C_repo` chunks per repository | Chunk count before ingestion (`B_low` to `B_high` range) |
| Never more than the per-file byte and share caps | Neurons per repository; local timings |
| Never a partially indexed file | How many repositories fit in Vectorize Free. The UI shows capacity used (%), never "N repositories left". |
| Every excluded file has a recorded reason | Whether a borderline repository fits before its text stage runs |
| Same commit and settings give the same indexed set | Exact D1 rows written (D1 metering for FTS5 is unknown) |
| Admission never exceeds the global ledger minus a 10% reserve | — |

## Deliberately undecided

These wait for M3 retrieval evaluation and E2/E3:
- Embedding dimensions: 256, 384, 512 or 1024.
- The character budget: 1,400 or 1,792.
- The final values of `C_repo`, `S`, `F_bytes` and the planning ceiling.
- Whether partial indexing is offered at all, or simply rejected, for the MVP.

## Consequences if accepted

- **M2 code changes:**
  - `planRepository` takes sizes and returns an admission plan.
  - `ChunkBudget` is replaced by the finalise step.
  - Priority tiers and the admission report are added.
  - All of this comes with tests.
- **M5 UI:** shows the report before ingestion starts, and repository capacity as a percentage.
- **Docs:** ADR 0001's limit references and README wording are updated to "capacity-based".
