/**
 * Unit tests for stage 3 — session facts as a wave input.
 *
 * What these pin, and why each one exists:
 *
 *  1. An Insight with a `metadata.parentId` becomes a fact anchored there.
 *     That field is stage 2's entire output; if it stops being read, stage 3
 *     silently reverts to code-only waves with no error anywhere.
 *  2. Facts roll UP the tree. A component must see what was recorded about its
 *     sub-components, or "describe the component" means "describe the files".
 *  3. Ancestry falls back to `contains` edges. 104 of 468 live SubComponents
 *     have no `metadata.parentId`; resolving by metadata alone would silently
 *     drop every fact below them.
 *  4. A cycle in `contains` terminates. A wave run must not hang on bad data.
 *  5. A dangling anchor is COUNTED, not silently skipped — the stage-1 lesson
 *     was that an unmeasured zero survives for months.
 *  6. `formatSessionFacts([])` is '' — an empty section header invites the
 *     model to invent content to fill it.
 *  7. The rendered block asks for the `[SESSION]` tag, which is the only
 *     mechanism making "cites a session fact, tagged by provenance" true.
 *  8. Store failure degrades to zero facts, never throws: session facts
 *     enrich a wave, they do not gate it.
 *
 * Test framework: node:test + node:assert/strict (project convention).
 *
 * Run via:
 *   npm run build && node --test dist/knowledge/session-facts.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSessionFactIndex,
  formatSessionFacts,
  preserveUnreproducibleEvidence,
  type SessionFactSource,
} from './session-facts.js';
import { SemanticAnalysisAgent } from '../agents/semantic-analysis-agent.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

type AnyEntity = Record<string, unknown>;
type AnyRelation = Record<string, unknown>;

function entity(
  id: string,
  name: string,
  entityType: string,
  metadata: Record<string, unknown> = {},
  description = '',
): AnyEntity {
  return {
    id,
    name,
    entityType,
    ontologyClass: entityType,
    layer: 'evidence',
    description,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    metadata,
  };
}

function insight(
  id: string,
  name: string,
  parentId: string,
  summary: string,
  extra: Record<string, unknown> = {},
): AnyEntity {
  return entity(id, name, 'Insight', {
    parentId,
    parentSource: 'classifier',
    summary,
    hierarchyLevel: 3,
    ...extra,
  });
}

function contains(from: string, to: string): AnyRelation {
  return { type: 'contains', from, to };
}

function source(entities: AnyEntity[], relations: AnyRelation[] = []): SessionFactSource {
  return {
    queryEntities: async () => entities as never,
    queryRelations: async (filter) => {
      const type = (filter as { type?: string } | undefined)?.type;
      return (type ? relations.filter((r) => r.type === type) : relations) as never;
    },
  };
}

/**
 * The canonical live shape, in miniature:
 *   Component(comp) ─contains→ SubComponent(sub) ─contains→ Detail(det)
 * with one Insight anchored on the sub-component and one on the detail.
 */
function standardGraph() {
  return source(
    [
      entity('comp', 'LiveLoggingSystem', 'Component'),
      entity('sub', 'EtmDaemon', 'SubComponent', { parentId: 'comp' }),
      entity('det', 'HeartbeatWriter', 'Detail', { parentId: 'sub' }),
      insight('i1', 'ETM wedges without dying', 'sub', 'A stalled event loop keeps ps healthy while the heartbeat stops.'),
      insight('i2', 'Heartbeat clock skew', 'det', 'lastBeat is written before the flush, so a crash backdates it.'),
    ],
    [contains('comp', 'sub'), contains('sub', 'det')],
  );
}

// ---------------------------------------------------------------------------
// 1 + 2 — placement is read, and facts roll up
// ---------------------------------------------------------------------------

describe('buildSessionFactIndex — placement and roll-up', () => {
  it('Test 1: an Insight with metadata.parentId lands on that node', async () => {
    const index = await buildSessionFactIndex(standardGraph());

    const direct = index.directFor('sub');
    assert.equal(direct.length, 1);
    assert.equal(direct[0].title, 'ETM wedges without dying');
    assert.equal(direct[0].anchorName, 'EtmDaemon');
    assert.equal(direct[0].placement, 'classifier', 'stage 2 placement source must survive');
    assert.equal(direct[0].sourceId, 'i1', 'the provenance handle must be the Insight id');
  });

  it('Test 2: facts roll up — the component sees its subtree, not just its own row', async () => {
    const index = await buildSessionFactIndex(standardGraph());

    assert.equal(index.directFor('comp').length, 0, 'nothing is anchored ON the component');
    const subtree = index.subtreeFor('comp');
    assert.equal(subtree.length, 2, 'both descendants’ facts reach the component');
    assert.deepEqual(
      subtree.map((f) => f.sourceId).sort(),
      ['i1', 'i2'],
    );
  });

  it('Test 3: name lookup resolves the same facts the id lookup does', async () => {
    const index = await buildSessionFactIndex(standardGraph());

    assert.equal(index.subtreeForName('LiveLoggingSystem').length, 2);
    assert.equal(index.directForName('EtmDaemon').length, 1);
    assert.equal(index.subtreeForName('NoSuchComponent').length, 0, 'unknown name is empty, not a throw');
  });
});

