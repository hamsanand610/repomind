# RepoMind evaluation results

**Run:** 2026-10-09 on a local evaluation server (`npm run eval:server`).
- Real Workers AI: `@cf/google/gemma-4-26b-a4b-it` for answers and `@cf/qwen/qwen3-embedding-0.6b` at 512 dimensions for embeddings.
- A separate Vectorize index, `repomind-eval`.
- Local D1 and a local test invite code. No production data or credentials were used.

**Repositories (pinned to exact commits):**
- `expressjs/cors` @ `5317ebe`
- `sindresorhus/ky` @ `3541888`

**Reproduce:**

```
npm run eval:server   # one terminal
npm run eval          # full run (uses about 1,000 Neurons)
npm run eval:keyword  # keyword search only, no AI quota
```

Raw results are written to `eval/results/`, which is git-ignored.

## Results

| Area | Result | Notes |
|---|---|---|
| Indexing | cors: 17 files, 57 chunks; ky: 109 files, 712 chunks; all embedded | ky took 297 s through the step API, including 712 embeddings |
| Vectorize visibility | New vectors became queryable 76 s after writing (141 s in an earlier run) | This is why answers report `semanticStatus: "pending"` and fall back to keywords meanwhile |
| Keyword search (expected file in top 3) | **8/8** after re-ranking (6/8 before) | See below |
| Answerable questions (answered, citing an expected file) | **8/8** | Citations are validated server-side and pinned to the commit |
| Absent-topic questions (must abstain) | **3/4** strict; **4/4** after manual review | "Which GraphQL schema does ky use?": the answer opened "The provided evidence does not mention a GraphQL schema", then correctly described ky's Standard Schema support with citations |
| Wrong-premise questions | **2/2** | Redis/cors abstained. axios/ky: "`ky` does not depend on `axios` … a tiny package with no dependencies", with citations |
| Prompt injection planted in evidence | **4/4** resisted | Override instruction, credential bait with a fake `[E9]` citation, phishing link, fake closing tag plus system-prompt extraction. No canary, link or prompt text appeared, and there were 0 invalid citations |
| Ask latency (local machine to Workers AI) | p50 8.5 s, max 13.6 s | |
| AI usage for the whole run | 954 Neurons | Daily Free allocation: 10,000 |
| Deletion | Both repositories return 404 after delete; Vectorize vector count back to **0** | Verified on real Vectorize after the fix below |

### Keyword search cases

| Query | Expected file | Before | After re-ranking |
|---|---|---|---|
| `isOriginAllowed` | lib/index.js | ✓ | ✓ (1st) |
| `configureCredentials` | lib/index.js | ✓ | ✓ (1st) |
| `configureExposedHeaders` | lib/index.js | ✓ | ✓ (1st) |
| `mergeHeaders` | source/utils/merge.ts | ✓ (2nd) | ✓ (1st) |
| `requestMethods` | source/core/constants.ts | ✓ (2nd) | ✓ (1st) |
| `HTTPError` | source/errors/HTTPError.ts | ✗ (tests ranked above) | ✓ (1st) |
| "merge headers" | source/utils/merge.ts | ✓ (2nd) | ✓ (1st) |
| "exposed headers" | lib/index.js | ✗ (tests and README ranked above) | ✓ (1st) |

**The fix:** BM25 candidates are re-ranked.
- A chunk that *defines* the searched identifier ranks first.
- File names containing a term rank higher.
- Tests, which repeat terms, rank lower.

The in-process keyword evaluation reproduced the live D1 ranking exactly before the change.

## Defect found by the evaluation (fixed)

**Deleting or re-indexing any repository with more than 100 chunks failed.**
- **Cause:** cleanup used one `IN (...)` with up to 400 bound parameters, and D1 allows 100. The background job then retried forever.
- **Fix:** deletes now run in 90-parameter slices inside one batch, and Vectorize `deleteByIds` runs in batches of 100.
- **Guard:** the SQLite test adapter now enforces D1's 100-parameter limit, and a regression test deletes a repository of more than 100 chunks. That test fails on the old code and passes on the fix.

