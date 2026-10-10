/**
 * Regression tests for repository context in Ask:
 *  - broad questions on a small static site while new vectors are not yet
 *    queryable (reported: santosharron/3D-Mars-landing-page abstained);
 *  - broad questions on a portfolio whose pages describe other projects
 *    (reported: hamsanand610/Portfolio_hams described an unrelated project);
 *  - no evidence from another repository or a superseded version, even if the
 *    vector index returned it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { AskResponse, RepoSummary } from "../../shared/api.ts";
import { handleRequest } from "../../worker/app.ts";
import type { AppEnv, VectorizeBinding } from "../../worker/platform.ts";
import { type FakeRepo, fakeAi, fakeEmbedding, fakeGitHubFetch, fakeVectorize } from "../support/fakes.ts";
import { type TestDatabase, createTestDatabase } from "../support/sqlite-db.ts";

const ORIGIN = "https://repomind.test";
const CODE = "invite-alpha-0123456789";

const MARS: FakeRepo = {
  owner: "space",
  repo: "mars-landing",
  defaultBranch: "main",
  sha: "1".repeat(40),
  files: {
    LICENSE: "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software, to deal in the Software without restriction.\n",
    "README.md": "# 3D Mars Landing Page\n\nI used Three.js to create a landing page with orbit controls and dat.gui.\n",
    "index.html":
      "<!DOCTYPE html>\n<html>\n<head>\n  <title>3D Mars</title>\n  <link rel='stylesheet' href='style.css'>\n</head>\n<body>\n" +
      "  <script src='https://cdnjs.cloudflare.com/ajax/libs/three.js/r73/three.min.js'></script>\n  <script src=\"./script.js\"></script>\n</body>\n</html>\n",
    "script.js":
      "let renderer = new THREE.WebGLRenderer();\nlet scene = new THREE.Scene();\n\n" +
      "function placeMarker(object, options) {\n  let position = latLongToVector3(options.latitude, options.longitude, options.radius);\n  object.add(marker(position));\n}\n",
    "style.css": "body {\n  margin: 0;\n}\ncanvas {\n  display: block;\n}\n",
  },
};

const CARDS = Array.from({ length: 3 }, (_, i) =>
  `<div class="card">\n  <h5>Project ${i + 1}: RepoMind ${i}</h5>\n  <p>This project is an AI platform. What does this project do? It does repository Q&A for this project.</p>\n</div>`,
).join("\n");

const PORTFOLIO: FakeRepo = {
  owner: "jane",
  repo: "portfolio",
  defaultBranch: "main",
  sha: "2".repeat(40),
  files: {
    "README.md": "# Portfolio\n\nStatic portfolio website of Jane Doe, built with Bootstrap 5.\n",
    "index.html": `<!DOCTYPE html>\n<html>\n<head>\n  <title>Jane Doe | Portfolio</title>\n</head>\n<body>\n<main>\n${CARDS}\n</main>\n</body>\n</html>\n`,
    "html/projects.html": `<section id="projects">\n${CARDS}\n</section>\n`,
    "assets/js/app.js": "export function startApp() {\n  document.body.classList.add('ready');\n}\n",
  },
};

let db: TestDatabase;
let env: AppEnv;
let ai: ReturnType<typeof fakeAi>;
let repos: FakeRepo[];

function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("Cookie", init.cookie);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return handleRequest(new Request(ORIGIN + path, { ...init, headers }), env, undefined, { fetch: fakeGitHubFetch(repos) });
}

async function login(): Promise<string> {
  const response = await call("/api/auth/login", { method: "POST", body: JSON.stringify({ code: CODE }) });
  return (response.headers.get("Set-Cookie") ?? "").split(";")[0];
}

async function addAndIndex(cookie: string, repo: FakeRepo): Promise<RepoSummary> {
  const created = (await (await call("/api/repos", { method: "POST", cookie, body: JSON.stringify({ url: `https://github.com/${repo.owner}/${repo.repo}` }) })).json()) as RepoSummary;
  return indexToCompletion(cookie, created.id);
}

async function indexToCompletion(cookie: string, repoId: string): Promise<RepoSummary> {
  for (let i = 0; i < 100; i++) {
    const { outcome, repo } = (await (await call(`/api/repos/${repoId}/step`, { method: "POST", cookie, body: "{}" })).json()) as { outcome: { kind: string }; repo: RepoSummary };
    if ((outcome.kind === "idle" || outcome.kind === "waiting") && repo.latest?.status !== "indexing") return repo;
  }
  throw new Error("indexing did not finish");
}

async function ask(cookie: string, repoId: string, question: string): Promise<AskResponse> {
  return (await (await call(`/api/repos/${repoId}/ask`, { method: "POST", cookie, body: JSON.stringify({ question }) })).json()) as AskResponse;
}

/** Vectors were written but the index has not processed them: queries return nothing (production state for ~1–2 min). */
function laggingVectorize(): VectorizeBinding {
  return { ...fakeVectorize(), query: async () => ({ matches: [] }), describe: async () => ({ processedUpToDatetime: 1 }) };
}

