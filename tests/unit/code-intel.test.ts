import { describe, expect, it } from "vitest";
import { type ResolveContext, parseImports, resolveImport } from "../../shared/code/imports.ts";
import { declaredIndex, parseManifest } from "../../shared/code/manifests.ts";
import { extractDefinitions, findOccurrences, languageFamily } from "../../shared/code/symbols.ts";
import { readmePurpose } from "../../worker/code-intel.ts";

const defs = (text: string, language: string, path?: string) =>
  extractDefinitions(text, language, { path }).map((d) => `${d.kind} ${d.container ? `${d.container}.` : ""}${d.name} ${d.line}-${d.endLine}`);

describe("extractDefinitions: JavaScript and TypeScript", () => {
  it("finds functions, classes, methods, arrow functions and constants with their line ranges", () => {
    const source = [
      "import { join } from 'node:path';", //1
      "const helpers = require('./helpers');", //2
      "export const DEFAULT_TIMEOUT = 5000;", //3
      "", //4
      "export function createClient(options) {", //5
      "  const url = join(options.base, '/');", //6
      "  return new Client(url);", //7
      "}", //8
      "", //9
      "export class Client extends Base {", //10
      "  constructor(url) {", //11
      "    super();", //12
      "    this.url = url;", //13
      "  }", //14
      "", //15
      "  async request(path, { method = 'GET' } = {}) {", //16
      "    if (path) {", //17
      "      return fetch(this.url + path, { method });", //18
      "    }", //19
      "  }", //20
      "", //21
      "  static get version() { return '1'; }", //22
      "  onError = (error) => this.log(error);", //23
      "}", //24
      "", //25
      "const toQuery = (params) => {", //26
      "  return new URLSearchParams(params).toString();", //27
      "};", //28
      "module.exports.retry = function (fn) { return fn(); };", //29
    ].join("\n");
    expect(defs(source, "javascript")).toEqual([
      "constant DEFAULT_TIMEOUT 3-3",
      "function createClient 5-8",
      "class Client 10-24",
      "method Client.constructor 11-14",
      "method Client.request 16-20",
      "method Client.version 22-22",
      "method Client.onError 23-23",
      "function toQuery 26-28",
      "function retry 29-29",
    ]);
  });

  it("finds object-literal functions, named function expressions and TypeScript types", () => {
    const source = [
      "let planet = {", //1
      "  sphere: function (size) {", //2
      "    return size;", //3
      "  },", //4
      "  latLongToVector3: function latLongToVector3(lat, lon) {", //5
      "    return [lat, lon];", //6
      "  },", //7
      "};", //8
      "export interface Options { timeout: number }", //9
      "export type Method = 'GET' | 'POST';", //10
      "export enum Level { Low, High }", //11
    ].join("\n");
    expect(defs(source, "typescript")).toEqual([
      "variable planet 1-8",
      "function sphere 2-4",
      "function latLongToVector3 5-7",
      "interface Options 9-9",
      "type Method 10-10",
      "enum Level 11-11",
    ]);
  });

  it("marks capitalised functions that return JSX as components", () => {
    const source = ["export default function Hero({ title }) {", "  return (", "    <header>{title}</header>", "  );", "}", "function formatDate(d) { return d; }"].join("\n");
    expect(defs(source, "javascript", "src/pages/index.js")).toEqual(["component Hero 1-5", "function formatDate 6-6"]);
  });

  it("ignores braces and keywords inside strings, templates and comments", () => {
    const source = ["function a() {", "  const s = '}';", "  const t = `${'{'} }`;", "  // }", "  /* } */", "  if (s) { return t; }", "}", "function b() {}"].join("\n");
    expect(defs(source, "javascript")).toEqual(["function a 1-7", "function b 8-8"]);
  });

  it("does not read quotes or backticks inside a regular expression as a string (axios lib/core/AxiosHeaders.js)", () => {
    const source = [
      "const isValidHeaderName = (str) => /^[-_a-zA-Z0-9^`|~,!#$%&'*+.]+$/.test(str.trim());", //1
      "const half = total / 2 / count;", //2
      "function split(s) { return s.split(/[{}]/); }", //3
      "const el = (x) => <div>{x}</div>;", //4
      "class AxiosHeaders {", //5
      "  set(header) {", //6
      "    return /`/.test(header) ? '`' : header;", //7
      "  }", //8
      "}", //9
    ].join("\n");
    expect(defs(source, "javascript", "lib/core/AxiosHeaders.js")).toEqual([
      "function isValidHeaderName 1-1",
      "constant half 2-2",
      "function split 3-3",
      "function el 4-4",
      "class AxiosHeaders 5-9",
      "method AxiosHeaders.set 6-8",
    ]);
  });
});