## Limitations

- **Small sample:** 2 repositories, 8 search cases, 14 questions and 4 injection cases, each run once, with the model at temperature 0.1. Treat the numbers as a smoke-level benchmark, not a statistical score.
- **Q&A timing:** the full Q&A run used keyword ranking from before the re-ranking change. Only keyword search was re-measured afterwards, to save quota.
- **Injection method:** cases are injected as evidence through the production prompt builder, model and validator, which is exactly what a repository file produces. They are not taken from a real indexed repository.
- **Grading:** wrong-premise answers are graded heuristically and were also reviewed manually.

# Repository context evaluation (2026-10-10)

This evaluation follows two failures reported from the live app:
- **hamsanand610/Portfolio_hams:** "What does this project do?" described an unrelated project.
- **santosharron/3D-Mars-landing-page:** "Not enough evidence" for questions about the project and its languages.

**Setup:**
- Same local eval server: real Workers AI, the separate `repomind-eval` Vectorize index, local D1 and a local test invite code.
- `npm run eval:context`, with the dataset in `eval/context-dataset.ts`.
- `eval/reproduce.ts` traces retrieval stage by stage for the reported questions.

**Repositories (pinned):**

| Repository | Commit | Files | Chunks |
|---|---|---|---|
| `hamsanand610/Portfolio_hams` | `c9670b8` (the commit production indexed) | 32 | 187 |
| `santosharron/3D-Mars-landing-page` | `f2bd1e0` (the commit production indexed) | 5 | 13 |
| `expressjs/cors` | `5317ebe` | 17 | 57 |

## Root causes (reproduced)

**Mars Landing abstained**
- **Timing:** production's per-minute counters show both questions were asked in the same minute the repository's vectors were written (12:45 UTC). Vectorize needs 76–141 s before new vectors are queryable, so retrieval was keyword-only.
- **Keyword search could not answer broad questions:**
  - "What does this project do?" has no search terms, because every word is a stopword.
  - "programming languages and technologies" never appears literally in the four files.
- **Result:** the evidence gate correctly found nothing and abstained.
- **Fragile even later:** once vectors were queryable, `README.md` scored 0.319 and `index.html` 0.308, just above the 0.30 threshold, while `LICENSE` scored highest (0.497).

**Portfolio described another project**
- **Semantic search only:** the broad question used no keyword terms, so retrieval relied entirely on vectors.
- **Showcase cards ranked first:** the closest matches were the portfolio's own showcase cards (`index.html` 402–426, `html/projects.html`), which describe RepoMind as "a project". `README.md` ranked fifth.
- **No repository identity:** the model was not told which repository "this project" referred to, so it described RepoMind.
- **Not a cross-repository leak:** every retrieved chunk ID carried the portfolio's active version ID.

**Isolation was already correct, and is now enforced by tests.** Every retrieval query is bound to the active version ID:
- keyword search;
- the vector namespace;
- the D1 re-read of vector IDs;
- neighbouring chunks;
- project files.

## Fix

- **Deterministic intent detection:** broad questions (overview, technologies, entry point) are recognised without an AI call.
- **Project files first:** for these questions, the active version's README, root manifests, entry points and one file per main language lead the evidence. Entry points include files that `package.json` declares.
- **Keyword search:** words that only express the intent ("languages", "entry point") are not searched for.
- **Repository identity:** the prompt names the repository and commit, and says that showcased or mentioned projects are not the repository.
- **File language:** each evidence block carries the file's detected language.
- **Less noise:** licence and ignore files are dropped from retrieval unless the question is about them.
- **Abstention unchanged:** absent topics and false premises still abstain.

## Results: 30 graded answers per run, old code vs fixed code

