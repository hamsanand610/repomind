/**
 * Ground truth for the code-intelligence evaluation, taken from the raw files
 * at each pinned commit with independent text searches (grep), not from the
 * extractor under test.
 */

export interface SymbolCase {
  repo: string;
  name: string;
  /** Every definition that must be found, with its exact line. */
  expect: Array<{ path: string; line: number; kind?: string; container?: string; role?: "source" | "test" | "declaration" }>;
}

export const SYMBOL_CASES: SymbolCase[] = [
  { repo: "cobra", name: "SuggestionsFor", expect: [{ path: "command.go", line: 863, kind: "method", container: "Command" }] },
  { repo: "cobra", name: "ld", expect: [{ path: "cobra.go", line: 192, kind: "function" }] },
  { repo: "cobra", name: "Command", expect: [{ path: "command.go", line: 54, kind: "struct" }] },
  { repo: "cobra", name: "Execute", expect: [{ path: "command.go", line: 1070, kind: "method", container: "Command" }] },
  { repo: "cobra", name: "OnInitialize", expect: [{ path: "cobra.go", line: 99, kind: "function" }] },
  { repo: "cobra", name: "GenBashCompletionV2", expect: [{ path: "bash_completionsV2.go", line: 482, kind: "method" }] },
  { repo: "cobra", name: "MarkFlagsMutuallyExclusive", expect: [{ path: "flag_groups.go", line: 65, kind: "method" }] },
  { repo: "cobra", name: "executeCommand", expect: [{ path: "command_test.go", line: 32, kind: "function", role: "test" }] },
  { repo: "click", name: "Context", expect: [{ path: "src/click/core.py", line: 238, kind: "class" }] },
  { repo: "click", name: "ParameterSource", expect: [{ path: "src/click/core.py", line: 199, kind: "class" }] },
  {
    repo: "click",
    name: "invoke",
    expect: [
      { path: "src/click/core.py", line: 880, kind: "method", container: "Context" },
      { path: "src/click/core.py", line: 885, kind: "method", container: "Context" },
      { path: "src/click/core.py", line: 887, kind: "method", container: "Context" },
      { path: "src/click/core.py", line: 1432, kind: "method", container: "Command" },
      { path: "src/click/core.py", line: 2052, kind: "method", container: "Group" },
      { path: "src/click/testing.py", line: 596, kind: "method", container: "CliRunner" },
    ],
  },
  // Found by the held-out sample: `self.name = …` assignments used up the definition candidates.
  { repo: "click", name: "name", expect: [{ path: "src/click/types.py", line: 1282, kind: "method" }] },
  { repo: "click", name: "make_pass_decorator", expect: [{ path: "src/click/decorators.py", line: 51, kind: "function" }] },
  { repo: "click", name: "NoSuchOption", expect: [{ path: "src/click/exceptions.py", line: 232, kind: "class" }] },
  { repo: "click", name: "echo_via_pager", expect: [{ path: "src/click/termui.py", line: 367, kind: "function" }] },
  { repo: "click", name: "runner", expect: [{ path: "tests/conftest.py", line: 7, kind: "function", role: "test" }] },
  { repo: "axios", name: "InterceptorManager", expect: [{ path: "lib/core/InterceptorManager.js", line: 56, kind: "class" }] },
  { repo: "axios", name: "mergeConfig", expect: [{ path: "lib/core/mergeConfig.js", line: 77, kind: "function" }] },
  { repo: "axios", name: "buildFullPath", expect: [{ path: "lib/core/buildFullPath.js", line: 68, kind: "function" }] },
  { repo: "axios", name: "isCancel", expect: [{ path: "lib/cancel/isCancel.js", line: 3, kind: "function" }] },
  { repo: "axios", name: "AxiosError", expect: [{ path: "lib/core/AxiosError.js", line: 153, kind: "class" }] },
  { repo: "axios", name: "_request", expect: [{ path: "lib/core/Axios.js", line: 94, kind: "method", container: "Axios" }] },
  { repo: "axios", name: "Axios", expect: [{ path: "lib/core/Axios.js", line: 24, kind: "class" }] },
  // Found by the held-out sample: a regular expression with a backtick hid the class.
  { repo: "axios", name: "AxiosHeaders", expect: [{ path: "lib/core/AxiosHeaders.js", line: 211, kind: "class" }] },
  { repo: "cors", name: "isOriginAllowed", expect: [{ path: "lib/index.js", line: 19, kind: "function" }] },
  { repo: "cors", name: "configureOrigin", expect: [{ path: "lib/index.js", line: 36, kind: "function" }] },
  { repo: "cors", name: "cors", expect: [{ path: "lib/index.js", line: 159, kind: "function" }] },
  { repo: "cors", name: "middlewareWrapper", expect: [{ path: "lib/index.js", line: 192, kind: "function" }] },
  {
    repo: "mars",
    name: "placeMarker",
    expect: [
      { path: "script.js", line: 204, kind: "function" },
      { path: "script.js", line: 321, kind: "method" },
    ],
  },
  { repo: "mars", name: "latLongToVector3", expect: [{ path: "script.js", line: 181, kind: "function" }] },
  { repo: "mars", name: "createPlanet", expect: [{ path: "script.js", line: 96, kind: "function" }] },
  { repo: "mars", name: "marker", expect: [{ path: "script.js", line: 191, kind: "function" }] },
  { repo: "mars", name: "render", expect: [{ path: "script.js", line: 282, kind: "function" }] },
  { repo: "portfolio", name: "debugLog", expect: [{ path: "assets/js/helpers.js", line: 10, kind: "function" }] },
  { repo: "portfolio", name: "checkSession", expect: [{ path: "assets/js/helpers.js", line: 21, kind: "function" }] },
  { repo: "portfolio", name: "lockScroll", expect: [{ path: "assets/js/helpers.js", line: 37, kind: "function" }] },
  { repo: "portfolio", name: "getFreePort", expect: [{ path: "server.js", line: 24, kind: "function" }] },
  { repo: "portfolio", name: "startServer", expect: [{ path: "server.js", line: 37, kind: "function" }] },
  { repo: "babel", name: "ASTViewer", expect: [{ path: "website/src/components/ast/ASTViewer.tsx", line: 21, kind: "component" }] },
  { repo: "babel", name: "CopyButton", expect: [{ path: "website/src/components/ast/CopyButton.tsx", line: 32, kind: "component" }] },
  { repo: "babel", name: "DataRender", expect: [{ path: "website/src/components/ast/DataRenderer.tsx", line: 213, kind: "component" }] },
  { repo: "babel", name: "useClipboard", expect: [{ path: "website/src/components/ast/hooks/useClipboard.ts", line: 7, kind: "function" }] },
  { repo: "babel", name: "useDebouncedToggle", expect: [{ path: "website/src/components/ast/hooks/useDebouncedToggle.ts", line: 3, kind: "function" }] },
];

