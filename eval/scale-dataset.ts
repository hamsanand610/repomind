/**
 * Larger-repository evaluation set: different sizes, languages and admission
 * outcomes, pinned to exact commits. Identifiers, expected files and facts
 * were checked against these commits (e.g. cobra command.go:863 SuggestionsFor,
 * click exceptions.py:255 get_close_matches, axios lib/core/Axios.js:179).
 */
import type { ContextCase } from "./context-dataset.ts";

export interface ScaleRepo {
  key: string;
  owner: string;
  repo: string;
  sha: string;
  /** state "not_added": the browser's discovery refuses the repository before calling the API. */
  expect: { decision: "full" | "partial" | "rejected"; state: "ready" | "failed" | "not_added"; partial: boolean };
  /** Exact identifiers or phrases: one of the files must be in the top 3 search hits. */
  search: Array<{ query: string; expectFiles: string[] }>;
  cases: ContextCase[];
}

const GENERIC = {
  overview: "What does this project do?",
  technologies: "What programming languages and technologies does it use?",
  entry: "Where is the main entry point?",
};

export const SCALE_REPOS: ScaleRepo[] = [
  {
    key: "cobra",
    owner: "spf13",
    repo: "cobra",
    sha: "adbc8813901bba65827259daa8e22ff94ec1f30e",
    expect: { decision: "full", state: "ready", partial: false },
    search: [
      { query: "SuggestionsFor", expectFiles: ["command.go"] },
      { query: "GenBashCompletionV2", expectFiles: ["bash_completionsV2.go"] },
      { query: "OnInitialize", expectFiles: ["cobra.go"] },
      { query: "levenshtein distance", expectFiles: ["cobra.go", "command.go"] },
    ],
    cases: [
      { kind: "overview", question: GENERIC.overview, expectFiles: ["README.md", "cobra.go", "command.go", "go.mod", "doc.go"], mustMention: [/\bCLI\b|command[- ]line/i] },
      { kind: "technologies", question: GENERIC.technologies, expectFiles: ["go.mod", "README.md", "cobra.go", "command.go"], mustMention: [/\bGo\b|golang/i] },
      { kind: "entry_point", question: GENERIC.entry, expectFiles: ["README.md", "command.go", "cobra.go", "go.mod"], mustMention: [/Execute/] },
      { kind: "feature", question: "How does cobra suggest a command when the user mistypes one?", expectFiles: ["command.go", "cobra.go"], mustMention: [/levenshtein|SuggestionsFor/i] },
      { kind: "absent", question: "How does cobra store command history in a SQLite database?", absentTerms: ["sqlite"] },
      { kind: "false_premise", question: "Why does cobra depend on the urfave/cli library?", absentTerms: ["urfave"] },
    ],
  },
  {
    key: "click",
    owner: "pallets",
    repo: "click",
    sha: "2247b35ea1c47c727d7a06e51fa280e12a863ff6",
    expect: { decision: "full", state: "ready", partial: false },
    search: [
      { query: "NoSuchOption", expectFiles: ["src/click/exceptions.py"] },
      { query: "make_pass_decorator", expectFiles: ["src/click/decorators.py"] },
      { query: "echo_via_pager", expectFiles: ["src/click/termui.py"] },
      // In src/click/core.py, which the old per-file share rule excluded.
      { query: "ParameterSource", expectFiles: ["src/click/core.py"] },
    ],
    cases: [
      { kind: "overview", question: GENERIC.overview, expectFiles: ["README.md", "pyproject.toml", "docs/index.md", "src/click/__init__.py"], mustMention: [/command[- ]line|\bCLI\b/i] },
      { kind: "technologies", question: GENERIC.technologies, expectFiles: ["pyproject.toml", "README.md", "src/click/core.py"], mustMention: [/python/i] },
      { kind: "entry_point", question: GENERIC.entry, expectFiles: ["pyproject.toml", "README.md", "src/click/__init__.py", "src/click/core.py", "docs/entry-points.md"], mustMention: [/__init__|core\.py|@click\.command|entry[ _-]?points?/i] },
      { kind: "feature", question: "How does click suggest a similar option name when the user mistypes an option?", expectFiles: ["src/click/exceptions.py", "src/click/parser.py"], mustMention: [/get_close_matches|difflib/i] },
      { kind: "absent", question: "How does click send usage telemetry to a remote server?", absentTerms: ["telemetry"] },
      // The docs explain why click does NOT use argparse; the answer must refute the premise or abstain.
      { kind: "false_premise", question: "Why is click built on top of argparse?" },
    ],
  },
  {
    key: "axios",
    owner: "axios",
    repo: "axios",
    sha: "f694ecd6ac49bb1917e086b5e532e1627c62d43a",
    expect: { decision: "partial", state: "ready", partial: true },
    search: [
      { query: "InterceptorManager", expectFiles: ["lib/core/InterceptorManager.js"] },
      { query: "mergeConfig", expectFiles: ["lib/core/mergeConfig.js"] },
      { query: "buildFullPath", expectFiles: ["lib/core/buildFullPath.js"] },
      { query: "isCancel", expectFiles: ["lib/cancel/isCancel.js"] },
    ],
    cases: [
      { kind: "overview", question: GENERIC.overview, expectFiles: ["README.md", "package.json", "index.js", "lib/axios.js", "docs/index.md"], mustMention: [/HTTP client/i, /promise/i] },
      { kind: "technologies", question: GENERIC.technologies, expectFiles: ["package.json", "README.md", "index.js", "index.d.ts", "lib/axios.js"], mustMention: [/javascript/i] },
      { kind: "entry_point", question: GENERIC.entry, expectFiles: ["package.json", "index.js", "lib/axios.js"], mustMention: [/index\.js|lib\/axios\.js|axios\.cjs/i] },
      { kind: "feature", question: "How are request interceptors run before a request is sent?", expectFiles: ["lib/core/Axios.js", "lib/core/InterceptorManager.js"], mustMention: [/interceptor/i] },
      { kind: "absent", question: "How does axios cache responses in IndexedDB?", absentTerms: ["indexeddb"] },
      { kind: "false_premise", question: "Why does axios depend on jQuery for making requests?", absentTerms: ["jquery"] },
    ],
  },
  // Over 2,000 supported files: the browser refuses it before anything is sent.
  {
    key: "django",
    owner: "django",
    repo: "django",
    sha: "dab0a5c47f159eb58472110dcbc10bd4a9b01adb",
    expect: { decision: "rejected", state: "not_added", partial: false },
    search: [],
    cases: [],
  },
  // Under 2,000 files but about 13k–16k chunks: the server's admission rejects it.
  {
    key: "redis",
    owner: "redis",
    repo: "redis",
    sha: "558ef8fafb508adb276fb838442f7f202fc1d7e6",
    expect: { decision: "rejected", state: "failed", partial: false },
    search: [],
    cases: [],
  },
];