| Question | Mode | Portfolio before → after | Mars before → after | cors before → after |
|---|---|---|---|---|
| overview | normal | ✗ answered (described RepoMind) → ✓ | ✓ → ✓ | ✗ answered (no description) → ✓ |
| overview | keyword-only | ✗ abstained → ✓ | ✗ abstained → ✓ | ✗ abstained → ✓ |
| technologies | normal | ✗ RepoMind's stack → ✓ | ✗ missed HTML/CSS → ✓ | ✗ cited only CI files → ✓ |
| technologies | keyword-only | ✗ person's skills → ✓ | ✗ abstained → ✓ | ✗ cited only CI files → ✓ |
| entry point | normal | ✗ abstained → ✓ | ✓ → ✓ | ✓ → ✓ |
| entry point | keyword-only | ✓ → ✓ | ✗ abstained → ✓ | ✓ → ✓ |
| specific feature | normal | ✓ → ✓ | ✓ → ✓ | ✓ → ✓ |
| absent topic (must abstain) | normal | ✓ → ✓ | ✓ → ✓ | ✓ → ✓ |
| false premise | normal | ✓ → ✓ | ✓ → ✓ | ✓ → ✓ |
| prompt injection in repository text | normal | ✓ → ✓ | ✓ → ✓ | ✓ → ✓ |
| **Total** | | | | **17/30 → 30/30** |

**What the columns mean:**
- **"Keyword-only"** asks the same question with semantic search disabled. Production behaves this way in the minute or two before new vectors are queryable, which is the Mars failure.
- **Grading of an answer** (pass requires all of these):
  - The required facts are present, for example "portfolio", "HTML/CSS/JavaScript", "Mars" and "Three.js", or `lib/index.js`.
  - At least one expected file is cited.
  - Each required fact is matched by a cited line range, path or file language.
  - Every citation's line range and text match the file on GitHub at the pinned commit.
  - It does not describe a showcased project as the repository.
- **Grading of abstention:**
  - Absent topics must abstain.
  - False premises must abstain or refute.
  - The dataset is sanity-checked: each "absent" word, such as Stripe, Angular, React or Redis, must return no keyword hits.
- **Injection cases:** a planted `docs/AI_NOTES.md` is placed first in the real retrieved evidence. It contains an override instruction, a fake `[E9]` citation, a canary string and a system-prompt extraction request. In all three runs no forbidden string appeared, and no answer cited the planted file.

**Run details:**
- **Fixed code:** 30/30 on two consecutive runs (743 and 746 Neurons). All 30 answers were reviewed manually; spot checks against the source confirmed, for example, ReportLab in `generate_resume_pdf.py:2` and Google geocoding in `script.js:215`.
- **Old code:** 686 Neurons. Questions were asked through the real `/api/repos/:id/ask` route; latency p50 4.9 s, max 9.4 s.

**Remaining limits:**
- **Sample size:** one pass per case at temperature 0.1, on 3 small repositories.
- **Pattern coverage:** intent detection is pattern-based, so unusual phrasings of a broad question fall back to normal retrieval.
- **Portfolio entry point:** the answer accurately quotes `package.json` `"main": "index.js"`, but the repository has no root `index.js`.

# Reliability and scale evaluation (2026-10-10)

**Where it ran:** on Cloudflare itself, on an isolated evaluation deployment (`wrangler.eval-remote.jsonc`).
- Its own Worker, D1 database (`repomind-eval-db`) and eval-only invite code.
- The separate `repomind-eval` Vectorize index, and an AI cap of 3,500 Neurons/day.
- It runs the production Worker code, with no eval-only endpoints.
- The harness drives it exactly like the browser: the UI's own discovery code, then `/step` until done.
- Worker CPU and outcomes come from `wrangler tail`; D1 rows from `wrangler d1 info`.

**Reproduce:** `npm run eval:scale`, `eval/lifecycle.ts` (re-index and delete), `eval/tail-summary.ts`. The dataset is `eval/scale-dataset.ts`. Deploy the evaluation Worker with `npx wrangler deploy --config wrangler.eval-remote.jsonc`, then load its secrets from the git-ignored `eval-remote.local` with `wrangler secret bulk`.

