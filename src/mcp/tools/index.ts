import type { ToolDefinition } from '../tool.js';
import { briefingTools } from './briefing.js';
import { decisionTools } from './decisions.js';
import { evidenceTools } from './evidence.js';
import { fleetTools } from './fleet.js';
import { missionTools } from './missions.js';
import { opsTools } from './ops.js';
import { policyTools } from './policy.js';
import { workTools } from './work.js';

export const TOOLS: readonly ToolDefinition[] = [
  ...briefingTools,
  ...missionTools,
  ...workTools,
  ...fleetTools,
  ...evidenceTools,
  ...decisionTools,
  ...policyTools,
  ...opsTools,
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

if (BY_NAME.size !== TOOLS.length) {
  throw new Error('Two MCP tools share a name');
}

export const findTool = (name: string): ToolDefinition | undefined =>
  BY_NAME.get(name);
