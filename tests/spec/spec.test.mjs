// Spec validation suite for the pre-application stage of the repository.
//
// What this checks (there is no application code yet, so these are the
// artifacts that exist today):
//   1. prisma/schema.prisma is valid and formatted (Prisma 7.10.1)
//   2. the data model keeps the promises made in docs/03-data-model.md
//   3. documentation links and section references resolve
//   4. requirement ids in the PRD are unique and carry a priority
//   5. .env.example contains no secret-looking values
//   6. status claims in the docs match the repository contents
//
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const schema = read('prisma/schema.prisma');

// Parse "model X { ... }" blocks.
const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => ({
  name: m[1],
  body: m[2],
}));
const enums = [...schema.matchAll(/^enum (\w+) \{/gm)].map((m) => m[1]);

const docFiles = readdirSync(join(root, 'docs'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => `docs/${f}`);
const markdownFiles = [...docFiles, 'README.md'];

// ---------------------------------------------------------------------------
// 1. Schema validity
// ---------------------------------------------------------------------------

const prismaBin = join(root, 'node_modules', '.bin', 'prisma');
// Prisma's validate and format commands do not run the native engines. The
// placeholders stop the CLI from downloading them, which is not needed here.
const prismaEnv = {
  ...process.env,
  PRISMA_SCHEMA_ENGINE_BINARY: '/bin/true',
  PRISMA_QUERY_ENGINE_LIBRARY: '/bin/true',
  PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING: '1',
};

test('schema: passes prisma validate', () => {
  const r = spawnSync(prismaBin, ['validate', '--schema', 'prisma/schema.prisma'], {
    cwd: root,
    env: prismaEnv,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /is valid/);
});

test('schema: is formatted (prisma format --check)', () => {
  const r = spawnSync(prismaBin, ['format', '--schema', 'prisma/schema.prisma', '--check'], {
    cwd: root,
    env: prismaEnv,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('schema: model and enum counts match the README', () => {
  const readme = read('README.md');
  assert.ok(
    readme.includes(`${models.length} models, ${enums.length} enums`),
    `README must state "${models.length} models, ${enums.length} enums"`,
  );
});

// ---------------------------------------------------------------------------
// 2. Data-model promises (docs/03-data-model.md)
// ---------------------------------------------------------------------------

test('schema: every model has a primary key', () => {
  const missing = models.filter((m) => !/@id\b|@@id\(/.test(m.body)).map((m) => m.name);
  assert.deepEqual(missing, []);
});

test('schema: every tenant-owned model relates to Business', () => {
  // docs/03 §2: every business-owned table carries businessId.
  const offenders = models
    .filter((m) => /^\s*businessId\s/m.test(m.body))
    .filter((m) => !/^\s*business\s+Business\??\s/m.test(m.body))
    .map((m) => m.name);
  assert.deepEqual(offenders, []);
});

test('schema: money fields are BigInt, never Float or Decimal', () => {
  // Every field whose name mentions "Minor" or "Amount" holds money (docs/03 §2).
  const bad = [];
  for (const m of models) {
    for (const line of m.body.split('\n')) {
      const field = line.match(/^\s*(\w*(?:Minor|Amount)\w*)\s+(\w+)/);
      if (field && field[2] !== 'BigInt') bad.push(`${m.name}.${field[1]}: ${field[2]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('schema: idempotency and duplicate-protection keys exist (docs/03 §5)', () => {
  // Each entry is a uniqueness guarantee the docs rely on.
  const required = [
    ['Order', '@@unique([businessId, checkoutKey])'],
    ['Payment', 'reference', 'String          @unique'],
    ['Payment', 'providerTransactionId'],
    ['WebhookEvent', '@@unique([provider, externalId])'],
    ['Message', 'providerMessageId'],
    ['WhatsAppNotification', 'dedupeKey'],
    ['Refund', 'providerRefundId'],
    ['ConfirmationRequest', 'tokenHash'],
    ['IdempotencyKey', '@@unique([businessId, scope, keyHash])'],
    ['DeliveryEvent', 'providerEventId'],
  ];
  const missing = [];
  for (const [modelName, ...needles] of required) {
    const m = models.find((x) => x.name === modelName);
    if (!m) {
      missing.push(`${modelName} (model missing)`);
      continue;
    }
    for (const needle of needles) {
      const hasUnique = m.body.includes(needle) && /@unique|@@unique/.test(m.body);
      if (!hasUnique) missing.push(`${modelName}: ${needle}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('schema: order lifecycle enum has all eleven states from the PRD §7', () => {
  const expected = [
    'PENDING_PAYMENT', 'PAYMENT_CONFIRMED', 'CONFIRMED', 'PROCESSING',
    'READY_FOR_DISPATCH', 'DISPATCHED', 'OUT_FOR_DELIVERY', 'DELIVERED',
    'CANCELLED', 'REFUND_PENDING', 'REFUNDED',
  ];
  const block = schema.match(/^enum OrderStatus \{([\s\S]*?)^\}/m)[1];
  const values = block.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(values, expected);
});

// ---------------------------------------------------------------------------
// 3. Documentation links and cross-references
// ---------------------------------------------------------------------------

test('docs: every relative markdown link resolves', () => {
  const broken = [];
  for (const file of markdownFiles) {
    const text = read(file);
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const path = resolve(dirname(join(root, file)), target.split('#')[0]);
      if (!existsSync(path)) broken.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

// Section numbers that exist in a document: "## 3. Title" or "### 3.6 Title".
function sectionNumbers(file) {
  const nums = new Set();
  for (const m of read(file).matchAll(/^#{2,4} (\d+(?:\.\d+)*)[ .]/gm)) nums.add(m[1]);
  return nums;
}

test('docs: explicit cross-document section references resolve', () => {
  // Matches: `03-data-model.md` §9   and   `06` §10
  const broken = [];
  const docsByPrefix = new Map(
    docFiles.map((f) => [basename(f).slice(0, 2), f]),
  );
  for (const file of markdownFiles) {
    for (const m of read(file).matchAll(/`((?:0\d)(?:-[\w-]+)?(?:\.md)?)`\s*§\s?(\d+(?:\.\d+)*)/g)) {
      const target = docsByPrefix.get(m[1].slice(0, 2));
      if (!target) {
        broken.push(`${file}: unknown document ${m[1]}`);
        continue;
      }
      if (!sectionNumbers(target).has(m[2])) {
        broken.push(`${file}: ${m[1]} §${m[2]} does not exist`);
      }
    }
  }
  assert.deepEqual(broken, []);
});

// ---------------------------------------------------------------------------
// 4. Requirements traceability (docs/01)
// ---------------------------------------------------------------------------

test('PRD: requirement ids are unique', () => {
  const ids = [...read('docs/01-product-requirements.md').matchAll(/^\| (FR-[A-Z]+-\d{2}) \|/gm)].map(
    (m) => m[1],
  );
  assert.ok(ids.length >= 40, `expected at least 40 requirement rows, found ${ids.length}`);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual([...new Set(dupes)], []);
});

test('PRD: every requirement row has a priority of M, S or C', () => {
  const rows = read('docs/01-product-requirements.md')
    .split('\n')
    .filter((l) => /^\| FR-[A-Z]+-\d{2} \|/.test(l));
  const bad = rows.filter((row) => {
    const cells = row.split('|').map((c) => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1);
    return !['M', 'S', 'C'].includes(cells[cells.length - 1]);
  });
  assert.deepEqual(bad.map((r) => r.slice(0, 60)), []);
});

// ---------------------------------------------------------------------------
// 5. Configuration template
// ---------------------------------------------------------------------------

test('env: .env.example contains no real-looking secrets', () => {
  const text = read('.env.example');
  const problems = [];
  if (/sk_(live|test)_[A-Za-z0-9]{8,}/.test(text)) problems.push('payment key literal');
  if (/AKIA[0-9A-Z]{12,}/.test(text)) problems.push('AWS access key literal');
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) problems.push('private key block');

  const secretKey = /(SECRET|TOKEN|PASSWORD|API_KEY|_KEY\b|DSN)/;
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m || !secretKey.test(m[1])) continue;
    const value = m[2].split(' #')[0].trim();
    if (value === '') continue;
    if (/^(replace|change-me|example|your)/i.test(value)) continue;
    problems.push(`${m[1]} has a non-placeholder value`);
  }
  assert.deepEqual(problems, []);
});

test('env: .env is ignored by git and .env.example is not', () => {
  const gitignore = read('.gitignore').split('\n').map((l) => l.trim());
  assert.ok(gitignore.includes('.env'), '.env must be ignored');
  assert.ok(gitignore.includes('!.env.example'), '.env.example must stay tracked');
});

// ---------------------------------------------------------------------------
// 6. Status honesty
// ---------------------------------------------------------------------------

test('status: roadmap says application code is not started while src/ is absent', () => {
  // When Stage 1 lands, update docs/07 §1 and this test together.
  if (existsSync(join(root, 'src'))) return;
  const row = read('docs/07-mvp-and-roadmap.md').match(/\| Application code \| (.*?) \|/);
  assert.ok(row, 'Application code row missing from docs/07 §1');
  assert.match(row[1], /Not started/);
});

test('status: README does not claim a runnable application', () => {
  if (existsSync(join(root, 'src'))) return;
  assert.match(read('README.md'), /no runnable application yet/i);
});
