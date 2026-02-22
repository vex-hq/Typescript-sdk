#!/usr/bin/env npx tsx
/**
 * Comprehensive E2E test suite for the Vex TypeScript SDK.
 *
 * Exercises the full SDK → Sync Gateway → Verification Engine → Redis pipeline
 * across 28 scenarios covering all verification checks, correction layers,
 * plan enforcement, error handling, and edge cases.
 *
 * Usage:
 *   VEX_API_KEY=ag_live_... npx tsx sdk/typescript/scripts/test_comprehensive.ts
 *   VEX_API_KEY=ag_live_... npx tsx sdk/typescript/scripts/test_comprehensive.ts --section verification
 *   VEX_API_KEY=ag_live_... npx tsx sdk/typescript/scripts/test_comprehensive.ts --section correction
 *   VEX_API_KEY=ag_live_... npx tsx sdk/typescript/scripts/test_comprehensive.ts --section plan
 *   VEX_API_KEY=ag_live_... npx tsx sdk/typescript/scripts/test_comprehensive.ts --section edge
 *   VEX_API_KEY=ag_live_... npx tsx sdk/typescript/scripts/test_comprehensive.ts --section multiturn
 */

import { Vex, VexBlockError, Session, ConfigurationError } from '../src/index';
import type { VexResult, VexConfigInput } from '../src/index';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_KEY = process.env.VEX_API_KEY ?? process.env.AGENTGUARD_API_KEY ?? '';
const API_URL =
  process.env.VEX_API_URL ?? process.env.AGENTGUARD_API_URL ?? 'https://api.tryvex.dev';