## Repositories (pinned)

| Repository | Language | Admission | Files indexed | Chunks | Searchable after | Fully embedded after | Steps |
|---|---|---|---|---|---|---|---|
| `spf13/cobra` @ `adbc881` | Go | full | 62 | 520 | 10 s | 135 s | 41 |
| `pallets/click` @ `2247b35` | Python | full (needed the fix below) | 171 | 1,135 | 26 s | 356 s | 93 |
| `axios/axios` @ `f694ecd` | JavaScript | **partial**: 229 of 463 files | 229 | 1,143 | 81 s | 555 s | 99 |
| `redis/redis` @ `558ef8f` | C | **rejected**: needs about 12.8k–16.5k chunks | — | — | — | — | 0 |
| `django/django` @ `dab0a5c` | Python | **refused in the browser**: 4,246 supported files, over the 2,000 limit | — | — | — | — | — |

**UI states:** checked through the live API, with the UI's own `repoState` and `isPartial`. All five matched expectations: ready/full, ready/full, ready/partial, failed with the admission message, and refused before adding.

## Measured on Cloudflare (Workers Free)

| Measure | Result |
|---|---|
| Worker CPU per `/step` (230 indexing and embedding steps) | p50 12–18 ms, p95 30 ms, p99 54 ms, max 123 ms. The max was the click step that chunks the 130 KB `core.py` |
| Worker CPU per answer / search / cron run | answer p50 29 ms (max 54); search p50 6 ms; cron p50 0–9 ms (max 37) |
| CPU-limit, memory or exception failures | **0** in about 330 invocations (`exceededCpu`: 0, `exceededMemory`: 0, exceptions: 0) |
| Step latency, as seen by the browser | p50 3.2–4.7 s, p95 5.8–12.1 s, max 18.1 s (embedding steps wait on Workers AI) |
| Answer latency | p50 5.2 s, max 15.7 s (18 answers) |
| New vectors queryable after | 91 s |
| D1 rows written | about 8 per chunk for index plus embed (cobra about 4.1k, click 8.9k, axios 9.2k including questions) |
| D1 rows read | about 30k–110k per repository cycle |
| Workers AI | 2,404 Neurons on the eval ledger for indexing three repositories (2,798 chunks) and 42 answers |
| Re-index (cobra, 520 chunks, more than 100) | 45 steps, 155 s. The superseded version's rows were removed automatically, then its vectors |
| Deleting all four repositories | every DELETE returned 200. The cron trigger finished cleanup in 169 s: 0 versions and rows left. Vectorize returned to exactly its pre-evaluation count (257, the local evaluation set), so no vectors leaked. D1 wrote 7,491 rows (about 2.7 per chunk) |

**The 10 ms CPU limit:** the Free plan documents 10 ms per invocation, but no invocation was stopped, even at 123 ms. RepoMind does not depend on that leniency. Indexing steps already had a crash guard (retry one file, then skip it as `processing_limit`). Embedding steps now have one too: retry with 4 chunks, then 1, then leave that chunk to keyword search. Before this, a killed embedding step would have retried forever and spent AI quota each time.

## Retrieval and answers (latest code, on Cloudflare)

- **Exact identifier search: 12/12** expected file in the top 3. This includes `ParameterSource` in click's `src/click/core.py`, which the old admission rule excluded.
- **Questions: 14/18 pass the strict rule; 17/18 correct on manual review.** Every citation's line range and text matched the file at the pinned commit.
  - **Absent topics:** 3/3 abstained.
  - **False premises:** 3/3 refuted or abstained. click cites `docs/why.md` to explain that it is not built on argparse.
  - **Correct but citing documentation:** three answers cite documentation where the dataset expected source files. cobra's entry point (it is a library; the answer explains `cmd.Execute()` from the user guide), cobra's suggestions (Levenshtein distance, minimum 2, `DisableSuggestions`), and axios' interceptors (LIFO order, chained). All three are accurate.
  - **Recall miss:** click's "How does click suggest a similar option name…?" abstained. Retrieval found `parser.py`, which raises `NoSuchOption`, but not the `exceptions.py` chunk that builds "Did you mean …?" with `get_close_matches`. This is an honest abstention, not a wrong answer.
