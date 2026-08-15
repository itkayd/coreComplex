/**
 * HSK is reporting, never scheduling.
 *
 * The specification is unambiguous: HSK "never decides readiness" (p.9), and HSK
 * reporting is kept separate (p.28). Now that the app ships HSK word lists and a
 * progress screen, that boundary needs a test — a band number is exactly the kind
 * of tempting signal that quietly becomes a scheduling input ("teach HSK 1
 * first"), and the moment it does, the curriculum is a list order rather than the
 * learner's actual memory.
 *
 * These read source text, so a forbidden reference cannot slip in unnoticed.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(name) && !name.endsWith(".test.ts") && !name.endsWith(".test.tsx")) out.push(p);
  }
  return out;
}

test("no learning package mentions HSK at all", () => {
  // Not even as a comment-level concept in scheduling code: the kernel decides
  // from traces, and the domain has no notion of a syllabus level.
  for (const pkg of ["domain", "kernel", "fsrs-adapter"]) {
    for (const file of sourceFiles(join(root, "packages", pkg, "src"))) {
      const src = readFileSync(file, "utf8");
      assert.ok(!/\bhsk\b/i.test(src), `${file} mentions HSK; scheduling must not know about bands`);
    }
  }
});

test("the planner's inputs contain no band or level signal", () => {
  const planner = readFileSync(join(root, "packages", "kernel", "src", "planner.ts"), "utf8");
  for (const t of ["hsk", "band", "syllabus", "curriculumLevel"]) {
    assert.ok(!new RegExp(`\\b${t}\\b`, "i").test(planner), `the planner must not reason about "${t}"`);
  }
});

test("the HSK view reads memory state but never writes it", () => {
  const view = readFileSync(join(root, "apps", "web", "src", "hsk.ts"), "utf8");
  // Reading traces is the whole point; mutating anything is not.
  for (const forbidden of ["submitAttempt", "submitCommand", "planSession", "traces.put", "hydrate("]) {
    assert.ok(!view.includes(forbidden), `the HSK report must not call ${forbidden}`);
  }
});

test("the HSK data file carries its licence provenance", () => {
  const data = JSON.parse(readFileSync(join(root, "apps", "web", "public", "packs", "hsk-bands.json"), "utf8")) as {
    attribution: { source: string; licence: string; holder: string }[];
    counts: Record<string, Record<string, number>>;
  };
  assert.ok(data.attribution.length >= 2, "band membership must record where it came from");
  for (const entry of data.attribution) {
    assert.ok(entry.source.length > 0 && entry.holder.length > 0, "every source needs a named holder");
    assert.equal(entry.licence, "MIT", `${entry.source} is not on the allowed licence list`);
  }
  // Sanity-check the totals against the published standards, so a mangled
  // regeneration is caught rather than silently shipping wrong denominators.
  const total = (s: string) => Object.values(data.counts[s]).reduce((a, b) => a + b, 0);
  assert.ok(total("new") > 10_000 && total("new") < 11_500, `HSK 3.0 total looks wrong: ${total("new")}`);
  assert.ok(total("old") > 4_500 && total("old") < 5_100, `HSK 2.0 total looks wrong: ${total("old")}`);
  assert.equal(Object.keys(data.counts.new).length, 7, "HSK 3.0 has bands 1-6 plus a combined 7-9");
  assert.equal(Object.keys(data.counts.old).length, 6, "HSK 2.0 has six levels");
});