// ---------------------------------------------------------------------------
// 3 — ancestry falls back to `contains` when parentId was never stamped
// ---------------------------------------------------------------------------

describe('buildSessionFactIndex — ancestry sources', () => {
  it('Test 4: a SubComponent with NO metadata.parentId still rolls up via its contains edge', async () => {
    // This is the live majority-case guard: 104 of 468 SubComponents carry a
    // `contains` edge and no parentId. Resolving by metadata alone drops
    // everything below them.
    const src = source(
      [
        entity('comp', 'SemanticAnalysis', 'Component'),
        entity('sub', 'WaveController', 'SubComponent'), // no parentId
        insight('i1', 'A fresh run undid parent descriptions', 'sub', 'Full-replace mode erased synthesised parents.'),
      ],
      [contains('comp', 'sub')],
    );

    const index = await buildSessionFactIndex(src);
    assert.equal(index.subtreeFor('comp').length, 1, 'contains edge must carry the fact upward');
  });

  it('Test 5: metadata.parentId wins over a contradicting contains edge', async () => {
    // Placement is the deliberate signal; a stale structural edge is not.
    const src = source(
      [
        entity('a', 'Alpha', 'Component'),
        entity('b', 'Beta', 'Component'),
        entity('sub', 'Shared', 'SubComponent', { parentId: 'b' }),
        insight('i1', 'fact', 'sub', 'something happened'),
      ],
      [contains('a', 'sub')],
    );

    const index = await buildSessionFactIndex(src);
    assert.equal(index.subtreeFor('b').length, 1, 'metadata parent receives the fact');
    assert.equal(index.subtreeFor('a').length, 0, 'the stale contains edge does not');
  });

  it('Test 6: a cycle in the hierarchy terminates instead of hanging the run', async () => {
    const src = source(
      [
        entity('x', 'X', 'Component', { parentId: 'y' }),
        entity('y', 'Y', 'Component', { parentId: 'x' }),
        insight('i1', 'fact', 'x', 'claim'),
      ],
      [],
    );

    const index = await buildSessionFactIndex(src);
    assert.equal(index.subtreeFor('x').length, 1);
    assert.equal(index.subtreeFor('y').length, 1, 'the cycle is walked once, not forever');
  });
});

// ---------------------------------------------------------------------------
// 5 — the counters that make a silent zero impossible
// ---------------------------------------------------------------------------

describe('buildSessionFactIndex — stats', () => {
  it('Test 7: an Insight naming an absent owner is counted as dangling, not dropped silently', async () => {
    const src = source([
      entity('sub', 'Real', 'SubComponent'),
      insight('i1', 'placed', 'sub', 'a claim'),
      insight('i2', 'orphaned', 'gone-from-store', 'another claim'),
      entity('i3', 'unplaced', 'Insight', { summary: 'no owner at all' }),
    ]);

    const index = await buildSessionFactIndex(src);
    assert.equal(index.stats.insightsSeen, 3);
    assert.equal(index.stats.insightsWithOwner, 2, 'the unplaced Insight has no owner');
    assert.equal(index.stats.factsIndexed, 1);
    assert.equal(index.stats.danglingAnchors, 1, 'the dangling anchor must be visible as a number');
    assert.equal(index.stats.anchoredNodes, 1);
  });

  it('Test 8: only Insights are indexed — Observations and Digests are raw material', async () => {
    const src = source([
      entity('sub', 'Target', 'SubComponent'),
      entity('o1', 'an observation', 'Observation', { parentId: 'sub', summary: 'raw' }),
      entity('d1', 'a digest', 'Digest', { parentId: 'sub', summary: 'rolled up once' }),
      insight('i1', 'an insight', 'sub', 'rolled up twice'),
    ]);

    const index = await buildSessionFactIndex(src);
    assert.equal(index.stats.insightsSeen, 1);
    assert.equal(index.directFor('sub').length, 1, 'the Insight only');
  });
});

