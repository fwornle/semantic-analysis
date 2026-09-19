/**
 * Unit tests for the deterministic L2 subsystem classifier — Phase 60 Plan 09.
 *
 * Locks the <behavior> block of 60-09-PLAN.md Task 1:
 *   - each of the 22 closed-vocabulary L2 classes is returned for at least one
 *     representative REAL entity name (reachability coverage test), using the L2
 *     class's declared parent;
 *   - parent-consistency: an OnlineObservation-keyword name whose L1 is Component
 *     returns null (parent mismatch);
 *   - no-forced-L2: generic names (CachingMechanism, TranscriptAdapter) return null.
 *
 * Test framework: node:test + node:assert/strict (matches sibling src/agents/*.test.ts).
 * Run via: npm run build && node --test dist/agents/l2-subsystem-classifier.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyL2, L2_KEYWORD_MAP } from './l2-subsystem-classifier.js';

describe('classifyL2 — representative real-entity mappings', () => {
  it('maps Component subsystem names to their L2 class', () => {
    assert.equal(classifyL2('LiveLoggingSystem', '', 'Component'), 'LiveLoggingSystem');
    assert.equal(
      classifyL2('SemanticAnalysis', 'wave-analysis pipeline coordinator', 'Component'),
      'BatchSemanticAnalysis',
    );
    assert.equal(
      classifyL2('ConstraintSystem', 'enforces no-console-log rules', 'Component'),
      'ConstraintMonitor',
    );
    assert.equal(classifyL2('LLMAbstraction', 'llm routing surface', 'Component'), 'RapidLlmProxy');
    assert.equal(classifyL2('KnowledgeManagement', '', 'Component'), 'KnowledgeManagement');
    assert.equal(classifyL2('DockerizedServices', '', 'Component'), 'DockerizedServices');
  });

  it('maps Detail online-pipeline artifacts to their L2 class', () => {
    assert.equal(
      classifyL2('Observation Pipeline — ObservationWriter and Deduplication', '', 'Detail'),
      'OnlineObservation',
    );
    assert.equal(
      classifyL2('ObservationConsolidator — Two-Tier Memory Aggregation', '', 'Detail'),
      'OnlineDigest',
    );
    assert.equal(classifyL2('InsightGenerator', '', 'Detail'), 'OnlineInsight');
  });

  it('maps the ETM SubComponent name to EtmDaemon', () => {
    assert.equal(
      classifyL2('Enhanced Transcript Monitor (ETM)', '', 'SubComponent'),
      'EtmDaemon',
    );
  });
});

describe('classifyL2 — name dominates description', () => {
  it('routes by the entity NAME even when the description references a sibling subsystem', () => {
    // SemanticAnalysis's real description mentions session-logging-ish terms; the
    // NAME must still win -> BatchSemanticAnalysis, not LiveLoggingSystem.
    assert.equal(
      classifyL2('SemanticAnalysis', 'agents capture session logging and lsl transcripts', 'Component'),
      'BatchSemanticAnalysis',
    );
    // DockerizedServices desc mentioning constraint-monitor must not override the name.
    assert.equal(
      classifyL2('DockerizedServices', 'hosts the constraint monitor and no-console-log enforcement', 'Component'),
      'DockerizedServices',
    );
  });

  it('falls back to the description only when the name carries no signal', () => {
    assert.equal(
      classifyL2('Some Generic Intent Entity', 'documents the online observation pipeline / observationwriter', 'Detail'),
      'OnlineObservation',
    );
  });
});

describe('classifyL2 — parent-consistency invariant', () => {
  it('returns null when an L2 keyword matches but the parent edge mismatches', () => {
    // OnlineObservation.parent === 'Detail'; an entity whose L1 is Component must NOT refine to it.
    assert.equal(classifyL2('ObservationWriter', '', 'Component'), null);
    // EtmDaemon.parent === 'SubComponent'; a Detail entity carrying the ETM name stays L1.
    assert.equal(classifyL2('Enhanced Transcript Monitor (ETM)', '', 'Detail'), null);
  });

  it('returns null for an unknown / empty parent', () => {
    assert.equal(classifyL2('LiveLoggingSystem', '', 'File'), null);
    assert.equal(classifyL2('LiveLoggingSystem', '', ''), null);
    assert.equal(classifyL2('LiveLoggingSystem', '', undefined), null);
  });
});

describe('classifyL2 — no-forced-L2 (generic names return null)', () => {
  it('returns null for generic SubComponent / Detail names with no subsystem signal', () => {
    assert.equal(classifyL2('CachingMechanism', '', 'SubComponent'), null);
    assert.equal(classifyL2('TranscriptAdapter', '', 'Detail'), null);
    assert.equal(classifyL2('CodingPatterns', '', 'Component'), null);
    assert.equal(classifyL2('Trajectory', '', 'Component'), null);
  });

  it('does not collide on the bare "etm" token inside unrelated words', () => {
    // word-boundary match: "TranscriptManager" / "system" must not trigger EtmDaemon.
    assert.equal(classifyL2('TranscriptManager', 'transcript management service', 'SubComponent'), null);
  });
});

describe('classifyL2 — 22-class reachability coverage', () => {
  // Each L2 class -> a representative real export name + its declared parent.
  const REPRESENTATIVES: Record<string, { name: string; parent: string }> = {
    LiveLoggingSystem: { name: 'LiveLoggingSystem', parent: 'Component' },
    ConstraintMonitor: { name: 'ConstraintSystem', parent: 'Component' },
    KnowledgeManagement: { name: 'KnowledgeManagement', parent: 'Component' },
    BatchSemanticAnalysis: { name: 'SemanticAnalysis', parent: 'Component' },
    RapidLlmProxy: { name: 'LLMAbstraction', parent: 'Component' },
    DockerizedServices: { name: 'DockerizedServices', parent: 'Component' },
    OnlineObservation: { name: 'ObservationWriter Retry Budget', parent: 'Detail' },
    OnlineDigest: { name: 'ObservationConsolidator — Two-Tier Memory Aggregation', parent: 'Detail' },
    OnlineInsight: { name: 'InsightGenerationPipeline', parent: 'Detail' },
    EtmDaemon: { name: 'Enhanced Transcript Monitor (ETM)', parent: 'SubComponent' },
    // Phase 61 corpus extension — 385 of 678 live coding insights matched none
    // of the original 10 classes. Each representative below exercises that
    // class's own keywords AND proves no earlier class in iteration order
    // shadows it (first match within the parent group wins).
    BenchmarkHarness: { name: 'kgbench Benchmarking Harness', parent: 'Component' },
    AgentIntegration: { name: 'Copilot CLI Integration', parent: 'Component' },
    ExperimentFramework: { name: 'A/B Experiment Runner', parent: 'Component' },
    GsdWorkflow: { name: 'GSD Milestone State', parent: 'Component' },
    HealthDashboard: { name: 'System Health Dashboard', parent: 'Component' },
    StatusLine: { name: 'Tmux Statusline Click Handler', parent: 'Component' },
    CodeGraph: { name: 'Graphify Incremental Rebuild', parent: 'Component' },
    TokenAccounting: { name: 'Token Usage Accounting', parent: 'Component' },
    OntologyAndViewer: { name: 'Ontology Path Resolver', parent: 'Component' },
    ContinuousIntegration: { name: 'GitHub Actions CI Workflow', parent: 'Component' },
    DocumentationSystem: { name: 'MkDocs Documentation Structure', parent: 'Component' },
    InstallAndBootstrap: { name: 'install.sh Dependency Gate', parent: 'Component' },
  };

  it('returns every one of the 22 L2 classes for at least one representative entity', () => {
    const classes = Object.keys(L2_KEYWORD_MAP);
    assert.equal(classes.length, 22, 'closed vocabulary must have exactly 22 L2 classes');
    for (const className of classes) {
      const rep = REPRESENTATIVES[className];
      assert.ok(rep, `missing representative for ${className}`);
      assert.equal(
        classifyL2(rep.name, '', rep.parent),
        className,
        `${className} unreachable via representative "${rep.name}" (${rep.parent})`,
      );
    }
  });
});
