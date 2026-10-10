import { describe, expect, it } from "vitest";
import { type FileInfo, analyseQuestion, declaredEntryPaths, isBoilerplateFor, selectContextFiles } from "../../worker/project-context.ts";
import { queryTerms } from "../../worker/search.ts";

describe("analyseQuestion", () => {
  it.each([
    ["What does this project do?", ["overview"]],
    ["What is this repository about?", ["overview"]],
    ["what's this?", ["overview"]],
    ["How does it work?", ["overview"]],
    ["Summarise this repository", ["overview"]],
    ["What programming languages and technologies does it use?", ["technologies"]],
    ["Which languages, frameworks and dependencies does it use?", ["technologies"]],
    ["What is it written in?", ["technologies"]],
    ["Where is the main entry point?", ["entry_point"]],
    ["How do I run it locally?", ["entry_point"]],
  ])("recognises %j", (question, intents) => {
    const analysis = analyseQuestion(question);
    expect(analysis.intents).toEqual(intents);
    // The words that only expressed the intent are not searched for.
    expect(queryTerms(analysis.keywordText, "any")).toEqual(question.includes("locally") ? ["locally"] : []);
  });

  it.each([
    "What does the retry function do?",
    "How does the app switch the UI language?",
    "How does this project connect to a PostgreSQL database?",
    "Where is saveUser defined?",
    "How are tokens verified?",
  ])("leaves the specific question %j alone", (question) => {
    expect(analyseQuestion(question)).toEqual({ intents: [], keywordText: question });
  });

  it("keeps the specific part of a mixed question searchable", () => {
    const analysis = analyseQuestion("Which frameworks does it use for routing?");
    expect(analysis.intents).toEqual(["technologies"]);
    expect(queryTerms(analysis.keywordText, "any")).toEqual(["routing"]);
  });
});

const file = (ordinal: number, path: string, language: string, lineCount: number): FileInfo => ({ ordinal, path, language, lineCount });
const paths = (files: FileInfo[], ordinals: number[]) => ordinals.map((ordinal) => files.find((f) => f.ordinal === ordinal)?.path);

describe("selectContextFiles", () => {
  // The files of santosharron/3D-Mars-landing-page as indexed in production.
  const mars = [
    file(0, "LICENSE", "text", 21),
    file(1, "README.md", "markdown", 10),
    file(2, "index.html", "html", 14),
    file(3, "script.js", "javascript", 371),
    file(4, "style.css", "css", 8),
  ];

  it("uses the README and the HTML entry page for an overview, never the licence", () => {
    expect(paths(mars, selectContextFiles(mars, ["overview"]))).toEqual(["README.md", "index.html"]);
  });

  it("covers every main language for a technology question", () => {
    expect(paths(mars, selectContextFiles(mars, ["technologies"]))).toEqual(["README.md", "script.js", "index.html", "style.css"]);
  });

  it("prefers manifests, then entry points, for a portfolio site", () => {
    const portfolio = [
      file(0, "README.md", "markdown", 39),
      file(1, "package.json", "json", 24),
      file(2, ".gitignore", "text", 2),
      file(3, "assets/css/components.css", "css", 1005),
      file(4, "assets/js/app.js", "javascript", 52),
      file(5, "html/projects.html", "html", 451),
      file(6, "index.html", "html", 525),
      file(7, "js/index.js", "javascript", 665),
      file(8, "server.js", "javascript", 109),
      file(9, "generate_resume_pdf.py", "python", 182),
    ];
    expect(paths(portfolio, selectContextFiles(portfolio, ["overview"]))).toEqual(["README.md", "package.json", "index.html"]);
    expect(paths(portfolio, selectContextFiles(portfolio, ["entry_point"]))).toEqual(["package.json", "index.html", "server.js", "README.md"]);
    expect(paths(portfolio, selectContextFiles(portfolio, ["technologies"]))).toEqual([
      "package.json", "README.md", "assets/css/components.css", "index.html", "server.js", "generate_resume_pdf.py",
    ]);
  });

  it("resolves the entry file a package.json declares, and skips tests", () => {
    const library = [
      file(0, "README.md", "markdown", 277),
      file(1, "package.json", "json", 42),
      file(2, "lib/index.js", "javascript", 238),
      file(3, "test/cors.js", "javascript", 900),
    ];
    const declared = declaredEntryPaths('{ "main": "./lib/index.js" }');
    expect(paths(library, selectContextFiles(library, ["entry_point"], declared))).toEqual(["package.json", "lib/index.js", "README.md"]);
    expect(paths(library, selectContextFiles(library, ["technologies"]))).toEqual(["package.json", "README.md", "lib/index.js"]);
  });

  it("selects nothing for a specific question", () => {
    expect(selectContextFiles(mars, [])).toEqual([]);
  });
});

describe("declaredEntryPaths", () => {
  it("reads main, module, bin, exports and start scripts", () => {
    const json = JSON.stringify({
      main: "./dist/index.cjs",
      module: "dist/index.mjs",
      bin: { tool: "./bin/cli.js" },
      exports: { ".": { import: "./dist/index.mjs", require: "./dist/index.cjs" } },
      scripts: { start: "node server.js --port 3000", test: "mocha test/*.js" },
    });
    expect(declaredEntryPaths(json)).toEqual(["dist/index.cjs", "dist/index.mjs", "bin/cli.js", "server.js"]);
  });

  it("ignores invalid or non-object JSON", () => {
    expect(declaredEntryPaths("{ not json")).toEqual([]);
    expect(declaredEntryPaths("[1, 2]")).toEqual([]);
  });
});

describe("isBoilerplateFor", () => {
  it("drops licence and ignore files unless the question is about them", () => {
    expect(isBoilerplateFor("What does this project do?", "LICENSE")).toBe(true);
    expect(isBoilerplateFor("Which license is it released under?", "LICENSE")).toBe(false);
    expect(isBoilerplateFor("What does this project do?", ".gitignore")).toBe(true);
    expect(isBoilerplateFor("Which files are ignored by git?", ".gitignore")).toBe(false);
    expect(isBoilerplateFor("What does this project do?", "src/license-check.ts")).toBe(false);
  });
});