// ---------------------------------------------------------------------------
// 8 — enrichment, not a gate
// ---------------------------------------------------------------------------

describe('buildSessionFactIndex — failure is not fatal', () => {
  it('Test 9: a store that throws yields an empty index rather than failing the run', async () => {
    const broken: SessionFactSource = {
      queryEntities: async () => {
        throw new Error('Database failed to open');
      },
      queryRelations: async () => {
        throw new Error('Database failed to open');
      },
    };

    const index = await buildSessionFactIndex(broken);
    assert.equal(index.stats.factsIndexed, 0);
    assert.equal(index.subtreeForName('anything').length, 0);
  });

  it('Test 10: an entity whose summary and description are both empty produces no fact', async () => {
    // A fact with no claim in it is prompt noise that still costs tokens.
    const src = source([
      entity('sub', 'Target', 'SubComponent'),
      entity('i1', 'titled but contentless', 'Insight', { parentId: 'sub' }),
    ]);

    const index = await buildSessionFactIndex(src);
    assert.equal(index.directFor('sub').length, 0);
  });

  it('Test 11: description is the fallback when metadata.summary is absent', async () => {
    const src = source([
      entity('sub', 'Target', 'SubComponent'),
      entity(
        'i1',
        'documented',
        'Insight',
        { parentId: 'sub' },
        '## Purpose\nThe consolidator retries on empty content only when output is low.',
      ),
    ]);

    const index = await buildSessionFactIndex(src);
    const facts = index.directFor('sub');
    assert.equal(facts.length, 1);
    assert.ok(
      !facts[0].summary.includes('##'),
      'markdown heading scaffolding must be stripped, not pasted into the prompt',
    );
    assert.ok(facts[0].summary.includes('retries on empty content'));
  });
});

// ---------------------------------------------------------------------------
// 6 + 7 — the prompt block
// ---------------------------------------------------------------------------

describe('formatSessionFacts', () => {
  it('Test 12: no facts renders nothing at all', () => {
    assert.equal(formatSessionFacts([]), '', 'an empty heading invites invented content');
  });

  it('Test 13: the block asks for the [SESSION] provenance tag', async () => {
    const index = await buildSessionFactIndex(standardGraph());
    const block = formatSessionFacts(index.subtreeFor('comp'));

    assert.match(block, /\[SESSION\]/, 'the tag is how provenance survives into the observation');
    assert.match(block, /NOT source code/i, 'the model must not cite these as files');
    assert.ok(block.includes('ETM wedges without dying'), 'the fact title reaches the prompt');
    assert.ok(block.includes('(about EtmDaemon)'), 'each fact names the node it is about');
  });

  it('Test 14: the block is truncated with an explicit count, never silently', async () => {
    const entities: AnyEntity[] = [entity('sub', 'Target', 'SubComponent')];
    for (let i = 0; i < 20; i += 1) {
      entities.push(insight(`i${i}`, `Insight ${i}`, 'sub', `claim ${i}`));
    }
    const index = await buildSessionFactIndex(source(entities));
    const block = formatSessionFacts(index.directFor('sub'), 5);

    assert.match(block, /\+15 further session records not shown/);
  });

  it('Test 15: newest facts survive truncation', async () => {
    const src = source([
      entity('sub', 'Target', 'SubComponent'),
      insight('old', 'Old finding', 'sub', 'stale claim', { lastUpdated: '2026-01-01T00:00:00.000Z' }),
      insight('new', 'New finding', 'sub', 'current claim', { lastUpdated: '2026-09-21T00:00:00.000Z' }),
    ]);

    const index = await buildSessionFactIndex(src);
    const block = formatSessionFacts(index.directFor('sub'), 1);

    assert.ok(block.includes('New finding'), 'a truncated prompt keeps the current state of the world');
    assert.ok(!block.includes('Old finding'));
  });
});

// ---------------------------------------------------------------------------
// The two ways stage 3 was silently erased at the last step
// ---------------------------------------------------------------------------