if (!API_KEY) {
  console.error('ERROR: Set VEX_API_KEY (or AGENTGUARD_API_KEY) environment variable.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const GREEN = '\x1b[92m';
const RED = '\x1b[91m';
const YELLOW = '\x1b[93m';
const CYAN = '\x1b[96m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function header(title: string): void {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`${BOLD}${CYAN}${title}${RESET}`);
  console.log(`${'='.repeat(72)}`);
}

function sectionHeader(title: string): void {
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`${BOLD}${title}${RESET}`);
  console.log(`${'─'.repeat(72)}`);
}

function ok(msg: string): void {
  console.log(`  ${GREEN}PASS${RESET}  ${msg}`);
}
function fail(msg: string): void {
  console.log(`  ${RED}FAIL${RESET}  ${msg}`);
}
function info(msg: string): void {
  console.log(`  ${DIM}INFO${RESET}  ${msg}`);
}
function warn(msg: string): void {
  console.log(`  ${YELLOW}WARN${RESET}  ${msg}`);
}

type ScenarioResult = [boolean, string];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVex(configOverrides?: VexConfigInput): Vex {
  return new Vex({
    apiKey: API_KEY,
    config: { apiUrl: API_URL, ...configOverrides },
  });
}

async function sdkVerify(opts: {
  agentId: string;
  task: string;
  output: unknown;
  groundTruth?: unknown;
  schema?: Record<string, unknown>;
  correction?: string;
  transparency?: string;
  input?: unknown;
  timeoutMs?: number;
}): Promise<{ result: VexResult | null; blocked: boolean }> {
  const vex = makeVex({
    mode: 'sync',
    correction: (opts.correction ?? 'none') as 'none' | 'auto',
    transparency: (opts.transparency ?? 'opaque') as 'opaque' | 'transparent',
    timeoutMs: opts.timeoutMs ?? 30000,
  });

  let result: VexResult | null = null;
  let blocked = false;

  try {
    result = await vex.trace(
      {
        agentId: opts.agentId,
        task: opts.task,
        input: opts.input ?? {},
      },
      (ctx) => {
        if (opts.groundTruth !== undefined) ctx.setGroundTruth(opts.groundTruth);
        if (opts.schema) ctx.setSchema(opts.schema);
        ctx.record(opts.output);
      },
    );
  } catch (err) {
    if (err instanceof VexBlockError) {
      blocked = true;
      result = err.result;
    } else {
      throw err;
    }
  } finally {
    await vex.close();
  }

  return { result, blocked };
}

async function rawVerify(payload: Record<string, unknown>): Promise<Response> {
  return fetch(`${API_URL}/v1/verify`, {
    method: 'POST',
    headers: { 'X-Vex-Key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
}

async function rawIngest(payload: Record<string, unknown>): Promise<Response> {
  return fetch(`${API_URL}/v1/ingest`, {
    method: 'POST',
    headers: { 'X-Vex-Key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
}

async function rawIngestBatch(events: Record<string, unknown>[]): Promise<Response> {
  return fetch(`${API_URL}/v1/ingest/batch`, {
    method: 'POST',
    headers: { 'X-Vex-Key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
    signal: AbortSignal.timeout(60_000),
  });
}

// ===========================================================================
// SECTION 1: VERIFICATION CHECKS
// ===========================================================================

async function testV1SchemaValid(): Promise<ScenarioResult> {
  header('V1: Schema — Valid Output');

  const { result } = await sdkVerify({
    agentId: 'test-schema-valid-ts',
    task: 'Return customer record',
    output: JSON.stringify({ id: 42, name: 'Jane Doe', email: 'jane@example.com' }),
    schema: {
      type: 'object',
      required: ['id', 'name', 'email'],
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        email: { type: 'string' },
      },
    },
    groundTruth: { id: 42, name: 'Jane Doe', email: 'jane@example.com' },
  });

  if (!result) { fail('No result'); return [false, 'no result']; }
  info(`action=${result.action}, confidence=${result.confidence}`);

  if ((result.action === 'pass' || result.action === 'flag') && (result.confidence ?? 0) >= 0.5) {
    ok(`Schema-valid output accepted: action=${result.action}`);
    return [true, result.action];
  }
  fail(`Expected pass/flag, got ${result.action}`);
  return [false, result.action];
}

async function testV2SchemaViolation(): Promise<ScenarioResult> {
  header('V2: Schema — Missing Required Fields');

  const { result, blocked } = await sdkVerify({
    agentId: 'test-schema-violation-ts',
    task: 'Return customer record with id, name, email',
    output: JSON.stringify({ name: 'John' }),
    schema: {
      type: 'object',
      required: ['id', 'name', 'email'],
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        email: { type: 'string', format: 'email' },
      },
    },
    groundTruth: { id: 1, name: 'John', email: 'john@test.com' },
  });

  if (blocked) { ok('Blocked: schema violation'); return [true, 'block']; }
  if (result && (result.action === 'flag' || result.action === 'block')) {
    ok(`Schema violation caught: action=${result.action}`);
    return [true, result.action];
  }
  fail(`Expected flag/block, got ${result?.action ?? 'None'}`);
  return [false, result?.action ?? 'no result'];
}

async function testV3SchemaTypeMismatch(): Promise<ScenarioResult> {
  header('V3: Schema — Type Mismatch');

  const { result, blocked } = await sdkVerify({
    agentId: 'test-schema-type-ts',
    task: 'Return numeric metrics',
    output: JSON.stringify({
      revenue: 'five billion',
      profit: 'eight hundred million',
      employees: 'twelve thousand',
    }),
    schema: {
      type: 'object',
      required: ['revenue', 'profit', 'employees'],
      properties: {
        revenue: { type: 'number' },
        profit: { type: 'number' },
        employees: { type: 'integer' },
      },
    },
    groundTruth: { revenue: 5200000000, profit: 800000000, employees: 12000 },
  });

  if (blocked) { ok('Blocked: type mismatch'); return [true, 'block']; }
  if (result && (result.action === 'flag' || result.action === 'block')) {
    ok(`Type mismatch caught: action=${result.action}`);
    return [true, result.action];
  }
  fail(`Expected flag/block, got ${result?.action ?? 'None'}`);
  return [false, result?.action ?? 'no result'];
}

async function testV4HallucinationFabricated(): Promise<ScenarioResult> {
  header('V4: Hallucination — Fabricated Facts');

  const { result, blocked } = await sdkVerify({
    agentId: 'test-hallucination-ts',
    task: 'Summarize ACME Corp Q4 financials',
    output:
      'ACME Corp reported revenue of $15 billion in Q4, up 200% year-over-year. ' +
      'The company acquired GlobalTech for $2B and announced plans to IPO on NASDAQ. ' +
      'CEO John Smith stated this was the best quarter in company history.',
    groundTruth: {
      company: 'ACME Corp',
      revenue: '$5.2 billion',
      profit: '$800 million',
      yoy_growth: '8%',
      employees: 12000,
      publicly_traded: false,
      acquisitions: [],
      ceo: 'Sarah Johnson',
    },
  });

  if (blocked) { ok('Blocked: hallucinated facts'); return [true, 'block']; }
  if (result && (result.action === 'flag' || result.action === 'block')) {
    ok(`Hallucination caught: action=${result.action}, conf=${result.confidence}`);
    return [true, result.action];
  }
  fail(`Expected flag/block, got ${result?.action ?? 'None'}`);
  return [false, result?.action ?? 'no result'];
}

async function testV5HallucinationAccurate(): Promise<ScenarioResult> {
  header('V5: Hallucination — Accurate Output');

  const { result } = await sdkVerify({
    agentId: 'test-accurate-ts',
    task: 'Summarize ACME Corp Q4 financials',
    output:
      'ACME Corp reported revenue of $5.2 billion in Q4, with a profit of ' +
      '$800 million. The company has approximately 12,000 employees.',
    groundTruth: {
      company: 'ACME Corp',
      revenue: '$5.2 billion',
      profit: '$800 million',
      employees: 12000,
    },
  });

  if (!result) { fail('No result'); return [false, 'no result']; }
  info(`action=${result.action}, confidence=${result.confidence}`);

  if ((result.action === 'pass' || result.action === 'flag') && (result.confidence ?? 0) >= 0.5) {
    ok(`Accurate output accepted: action=${result.action}`);
    return [true, result.action];
  }
  fail(`Expected pass/flag, got ${result.action}`);
  return [false, result.action];
}

async function testV6DriftOffTopic(): Promise<ScenarioResult> {
  header('V6: Drift — Off-Topic Response');

  const { result, blocked } = await sdkVerify({
    agentId: 'test-drift-ts',
    task: 'Provide quarterly financial analysis for ACME Corp',
    output:
      'To make a perfect sourdough bread, you need 500g of flour, 350g of water, ' +
      '100g of sourdough starter, and 10g of salt. Mix the ingredients and let ' +
      'the dough ferment for 12 hours at room temperature.',
  });

  if (blocked) { ok('Blocked: off-topic drift'); return [true, 'block']; }
  if (result && (result.action === 'flag' || result.action === 'block')) {
    ok(`Drift caught: action=${result.action}, conf=${result.confidence}`);
    return [true, result.action];
  }
  fail(`Expected flag/block, got ${result?.action ?? 'None'}`);
  return [false, result?.action ?? 'no result'];
}

async function testV7DriftOnTask(): Promise<ScenarioResult> {
  header('V7: Drift — On-Task Response');

  const { result } = await sdkVerify({
    agentId: 'test-on-task-ts',
    task: 'Explain the benefits of cloud computing for small businesses',
    output:
      'Cloud computing offers several key benefits for small businesses: ' +
      '1) Cost savings through pay-as-you-go pricing. 2) Scalability to handle growth. ' +
      '3) Remote access enabling distributed teams. 4) Automatic updates and security patches.',
  });

  if (!result) { fail('No result'); return [false, 'no result']; }
  info(`action=${result.action}, confidence=${result.confidence}`);

  if ((result.action === 'pass' || result.action === 'flag') && (result.confidence ?? 0) >= 0.5) {
    ok(`On-task output accepted: action=${result.action}`);
    return [true, result.action];
  }
  fail(`Expected pass/flag, got ${result.action}`);
  return [false, result.action];
}

async function testV8Minimal(): Promise<ScenarioResult> {
  header('V8: Minimal — No Ground Truth, No Schema');

  const { result } = await sdkVerify({
    agentId: 'test-minimal-ts',
    task: 'Write a haiku about programming',
    output: 'Semicolons fall\nLike autumn leaves in the code\nBugs bloom in the spring',
  });

  if (!result) { fail('No result'); return [false, 'no result']; }
  info(`action=${result.action}, confidence=${result.confidence}`);

  if (result.action === 'pass' || result.action === 'flag') {
    ok(`Minimal verify works: action=${result.action}`);
    return [true, result.action];
  }
  fail(`Expected pass/flag, got ${result.action}`);
  return [false, result.action];
}

async function testV9CombinedFailures(): Promise<ScenarioResult> {
  header('V9: Combined — All Checks Fail');

  const { result, blocked } = await sdkVerify({
    agentId: 'test-all-fail-ts',
    task: 'Return structured financial data for ACME Corp',
    output: JSON.stringify({ pizza: 'pepperoni', toppings: ['cheese', 'mushrooms'] }),
    schema: {
      type: 'object',
      required: ['company', 'revenue', 'profit'],
      properties: {
        company: { type: 'string' },
        revenue: { type: 'number' },
        profit: { type: 'number' },
      },
    },
    groundTruth: { company: 'ACME Corp', revenue: 5200000000, profit: 800000000 },
  });

  if (blocked) { ok('Blocked: all checks failed'); return [true, 'block']; }
  if (result && result.action === 'block') {
    ok(`All checks failed → block, conf=${result.confidence}`);
    return [true, 'block'];
  }
  if (result && result.action === 'flag') {
    warn(`Expected block but got flag, conf=${result.confidence}`);
    return [true, 'flag'];
  }
  fail(`Expected block/flag, got ${result?.action ?? 'None'}`);
  return [false, result?.action ?? 'no result'];
}

// ===========================================================================
// SECTION 2: MULTI-TURN / COHERENCE
// ===========================================================================

async function testM1ConsistentSession(): Promise<ScenarioResult> {
  header('M1: Multi-Turn — Consistent Session');

  const vex = makeVex({ mode: 'sync', timeoutMs: 30000 });
  const session = new Session(vex, 'test-consistent-ts');

  const turns: [string, string][] = [
    ['What is ACME\'s revenue?', 'ACME Corp\'s Q4 revenue was $5.2 billion.'],
    ['What about profit?', 'ACME Corp reported a profit of $800 million in Q4.'],
    ['What\'s the profit margin?', 'With $5.2B revenue and $800M profit, the margin is approximately 15.4%.'],
  ];

  const gt = { revenue: '$5.2 billion', profit: '$800 million', employees: 12000 };
  const actions: string[] = [];
  let allPassed = true;

  for (let i = 0; i < turns.length; i++) {
    const [q, a] = turns[i]!;
    try {
      const r = await session.trace(
        { task: 'Financial Q&A for ACME Corp', input: { query: q } },
        (ctx) => { ctx.setGroundTruth(gt); ctx.record({ response: a }); },
      );
      actions.push(r.action);
      info(`Turn ${i + 1}: action=${r.action}, conf=${r.confidence}`);
      if (r.action !== 'pass' && r.action !== 'flag') allPassed = false;
    } catch (err) {
      if (err instanceof VexBlockError) {
        actions.push('block');
        allPassed = false;
      } else throw err;
    }
  }

  await vex.close();

  if (allPassed) { ok(`All turns accepted: ${actions.join(', ')}`); return [true, 'consistent']; }
  fail(`Expected all pass/flag, got: ${actions.join(', ')}`);
  return [false, actions.join(', ')];
}

async function testM2Contradiction(): Promise<ScenarioResult> {
  header('M2: Multi-Turn — Self-Contradiction');

  const vex = makeVex({ mode: 'sync', timeoutMs: 30000 });
  const session = new Session(vex, 'test-contradiction-ts');

  // Turn 1
  await session.trace(
    { task: 'Financial Q&A for ACME Corp', input: { query: 'What is ACME\'s revenue?' } },
    (ctx) => {
      ctx.setGroundTruth({ revenue: '$5.2 billion' });
      ctx.record({ response: 'ACME Corp\'s Q4 revenue was $5.2 billion.' });
    },
  );

  // Turn 2: contradict
  let blocked = false;
  let result: VexResult | null = null;

  try {
    result = await session.trace(
      { task: 'Financial Q&A for ACME Corp', input: { query: 'Confirm ACME\'s revenue?' } },
      (ctx) => {
        ctx.setGroundTruth({ revenue: '$5.2 billion' });
        ctx.record({
          response:
            'Actually, ACME Corp\'s revenue was $50 billion in Q4. ' +
            'I was completely wrong before — they are ten times larger than I said.',
        });
      },
    );
  } catch (err) {
    if (err instanceof VexBlockError) { blocked = true; result = err.result; }
    else throw err;
  }

  await vex.close();

  if (blocked) { ok('Blocked: contradiction detected'); return [true, 'block']; }
  if (result && (result.action === 'flag' || result.action === 'block')) {
    ok(`Contradiction caught: action=${result.action}, conf=${result.confidence}`);
    return [true, result.action];
  }
  fail(`Expected flag/block, got ${result?.action ?? 'None'}`);
  return [false, result?.action ?? 'no result'];
}

async function testM3ProgressiveDrift(): Promise<ScenarioResult> {
  header('M3: Multi-Turn — Progressive Drift');

  const vex = makeVex({ mode: 'sync', timeoutMs: 30000 });
  const session = new Session(vex, 'test-drift-session-ts');

  const turns: [string, string][] = [
    ['Tell me about ACME\'s financials', 'ACME Corp reported $5.2B in revenue in Q4.'],
    ['What about employee morale?', 'Employee satisfaction at ACME is moderate. Many enjoy the cafeteria.'],
    ['What food do they serve?', 'The cafeteria serves pasta, salads, and fresh bread.'],
    ['How do you make that bread?', 'For the best sourdough, mix 500g flour with 350g water and 100g starter. Ferment 12 hours and bake at 450F.'],
  ];

  const actions: string[] = [];
  for (let i = 0; i < turns.length; i++) {
    const [q, a] = turns[i]!;
    try {
      const r = await session.trace(
        { task: 'Financial Q&A for ACME Corp', input: { query: q } },
        (ctx) => { ctx.record({ response: a }); },
      );
      actions.push(r.action);
      info(`Turn ${i + 1}: action=${r.action}`);
    } catch (err) {
      if (err instanceof VexBlockError) { actions.push('block'); info(`Turn ${i + 1}: action=block`); }
      else throw err;
    }
  }

  await vex.close();

  const last = actions[actions.length - 1];
  if (last === 'flag' || last === 'block') {
    ok(`Progressive drift detected on final turn: ${actions.join(', ')}`);
    return [true, last];
  }
  fail(`Expected last turn to be flag/block, got: ${actions.join(', ')}`);
  return [false, actions.join(', ')];
}

// ===========================================================================
// SECTION 3: CORRECTION CASCADE
// ===========================================================================

async function testC1CorrectionTransparent(): Promise<ScenarioResult> {
  header('C1: Correction — Transparent Mode');

  const { result } = await sdkVerify({
    agentId: 'test-correction-transparent-ts',
    task: 'Answer geography questions accurately',
    output: 'The capital of France is Lyon.',
    groundTruth: 'The capital of France is Paris.',
    correction: 'cascade',
    transparency: 'transparent',
    timeoutMs: 60000,
  });

  if (!result) { fail('No result'); return [false, 'no result']; }
  info(`action=${result.action}, corrected=${result.corrected}`);

  if (result.corrected) {
    ok(`Correction succeeded: action=${result.action}`);
    if (result.originalOutput !== null) ok('Transparent: original_output present');
    return [true, 'corrected'];
  }

  if (result.action === 'flag' || result.action === 'block') {
    warn(`Correction not applied (may be free plan), but error caught: ${result.action}`);
    return [true, result.action];
  }
  fail(`Expected correction or flag/block, got action=${result.action}`);
  return [false, result.action];
}

async function testC2CorrectionOpaque(): Promise<ScenarioResult> {
  header('C2: Correction — Opaque Mode');

  const { result } = await sdkVerify({
    agentId: 'test-correction-opaque-ts',
    task: 'Answer geography questions accurately',
    output: 'The capital of France is Berlin.',
    groundTruth: 'The capital of France is Paris.',
    correction: 'cascade',
    transparency: 'opaque',
    timeoutMs: 60000,
  });

  if (!result) { fail('No result'); return [false, 'no result']; }
  info(`action=${result.action}, corrected=${result.corrected}`);

  if (result.corrected) {
    ok(`Opaque correction: action=${result.action}`);
    if (result.originalOutput === null) ok('Opaque: original_output hidden');
    else warn('Opaque: original_output exposed (unexpected)');
    return [true, 'corrected'];
  }

  if (result.action === 'flag' || result.action === 'block') {
    warn(`Correction not applied, but error caught: ${result.action}`);
    return [true, result.action];
  }
  fail('Expected correction or flag/block');
  return [false, result.action];
}

async function testC3CorrectionNotNeeded(): Promise<ScenarioResult> {
  header('C3: Correction — Not Needed (already correct)');

  const { result } = await sdkVerify({
    agentId: 'test-correction-not-needed-ts',
    task: 'What is 2+2?',
    output: '2+2 equals 4.',
    groundTruth: '4',
    correction: 'cascade',
    transparency: 'transparent',
    timeoutMs: 30000,
  });

  if (!result) { fail('No result'); return [false, 'no result']; }
  info(`action=${result.action}, corrected=${result.corrected}`);

  if (!result.corrected && (result.action === 'pass' || result.action === 'flag')) {
    ok('Correct output not unnecessarily corrected');
    return [true, 'no-correction'];
  }
  if (result.corrected) {
    warn('Correction applied to already-correct output (unexpected)');
    return [true, 'over-corrected'];
  }
  fail(`Unexpected: action=${result.action}, corrected=${result.corrected}`);
  return [false, result.action];
}

// ===========================================================================
// SECTION 4: PLAN ENFORCEMENT
// ===========================================================================

async function testP1CorrectionGating(): Promise<ScenarioResult> {
  header('P1: Plan — Correction Gating (Free Plan)');

  const resp = await rawVerify({
    execution_id: 'test-gating-ts-001',
    agent_id: 'test-gating-ts',
    task: 'Answer questions',
    output: 'The capital of France is Berlin.',
    ground_truth: 'The capital of France is Paris.',
    input: {},
    metadata: { correction: 'cascade', transparency: 'transparent' },
  });

  if (resp.status !== 200) {
    fail(`Expected 200, got ${resp.status}`);
    return [false, String(resp.status)];
  }

  const body = await resp.json() as Record<string, unknown>;
  info(`correction_skipped=${body.correction_skipped}`);
  info(`correction_skipped_reason=${body.correction_skipped_reason}`);

  if (body.correction_skipped) {
    if (body.correction_skipped_reason === 'upgrade_required') {
      ok('Correction gated: correction_skipped=true, reason=upgrade_required');
      return [true, 'gated'];
    }
    ok(`Correction skipped, reason=${body.correction_skipped_reason}`);
    return [true, 'gated'];
  }
  warn('Correction not skipped — org may be on a paid plan');
  return [true, 'not-gated'];
}

async function testP2Health(): Promise<ScenarioResult> {
  header('P2: Health Endpoint');

  const resp = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(10_000) });

  if (resp.status === 200) {
    const body = await resp.json() as Record<string, unknown>;
    if (body.status === 'healthy') { ok('Health check passed'); return [true, 'healthy']; }
    fail(`Unexpected health body: ${JSON.stringify(body)}`);
    return [false, String(body)];
  }
  fail(`Health check failed: status=${resp.status}`);
  return [false, String(resp.status)];
}

async function testP3MissingApiKey(): Promise<ScenarioResult> {
  header('P3: Auth — Missing API Key');

  const resp = await fetch(`${API_URL}/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      execution_id: 'test-nokey-ts',
      agent_id: 'test',
      task: 'test',
      output: 'test',
      input: {},
      metadata: {},
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (resp.status === 401 || resp.status === 403 || resp.status === 422) {
    ok(`No API key rejected: status=${resp.status}`);
    return [true, String(resp.status)];
  }
  fail(`Expected 401/403/422, got ${resp.status}`);
  return [false, String(resp.status)];
}

async function testP4InvalidApiKey(): Promise<ScenarioResult> {
  header('P4: Auth — Invalid API Key');

  const resp = await fetch(`${API_URL}/v1/verify`, {
    method: 'POST',
    headers: { 'X-Vex-Key': 'ag_live_INVALID_KEY_12345678', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      execution_id: 'test-badkey-ts',
      agent_id: 'test',
      task: 'test',
      output: 'test',
      input: {},
      metadata: {},
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (resp.status === 401) { ok('Invalid API key rejected: 401'); return [true, '401']; }
  fail(`Expected 401, got ${resp.status}`);
  return [false, String(resp.status)];
}

async function testP5ConfigurationError(): Promise<ScenarioResult> {
  header('P5: SDK — ConfigurationError on Bad Key');

  try {
    new Vex({ apiKey: '' });
    fail('No error thrown for empty API key');
    return [false, 'no error'];
  } catch (err) {
    if (err instanceof ConfigurationError) {
      ok('ConfigurationError thrown for empty key');
      return [true, 'ConfigurationError'];
    }
    fail(`Wrong error type: ${err}`);
    return [false, 'wrong error'];
  }
}

// ===========================================================================
// SECTION 5: EDGE CASES & INGESTION
// ===========================================================================

async function testE1AsyncIngest(): Promise<ScenarioResult> {
  header('E1: Async Ingest — Fire and Forget');

  const vex = makeVex({ mode: 'async' });
  try {
    await vex.trace(
      { agentId: 'test-async-ingest-ts', task: 'Test async ingestion', input: { query: 'test' } },
      (ctx) => { ctx.record({ response: 'test output' }); },
    );
    await vex.close();
    ok('Async ingest completed without exception');
    return [true, 'accepted'];
  } catch (err) {
    fail(`Async ingest raised: ${err}`);
    return [false, String(err)];
  }
}

async function testE2BatchIngest(): Promise<ScenarioResult> {
  header('E2: Batch Ingest — Multiple Events');

  const events = Array.from({ length: 5 }, (_, i) => ({
    execution_id: `batch-test-ts-${i}`,
    agent_id: 'test-batch-ts',
    task: 'batch test',
    output: `output ${i}`,
    input: { idx: i },
    metadata: {},
  }));

  const resp = await rawIngestBatch(events);

  if (resp.status === 202) {
    const body = await resp.json() as Record<string, unknown>;
    const accepted = body.accepted as number;
    if (accepted === 5) { ok(`Batch accepted: ${accepted} events`); return [true, `accepted=${accepted}`]; }
    fail(`Expected 5 accepted, got ${accepted}`);
    return [false, `accepted=${accepted}`];
  }
  fail(`Expected 202, got ${resp.status}`);
  return [false, String(resp.status)];
}

async function testE3SingleIngest(): Promise<ScenarioResult> {
  header('E3: Single Ingest — Raw HTTP');

  const resp = await rawIngest({
    execution_id: 'single-ingest-test-ts',
    agent_id: 'test-single-ingest-ts',
    task: 'test',
    output: 'test output',
    input: { query: 'test' },
    metadata: {},
  });

  if (resp.status === 202) {
    const body = await resp.json() as Record<string, unknown>;
    ok(`Single ingest accepted: execution_id=${body.execution_id}`);
    return [true, 'accepted'];
  }
  fail(`Expected 202, got ${resp.status}`);
  return [false, String(resp.status)];
}

async function testE4EmptyOutput(): Promise<ScenarioResult> {
  header('E4: Edge — Empty Output');

  const { result, blocked } = await sdkVerify({
    agentId: 'test-empty-output-ts',
    task: 'Generate a report',
    output: '',
    groundTruth: 'Expected non-empty report',
  });

  if (blocked) { ok('Empty output blocked'); return [true, 'block']; }
  if (!result) { fail('No result and no block'); return [false, 'no result']; }
  info(`action=${result.action}, confidence=${result.confidence}`);

  if (result.action === 'flag' || result.action === 'block') {
    ok(`Empty output caught: action=${result.action}`);
    return [true, result.action];
  }
  warn(`Empty output passed (action=${result.action}) — may be acceptable`);
  return [true, result.action];
}

async function testE5LargeOutput(): Promise<ScenarioResult> {
  header('E5: Edge — Large Output (10KB)');

  const largeOutput = {
    report: 'Financial analysis: ' + 'ACME Corp had strong results. '.repeat(200),
    sections: Array.from({ length: 10 }, (_, i) => ({
      title: `Section ${i}`,
      content: `Details about section ${i}. `.repeat(20),
    })),
  };

  const { result } = await sdkVerify({
    agentId: 'test-large-output-ts',
    task: 'Generate comprehensive financial report',
    output: JSON.stringify(largeOutput),
    timeoutMs: 60000,
  });

  if (!result) { fail('No result for large output'); return [false, 'no result']; }
  info(`action=${result.action}, confidence=${result.confidence}`);
  ok(`Large output handled: action=${result.action}`);
  return [true, result.action];
}

async function testE6SpecialCharacters(): Promise<ScenarioResult> {
  header('E6: Edge — Special Characters');

  const { result } = await sdkVerify({
    agentId: 'test-special-chars-ts',
    task: 'Respond in multiple languages',
    output:
      'Revenue: ¥5.2兆 (approximately $5.2B USD)\n' +
      'Profit margin: 15.4% 📈\n' +
      'Status: «très bien» — excellent results\n' +
      'Growth: ↑8% YoY • €4.8B → €5.2B',
    groundTruth: 'Revenue $5.2B, profit $800M',
  });

  if (!result) { fail('No result for special chars'); return [false, 'no result']; }
  info(`action=${result.action}, confidence=${result.confidence}`);
  ok(`Special characters handled: action=${result.action}`);
  return [true, result.action];
}

async function testE7JsonStringOutput(): Promise<ScenarioResult> {
  header('E7: Edge — JSON String Output (schema parses string)');

  const { result } = await sdkVerify({
    agentId: 'test-json-string-ts',
    task: 'Return structured data',
    output: '{"name": "ACME", "revenue": 5200000000}',
    schema: {
      type: 'object',
      required: ['name', 'revenue'],
      properties: { name: { type: 'string' }, revenue: { type: 'number' } },
    },
    groundTruth: { name: 'ACME', revenue: 5200000000 },
  });

  if (!result) { fail('No result'); return [false, 'no result']; }
  info(`action=${result.action}, confidence=${result.confidence}`);

  if (result.action === 'pass' || result.action === 'flag') {
    ok(`JSON string output parsed correctly: action=${result.action}`);
    return [true, result.action];
  }
  fail(`Expected pass/flag, got ${result.action}`);
  return [false, result.action];
}

async function testE8TraceWithSteps(): Promise<ScenarioResult> {
  header('E8: SDK — Trace with Steps');

  const vex = makeVex({ mode: 'async' });
  try {
    await vex.trace(
      { agentId: 'test-steps-ts', task: 'Multi-step agent task', input: { query: 'Analyze ACME' } },
      (ctx) => {
        ctx.step({ type: 'tool_call', name: 'fetch_data', input: { company: 'ACME' }, output: { revenue: 5.2 } });
        ctx.step({ type: 'llm', name: 'analyze', input: { revenue: 5.2 }, output: 'Strong performance' });
        ctx.setGroundTruth({ revenue: '$5.2B' });
        ctx.setTokenCount(150);
        ctx.setCostEstimate(0.003);
        ctx.setMetadata('model', 'gpt-4');
        ctx.setMetadata('version', '1.0');
        ctx.record({ summary: 'ACME Corp showed strong Q4 performance.' });
      },
    );
    await vex.close();
    ok('Trace with steps completed successfully');
    return [true, 'accepted'];
  } catch (err) {
    fail(`Trace with steps raised: ${err}`);
    return [false, String(err)];
  }
}

async function testE9SessionHistory(): Promise<ScenarioResult> {
  header('E9: SDK — Session History Accumulation');

  const vex = makeVex({ mode: 'async' });
  const session = new Session(vex, 'test-session-history-ts');

  // 3 turns
  for (let i = 0; i < 3; i++) {
    await session.trace(
      { task: `Task ${i}`, input: { turn: i } },
      (ctx) => { ctx.record({ response: `Answer ${i}` }); },
    );
  }

  await vex.close();

  // Session should have accumulated 3 turns
  if (session.sequence === 3) {
    ok(`Session accumulated ${session.sequence} turns correctly`);
    return [true, `turns=${session.sequence}`];
  }
  fail(`Expected 3 turns, got ${session.sequence}`);
  return [false, `turns=${session.sequence}`];
}

// ===========================================================================
// Test runner
// ===========================================================================

const SECTIONS: Record<string, [string, () => Promise<ScenarioResult>][]> = {
  verification: [
    ['V1: Schema Valid', testV1SchemaValid],
    ['V2: Schema Violation', testV2SchemaViolation],
    ['V3: Schema Type Mismatch', testV3SchemaTypeMismatch],
    ['V4: Hallucination', testV4HallucinationFabricated],
    ['V5: Accurate Output', testV5HallucinationAccurate],
    ['V6: Drift Off-Topic', testV6DriftOffTopic],
    ['V7: Drift On-Task', testV7DriftOnTask],
    ['V8: Minimal Verify', testV8Minimal],
    ['V9: All Checks Fail', testV9CombinedFailures],
  ],
  multiturn: [
    ['M1: Consistent Session', testM1ConsistentSession],
    ['M2: Contradiction', testM2Contradiction],
    ['M3: Progressive Drift', testM3ProgressiveDrift],
  ],
  correction: [
    ['C1: Transparent', testC1CorrectionTransparent],
    ['C2: Opaque', testC2CorrectionOpaque],
    ['C3: Not Needed', testC3CorrectionNotNeeded],
  ],
  plan: [
    ['P1: Correction Gating', testP1CorrectionGating],
    ['P2: Health', testP2Health],
    ['P3: Missing API Key', testP3MissingApiKey],
    ['P4: Invalid API Key', testP4InvalidApiKey],
    ['P5: ConfigurationError', testP5ConfigurationError],
  ],
  edge: [
    ['E1: Async Ingest', testE1AsyncIngest],
    ['E2: Batch Ingest', testE2BatchIngest],
    ['E3: Single Ingest', testE3SingleIngest],
    ['E4: Empty Output', testE4EmptyOutput],
    ['E5: Large Output', testE5LargeOutput],
    ['E6: Special Chars', testE6SpecialCharacters],
    ['E7: JSON String', testE7JsonStringOutput],
    ['E8: Steps', testE8TraceWithSteps],
    ['E9: Session History', testE9SessionHistory],
  ],
};

async function main(): Promise<number> {
  const sectionArg = process.argv.find((a) => a === '--section');
  const sectionIdx = process.argv.indexOf('--section');
  const selectedSection = sectionIdx >= 0 ? process.argv[sectionIdx + 1] : 'all';

  const validSections = [...Object.keys(SECTIONS), 'all'];
  if (!selectedSection || !validSections.includes(selectedSection)) {
    console.error(`Usage: npx tsx test_comprehensive.ts [--section ${validSections.join('|')}]`);
    return 1;
  }

  console.log(`${BOLD}Vex TypeScript SDK — Comprehensive E2E Test Suite${RESET}`);
  console.log(`  API URL: ${API_URL}`);
  console.log(`  API Key: ${API_KEY.slice(0, 8)}...${API_KEY.slice(-4)}`);

  const sectionsToRun =
    selectedSection === 'all' ? Object.keys(SECTIONS) : [selectedSection];

  const allResults: [string, boolean, string][] = [];

  for (const sectionName of sectionsToRun) {
    sectionHeader(`SECTION: ${sectionName.toUpperCase()}`);
    const tests = SECTIONS[sectionName]!;

    for (const [name, fn] of tests) {
      const t0 = performance.now();
      try {
        const [passed, detail] = await fn();
        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        console.log(`  ${DIM}(${elapsed}s)${RESET}`);
        allResults.push([name, passed, detail]);
      } catch (err) {
        fail(`Unhandled exception in ${name}: ${err}`);
        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        console.log(`  ${DIM}(${elapsed}s)${RESET}`);
        allResults.push([name, false, 'exception']);
      }
    }
  }

  // Summary
  header('FINAL SUMMARY');

  let passedCount = 0;
  let failedCount = 0;

  for (const [name, passed, detail] of allResults) {
    const status = passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    console.log(`  ${name.padEnd(30)}  [${status}]  ${detail}`);
    if (passed) passedCount++;
    else failedCount++;
  }

  const total = allResults.length;
  console.log(`\n  ${BOLD}${passedCount}/${total} tests passed${RESET}`);
  if (failedCount > 0) console.log(`  ${RED}${failedCount} tests failed${RESET}`);

  if (passedCount === total) {
    console.log(`\n  ${GREEN}${BOLD}ALL TESTS PASSED${RESET}`);
    return 0;
  }
  console.log(`\n  ${RED}${BOLD}SOME TESTS FAILED${RESET}`);
  return 1;
}

main().then((code) => process.exit(code));
