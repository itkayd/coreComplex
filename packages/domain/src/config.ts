/**
 * Kernel configuration and its deterministic hash.
 *
 * Spec p.18 (Plan Output) and p.24 (Event Envelope) require a
 * `configurationHash` to be stored on every plan and event, so replay can
 * assert it ran under the same configuration. Spec p.14 fixes the three
 * bounded session lengths; spec p.6 fixes the known-token comprehension band.
 */
import { hashValue } from "./hash.ts";

export interface KernelConfig {
  /** Desired retention target for scheduling (FSRS requestRetention). */
  requestRetention: number;
  /** Bounded session lengths in minutes (spec p.14: 3 / 7 / 15). */
  sessionMinutes: { rescue: 3; default: 7; core: 15 };
  /** Comprehensible-input band: normally 95–98% known tokens (spec p.6). */
  knownTokenBand: { min: number; max: number };
  /** Max novel introductions admitted per session (novelty ceiling, p.18). */
  noveltyCeiling: number;
  /** Forecast horizons in days for the workload governor (spec p.18). */
  forecastHorizonsDays: [7, 30];
  /** Below this confidence a speech score cannot grade (spec p.17 PROHIBITED). */
  speechConfidenceFloor: number;
  /** FSRS adapter identity, pinned for reproducibility (spec p.16). */
  fsrsAdapterVersion: string;
}

export const DEFAULT_CONFIG: KernelConfig = {
  requestRetention: 0.9,
  sessionMinutes: { rescue: 3, default: 7, core: 15 },
  knownTokenBand: { min: 0.95, max: 0.98 },
  noveltyCeiling: 5,
  forecastHorizonsDays: [7, 30],
  speechConfidenceFloor: 0.6,
  fsrsAdapterVersion: "dyr-fsrs-adapter@1.0.0",
};

export function configurationHash(config: KernelConfig): string {
  return hashValue(config);
}