/** Every reference to these names is in tests (helpers) or in source only (verified with grep). */
export const REFERENCE_ROLE_CASES: Array<{ repo: string; name: string; only: "test" | "source" }> = [
  { repo: "cobra", name: "executeCommand", only: "test" },
  { repo: "cors", name: "isOriginAllowed", only: "source" },
  { repo: "mars", name: "latLongToVector3", only: "source" },
];

/** Names that do not occur in the repository (verified with grep): no definitions and no references. */
export const MISSING_SYMBOLS: Array<{ repo: string; name: string }> = [
  { repo: "cobra", name: "parseYamlConfig" },
  { repo: "click", name: "renderTemplate" },
  { repo: "axios", name: "cacheInIndexedDb" },
  { repo: "mars", name: "loadPlanetsFromApi" },
  { repo: "cors", name: "rateLimiter" },
  // Defined in another evaluated repository: must not leak across repositories.
  { repo: "click", name: "SuggestionsFor" },
  { repo: "portfolio", name: "latLongToVector3" },
];

export interface ImportCase {
  repo: string;
  file: string;
  /** Imports that must be listed with this resolution: a target path, or a kind for non-file imports. */
  expect: Array<{ specifier: string; target?: string; kind?: "package" | "builtin" | "remote" }>;
}

export const IMPORT_CASES: ImportCase[] = [
  {
    repo: "axios",
    file: "lib/core/Axios.js",
    expect: [
      { specifier: "../utils.js", target: "lib/utils.js" },
      { specifier: "../helpers/buildURL.js", target: "lib/helpers/buildURL.js" },
      { specifier: "./InterceptorManager.js", target: "lib/core/InterceptorManager.js" },
      { specifier: "./dispatchRequest.js", target: "lib/core/dispatchRequest.js" },
      { specifier: "./mergeConfig.js", target: "lib/core/mergeConfig.js" },
      { specifier: "./buildFullPath.js", target: "lib/core/buildFullPath.js" },
      { specifier: "./methodList.js", target: "lib/core/methodList.js" },
      { specifier: "../helpers/validator.js", target: "lib/helpers/validator.js" },
      { specifier: "./AxiosHeaders.js", target: "lib/core/AxiosHeaders.js" },
      { specifier: "../defaults/transitional.js", target: "lib/defaults/transitional.js" },
      { specifier: "./AxiosError.js", target: "lib/core/AxiosError.js" },
    ],
  },
  {
    repo: "click",
    file: "src/click/decorators.py",
    expect: [
      { specifier: "inspect", kind: "builtin" },
      { specifier: "functools", kind: "builtin" },
      { specifier: ".core", target: "src/click/core.py" },
      { specifier: ".globals", target: "src/click/globals.py" },
      { specifier: ".utils", target: "src/click/utils.py" },
    ],
  },
  { repo: "cobra", file: "doc/man_docs.go", expect: [{ specifier: "github.com/spf13/cobra", target: "." }, { specifier: "github.com/cpuguy83/go-md2man/v2/md2man", kind: "package" }] },
  { repo: "cors", file: "lib/index.js", expect: [{ specifier: "object-assign", kind: "package" }, { specifier: "vary", kind: "package" }] },
  {
    repo: "mars",
    file: "index.html",
    expect: [
      { specifier: "style.css", target: "style.css" },
      { specifier: "./script.js", target: "script.js" },
      { specifier: "https://cdnjs.cloudflare.com/ajax/libs/three.js/r73/three.min.js", kind: "remote" },
    ],
  },
  {
    repo: "portfolio",
    file: "index.html",
    expect: [
      { specifier: "assets/css/variables.css", target: "assets/css/variables.css" },
      { specifier: "assets/js/loader.js", target: "assets/js/loader.js" },
      { specifier: "assets/js/app.js", target: "assets/js/app.js" },
      { specifier: "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js", kind: "remote" },
    ],
  },
  { repo: "portfolio", file: "assets/js/timeline.js", expect: [{ specifier: "gsap", kind: "package" }, { specifier: "./helpers.js", target: "assets/js/helpers.js" }] },
  { repo: "portfolio", file: "server.js", expect: [{ specifier: "http", kind: "builtin" }, { specifier: "fs", kind: "builtin" }] },
  { repo: "babel", file: "website/src/components/ast/CopyButton.tsx", expect: [{ specifier: "./hooks/useClipboard", target: "website/src/components/ast/hooks/useClipboard.ts" }] },
];