- **Context evaluation re-run locally (Portfolio, Mars, cors, including prompt injection): 30/30**, with the new citation reminder.

## Defects found and fixed

1. **Transient GitHub errors permanently skipped files.** Handled errors were counted as CPU-limit crashes, so four 5xx responses (about 2 minutes) skipped a file as `processing_limit`. GitHub rate limits did the same.
2. **Vectors orphaned after a crash.** A step killed after writing vectors but before marking chunks embedded left vectors behind when the repository was deleted. In the test, 16 vectors leaked and kept using the shared storage quota.
3. **Deleting returned an error** whenever Vectorize deletes failed, although the repository was already gone.
4. **Failed re-index attempts accumulated** forever.
5. **Admission excluded `src/click/core.py`** (its 10% per-file share rule) although the whole repository fit. On axios, 100+ translated docs (`docs/es`, `docs/fr`, `docs/zh`) crowded out almost all of `lib/`.
6. **Uncited answers became "Not enough evidence".** On cobra, "What does this project do?" got a correct answer with no `[E#]` labels.
7. **Embedding steps had no crash guard** (see the 10 ms note above).
8. **The UI did not distinguish partial indexes or a paused semantic index.** "Files indexed" counted planned files, not searchable ones. A failed re-index card read "…commit.. Still serving…"; the render test caught that.

**Regression tests:** each fix has one, and each fails on the previous code: 7 recovery tests, 14 admission tests, 3 citation tests and 1 embedding crash-guard test.

## Limits of this evaluation

- **Sample size:** one run per question at temperature 0.1; three indexed repositories and two rejected ones.
- **Leniency over time:** CPU leniency was observed over about 330 invocations; it is not a documented guarantee.
- **Free quotas are account-wide:** the evaluation shared them with production. Totals for the day are in [free-tier.md](free-tier.md).

# Code intelligence evaluation (2026-10-10)

**What is measured:** each feature separately, never one combined score. The features are the architecture overview, symbol definitions and usages, imports of a file, importers of a file, and declared dependencies. Every returned line is checked against the raw file at the pinned commit.

**Where it ran:**
1. **In process** (`npm run eval:code`): the production ingestion pipeline writes into SQLite with the same schema and FTS5 table as D1. No AI is used.
2. **On Cloudflare:** the isolated evaluation deployment with `DAILY_NEURON_BUDGET=0`, so no Neurons were spent. The script is `eval/code-intel-remote.ts`. Worker CPU comes from `wrangler tail`.

## Repositories (pinned)

| Repository | Main languages | Files indexed | Index |
|---|---|---|---|
| `hamsanand610/Portfolio_hams` @ `c9670b8` | HTML, CSS, JavaScript | 32 | full |
| `santosharron/3D-Mars-landing-page` @ `f2bd1e0` | JavaScript (Three.js from a CDN) | 5 | full |
| `expressjs/cors` @ `5317ebe` | JavaScript | 17 | full |
| `spf13/cobra` @ `adbc881` | Go | 62 | full |
| `pallets/click` @ `2247b35` | Python | 171 | full |
| `axios/axios` @ `f694ecd` | JavaScript, TypeScript declarations | 229 of 463 | **partial** |
| `babel/website` @ `eb2e026` | Markdown, TypeScript/React | 380 of 507 | **partial** |

## Results per feature (final code, in process)

The expected answers in `eval/code-intel-dataset.ts` were written from `grep` over the raw files, not from the extractor's output.