describe('session grounding survives the re-analysis pass', () => {
  it('Test 16: [SESSION] observations are preserved across the SAA overwrite', () => {
    // All three waves end by replacing an entity's observations with fresh SAA
    // output derived from source files alone. Every wave's copy of this filter
    // listed only [CGR] — so a session-grounded observation was produced, then
    // deleted, on every single entity.
    const before = [
      '[CGR] WaveController (class) in wave-controller.ts',
      '[SESSION] Full-replace mode erased synthesised parent descriptions on a fresh run',
      '[LLM] Coordinates three waves of analysis',
    ];

    const preserved = preserveUnreproducibleEvidence(before);

    assert.deepEqual(preserved, [
      '[CGR] WaveController (class) in wave-controller.ts',
      '[SESSION] Full-replace mode erased synthesised parent descriptions on a fresh run',
    ]);
  });

  it('Test 17: [LLM] observations are NOT preserved — the pass regenerates them', () => {
    assert.deepEqual(preserveUnreproducibleEvidence(['[LLM] anything']), []);
  });

  it('Test 18: autoTagObservations leaves a [SESSION] tag alone', () => {
    // An unrecognised prefix is not left alone, it is prefixed AGAIN. Before
    // the tag set was widened this produced "[LLM] [SESSION] …" — provenance
    // reading as the exact opposite of the truth.
    const tagged = SemanticAnalysisAgent.autoTagObservations(
      ['[SESSION] The proxy re-decides HTTPS_PROXY every 30 seconds'],
      false,
    );

    assert.equal(tagged.length, 1);
    assert.ok(!tagged[0].startsWith('[LLM]'), 'must not be double-tagged');
    assert.ok(tagged[0].startsWith('[SESSION]'));
  });

  it('Test 19: an untagged observation still gets [LLM] — the widening is narrow', () => {
    const tagged = SemanticAnalysisAgent.autoTagObservations(['plain claim'], false);
    assert.equal(tagged[0], '[LLM] plain claim');
  });
});

// ---------------------------------------------------------------------------
// Prompt calibration — why grounding was 0 on one component and 14 on another
// ---------------------------------------------------------------------------

describe('formatSessionFacts — balance rules', () => {
  function withFacts(n: number) {
    const entities: AnyEntity[] = [entity('sub', 'Target', 'SubComponent')];
    for (let i = 0; i < n; i += 1) {
      entities.push(insight(`i${i}`, `Finding ${i}`, 'sub', `claim ${i}`));
    }
    return source(entities);
  }

  it('Test 20: the block resolves the code-artifact contradiction explicitly', async () => {
    // Every wave prompt carries "each observation MUST reference a code
    // artifact". A session fact satisfies that rule in no way at all, so the
    // two instructions fought and each model settled it differently per
    // component — 0 session observations on ConstraintSystem, 14 (and no code
    // observations at all) on CodingPatterns. The block must say which rule
    // governs a session-grounded observation.
    const index = await buildSessionFactIndex(withFacts(5));
    const block = formatSessionFacts(index.directFor('sub'));

    assert.match(block, /MUST name the record it comes from/);
    assert.match(block, /applies to\s+observations about the CODE/);
  });

  it('Test 21: a floor of 2 applies once there are enough records to meet it', async () => {
    const index = await buildSessionFactIndex(withFacts(5));
    const block = formatSessionFacts(index.directFor('sub'));

    assert.match(block, /AT LEAST 2 of your observations must be grounded/);
  });

  it('Test 22: the floor drops to 1 when only one or two records exist', async () => {
    // Asking for two session-grounded observations from a component with one
    // record on file is an instruction that can only be met by inventing the
    // second.
    for (const n of [1, 2]) {
      const index = await buildSessionFactIndex(withFacts(n));
      const block = formatSessionFacts(index.directFor('sub'));
      assert.match(block, /AT LEAST 1 of your observations must be grounded/, `n=${n}`);
    }
  });

  it('Test 23: the floor follows what is SHOWN, not what exists', async () => {
    // With 20 facts but a limit of 2, only 2 reach the model. The floor must
    // be computed against the visible list or it demands grounding in records
    // the model was never given.
    const index = await buildSessionFactIndex(withFacts(20));
    const block = formatSessionFacts(index.directFor('sub'), 2);

    assert.match(block, /AT LEAST 1 of your observations must be grounded/);
  });

  it('Test 24: a ceiling keeps the code the primary subject', async () => {
    const index = await buildSessionFactIndex(withFacts(5));
    const block = formatSessionFacts(index.directFor('sub'));

    assert.match(block, /NO MORE THAN HALF of your observations may be session-grounded/);
    assert.match(block, /return fewer observations rather than/,
      'thin source files must not be padded from the work record');
  });

  it('Test 25: the block bans reacting to evidence instead of stating it', async () => {
    // Several wave-1 observations read "This suggests that…" / "This indicates
    // that…" — the model narrating its own inference rather than recording
    // what the session established.
    const index = await buildSessionFactIndex(withFacts(5));
    const block = formatSessionFacts(index.directFor('sub'));

    assert.match(block, /do NOT write "This suggests/);
  });
});
