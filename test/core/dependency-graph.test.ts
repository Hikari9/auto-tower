import { describe, expect, it } from 'vitest';
import { cycleIfAdded, findCycle } from '../../src/core/dependency-graph.js';
import { DependencyCycleError } from '../../src/core/errors.js';
import { createHarness, MissionDriver } from './helpers.js';

const graph = (edges: Record<string, string[]>) =>
  new Map(Object.entries(edges));

describe('findCycle', () => {
  it('accepts an empty graph, a chain and a diamond', () => {
    expect(findCycle(graph({}))).toBeUndefined();
    expect(findCycle(graph({ a: [], b: ['a'], c: ['b'] }))).toBeUndefined();
    expect(
      findCycle(graph({ a: [], b: ['a'], c: ['a'], d: ['b', 'c'] })),
    ).toBeUndefined();
  });

  it('finds a self loop, a pair and a longer loop', () => {
    expect(findCycle(graph({ a: ['a'] }))).toEqual(['a', 'a']);
    expect(findCycle(graph({ a: ['b'], b: ['a'] }))).toEqual(['a', 'b', 'a']);
    expect(findCycle(graph({ a: ['b'], b: ['c'], c: ['a'] }))).toEqual([
      'a',
      'b',
      'c',
      'a',
    ]);
  });

  it('finds a cycle that hangs off an acyclic prefix', () => {
    expect(
      findCycle(graph({ s: ['a'], a: ['b'], b: ['c'], c: ['b'] })),
    ).toEqual(['b', 'c', 'b']);
  });

  it('handles a very long chain without overflowing the stack', () => {
    const edges = new Map<string, string[]>();
    for (let i = 0; i < 50_000; i += 1) {
      edges.set(`n${i}`, i === 0 ? [] : [`n${i - 1}`]);
    }
    expect(findCycle(edges)).toBeUndefined();
    edges.set('n0', ['n49999']);
    expect(findCycle(edges)?.length).toBe(50_001);
  });
});

describe('dependency commands', () => {
  function build() {
    const h = createHarness();
    const m = MissionDriver.create(h);
    const a = m.addPacket('A');
    const b = m.addPacket('B', { dependsOn: [a] });
    const c = m.addPacket('C', { dependsOn: [b] });
    return { h, m, a, b, c };
  }

  it('rejects an edge that would close a cycle and leaves the graph unchanged', () => {
    const { h, m, a, c } = build();
    const version = m.state.version;

    try {
      h.core.missions.addDependency(h.ctx(), m.id, version, a, c);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DependencyCycleError);
      expect((error as DependencyCycleError).path).toEqual([
        a,
        c,
        expect.any(String),
        a,
      ]);
    }

    expect(h.core.missions.getMission('ws_test', m.id)).toMatchObject({
      version,
    });
    expect(m.state.packets[0]?.dependsOn).toEqual([]);
  });

  it('rejects a self dependency and a duplicate edge', () => {
    const { h, m, a, b } = build();
    expect(() =>
      h.core.missions.addDependency(h.ctx(), m.id, m.state.version, a, a),
    ).toThrow(DependencyCycleError);
    expect(() =>
      h.core.missions.addDependency(h.ctx(), m.id, m.state.version, b, a),
    ).toThrow(/already exists/);
  });

  it('accepts an edge that keeps the graph acyclic and projects it', () => {
    const { h, m, a, c } = build();
    const { mission } = h.core.missions.addDependency(
      h.ctx(),
      m.id,
      m.state.version,
      c,
      a,
    );

    expect(mission.packets.find((p) => p.id === c)?.dependsOn).toContain(a);
    expect(
      h.db.all(
        'SELECT packet_id, depends_on_packet_id FROM packet_dependencies WHERE packet_id = ?',
        [c],
      ).length,
    ).toBe(2);
  });

  it('refuses new prerequisites on a packet that already started', () => {
    const h = createHarness();
    h.pool.online = ['prn_runner'];
    const m = MissionDriver.create(h);
    m.go('ready');
    const a = m.addPacket('A');
    const b = m.addPacket('B');
    m.authorize(a);
    m.tick();

    expect(() =>
      h.core.missions.addDependency(h.ctx(), m.id, m.state.version, a, b),
    ).toThrow(/only pending packets/);
  });
});

describe('cycleIfAdded', () => {
  it('does not mutate the packets it inspects', () => {
    const packets = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
    ] as never;
    expect(cycleIfAdded(packets, 'a', 'b')).toEqual(['a', 'b', 'a']);
    expect((packets as Array<{ dependsOn: string[] }>)[0]?.dependsOn).toEqual(
      [],
    );
  });
});