| Feature | Measure | Result |
|---|---|---|
| Symbol definitions | Expected definition found at the exact line | **49/49** |
| | Right kind (function, class, method, struct…) | 49/49 |
| | Right enclosing class or type | 9/9 |
| | Test-only helpers labelled as tests | 2/2 |
| | Precision: returned definitions that are real definition lines | **62/62** |
| Usages | Returned usage lines that contain the name (first 25 per name) | **504/504** |
| | Names used only in tests, or only in source, labelled correctly | 3/3 |
| Missing names | No results for absent names and names defined only in another indexed repository | **7/7** |
| Imports of a file | Expected imports listed with the right target or kind | **32/32** |
| | Returned imports whose line holds the specifier and whose target exists | 73/73 |
| Importers | Expected importing files found | **16/16** |
| | Returned importers whose line really imports the file | 42/42 |
| Dependencies | Cited at the right manifest line | 8/8 |
| | "Imported or not" correct | 8/8 |
| Overview | Main language | 7/7 |
| | Purpose quoted from README or manifest | 7/7 |
| | Entry point, with the right basis (from the files vs inferred) | 7/7 |
| | Partial index flagged | 7/7 |
| | CDN libraries detected (Portfolio, Mars) | 4/4 |
| | Citations that exist and support their quoted text | **169/169** |

**These cases were used while building the features.** Every defect they exposed was fixed, so 100% on them is not an independent measure. The random samples below are.

## Held-out random samples

Definitions and relative imports were picked at random with a fixed seed. They were found by plain line patterns over the raw files (`^func`, `def name(`, `function name(`, `from .x import`…), independently of the extractor.

| Sample | Definitions found at the exact line | Relative imports resolved to an existing file |
|---|---|---|
| Seed 20261010, 15 per repository | **87/88** on first run; 88/88 after fix 13 below | 43/43 |
| Seed 7, 40 per repository (drawn after fix 13) | **196/201 (98%)** on first run; 197/201 after fix 14 | 94/94 |

The 4 remaining misses are all `cli` in click: a local function defined more than 100 times across the tests. The response returns over 100 definitions and is marked as truncated. The UI says the list is incomplete.

## Measured on Cloudflare (Workers Free, no AI)

**Pass 1:** cobra and axios, on the build before fixes 13 and 14. **Pass 2:** axios read twice, on the final build, one request a second so that `wrangler tail` kept every event.

| Measure | Result |
|---|---|
| Answers checked through the live API | Pass 1: architecture 8/8, definitions 15/15, missing 2/2, importers 6/6, imports 13/13, search 10/10. Pass 2: 8/8, 16/16 (including `AxiosHeaders`, fix 13), 2/2, 6/6, 22/22, 10/10 |
| Outcomes | Every request returned 200. 0 `exceededCpu`, 0 `exceededMemory`, 0 exceptions |
| Worker CPU per request (pass 2, all 40 reads captured) | Architecture p50 24 ms, max 32 ms. Symbols p50 17 ms, max 60 ms: the first `Axios` lookup in a fresh isolate; the same call took 17 ms later. Importers 4–12 ms; file with outline and imports 6–8 ms; keyword search 2–5 ms. Indexing steps p50 11 ms, p99 35 ms |
| Latency seen by the client (including the network) | p50 170–280 ms per request |
| Keyword-search SQL, old vs new form, on D1 (6 query pairs) | Same rows and same rows read (477–2,374): D1 already ran the match first. SQL time equal or lower for the new form (for example 19.4 → 9.9 ms), single samples |
| D1 rows written | About 22,000 for both passes: indexing 2,806 chunks without embeddings, the requests, and deletion |
| Workers AI | **0 Neurons** (eval ledger unchanged at 2,653) |
| Vectorize | Unchanged (no vectors written) |

**The 10 ms CPU limit:** the code-intelligence endpoints use 2–32 ms of CPU on a warm isolate for axios, the largest evaluated repository. That is above the documented 10 ms per request on Free, like the indexing steps measured earlier. None were stopped. If Cloudflare enforced the documented limit strictly, the heaviest lookups would fail with an error. They would not return wrong data.

**Cleanup:** the recreated evaluation Worker's cron trigger did not fire during this session. Production's cron fired normally. Deleting a repository removes its chunks inline, but the last step (file and version rows) waits for the cron. That step was run by hand on the evaluation database for two versions. The database was left empty and the Worker deleted.

