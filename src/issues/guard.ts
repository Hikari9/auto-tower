import type { CompletionGuard, GuardVerdict } from '../core/guards.js';
import type { SqlDatabase } from '../storage/database.js';
import { loadEverRequiredUrls, loadLinks } from './store.js';
import type { IssueLinkRecord } from './types.js';

export const REQUIRED_ISSUES_GUARD = 'required-issues-closed';

/** How old a provider read-back may be when a mission completes. */
export const DEFAULT_READBACK_MAX_AGE_MS = 15 * 60_000;

/**
 * Required links close the mission out. A mission completes only when each required link is
 * verified closed by a provider read-back that showed the same issue, or a human approved an
 * exemption. A link counts from the moment it is tracked as required and keeps counting if a
 * mission update removes it or downgrades it. Links that were never required do not count. The
 * check is synchronous: it reads what the last read-back stored and never calls a provider.
 */
export function createRequiredIssuesGuard(
  db: SqlDatabase,
  clock: () => Date,
  maxAgeMs: number = DEFAULT_READBACK_MAX_AGE_MS,
): CompletionGuard {
  return {
    name: REQUIRED_ISSUES_GUARD,
    check({ mission }): GuardVerdict {
      const required = [
        ...new Set([
          ...mission.links
            .filter((link) => link.classification === 'required')
            .map((link) => link.url),
          ...loadEverRequiredUrls(db, mission.workspaceId, mission.id),
        ]),
      ];
      if (required.length === 0) {
        return { ok: true };
      }
      const tracked = new Map<string, IssueLinkRecord>(
        loadLinks(db, mission.workspaceId, mission.id).map((row) => [
          row.url,
          row,
        ]),
      );
      const open = openAttentionLinks(db, mission.workspaceId, mission.id);
      const now = clock().getTime();
      const problems: string[] = [];
      for (const url of required) {
        const row = tracked.get(url);
        if (row?.exemption.status === 'approved') {
          continue;
        }
        if (row === undefined || row.verifiedClosedAt === null) {
          problems.push(`${url} is not verified closed`);
        } else if (row.observedState !== 'closed' || row.nodeId === null) {
          problems.push(`${url} was last seen ${row.observedState}`);
        } else if (open.has(row.id)) {
          problems.push(`${url} has an unresolved discrepancy`);
        } else if (now - Date.parse(row.verifiedClosedAt) > maxAgeMs) {
          problems.push(`${url} read-back is stale; verify it again`);
        }
      }
      return problems.length === 0
        ? { ok: true }
        : { ok: false, reason: problems.join('; ') };
    },
  };
}

function openAttentionLinks(
  db: SqlDatabase,
  workspaceId: string,
  missionId: string,
): Set<string> {
  return new Set(
    db
      .all<{ link_id: string }>(
        'SELECT DISTINCT link_id FROM issue_discrepancies WHERE workspace_id = ? AND mission_id = ? AND resolved_at IS NULL AND requires_attention = 1',
        [workspaceId, missionId],
      )
      .map((row) => row.link_id),
  );
}
