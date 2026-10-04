/**
 * The parent edge of a wave entity lands on THAT entity, from its DECLARED
 * parent (persistWithKmCore's relationship sweep + anchor pass).
 *
 * Found 2026-10-04: 29 wave rows named an existing parent and had no edge from
 * it, so the viewer drew them floating. Two of the three causes are here:
 *
 *   1. Namesakes. Edges are stored by name and a name resolves to its OLDEST
 *      node, so `ObservationPipeline -> ObservationWriter` attached to an older
 *      SubComponent called ObservationWriter, and the new Detail — marked
 *      anchored by name — was skipped by the anchor pass as well.
 *   2. Re-parenting. "Has some incoming contains edge" counted as anchored, so
 *      an entity a later run placed under a new parent kept only the old edge.
 *
 * (The third — wave 4 creating gate-rejected entities — is a filter on the
 * insight list; see rejectedEntityNames.)
 *
 * Run: npm run build && node --test dist/agents/wave-controller-parent-anchor.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';

import { WaveController } from './wave-controller.js';

interface Node { id: string; name: string; entityType: string }
interface Edge { from: string; to: string; type: string }

/** In-memory adapter with km-core's name rule: oldest namesake wins unless a type is given. */
function fakeAdapter(nodes: Node[], edges: Edge[]) {
  let seq = 0;
  const resolve = (name: string, type?: string): Node | undefined =>
    nodes.find((n) => n.name === name && (!type || n.entityType === type));
  return {
    async queryEntities(): Promise<Array<{ name: string; entityType: string }>> {
      return nodes.filter((n) => n.entityType === 'Project');
    },
    async storeEntity(e: { name: string; entityType: string }): Promise<{ id: string }> {
      const hit = resolve(e.name, e.entityType);
      if (hit) return { id: hit.id };
      const n = { id: `new-${++seq}`, name: e.name, entityType: e.entityType };
      nodes.push(n);
      return { id: n.id };
    },
    async storeRelationship(
      from: string, to: string, type: string, _m?: unknown, t?: { from?: string; to?: string },
    ): Promise<void> {
      const f = resolve(from, t?.from); const d = resolve(to, t?.to);
      if (!f || !d) throw new Error(`endpoint not found: ${from} -> ${to}`);
      if (!edges.some((x) => x.from === f.id && x.to === d.id && x.type === type)) edges.push({ from: f.id, to: d.id, type });
    },
    async queryIncomingRelations(name: string, type?: string): Promise<Edge[]> {
      const n = resolve(name, type);
      return n ? edges.filter((x) => x.to === n.id) : [];
    },
    async getEntity(name: string): Promise<Node | undefined> {
      return resolve(name);
    },
  };
}

function harness(nodes: Node[], edges: Edge[]) {
  const tmpRepo = path.join(os.tmpdir(), `wave-parent-anchor-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const controller = new WaveController({
    repositoryPath: tmpRepo, team: 'coding', progressFile: path.join(tmpRepo, 'p.json'), maxAgentsPerWave: 1, failFast: false,
  });
  const c = controller as unknown as {
    kmCoreAdapter: unknown;
    persistedEntityNames: Set<string>;
    persistWithKmCore: (e: unknown[], r: unknown[], runId: string) => Promise<unknown>;
  };
  c.kmCoreAdapter = fakeAdapter(nodes, edges);
  for (const n of nodes) c.persistedEntityNames.add(n.name);
  return c;
}

const detail = (name: string, parent: string) => ({
  name, entityType: 'Detail', observations: [`${name} does a specific thing in src/x.ts:10.`],
  significance: 6, metadata: {}, parentEntityName: parent, hierarchyLevel: 3,
});

describe('persistWithKmCore — parent edges', () => {
  it('a new Detail sharing its name with an older node gets the edge, not the namesake', async () => {
    const nodes: Node[] = [
      { id: 'coding', name: 'Coding', entityType: 'Project' },
      { id: 'pipe', name: 'ObservationPipeline', entityType: 'SubComponent' },
      { id: 'old-writer', name: 'ObservationWriter', entityType: 'SubComponent' },
    ];
    const edges: Edge[] = [{ from: 'coding', to: 'old-writer', type: 'contains' }];
    const c = harness(nodes, edges);
    c.persistedEntityNames.add('ObservationWriter');
    await c.persistWithKmCore(
      [detail('ObservationWriter', 'ObservationPipeline')],
      [{ from: 'ObservationPipeline', to: 'ObservationWriter', type: 'contains' }],
      'run-1',
    );
    const fresh = nodes.find((n) => n.name === 'ObservationWriter' && n.entityType === 'Detail')!;
    assert.ok(fresh, 'the Detail was stored as its own node');
    assert.ok(edges.some((e) => e.from === 'pipe' && e.to === fresh.id), 'pipeline -> the NEW Detail');
    assert.ok(!edges.some((e) => e.from === 'pipe' && e.to === 'old-writer'), 'not onto the namesake');
  });

  it('an entity re-placed under a new declared parent gets an edge from it', async () => {
    const nodes: Node[] = [
      { id: 'coding', name: 'Coding', entityType: 'Project' },
      { id: 'cms', name: 'ConstraintMonitorServices', entityType: 'SubComponent' },
      { id: 'dsw', name: 'DashboardServiceWrapper', entityType: 'Detail' },
    ];
    const edges: Edge[] = [{ from: 'coding', to: 'dsw', type: 'contains' }];
    const c = harness(nodes, edges);
    await c.persistWithKmCore([detail('DashboardServiceWrapper', 'ConstraintMonitorServices')], [], 'run-2');
    assert.ok(edges.some((e) => e.from === 'cms' && e.to === 'dsw' && e.type === 'contains'));
  });

  it('with no declared parent, an existing contains edge still counts (no extra edge)', async () => {
    const nodes: Node[] = [
      { id: 'coding', name: 'Coding', entityType: 'Project' },
      { id: 'x', name: 'Loose', entityType: 'Detail' },
    ];
    const edges: Edge[] = [{ from: 'coding', to: 'x', type: 'contains' }];
    const c = harness(nodes, edges);
    await c.persistWithKmCore([{ ...detail('Loose', ''), parentEntityName: undefined }], [], 'run-3');
    assert.equal(edges.length, 1);
  });
});