describe("extractDefinitions: other languages", () => {
  it("Python: classes, methods, nested functions and constants by indentation", () => {
    const source = [
      "MAX_RETRIES = 3", //1
      "", //2
      "class NoSuchOption(UsageError):", //3
      '    """Raised when an option does not exist."""', //4
      "", //5
      "    def __init__(self, name):", //6
      "        def helper():", //7
      "            return name", //8
      "        self.name = helper()", //9
      "", //10
      "    async def format_message(self):", //11
      "        return self.name", //12
      "", //13
      "@decorator", //14
      "def make_pass_decorator(object_type):", //15
      "    return object_type", //16
    ].join("\n");
    expect(defs(source, "python")).toEqual([
      "constant MAX_RETRIES 1-1",
      "class NoSuchOption 3-12",
      "method NoSuchOption.__init__ 6-9",
      "function helper 7-8",
      "method NoSuchOption.format_message 11-12",
      "function make_pass_decorator 15-16",
    ]);
  });

  it("Go: functions, methods with receivers, types and const blocks", () => {
    const source = [
      "package cobra", //1
      "", //2
      "const (", //3
      "\tdefaultPrefix = \"cobra\"", //4
      "\tmaxDepth      = 10", //5
      ")", //6
      "", //7
      "type Command struct {", //8
      "\tUse string", //9
      "}", //10
      "", //11
      "func (c *Command) SuggestionsFor(typedName string) []string {", //12
      "\treturn nil", //13
      "}", //14
      "", //15
      "func ld(s, t string, ignoreCase bool) int {", //16
      "\treturn 0", //17
      "}", //18
    ].join("\n");
    expect(defs(source, "go")).toEqual([
      "constant defaultPrefix 4-4",
      "constant maxDepth 5-5",
      "struct Command 8-10",
      "method Command.SuggestionsFor 12-14",
      "function ld 16-18",
    ]);
  });

  it("Rust, Java, Ruby, PHP, C and shell", () => {
    expect(defs(["pub struct Point { x: i32 }", "impl Point {", "    pub fn new() -> Self {", "        Point { x: 0 }", "    }", "}", "trait Shape {}"].join("\n"), "rust")).toEqual([
      "struct Point 1-1",
      "method Point.new 3-5",
      "trait Shape 7-7",
    ]);
    expect(defs(["public class Parser {", "    public List<String> parse(String input) {", "        return null;", "    }", "}"].join("\n"), "java")).toEqual([
      "class Parser 1-5",
      "method Parser.parse 2-4",
    ]);
    expect(defs(["class Repo", "  def clone(url)", "    run(url)", "  end", "end"].join("\n"), "ruby")).toEqual(["class Repo 1-5", "method Repo.clone 2-4"]);
    expect(defs(["<?php", "class Cart {", "    public function total() {", "        return 0;", "    }", "}"].join("\n"), "php")).toEqual(["class Cart 2-6", "method Cart.total 3-5"]);
    expect(defs(["#define MAX 10", "struct node {", "  int value;", "};", "static int add(int a, int b)", "{", "  return a + b;", "}"].join("\n"), "c")).toEqual([
      "macro MAX 1-1",
      "struct node 2-4",
      "function add 5-8",
    ]);
    expect(defs(["deploy() {", "  echo done", "}"].join("\n"), "shell")).toEqual(["function deploy 1-3"]);
  });

  it("supports a fixed set of language families", () => {
    expect(languageFamily("typescript")).toBe("js");
    expect(languageFamily("markdown")).toBeNull();
    expect(extractDefinitions("# Title", "markdown")).toEqual([]);
  });

  it("offsets line numbers for a chunk that starts later in its file", () => {
    expect(extractDefinitions("def run():\n    pass", "python", { startLine: 120 })[0]).toMatchObject({ line: 120, endLine: 121 });
  });
});

