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

test("layers import only domain read-contracts, never the kernel or its stores", () => {
  for (const file of tsFiles(join(root, "packages", "layers", "src"))) {
    for (const spec of imports(file)) {
      assert.ok(spec !== "@dyr/kernel", `layers must not import the kernel (${file})`);
      assert.ok(spec !== "ts-fsrs", `layers must not import ts-fsrs (${file})`);
    }
  }
});
