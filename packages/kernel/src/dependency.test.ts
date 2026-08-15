import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Architecture / dependency-direction tests (spec §20, spec p.29 CONTENT CI +
 * LAYER ISOLATION). These read source text so a forbidden import cannot slip in
 * unnoticed. The kernel must stay headless; only the FSRS adapter may touch
 * ts-fsrs; the domain must be free of scheduling-library types.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", ".."); // repo root

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules") continue;
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

function imports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
}

test("only @dyr/fsrs-adapter imports ts-fsrs", () => {
  for (const pkg of ["domain", "kernel", "content", "senses", "layers"]) {
    for (const file of tsFiles(join(root, "packages", pkg, "src"))) {
      assert.ok(!imports(file).includes("ts-fsrs"), `${pkg} must not import ts-fsrs (${file})`);
    }
  }
});

test("the domain imports no other @dyr package and no scheduling library", () => {
  for (const file of tsFiles(join(root, "packages", "domain", "src"))) {
    for (const spec of imports(file)) {
      assert.ok(!spec.startsWith("@dyr/"), `domain must not import ${spec}`);
      assert.ok(spec !== "ts-fsrs", `domain must be free of ts-fsrs (${file})`);
    }
  }
});

test("the kernel imports no UI / game / layer / provider implementation (headless, Rule 3)", () => {
  const forbidden = ["@dyr/layers", "react", "react-dom", "@dyr/senses", "vue", "svelte"];
  for (const file of tsFiles(join(root, "packages", "kernel", "src"))) {
    for (const spec of imports(file)) {
      assert.ok(!forbidden.includes(spec), `kernel must not import ${spec} (${file})`);
    }
  }
});

test("no learning package imports a concrete language/speech TOOL", () => {
  // The full list from the infrastructure brief. Every one of these is a
  // sensory provider, content tool or presentation concern — none may appear in
  // the learning brain, or an upgrade to a segmenter/model could silently change
  // lexeme identity, evidence, or scheduling.
  const tools = [
    "jieba", "nodejieba", "opencc", "pinyin", "pypinyin", "hanzi-writer",
    "sherpa-onnx", "librosa", "montreal-forced-aligner", "ffmpeg", "fluent-ffmpeg",
    "cosyvoice", "fastapi", "playwright", "@playwright/test", "axe-core",
    "minisearch", "workbox-window", "yjs", "zod", "umami", "@opentelemetry/api",
  ];
  for (const pkg of ["domain", "kernel", "content", "layers"]) {
    for (const file of tsFiles(join(root, "packages", pkg, "src"))) {
      for (const spec of imports(file)) {
        assert.ok(!tools.includes(spec.toLowerCase()),
          `${pkg} must not import "${spec}" (${file})`);
      }
    }
  }
});

test("the content import pipeline is build-time only — the kernel never imports it", () => {
  for (const file of tsFiles(join(root, "packages", "kernel", "src"))) {
    for (const spec of imports(file)) {
      assert.ok(!spec.includes("/import/"), `kernel must not import the content pipeline (${file})`);
      assert.ok(spec !== "@dyr/content", `kernel must not import @dyr/content (${file})`);
    }
  }
});

test("no learning package imports a concrete speech engine (CosyVoice isolation)", () => {
  // CosyVoice, its FastAPI runtime and the service that wraps it must stay
  // behind the SyntheticSpeechProvider contract. A speech engine appearing in
  // the domain/kernel/content/layers would couple learning logic to an engine.
  const engineish = /cosyvoice|fastapi|uvicorn|torchaudio|python|melotts|piper-tts|@dyr\/service/i;
  for (const pkg of ["domain", "kernel", "content", "layers"]) {
    for (const file of tsFiles(join(root, "packages", pkg, "src"))) {
      for (const spec of imports(file)) {
        assert.ok(!engineish.test(spec), `${pkg} must not import speech engine "${spec}" (${file})`);
      }
    }
  }
});

test("only the service adapter knows CosyVoice; senses stays an interface", () => {
  // @dyr/senses may NAME the engine in prose, but must not import or implement
  // one — it is the contract the engine is swapped behind.
  for (const file of tsFiles(join(root, "packages", "senses", "src"))) {
    for (const spec of imports(file)) {
      assert.ok(!/cosyvoice|fastapi|node:child_process|node:http/i.test(spec),
        `senses must remain a pure contract, found "${spec}" (${file})`);
    }
  }
});

test("the speech service depends only on contracts, never on the kernel", () => {
  // The service wires an engine to a contract; it has no business importing the
  // learning kernel, and must never be able to write learning state.
  for (const file of tsFiles(join(root, "apps", "service", "src"))) {
    for (const spec of imports(file)) {
      assert.ok(spec !== "@dyr/kernel", `service must not import the kernel (${file})`);
      assert.ok(spec !== "@dyr/layers", `service must not import layers (${file})`);
    }
  }
});

test("THE REMOTE DATABASE IS INVISIBLE TO THE LEARNING BRAIN", () => {
  // The backup is durable storage and nothing more. A learning package that
  // could reach the database would be able to read or write memory state over
  // the network, and the kernel would stop being the sole authority on what a
  // learner knows (spec p.3). The browser must not reach it either: it holds no
  // key, and same-origin /api/sync is what keeps `connect-src 'self'` true.
  const database = /supabase|postgres|@neondatabase|pg-promise|knex|prisma|drizzle-orm|mysql/i;
  const packages = [
    ...["domain", "kernel", "content", "layers", "senses", "fsrs-adapter"].map((p) => join(root, "packages", p, "src")),
    join(root, "apps", "web", "src"),
    join(root, "apps", "service", "src"),
  ];
  for (const dir of packages) {
    for (const file of tsFiles(dir)) {
      for (const spec of imports(file)) {
        assert.ok(!database.test(spec), `${file} must not import a database client ("${spec}")`);
      }
    }
  }
});

test("no package declares a paid speech/AI SaaS dependency", () => {
  const paid = ["@google-cloud/text-to-speech", "microsoft-cognitiveservices-speech-sdk",
    "elevenlabs", "@aws-sdk/client-polly", "openai", "@azure/cognitiveservices-speech",
    "@deepgram/sdk", "assemblyai", "playht"];
  const manifests = ["package.json",
    ...["domain", "kernel", "content", "senses", "layers", "fsrs-adapter"].map((p) => join("packages", p, "package.json")),
    join("apps", "service", "package.json"), join("apps", "web", "package.json")];
  for (const rel of manifests) {
    const file = join(root, rel);
    let raw: string;
    try { raw = readFileSync(file, "utf8"); } catch { continue; }
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    for (const dep of names) {
      assert.ok(!paid.includes(dep), `${rel} declares paid dependency ${dep}`);
    }
  }
});

test("layers import only domain read-contracts, never the kernel or its stores", () => {
  for (const file of tsFiles(join(root, "packages", "layers", "src"))) {
    for (const spec of imports(file)) {
      assert.ok(spec !== "@dyr/kernel", `layers must not import the kernel (${file})`);
      assert.ok(spec !== "ts-fsrs", `layers must not import ts-fsrs (${file})`);
    }
  }
});