describe("findOccurrences", () => {
  it("classifies definitions, imports and references of an exact identifier", () => {
    const source = [
      "import { mergeConfig } from './mergeConfig.js';",
      "export default function mergeConfig(a, b) {",
      "  return mergeConfigDeep(a, b); // mergeConfig handles defaults",
      "}",
      "const merged = mergeConfig(x, y);",
    ].join("\n");
    expect(findOccurrences(source, "mergeConfig", "javascript").map((o) => `${o.line}:${o.kind}`)).toEqual(["1:import", "2:definition", "3:reference", "5:reference"]);
  });
});

const ctx = (paths: string[], declared: Record<string, [string, number]> = {}, goModule: string | null = null): ResolveContext => ({
  files: new Map(paths.map((path) => [path, true])),
  declared: new Map(Object.entries(declared).map(([name, [path, line]]) => [name, { path, line }])),
  goModule,
});

describe("parseImports and resolveImport", () => {
  it("parses JavaScript imports, including multi-line and dynamic ones", () => {
    const source = [
      "import axios from 'axios';",
      "import {",
      "  mergeConfig,",
      "  buildFullPath,",
      "} from './core/index.js';",
      "export * from './helpers';",
      "import './styles.css';",
      "const fs = require('node:fs');",
      "const lazy = () => import('./lazy.js');",
      "const plugin = require(name);",
      "// import ignored from 'commented-out';",
    ].join("\n");
    const parsed = parseImports(source, "javascript");
    expect(parsed?.imports.map((i) => `${i.line}-${i.endLine} ${i.kind} ${i.specifier}`)).toEqual([
      "1-1 static axios",
      "2-5 static ./core/index.js",
      "6-6 re-export ./helpers",
      "7-7 side-effect ./styles.css",
      "8-8 require node:fs",
      "9-9 dynamic ./lazy.js",
    ]);
    expect(parsed?.dynamic.map((d) => d.line)).toEqual([10]);
  });

  it("resolves JavaScript specifiers to files, packages and built-ins", () => {
    const c = ctx(["lib/core/index.ts", "lib/helpers.js", "src/utils/date.ts", "lib/axios.js"], { axios: ["package.json", 12] });
    const resolve = (specifier: string, from = "lib/axios.js") => resolveImport({ specifier, kind: "static" }, from, "javascript", c);
    expect(resolve("./core/index.js")).toMatchObject({ kind: "internal", target: "lib/core/index.ts" });
    expect(resolve("./helpers")).toMatchObject({ kind: "internal", target: "lib/helpers.js" });
    expect(resolve("./core")).toMatchObject({ kind: "internal", target: "lib/core/index.ts" });
    expect(resolve("@/utils/date")).toMatchObject({ kind: "internal", target: "src/utils/date.ts", via: "path alias @/" });
    expect(resolve("axios")).toEqual({ kind: "package", name: "axios", declared: { path: "package.json", line: 12 } });
    expect(resolve("@babel/core/lib/x")).toEqual({ kind: "package", name: "@babel/core", declared: null });
    expect(resolve("node:fs")).toEqual({ kind: "builtin", name: "fs" });
    expect(resolve("./missing")).toMatchObject({ kind: "unresolved" });
    expect(resolve("../../outside")).toMatchObject({ kind: "unresolved", reason: "points outside the repository" });
  });

  it("parses and resolves Python imports (relative, src layout, standard library, packages)", () => {
    const source = ["from . import types", "from .core import Command", "from ._compat import (", "    term_len,", ")", "import os, sys", "import yaml", "mod = importlib.import_module(name)"].join("\n");
    const parsed = parseImports(source, "python");
    expect(parsed?.imports.map((i) => `${i.line} ${i.specifier}`)).toEqual(["1 .types", "2 .core", "3 ._compat", "6 os", "6 sys", "7 yaml"]);
    expect(parsed?.dynamic.map((d) => d.line)).toEqual([8]);
    const c = ctx(["src/click/__init__.py", "src/click/core.py", "src/click/types.py", "src/click/_compat.py"], { pyyaml: ["pyproject.toml", 9] });
    const resolve = (specifier: string) => resolveImport({ specifier, kind: "static" }, "src/click/decorators.py", "python", c);
    expect(resolve(".core")).toMatchObject({ kind: "internal", target: "src/click/core.py" });
    expect(resolve(".types")).toMatchObject({ kind: "internal", target: "src/click/types.py" });
    expect(resolve("click.core")).toMatchObject({ kind: "internal", target: "src/click/core.py" });
    expect(resolve("os")).toEqual({ kind: "builtin", name: "os" });
    expect(resolve("yaml")).toEqual({ kind: "package", name: "pyyaml", declared: { path: "pyproject.toml", line: 9 } });
  });

  it("parses and resolves Go imports against the module path", () => {
    const source = ['import (', '\t"fmt"', '\tflag "github.com/spf13/pflag"', '\t"github.com/spf13/cobra/doc"', ")"].join("\n");
    const parsed = parseImports(source, "go");
    expect(parsed?.imports.map((i) => i.specifier)).toEqual(["fmt", "github.com/spf13/pflag", "github.com/spf13/cobra/doc"]);
    const c = ctx(["doc/man_docs.go", "command.go"], { "github.com/spf13/pflag": ["go.mod", 8] }, "github.com/spf13/cobra");
    const resolve = (specifier: string) => resolveImport({ specifier, kind: "static" }, "command.go", "go", c);
    expect(resolve("github.com/spf13/cobra/doc")).toMatchObject({ kind: "internal", target: "doc", targetType: "directory" });
    expect(resolve("fmt")).toEqual({ kind: "builtin", name: "fmt" });
    expect(resolve("github.com/spf13/pflag")).toEqual({ kind: "package", name: "github.com/spf13/pflag", declared: { path: "go.mod", line: 8 } });
  });

  it("parses HTML scripts and stylesheets, and CSS imports", () => {
    const html = [
      "<link rel='stylesheet' href='style.css'>",
      "<script src='https://cdnjs.cloudflare.com/ajax/libs/three.js/r73/three.min.js'></script>",
      '<script src="./script.js"></script>',
    ].join("\n");
    const c = ctx(["style.css", "script.js", "base.css"]);
    const resolved = parseImports(html, "html")?.imports.map((i) => resolveImport(i, "index.html", "html", c));
    expect(resolved).toEqual([
      { kind: "internal", target: "style.css", targetType: "file", indexed: true },
      { kind: "remote", url: "https://cdnjs.cloudflare.com/ajax/libs/three.js/r73/three.min.js", library: "three" },
      { kind: "internal", target: "script.js", targetType: "file", indexed: true },
    ]);
    expect(parseImports("@import url('base.css');", "css")?.imports.map((i) => i.specifier)).toEqual(["base.css"]);
  });

  it("cites a tag spread over several lines up to the line holding its URL (axios sandbox/client.html)", () => {
    const html = ["<head>", '  <link rel="stylesheet" type="text/css"', '    href="https://cdn.example/bootstrap.min.css" />', "</head>"].join("\n");
    expect(parseImports(html, "html")?.imports).toEqual([{ line: 2, endLine: 3, specifier: "https://cdn.example/bootstrap.min.css", kind: "stylesheet" }]);
  });

  it("finds methods attached at run time (Mars `this.placeMarker = function`)", () => {
    const source = ["var controls = new function () {", "  this.placeMarker = function () {", "    place();", "  };", "};", "Planet.prototype.spin = function (speed) {", "  return speed;", "};"].join("\n");
    expect(defs(source, "javascript")).toEqual(["variable controls 1-5", "method placeMarker 2-4", "method Planet.spin 6-8"]);
  });

  it("reports languages without import analysis", () => {
    expect(parseImports("use std::io;", "rust")).toBeNull();
  });
});

