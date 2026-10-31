import type { WorkPacket } from './types.js';

/** Packet id to the ids it depends on. */
export type DependencyEdges = ReadonlyMap<string, readonly string[]>;

function edgesOf(packets: readonly WorkPacket[]): Map<string, string[]> {
  return new Map(packets.map((p) => [p.id, [...p.dependsOn]]));
}

/**
 * Returns the first cycle found as a path that starts and ends on the same id,
 * or undefined when the graph is acyclic. Iterative, so a long chain cannot
 * overflow the stack. Visit order follows insertion order, so the result is stable.
 */
export function findCycle(edges: DependencyEdges): string[] | undefined {
  const done = new Set<string>();
  for (const start of edges.keys()) {
    if (done.has(start)) {
      continue;
    }
    const path: string[] = [];
    const onPath = new Set<string>();
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];
    path.push(start);
    onPath.add(start);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) {
        break;
      }
      const deps = edges.get(frame.id) ?? [];
      const dep = deps[frame.next];
      if (dep === undefined) {
        stack.pop();
        path.pop();
        onPath.delete(frame.id);
        done.add(frame.id);
        continue;
      }
      frame.next += 1;
      if (onPath.has(dep)) {
        return [...path.slice(path.indexOf(dep)), dep];
      }
      if (!done.has(dep)) {
        stack.push({ id: dep, next: 0 });
        path.push(dep);
        onPath.add(dep);
      }
    }
  }
  return undefined;
}

/** The cycle that adding `packetId -> dependsOnId` would create, if any. */
export function cycleIfAdded(
  packets: readonly WorkPacket[],
  packetId: string,
  dependsOnId: string,
): string[] | undefined {
  const edges = edgesOf(packets);
  edges.set(packetId, [...(edges.get(packetId) ?? []), dependsOnId]);
  return findCycle(edges);
}

/** True when every dependency of the packet is verified. Cancelled or failed ones do not count. */
export function dependenciesSatisfied(
  packet: WorkPacket,
  packets: readonly WorkPacket[],
): boolean {
  return packet.dependsOn.every(
    (id) => packets.find((p) => p.id === id)?.status === 'verified',
  );
}
