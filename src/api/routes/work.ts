import { MissionNotFoundError } from '../../core/errors.js';
import { missionForViewer } from '../../fleet/broker.js';
import {
  parseAddDependency,
  parseAddPacket,
  parseAuthorize,
  parseEvidenceCommand,
  parseReject,
  parseVersionOnly,
} from '../../core/inputs.js';
import type { RouteSpec } from '../app.js';
import {
  callerOf,
  commandContext,
  coreOf,
  guarded,
  readJson,
  respond,
} from './missions.js';

const addPacket: RouteSpec = {
  method: 'post',
  path: '/missions/:id/work-packets',
  access: { scopes: ['mission:write'] },
  handler: guarded(async (c) => {
    const { expectedVersion, packet } = parseAddPacket(await readJson(c));
    return respond(
      c,
      coreOf(c).missions.addPacket(
        commandContext(c),
        c.req.param('id') ?? '',
        expectedVersion,
        packet,
      ),
      true,
    );
  }),
};

const listPackets: RouteSpec = {
  method: 'get',
  path: '/missions/:id/work-packets',
  access: { scopes: ['mission:read'] },
  handler: guarded((c) => {
    const id = c.req.param('id') ?? '';
    const found = coreOf(c).missions.getMission(callerOf(c).workspaceId, id);
    if (found === undefined) {
      throw new MissionNotFoundError(id);
    }
    const mission = missionForViewer(found, callerOf(c).actor.kind);
    return c.json({ packets: mission.packets, attempts: mission.attempts });
  }),
};

const addDependency: RouteSpec = {
  method: 'post',
  path: '/missions/:id/work-packets/:packetId/dependencies',
  access: { scopes: ['mission:write'] },
  handler: guarded(async (c) => {
    const { expectedVersion, dependsOnPacketId } = parseAddDependency(
      await readJson(c),
    );
    return respond(
      c,
      coreOf(c).missions.addDependency(
        commandContext(c),
        c.req.param('id') ?? '',
        expectedVersion,
        c.req.param('packetId') ?? '',
        dependsOnPacketId,
      ),
    );
  }),
};

const authorizePacket: RouteSpec = {
  method: 'post',
  path: '/missions/:id/work-packets/:packetId/authorize',
  access: { scopes: ['mission:write'] },
  handler: guarded(async (c) => {
    const { expectedVersion, policyRefs } = parseAuthorize(await readJson(c));
    return respond(
      c,
      coreOf(c).missions.authorizePacket(
        commandContext(c),
        c.req.param('id') ?? '',
        expectedVersion,
        c.req.param('packetId') ?? '',
        policyRefs,
      ),
    );
  }),
};

/** Records Tower's own verification. A runner's report alone never sets a packet to verified. */
const verifyPacket: RouteSpec = {
  method: 'post',
  path: '/missions/:id/work-packets/:packetId/verify',
  access: { scopes: ['mission:write'] },
  handler: guarded(async (c) => {
    const { expectedVersion, evidenceRefs } = parseEvidenceCommand(
      await readJson(c),
    );
    return respond(
      c,
      coreOf(c).missions.verifyPacket(
        commandContext(c),
        c.req.param('id') ?? '',
        expectedVersion,
        c.req.param('packetId') ?? '',
        evidenceRefs,
      ),
    );
  }),
};

const rejectPacket: RouteSpec = {
  method: 'post',
  path: '/missions/:id/work-packets/:packetId/reject',
  access: { scopes: ['mission:write'] },
  handler: guarded(async (c) => {
    const { expectedVersion, reason } = parseReject(await readJson(c));
    return respond(
      c,
      coreOf(c).missions.rejectPacket(
        commandContext(c),
        c.req.param('id') ?? '',
        expectedVersion,
        c.req.param('packetId') ?? '',
        reason,
      ),
    );
  }),
};

const requeuePacket: RouteSpec = {
  method: 'post',
  path: '/missions/:id/work-packets/:packetId/requeue',
  access: { scopes: ['mission:write'] },
  handler: guarded(async (c) => {
    const { expectedVersion } = parseVersionOnly(await readJson(c));
    return respond(
      c,
      coreOf(c).missions.requeuePacket(
        commandContext(c),
        c.req.param('id') ?? '',
        expectedVersion,
        c.req.param('packetId') ?? '',
      ),
    );
  }),
};

/** Runs one scheduler pass over the caller's workspace. Safe to call repeatedly. */
const schedule: RouteSpec = {
  method: 'post',
  path: '/work/schedule',
  access: { scopes: ['mission:write'] },
  handler: guarded((c) => {
    const { workspaceId, actor } = callerOf(c);
    const result = coreOf(c).scheduler.tick(
      workspaceId,
      actor,
      commandContext(c).correlationId,
    );
    return c.json(result);
  }),
};

export const workRoutes: readonly RouteSpec[] = [
  addPacket,
  listPackets,
  addDependency,
  authorizePacket,
  verifyPacket,
  rejectPacket,
  requeuePacket,
  schedule,
];