describe("parseManifest", () => {
  it("reads package.json fields, scripts and dependencies with their lines", () => {
    const text = [
      "{", //1
      '  "name": "axios",', //2
      '  "description": "Promise based HTTP client",', //3
      '  "main": "./dist/node/axios.cjs",', //4
      '  "scripts": {', //5
      '    "start": "node server.js"', //6
      "  },", //7
      '  "dependencies": {', //8
      '    "follow-redirects": "^1.15.6",', //9
      '    "form-data": "^4.0.0"', //10
      "  },", //11
      '  "devDependencies": { "jest": "^29" }', //12
      "}", //13
    ].join("\n");
    const info = parseManifest("package.json", text);
    expect(info?.name).toEqual({ value: "axios", line: 2 });
    expect(info?.description).toEqual({ value: "Promise based HTTP client", line: 3 });
    expect(info?.entries).toEqual([{ field: "main", value: "./dist/node/axios.cjs", line: 4 }]);
    expect(info?.scripts).toEqual([{ name: "start", command: "node server.js", line: 6 }]);
    expect(info?.dependencies.map((d) => `${d.scope} ${d.name} ${d.line}`)).toEqual(["runtime follow-redirects 9", "runtime form-data 10"]);
  });

  it("reads pyproject.toml lists, optional and build dependencies, and scripts", () => {
    const text = [
      "[project]", //1
      'name = "click"', //2
      'description = "Composable command line interface toolkit"', //3
      "dependencies = [", //4
      '    "colorama; platform_system == \'Windows\'",', //5
      "]", //6
      "[project.optional-dependencies]", //7
      'docs = ["sphinx>=7", "pallets-sphinx-themes"]', //8
      "[project.scripts]", //9
      'flask = "flask.cli:main"', //10
      "[build-system]", //11
      'requires = ["flit_core<4"]', //12
    ].join("\n");
    const info = parseManifest("pyproject.toml", text);
    expect(info?.description?.line).toBe(3);
    expect(info?.dependencies.map((d) => `${d.scope} ${d.name} ${d.line}`)).toEqual(["runtime colorama 5", "optional sphinx 8", "optional pallets-sphinx-themes 8", "build flit_core 12"]);
    expect(info?.entries).toEqual([{ field: "project.scripts.flask", value: "flask.cli:main", line: 10 }]);
  });

  it("reads go.mod, requirements.txt and Cargo.toml", () => {
    const go = parseManifest("go.mod", ["module github.com/spf13/cobra", "", "go 1.15", "", "require (", "\tgithub.com/spf13/pflag v1.0.9", "\tgo.yaml.in/yaml/v3 v3.0.4 // indirect", ")"].join("\n"));
    expect(go?.name?.value).toBe("github.com/spf13/cobra");
    expect(go?.dependencies.map((d) => `${d.scope} ${d.name} ${d.line}`)).toEqual(["runtime github.com/spf13/pflag 6", "indirect go.yaml.in/yaml/v3 7"]);
    expect(parseManifest("requirements.txt", "# web\nflask==3.0\n-r base.txt\nrequests>=2\n")?.dependencies.map((d) => `${d.name} ${d.line}`)).toEqual(["flask 2", "requests 4"]);
    const cargo = parseManifest("Cargo.toml", ['[package]', 'name = "tool"', "[dependencies]", 'serde = { version = "1", features = ["derive"] }', "[dev-dependencies]", 'tempfile = "3"'].join("\n"));
    expect(cargo?.dependencies.map((d) => `${d.scope} ${d.name} ${d.version}`)).toEqual(["runtime serde 1", "dev tempfile 3"]);
    expect(declaredIndex([go!]).get("github.com/spf13/pflag")).toEqual({ path: "go.mod", line: 6 });
  });
});

describe("readmePurpose", () => {
  it("quotes the first prose paragraph, skipping badges, HTML and headings", () => {
    const readme = [
      '<div align="center"><img src="logo.png"></div>', //1
      "", //2
      "# Cobra", //3
      "[![Test](https://img.shields.io/badge.svg)](https://ci)", //4
      "", //5
      "Cobra is a library for creating powerful modern CLI", //6
      "applications in [Go](https://go.dev).", //7
      "", //8
      "Other text.", //9
    ].join("\n");
    expect(readmePurpose(readme)).toEqual({ title: "Cobra", text: "Cobra is a library for creating powerful modern CLI applications in Go.", startLine: 6, endLine: 7 });
  });
});