beforeEach(() => {
  db = createTestDatabase();
  // The fake model cites the first evidence block, so citations show what retrieval put first.
  ai = fakeAi({ answer: (_question, labels) => `It is described in the first block [${labels[0]}].` });
  env = { DB: db, AI: ai, VECTORIZE: fakeVectorize(), SESSION_SECRET: "test-session-secret-0123456789", INVITE_CODES: CODE };
  repos = [MARS, PORTFOLIO];
});

describe("broad questions on a small static site before vectors are queryable (Mars Landing regression)", () => {
  it("answers 'What does this project do?' from the README instead of abstaining", async () => {
    env = { ...env, VECTORIZE: laggingVectorize() };
    const cookie = await login();
    const repo = await addAndIndex(cookie, MARS);
    expect(repo.active?.status).toBe("ready");

    const answer = await ask(cookie, repo.id, "What does this project do?");
    expect(answer.retrieval.semanticStatus).toBe("pending");
    expect(answer.retrieval.keywordHits).toBe(0); // every word is a stopword: keywords alone cannot answer
    expect(answer.status).toBe("answered");
    expect(answer.citations[0].path).toBe("README.md");
    expect(answer.citations[0].url).toBe(`https://github.com/space/mars-landing/blob/${MARS.sha}/README.md#L1-L3`);
    expect(answer.retrieval.contextFiles).toBeGreaterThan(0);
  });

  it("gives the model one file per language for 'What programming languages and technologies does it use?'", async () => {
    env = { ...env, VECTORIZE: laggingVectorize() };
    const cookie = await login();
    const repo = await addAndIndex(cookie, MARS);

    const answer = await ask(cookie, repo.id, "What programming languages and technologies does it use?");
    expect(answer.status).toBe("answered");
    const prompt = ai.prompts.at(-1) ?? "";
    expect(prompt).toMatch(/path="script\.js" language="javascript"/);
    expect(prompt).toMatch(/path="index\.html" language="html"/);
    expect(prompt).toMatch(/path="style\.css" language="css"/);
    expect(prompt).toContain("three.min.js"); // the HTML entry shows the libraries it loads
    expect(prompt).not.toContain('path="LICENSE"');
  });

  it("still abstains without calling the model when nothing relates to a specific question", async () => {
    env = { ...env, VECTORIZE: laggingVectorize() };
    const cookie = await login();
    const repo = await addAndIndex(cookie, MARS);
    const before = ai.prompts.length;
    const answer = await ask(cookie, repo.id, "How are payments refunded through Stripe?");
    expect(answer.status).toBe("insufficient_evidence");
    expect(ai.prompts.length).toBe(before);
  });
});

describe("broad questions on a portfolio that showcases other projects (Portfolio regression)", () => {
  it("puts the repository's own README first and tells the model which repository 'this project' is", async () => {
    const cookie = await login();
    const repo = await addAndIndex(cookie, PORTFOLIO);
    const question = "What does this project do?";

    // Precondition: semantic search alone ranks the showcased-project cards above the README.
    const store = (env.VECTORIZE as ReturnType<typeof fakeVectorize>).store;
    const { matches } = await (env.VECTORIZE as VectorizeBinding).query(fakeEmbedding(question).slice(0, 512), { topK: 3, namespace: repo.active?.id });
    const readmeIds = [...store.keys()].filter((id) => id.endsWith(":0:0"));
    expect(readmeIds).toHaveLength(1);
    expect(matches[0].id).not.toBe(readmeIds[0]);

    const answer = await ask(cookie, repo.id, question);
    expect(answer.status).toBe("answered");
    expect(answer.citations[0].path).toBe("README.md");
    const prompt = ai.prompts.at(-1) ?? "";
    expect(prompt).toContain("The repository is jane/portfolio at commit 2222222.");
    expect(prompt).toMatch(/merely mention, list or showcase are not the repository itself/);
  });
});