/** Files expected to import the target (grep of import lines); results may include more only if they truly import it. */
export const IMPORTER_CASES: Array<{ repo: string; path: string; expect: string[] }> = [
  { repo: "axios", path: "lib/core/mergeConfig.js", expect: ["lib/axios.js", "lib/core/Axios.js", "lib/helpers/resolveConfig.js"] },
  {
    repo: "click",
    path: "src/click/exceptions.py",
    expect: ["src/click/__init__.py", "src/click/_termui_impl.py", "src/click/core.py", "src/click/parser.py", "src/click/termui.py", "src/click/types.py", "src/click/utils.py"],
  },
  { repo: "cobra", path: "command.go", expect: ["doc/man_docs.go", "doc/md_docs.go", "doc/rest_docs.go"] },
  { repo: "babel", path: "website/src/components/ast/hooks/useClipboard.ts", expect: ["website/src/components/ast/CopyButton.tsx"] },
  { repo: "portfolio", path: "assets/js/helpers.js", expect: ["assets/js/timeline.js"] },
  { repo: "mars", path: "script.js", expect: ["index.html"] },
];

/** Declared dependencies: manifest line, and whether import statements for it exist in the indexed code. */
export const DEPENDENCY_CASES: Array<{ repo: string; name: string; manifest: string; line: number; used: boolean }> = [
  { repo: "cors", name: "object-assign", manifest: "package.json", line: 20, used: true },
  { repo: "cors", name: "vary", manifest: "package.json", line: 21, used: true },
  { repo: "cors", name: "mocha", manifest: "package.json", line: 27, used: false },
  { repo: "cobra", name: "github.com/spf13/pflag", manifest: "go.mod", line: 8, used: true },
  { repo: "axios", name: "follow-redirects", manifest: "package.json", line: 142, used: true },
  { repo: "axios", name: "proxy-from-env", manifest: "package.json", line: 145, used: true },
  { repo: "portfolio", name: "gsap", manifest: "package.json", line: 22, used: true },
  { repo: "click", name: "flit_core", manifest: "pyproject.toml", line: 63, used: false },
];

/** Overview facts: main language, purpose quote, entry point and coverage. */
export const ARCHITECTURE_CASES: Array<{ repo: string; topLanguage: string; purpose: RegExp; entry: string | null; entryBasis?: "explicit" | "inferred"; partial: boolean; remote?: string[] }> = [
  { repo: "portfolio", topLanguage: "html", purpose: /portfolio/i, entry: "index.html", entryBasis: "inferred", partial: false, remote: ["bootstrap"] },
  { repo: "mars", topLanguage: "javascript", purpose: /Three\.js/, entry: "index.html", entryBasis: "inferred", partial: false, remote: ["three", "dat.gui", "OrbitControls"] },
  { repo: "cors", topLanguage: "javascript", purpose: /middleware/i, entry: "lib/index.js", entryBasis: "explicit", partial: false },
  { repo: "cobra", topLanguage: "go", purpose: /CLI/, entry: "cobra.go", entryBasis: "inferred", partial: false },
  { repo: "click", topLanguage: "python", purpose: /command line/i, entry: "src/click/__init__.py", entryBasis: "inferred", partial: false },
  { repo: "axios", topLanguage: "javascript", purpose: /HTTP client/i, entry: "index.js", entryBasis: "explicit", partial: true },
  { repo: "babel", topLanguage: "markdown", purpose: /babeljs\.io website/, entry: null, partial: true },
];
