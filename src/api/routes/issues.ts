import type { Context } from 'hono';
import {
  createIssueService,
  IssueError,
  type IssueService,
} from '../../issues/index.js';
import {
  parseAddLink,
  parseCloseLinks,
  parseDiscrepancyStatus,
  parseEmpty,
  parseNote,
  parseReason,
  parseSyncConfig,
} from '../../issues/inputs.js';
import type { AppDependencies, AppEnv, RouteSpec } from '../app.js';
import {
  callerOf,
  commandContext,
  coreOf,
  readJson,
  respond,
} from './missions.js';
import { authorityGuarded, authorityOf } from './policy.js';

const services = new WeakMap<AppDependencies, IssueService>();

/**
 * The issue service for this app. It registers the required-issues completion guard on the
 * core's registry, so `ensureIssues` runs before every request: no route can complete a
 * mission ahead of the guard being in place.
 */
export function issuesOf(c: Context<AppEnv>): IssueService {
  const deps = c.get('deps');
  if (deps.issues !== undefined) {
    return deps.issues;
  }
  let service = services.get(deps);
  if (service === undefined) {
    service = createIssueService({
      db: deps.db,
      core: coreOf(c),
      policy: authorityOf(c).policy,
      ...(deps.issueProviders === undefined
        ? {}
        : { providers: deps.issueProviders }),
      ...(deps.now === undefined ? {} : { clock: deps.now }),
    });
    services.set(deps, service);
  }
  return service;
}

/** Maps issue refusals to their status, then leaves the rest to the authority and core mappers. */
function issueGuarded(
  handler: (c: Context<AppEnv>) => Response | Promise<Response>,
) {
  return authorityGuarded(async (c) => {
    try {
      return await handler(c);
    } catch (error) {
      if (error instanceof IssueError) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      }
      throw error;
    }
  });
}

const param = (c: Context<AppEnv>, name: string): string =>
  c.req.param(name) ?? '';

const listLinks: RouteSpec = {
  method: 'get',
  path: '/missions/:id/issue-links',
  access: { scopes: ['mission:read'] },
  handler: issueGuarded((c) => {
    const { workspaceId } = callerOf(c);
    const issues = issuesOf(c);
    const id = param(c, 'id');
    return c.json(
      {
        links: issues.listLinks(workspaceId, id),
        discrepancies: issues.discrepancies(workspaceId, id, 'open'),
      },
      200,
      { 'x-content-type-options': 'nosniff' },
    );
  }),
};

const addLink: RouteSpec = {
  method: 'post',
  path: '/missions/:id/issue-links',
  access: { scopes: ['mission:write'] },
  handler: issueGuarded(async (c) => {
    const input = parseAddLink(await readJson(c));
    const { result, link } = issuesOf(c).addLink(
      commandContext(c),
      param(c, 'id'),
      input.expectedVersion,
      input,
    );
    const response = respond(c, result, true);
    return c.json(
      { ...((await response.json()) as object), link },
      response.status as 200 | 201,
    );
  }),
};

const verify: RouteSpec = {
  method: 'post',
  path: '/missions/:id/issue-links/verify',
  access: { scopes: ['mission:write'] },
  handler: issueGuarded(async (c) => {
    parseEmpty(await readJson(c));
    return c.json(
      await issuesOf(c).verifyMission(commandContext(c), param(c, 'id')),
    );
  }),
};

const close: RouteSpec = {
  method: 'post',
  path: '/missions/:id/issue-links/close',
  access: { scopes: ['mission:write'] },
  handler: issueGuarded(async (c) => {
    const { urls } = parseCloseLinks(await readJson(c));
    return c.json(
      await issuesOf(c).closeRequired(commandContext(c), param(c, 'id'), urls),
    );
  }),
};

const requestExemption: RouteSpec = {
  method: 'post',
  path: '/missions/:id/issue-links/:linkId/exemption',
  access: { scopes: ['mission:write'] },
  handler: issueGuarded(async (c) => {
    const { reason } = parseReason(await readJson(c));
    return c.json({
      link: issuesOf(c).requestExemption(
        commandContext(c),
        param(c, 'id'),
        param(c, 'linkId'),
        reason,
      ),
    });
  }),
};