describe("answers that forget their citations (spf13/cobra regression)", () => {
  const chatCalls = () => ai.calls.filter((call) => call.kind === "chat").length;

  it("asks once more when a substantive answer has no evidence label, and shows the cited version", async () => {
    ai = fakeAi({ answer: (_q, labels, turn) => (turn === 0 ? "Cobra is a library for creating CLI applications." : `Cobra is a library for CLI applications [${labels[0]}].`) });
    env = { ...env, AI: ai };
    const cookie = await login();
    const repo = await addAndIndex(cookie, MARS);
    const before = chatCalls();
    const answer = await ask(cookie, repo.id, "What does this project do?");
    expect(answer.status).toBe("answered");
    expect(answer.citations[0].path).toBe("README.md");
    expect(chatCalls() - before).toBe(2);
    expect(ai.prompts.at(-1)).toContain("cites no evidence labels");
  });

  it("still never shows uncited text when the retry is uncited too", async () => {
    ai = fakeAi({ answer: () => "An answer with no labels at all." });
    env = { ...env, AI: ai };
    const cookie = await login();
    const repo = await addAndIndex(cookie, MARS);
    const before = chatCalls();
    const answer = await ask(cookie, repo.id, "What does this project do?");
    expect(answer).toMatchObject({ status: "insufficient_evidence", answer: null, citations: [] });
    expect(chatCalls() - before).toBe(2);
  });

  it.each([
    ["an abstention", "INSUFFICIENT_EVIDENCE"],
    ["an answer citing only a label the server never supplied", "The admin password is in the config [E99]."],
  ])("does not retry %s", async (_name, reply) => {
    ai = fakeAi({ answer: () => reply });
    env = { ...env, AI: ai };
    const cookie = await login();
    const repo = await addAndIndex(cookie, MARS);
    const before = chatCalls();
    expect((await ask(cookie, repo.id, "What does this project do?")).status).toBe("insufficient_evidence");
    expect(chatCalls() - before).toBe(1);
  });

  it("repeats the citation rule after the evidence", async () => {
    const cookie = await login();
    const repo = await addAndIndex(cookie, MARS);
    await ask(cookie, repo.id, "What does this project do?");
    expect((ai.prompts.at(-1) ?? "").trimEnd()).toMatch(/like \[E1\]\. If the evidence is not enough, reply with exactly: INSUFFICIENT_EVIDENCE$/);
  });
});

describe("repository and version isolation", () => {
  it("never uses another repository's chunks, even when the vector index ignores namespaces", async () => {
    env = { ...env, VECTORIZE: fakeVectorize({ ignoreNamespace: true }) };
    const alpha: FakeRepo = { ...MARS, repo: "alpha", sha: "a".repeat(40), files: { ...MARS.files, "README.md": "# Alpha\n\nALPHA_ONLY_CANARY orbit controls landing page.\n" } };
    repos = [alpha, PORTFOLIO];
    const cookie = await login();
    await addAndIndex(cookie, alpha);
    const target = await addAndIndex(cookie, PORTFOLIO);

    for (const question of ["What does this project do?", "orbit controls landing page ALPHA_ONLY_CANARY", "What programming languages and technologies does it use?"]) {
      const answer = await ask(cookie, target.id, question);
      for (const citation of answer.citations) expect(citation.url.startsWith(`https://github.com/jane/portfolio/blob/${PORTFOLIO.sha}/`)).toBe(true);
      expect(answer.commitSha).toBe(PORTFOLIO.sha);
    }
    for (const prompt of ai.prompts) {
      expect(prompt).not.toContain("ALPHA_ONLY_CANARY");
      expect(prompt).not.toContain("three.min.js");
    }
  });

  it("answers from the active version only while a superseded version's chunks still exist", async () => {
    env = { ...env, VECTORIZE: fakeVectorize({ ignoreNamespace: true }) };
    const site: FakeRepo = { ...PORTFOLIO, files: { ...PORTFOLIO.files, "README.md": "# Portfolio\n\nOLD_VERSION_CANARY portfolio website.\n" } };
    repos = [site];
    const cookie = await login();
    const first = await addAndIndex(cookie, site);

    // A new commit is pushed and re-indexed; the old version is not cleaned up yet.
    const updated: FakeRepo = { ...site, sha: "3".repeat(40), files: { ...site.files, "README.md": "# Portfolio\n\nNEW_VERSION portfolio website.\n" } };
    repos = [updated];
    expect((await call(`/api/repos/${first.id}/reindex`, { method: "POST", cookie, body: "{}" })).status).toBe(202);
    // Step only until the new version becomes active; later steps would retire the old one.
    let second: RepoSummary | undefined;
    for (let i = 0; i < 100 && second?.active?.commitSha !== updated.sha; i++) {
      second = ((await (await call(`/api/repos/${first.id}/step`, { method: "POST", cookie, body: "{}" })).json()) as { repo: RepoSummary }).repo;
    }
    expect(second?.active?.commitSha).toBe(updated.sha);
    const stale = db.sqlite.prepare("SELECT COUNT(*) AS n FROM chunks WHERE version_id = ?").get(first.active?.id ?? "") as { n: number };
    expect(stale.n).toBeGreaterThan(0);

    const answer = await ask(cookie, first.id, "What does this project do? OLD_VERSION_CANARY portfolio website");
    expect(answer.commitSha).toBe(updated.sha);
    expect(answer.citations.length).toBeGreaterThan(0);
    for (const citation of answer.citations) expect(citation.url).toContain(`/blob/${updated.sha}/`);
    const evidence = (ai.prompts.at(-1) ?? "").split("\nEvidence:\n")[1] ?? "";
    expect(evidence).toContain("NEW_VERSION");
    expect(evidence).not.toContain("OLD_VERSION_CANARY");
  });
});
