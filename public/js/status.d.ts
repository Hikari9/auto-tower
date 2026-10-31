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