const approveExemption: RouteSpec = {
  method: 'post',
  path: '/missions/:id/issue-links/:linkId/exemption/approve',
  access: { scopes: ['mission:write'] },
  handler: issueGuarded(async (c) => {
    parseEmpty(await readJson(c));
    return c.json({
      link: issuesOf(c).approveExemption(
        commandContext(c),
        param(c, 'id'),
        param(c, 'linkId'),
      ),
    });
  }),
};

const revokeExemption: RouteSpec = {
  method: 'post',
  path: '/missions/:id/issue-links/:linkId/exemption/revoke',
  access: { scopes: ['mission:write'] },
  handler: issueGuarded(async (c) => {
    parseEmpty(await readJson(c));
    return c.json({
      link: issuesOf(c).revokeExemption(
        commandContext(c),
        param(c, 'id'),
        param(c, 'linkId'),
      ),
    });
  }),
};

const history: RouteSpec = {
  method: 'get',
  path: '/missions/:id/issue-links/history',
  access: { scopes: ['mission:read'] },
  handler: issueGuarded((c) => {
    const after = Number(c.req.query('after') ?? 0);
    const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);
    const page = {
      afterSeq: Number.isInteger(after) && after >= 0 ? after : 0,
      limit: Number.isInteger(limit) && limit > 0 ? limit : 100,
    };
    return c.json(
      {
        items: issuesOf(c).history(
          callerOf(c).workspaceId,
          param(c, 'id'),
          page,
        ),
      },
      200,
      { 'x-content-type-options': 'nosniff' },
    );
  }),
};

const listDiscrepancies: RouteSpec = {
  method: 'get',
  path: '/missions/:id/issue-discrepancies',
  access: { scopes: ['mission:read'] },
  handler: issueGuarded((c) =>
    c.json({
      discrepancies: issuesOf(c).discrepancies(
        callerOf(c).workspaceId,
        param(c, 'id'),
        parseDiscrepancyStatus(c.req.query('status')),
      ),
    }),
  ),
};

const resolveDiscrepancy: RouteSpec = {
  method: 'post',
  path: '/missions/:id/issue-discrepancies/:discrepancyId/resolve',
  access: { scopes: ['mission:write'] },
  handler: issueGuarded(async (c) => {
    const { note } = parseNote(await readJson(c));
    return c.json(
      issuesOf(c).resolveDiscrepancy(
        commandContext(c),
        param(c, 'id'),
        param(c, 'discrepancyId'),
        note,
      ),
    );
  }),
};

const readConfig: RouteSpec = {
  method: 'get',
  path: '/issues/sync-config',
  access: { scopes: ['mission:read'] },
  handler: issueGuarded((c) =>
    c.json({ configs: issuesOf(c).getSyncConfigs(callerOf(c).workspaceId) }),
  ),
};

/** Widens or narrows what Tower may do to an outside system. Human only, so `policy:write`. */
const writeConfig: RouteSpec = {
  method: 'put',
  path: '/issues/sync-config',
  access: { scopes: ['policy:write'] },
  handler: issueGuarded(async (c) => {
    const input = parseSyncConfig(await readJson(c));
    return c.json({
      config: issuesOf(c).setSyncConfig(commandContext(c), input),
    });
  }),
};

const poll: RouteSpec = {
  method: 'post',
  path: '/issues/poll',
  access: { scopes: ['provider:sync'] },
  handler: issueGuarded(async (c) => {
    parseEmpty(await readJson(c));
    return c.json(await issuesOf(c).poll(callerOf(c)));
  }),
};

export const issueRoutes: readonly RouteSpec[] = [
  listLinks,
  addLink,
  verify,
  close,
  history,
  listDiscrepancies,
  resolveDiscrepancy,
  requestExemption,
  approveExemption,
  revokeExemption,
  readConfig,
  writeConfig,
  poll,
];
