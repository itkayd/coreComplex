/**
 * Branded identifier types.
 *
 * The spec (p.15) insists language objects are "a graph, not a deck" and that
 * a prompt is generated from a *versioned language object plus a target skill
 * direction; it is never the permanent unit of mastery". Branding the ID
 * strings keeps a LexemeId from ever being passed where a TraceId is expected,
 * which is exactly the confusion the four-traces rule (p.4) forbids.
 */

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type LearnerId = Brand<string, "LearnerId">;
export type DeviceId = Brand<string, "DeviceId">;
export type LexemeId = Brand<string, "LexemeId">;
export type CharacterId = Brand<string, "CharacterId">;
export type SentenceId = Brand<string, "SentenceId">;
export type PackVersion = Brand<string, "PackVersion">;
export type PlannerVersion = Brand<string, "PlannerVersion">;
export type TraceId = Brand<string, "TraceId">;
export type TaskId = Brand<string, "TaskId">;
export type AttemptId = Brand<string, "AttemptId">;
export type EventId = Brand<string, "EventId">;
export type FactId = Brand<string, "FactId">;

// Constructors — thin, but they make intent explicit at call sites and give a
// single place to add validation later.
export const LearnerId = (s: string): LearnerId => s as LearnerId;
export const DeviceId = (s: string): DeviceId => s as DeviceId;
export const LexemeId = (s: string): LexemeId => s as LexemeId;
export const CharacterId = (s: string): CharacterId => s as CharacterId;
export const SentenceId = (s: string): SentenceId => s as SentenceId;
export const PackVersion = (s: string): PackVersion => s as PackVersion;
export const PlannerVersion = (s: string): PlannerVersion => s as PlannerVersion;
export const TaskId = (s: string): TaskId => s as TaskId;
export const TraceId = (s: string): TraceId => s as TraceId;
export const AttemptId = (s: string): AttemptId => s as AttemptId;
export const EventId = (s: string): EventId => s as EventId;
export const FactId = (s: string): FactId => s as FactId;

/**
 * A SkillTrace is identified by the pairing of a lexeme and a single skill
 * direction — never by the lexeme alone. This is the physical embodiment of
 * spec Rule 1 (Four Traces) and Rule 2 (One Update): four independent traces
 * per concept, and one accepted attempt touches exactly one of them.
 */
export function traceId(lexeme: LexemeId, skill: string): TraceId {
  return `${lexeme}::${skill}` as TraceId;
}
