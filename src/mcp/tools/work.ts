import { PacketNotFoundError } from '../../core/errors.js';
import { parseAuthorize } from '../../core/inputs.js';
import type { WorkPacket } from '../../core/types.js';
import { InputReader } from '../../core/validation.js';
import { withoutRuleIds } from '../../fleet/broker.js';
import { refusalForPolicyRefs } from '../../policy/packet-refs.js';
import { takeId } from '../args.js';
import type { ToolDefinition } from '../tool.js';
import { commandData, requireMission } from './missions.js';

type Next =
  | 'needs-authorization'
  | 'waiting-on-dependencies'
  | 'will-be-offered-to-a-runner'
  | 'in-flight'
  | 'reported-awaiting-verification'
  | 'done'
  | 'stopped';

function nextFor(packet: WorkPacket, unmet: readonly string[]): Next {
  switch (packet.status) {
    case 'verified':
      return 'done';
    case 'failed':
    case 'cancelled':
      return 'stopped';
    case 'leased':
    case 'running':
      return 'in-flight';
    case 'reported':
      return 'reported-awaiting-verification';
    default:
      if (packet.authorization === null) {
        return 'needs-authorization';
      }
      return unmet.length > 0
        ? 'waiting-on-dependencies'
        : 'will-be-offered-to-a-runner';
  }
}

const missionId = { type: 'string' } as const;
const packetId = { type: 'string' } as const;
const policyRefs = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Policy rule refs a chief of staff acts under, such as policy:v3:rule:rul_x@1. A person needs none.',
} as const;

export const workTools: readonly ToolDefinition[] = [
  {
    name: 'preview_dispatch',
    title: 'Preview a dispatch',
    description:
      'Shows, without changing anything, what request_dispatch would do for a mission: each packet, what it waits for, and for one named packet whether the policy refs you cite would be accepted.',
    readOnly: true,
    scopes: ['mission:read'],
    properties: { missionId, packetId, policyRefs },
    required: ['missionId'],
    run(ctx, args) {
      const { id, rest } = takeId(args, 'missionId');
      const r = new InputReader(rest);
      const only = r.optString('packetId', { max: 128, min: 1 });
      const refs = r.optStrings('policyRefs', {
        maxItems: 32,
        maxLength: 512,
        minLength: 1,
      });
      r.finish();
      const mission = requireMission(ctx, id);
      if (only !== undefined && !mission.packets.some((p) => p.id === only)) {
        throw new PacketNotFoundError(only);
      }
      const verified = new Set(
        mission.packets.filter((p) => p.status === 'verified').map((p) => p.id),
      );
      const packets = mission.packets
        .filter((p) => only === undefined || p.id === only)
        .map((packet) => {
          const unmet = packet.dependsOn.filter((dep) => !verified.has(dep));
          const next = nextFor(packet, unmet);
          const cited =
            only !== undefined &&
            refs !== undefined &&
            next === 'needs-authorization'
              ? citedPolicy(ctx, mission, packet, refs)
              : undefined;
          return {
            id: packet.id,
            title: packet.title,
            status: packet.status,
            required: packet.required,
            scope: packet.scope,
            authorized: packet.authorization !== null,
            unmetDependencies: unmet,
            next,
            ...(cited === undefined ? {} : { citedPolicy: cited }),
          };
        });
      return {
        data: {
          missionId: mission.id,
          missionState: mission.state,
          version: mission.version,
          packets,
        },
      };
    },
  },
  {
    name: 'request_dispatch',
    title: 'Request a dispatch',
    description:
      'Authorizes one work packet and runs one scheduler pass, which offers it to an eligible runner. With no runner online the mission reports waiting-runner. A chief of staff must cite policy refs that cover the packet.',
    readOnly: false,
    scopes: ['mission:write'],
    material: true,
    effect: 'Authorizes the packet for execution and schedules it.',
    properties: {
      missionId,
      packetId,
      expectedVersion: { type: 'integer', minimum: 1 },
      policyRefs,
    },
    required: ['missionId', 'packetId', 'expectedVersion'],
    run(ctx, args, key) {
      const { id, rest } = takeId(args, 'missionId');
      const { id: pid, rest: body } = takeId(rest, 'packetId');
      const { expectedVersion, policyRefs: refs } = parseAuthorize(body);
      const { core } = ctx.services;
      const authorized = core.missions.authorizePacket(
        ctx.command(key),
        id,
        expectedVersion,
        pid,
        refs,
      );
      const schedule = core.scheduler.tick(
        ctx.caller.workspaceId,
        ctx.caller.actor,
        key,
      );
      return {
        data: {
          ...commandData(authorized),
          // The mission after the scheduler ran, not as of the authorization.
          mission: requireMission(ctx, id),
          schedule,
        },
      };
    },
  },
];

function citedPolicy(
  ctx: Parameters<ToolDefinition['run']>[0],
  mission: Parameters<typeof refusalForPolicyRefs>[1]['mission'],
  packet: WorkPacket,
  refs: readonly string[],
): { accepted: boolean; reason?: string; note?: string } {
  if (ctx.caller.actor.kind === 'human') {
    return { accepted: true, note: 'a person needs no policy ref' };
  }
  const refusal = refusalForPolicyRefs(
    ctx.services.authority.policy,
    {
      workspaceId: ctx.caller.workspaceId,
      actor: ctx.caller.actor,
      mission,
      packet,
    },
    refs,
  );
  return refusal === undefined
    ? { accepted: true }
    : {
        accepted: false,
        // A chief of staff cites rules, so it may see them. A runner or provider may not.
        reason:
          ctx.caller.actor.kind === 'chief_of_staff'
            ? refusal
            : withoutRuleIds(refusal),
      };
}
