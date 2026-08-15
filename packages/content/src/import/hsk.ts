/**
 * HSK 3.0 level model and source admission.
 *
 * HSK 3.0 is three stages / nine levels. Some sources publish 7–9 as a single
 * combined band; that original classification is PRESERVED as published, while
 * the internal model keeps nine distinct levels so a future source that splits
 * 7/8/9 needs no redesign. Nothing here assumes 7–9 stays combined forever.
 *
 * HSK is a REPORTING MAP, never the scheduler (spec p.9): a level may explain or
 * order content, but it never decides readiness, schedules a review, or collapses
 * the four-dimensional profile into one number.
 */
import type { SourceAsset } from "../index.ts";

export const HSK_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type HskLevel = (typeof HSK_LEVELS)[number];

/** HSK 3.0 stages. */
export type HskStage = "elementary" | "intermediate" | "advanced";

export function stageOf(level: HskLevel): HskStage {
  if (level <= 3) return "elementary";
  if (level <= 6) return "intermediate";
  return "advanced";
}

/**
 * How a source published the level. `7-9` records that the upstream did not
 * distinguish within the advanced band — we keep that fact rather than
 * inventing a precision the source never had.
 */
export type PublishedBand = "1" | "2" | "3" | "4" | "5" | "6" | "7-9" | "7" | "8" | "9";

export interface HskAssignment {
  /** Dyr lexeme id — never raw Chinese text as permanent identity. */
  lexemeId: string;
  simplified: string;
  /** Internal level. For a "7-9" source this is 7, with band preserved below. */
  level: HskLevel;
  /** Exactly as the source published it. */
  publishedBand: PublishedBand;
  stage: HskStage;
  sourceName: string;
}

export function assignmentFrom(input: {
  lexemeId: string;
  simplified: string;
  publishedBand: PublishedBand;
  sourceName: string;
}): HskAssignment {
  const level = (input.publishedBand === "7-9" ? 7 : Number(input.publishedBand)) as HskLevel;
  return {
    lexemeId: input.lexemeId,
    simplified: input.simplified,
    level,
    publishedBand: input.publishedBand,
    stage: stageOf(level),
    sourceName: input.sourceName,
  };
}

// ---------------------------------------------------------------------------
// Source admission
// ---------------------------------------------------------------------------

/**
 * Provenance declared by an upstream repository, per COMPONENT.
 *
 * A repository is not one legal object: a single repo can mix CC BY-SA data with
 * material that cannot be redistributed at all. Admission is therefore decided
 * per component, never per repository.
 */
export interface SourceComponent {
  component: string;
  /** SPDX id, or the literal "UNKNOWN" when the source does not say. */
  licenseSpdx: string;
  /** Upstream the component was itself derived from, if declared. */
  derivedFrom?: string;
  url?: string;
}

export interface SourceAudit {
  sourceName: string;
  url: string;
  components: SourceComponent[];
}

export type AdmissionVerdict = "admit" | "reject" | "human_review";

export interface ComponentDecision {
  component: string;
  verdict: AdmissionVerdict;
  reason: string;
}

/**
 * Origins Dyr may never bundle, however the intermediate repository is licensed.
 * A permissive licence on a redistribution does not launder the origin.
 */
const FORBIDDEN_ORIGINS = [
  { match: /pleco/i, why: "Pleco-derived data is denied by the content policy (spec p.7, p.22)" },
  { match: /\bhsk\.cn\b|moe\.gov\.cn/i, why: "official HSK publication: redistribution rights not established (spec p.22)" },
  { match: /anki\s*deck|shared\s*deck/i, why: "community deck of uncertain onward provenance" },
];

const ALLOWED_LICENCES = new Set([
  "CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "MIT", "Apache-2.0", "Unicode-DFS-2016",
]);

const DENIED_LICENCE_TOKENS = [/-NC/i, /-ND/i, /UNKNOWN/i, /PROPRIETARY/i];

/**
 * Decide admission for each component of a source.
 *
 * The rule the spec insists on: when provenance is ambiguous, DO NOT IMPORT —
 * route it to human review instead of guessing.
 */
export function auditSource(audit: SourceAudit): ComponentDecision[] {
  return audit.components.map((component) => {
    const origin = `${component.derivedFrom ?? ""} ${component.url ?? ""} ${component.component}`;
    for (const forbidden of FORBIDDEN_ORIGINS) {
      if (forbidden.match.test(origin)) {
        return { component: component.component, verdict: "reject" as const, reason: forbidden.why };
      }
    }
    for (const denied of DENIED_LICENCE_TOKENS) {
      if (denied.test(component.licenseSpdx)) {
        return {
          component: component.component,
          verdict: "reject" as const,
          reason: `licence not redistributable: ${component.licenseSpdx}`,
        };
      }
    }
    if (!ALLOWED_LICENCES.has(component.licenseSpdx)) {
      return {
        component: component.component,
        verdict: "human_review" as const,
        reason: `licence not on the allowlist: ${component.licenseSpdx}`,
      };
    }
    return {
      component: component.component,
      verdict: "admit" as const,
      reason: `allowed under ${component.licenseSpdx}`,
    };
  });
}

/**
 * The audit of krmanik/HSK-3.0, transcribed from that repository's own
 * License.md (fetched 2026-08). It is recorded here because the result is a
 * decision the project must be able to justify later, not a one-off judgement.
 *
 * The repository is genuinely useful and openly licensed in parts — but its HSK
 * 3.0 WORD LISTS are declared as coming from Pleco, and the repo has a single
 * root licence file with no per-file provenance that would let the wordlists be
 * separated from the CC-BY-SA components. Under "if uncertain, do not import",
 * the word lists are rejected.
 */
export const HSK30_KRMANIK_AUDIT: SourceAudit = {
  sourceName: "krmanik/HSK-3.0",
  url: "https://github.com/krmanik/HSK-3.0",
  components: [
    { component: "HSK 3.0 word lists (Pleco)", licenseSpdx: "MIT", derivedFrom: "Pleco forums", url: "https://plecoforums.com/threads/hsk-3-0-flashcards.6706/" },
    { component: "HSK 3.0 official syllabus", licenseSpdx: "UNKNOWN", derivedFrom: "moe.gov.cn", url: "http://www.moe.gov.cn" },
    { component: "CC-CEDICT extract", licenseSpdx: "CC-BY-SA-4.0", derivedFrom: "CC-CEDICT" },
    { component: "SUBTLEX-CH frequency", licenseSpdx: "CC-BY-SA-4.0", derivedFrom: "openlexicon" },
  ],
};
