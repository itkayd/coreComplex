/**
 * `npm run content:sources` — what is installed, what is missing, what to do.
 *
 * Makes the remaining Stage 2 content blockers measurable rather than a feeling.
 * Requires no network.
 */
import { buildCore60Pack } from "../src/pipeline.ts";
import { isCanonical } from "../src/audio.ts";
import {
  importAudioCandidates, importCedict, importTatoeba, inspectSource,
} from "../src/sources/index.ts";

const inbox = process.argv[2] ?? "sources/inbox";
const line = (s = "") => console.log(s);
const yn = (v: boolean) => (v ? "YES" : "NO");

const { pack } = buildCore60Pack();

line("Dyr Mandarin Source Status");
line("==========================");
line(`inbox: ${inbox}`);
line();

// ---- CC-CEDICT ----
const cedict = importCedict(inbox);
line("CC-CEDICT");
line(`  Installed:      ${yn(cedict.installed)}`);
if (cedict.installed) {
  line(`  Licence:        ${cedict.status.manifest?.licenseSpdx}`);
  line(`  Source version: ${cedict.status.manifest?.sourceVersion}`);
  line(`  Hash:           ${cedict.sha256}`);
  line(`  Entries parsed: ${cedict.parsed?.entries.length}`);
  line(`  Rejected lines: ${cedict.parsed?.rejected.length}`);
} else {
  line(`  Reason:         ${cedict.status.state.replace(/_/g, " ")}`);
  line(`  Required for Stage 2? NO — enrichment only (spec p.28 lists licensed lexemes + human audio)`);
}
line();

// ---- HSK ----
const hsk = inspectSource("hsk", inbox);
line("HSK mapping");
line(`  Installed:      ${yn(hsk.state === "ready")}`);
line(`  Reason:         ${hsk.state === "ready" ? "approved source supplied" : "no approved redistributable source supplied"}`);
line("  Required for Stage 2? NO — spec p.28 says \"Keep HSK reporting separate\"; p.9 says HSK never decides readiness");
line();

// ---- Tatoeba ----
const tatoeba = importTatoeba(inbox);
line("Tatoeba sentences");
line(`  Installed:            ${yn(tatoeba.installed)}`);
if (tatoeba.installed) {
  line(`  Mandarin sentences:   ${tatoeba.mandarinSentences.length}`);
  line(`  Usable translations:  ${tatoeba.translations.size}`);
  line(`  Licensed audio rows:  ${tatoeba.audioRows.length}`);
  line(`  Audio rejected (no licence): ${tatoeba.audioRejectedForLicence}`);
} else {
  line(`  Reason:               ${tatoeba.status.state.replace(/_/g, " ")}`);
  line("  Required for Stage 2? NO — sentences are enrichment; the 60 lexemes already carry senses");
}
line();

// ---- Human audio ----
const audio = importAudioCandidates(inbox);
const licenceRejected = audio.results.filter((r) => r.rejections.some((c) => c.startsWith("licence"))).length;
const qaRejected = audio.results.filter((r) => r.rejections.includes("signal_screening_failed")).length;
line("Human audio");
line(`  Candidates:        ${audio.results.length}`);
line(`  Licence accepted:  ${audio.results.length - licenceRejected}`);
line(`  Licence rejected:  ${licenceRejected}`);
line(`  QA accepted:       ${audio.accepted.length}`);
line(`  QA rejected:       ${qaRejected}`);
line();

// ---- Stage 2 canonical coverage (the actual blocker) ----
const total = pack.lexemes.length;
const canonical = pack.lexemes.filter((l) => isCanonical(pack.audio.get(String(l.id)))).length;
line("Canonical Stage 2 audio coverage");
line(`  ${canonical} / ${total}`);
line();

if (!cedict.installed) { line(cedict.message); line(); }
if (!audio.installed) { line(audio.message); line(); }
if (!tatoeba.installed) { line(tatoeba.message); line(); }