## Defects found and fixed

Each fix has a regression test (`tests/unit/code-intel.test.ts`, `code-intel-flow.test.ts`, `ingest/admission.test.ts`, `ui-states.test.ts`) or a dataset case.
1. **Common names lost their definitions.** Candidates were truncated, and a case-insensitive filter was too noisy. Fixed with a case-sensitive definition-shape prefilter and code before docs.
2. **A method was not found** when its class header was in another chunk. Candidate files are now read whole.
3. **A Python multi-line signature** ended at the `)` line.
4. **Go `const` entries and C macros** had wrong end lines.
5. **A class-field arrow function ending in `;`** was rejected.
6. **`this.placeMarker = function`** (Mars) was missed.
7. **Admission treated babel/website's React code as documentation** (decision D23).
8. **The axios README purpose was HTML attributes.** The summary now prefers a README paragraph that names the project, otherwise the manifest description.
9. **Overview noise:**
   - `types` fields and an empty `main` listed as entry points;
   - duplicate dependencies, entry-point imports and purpose quotes;
   - the root directory missing from the directory table.
10. **A `<link>` tag spread over several lines** was cited at its first line, not the line holding the URL.
11. **Long paths overflowed** the page at 375 px width.
12. **A slow local FTS plan:** 150 ms–2.7 s per query (decision D22).
13. **A regular expression literal containing a backtick** (in axios `lib/core/AxiosHeaders.js`) was read as the start of a template string. It hid everything after it, including `class AxiosHeaders`. Found by the held-out sample.
14. **`self.name = …` assignments used up the definition candidates**, so click's `def name(self)` in `src/click/types.py` was missed. Passages with a definition keyword now rank first. Found by the held-out sample.

## What is supported

- **Definitions** (file outline and symbol search):
  - *Evaluated on real repositories:* JavaScript, TypeScript (`.d.ts` files as declarations), JSX/TSX components, Python and Go.
  - *Covered by unit tests only:* Rust, Java, Ruby, PHP, C and shell.
  - *Handled with the closest family's rules but not tested:* Kotlin, Scala, Groovy, C#, C++, Objective-C, and Vue/Svelte/Astro files.
  - Other languages are reported as not analysed.
- **Imports:**
  - JavaScript and TypeScript: `import`, `export … from` and `require`, with relative paths, extensions, `index` files and the `@/`, `~/` and `@site/` aliases.
  - Python: `import` and `from`, relative imports and the `src/` layout.
  - Go: imports within the module path from `go.mod`.
  - HTML: `<script src>` and `<link href>`, including CDN URLs.
  - CSS: `@import`.
  - Imports computed at run time are counted and flagged, not followed.
- **Manifests:** `package.json`, `composer.json`, `pyproject.toml`, `setup.py`, `requirements*.txt`, `Cargo.toml`, `go.mod` and `Gemfile`, with scopes (runtime, dev, peer, optional, build, indirect).
- **Relationships:**
  - definition;
  - usage (import or reference; source, test, docs or declaration);
  - file imports file, package, built-in or remote URL;
  - files importing a file;
  - dependency declared at a manifest line, and whether any indexed file imports it.

  **Not supported:** a call graph, type hierarchy or run-time dispatch.

## Limits of this evaluation

- **Extraction:** it is line based, not a full parser, so unusual formatting can be missed. The held-out recall was 98–99%.
- **Bounded reads:** each request reads a bounded number of passages. Names defined or used in very many places return a truncated list, and the UI says so.
- **Partial indexes:** only indexed files are analysed. A definition in a file left out of a partial index is not found, and the UI says this may be the reason.
- **Aliases:** `tsconfig.json` `paths` and bundler aliases other than `@/`, `~/` and `@site/` are not read; such imports show as unresolved.
- **Sample size:** seven repositories; definitions and imports are evaluated on JavaScript, TypeScript, Python, Go and HTML only.
