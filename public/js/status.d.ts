// Types for the status tables, so TypeScript tests can import public/js/status.js.
// The implementation is plain browser JavaScript and is not compiled by the repo's tsconfig.

export interface StateLabel {
  label: string;
  tone: string;
}

export const MISSION_STATES: Record<string, StateLabel>;
export const PACKET_STATES: Record<string, StateLabel>;
export const LEASE_STATES: Record<string, StateLabel>;
export const RUNNER_STATES: Record<string, StateLabel>;

export function describe(
  table: Record<string, StateLabel>,
  key: string,
): StateLabel;

export interface Evidence {
  kind: 'verified' | 'self-reported' | 'none';
  label: string;
}

export function evidenceOf(
  packet: { verification?: unknown; status?: string },
  attempt: { report?: unknown } | null | undefined,
): Evidence;

export function unmetDependencies(
  packet: { dependsOn?: string[]; status?: string },
  byId: Map<string, { title: string; verification?: unknown }>,
): string[];
