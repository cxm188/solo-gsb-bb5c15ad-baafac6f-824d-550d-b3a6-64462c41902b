import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { EXAMPLE_CONFLICT_REQUEST } from '../src/example.js';

let app;

before(async () => {
  app = buildApp({ logger: false, storeMax: 100 });
  await app.ready();
});

after(async () => {
  await app.close();
});

async function createRecord(payload) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/merges',
    payload,
  });
  return created.json();
}

async function preview(id, resolutions) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/merges/${id}/resolution-preview`,
    payload: { resolutions },
  });
}

test('preview unknown id returns 404', async () => {
  const res = await preview('no-such-id', []);
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'Not Found');
});

test('preview on a clean record returns 409', async () => {
  const rec = await createRecord({
    base: { a: 1 },
    patchA: [{ op: 'replace', path: '/a', value: 2 }],
    patchB: [],
  });
  assert.equal(rec.status, 'clean');
  const res = await preview(rec.id, []);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, 'NOT_CONFLICTED');
});

test('preview rejects malformed body (400 via schema)', async () => {
  const rec = await createRecord(EXAMPLE_CONFLICT_REQUEST);
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/merges/${rec.id}/resolution-preview`,
    payload: { resolutions: [{ conflict: 0, winner: 'C' }] },
  });
  assert.equal(res.statusCode, 400);
});

test('incomplete coverage (missing conflict) returns 422 with missing ordinals', async () => {
  const rec = await createRecord(EXAMPLE_CONFLICT_REQUEST);
  // only conflict 0 decided; conflict 1 (/mode) missing
  const res = await preview(rec.id, [{ conflict: 0, winner: 'A' }]);
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.code, 'INCOMPLETE_RESOLUTION');
  assert.deepEqual(body.details.missing, [1]);
  assert.equal(body.details.conflictCount, 2);
});

test('duplicate and out-of-range conflict ordinals return 422', async () => {
  const rec = await createRecord(EXAMPLE_CONFLICT_REQUEST);
  const res = await preview(rec.id, [
    { conflict: 0, winner: 'A' },
    { conflict: 0, winner: 'B' },
    { conflict: 1, winner: 'A' },
    { conflict: 7, winner: 'A' },
  ]);
  assert.equal(res.statusCode, 422);
  const { details } = res.json();
  assert.deepEqual(details.duplicate, [0]);
  assert.deepEqual(details.outOfRange, [7]);
});

test('resolving all conflicts for A produces merged document, retained/dropped lists and stats', async () => {
  const rec = await createRecord(EXAMPLE_CONFLICT_REQUEST);
  const res = await preview(rec.id, [
    { conflict: 0, winner: 'A' },
    { conflict: 1, winner: 'A' },
  ]);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'clean');
  assert.deepEqual(body.merged, { mode: 'single' });
  assert.deepEqual(
    body.retained.map((o) => [o.side, o.index]),
    [
      ['A', 0],
      ['A', 1],
    ],
  );
  assert.deepEqual(
    body.dropped.map((o) => [o.side, o.index]),
    [
      ['B', 0],
      ['B', 1],
    ]);
  // every listing names the conflict ordinals it participated in
  assert.deepEqual(body.retained[0].conflictIndices, [0]);
  assert.deepEqual(body.dropped[0].conflictIndices, [0]);
  assert.equal(body.stats.received.A, 2);
  assert.equal(body.stats.received.B, 0); // both B ops filtered out
  assert.equal(body.stats.conflicts, 0);
  assert.equal(body.stats.applied, 2);
});

test('mixed winners: A wins /database conflict, B wins /mode conflict', async () => {
  const rec = await createRecord(EXAMPLE_CONFLICT_REQUEST);
  const res = await preview(rec.id, [
    { conflict: 0, winner: 'B' }, // keep B's /database/host replace, drop A's remove
    { conflict: 1, winner: 'B' }, // keep B's /mode=readonly
  ]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().merged, {
    database: { host: 'db2.internal', port: 5432 },
    mode: 'readonly',
  });
});

test('same operation retained and dropped across conflicts returns 422 listing op and ordinals', async () => {
  // A#0 removes /o; B modifies two members underneath -> two conflicts sharing A#0.
  const rec = await createRecord({
    base: { o: { x: 1, y: 2 } },
    patchA: [{ op: 'remove', path: '/o' }],
    patchB: [
      { op: 'replace', path: '/o/x', value: 10 },
      { op: 'replace', path: '/o/y', value: 20 },
    ],
  });
  assert.equal(rec.status, 'conflict');
  // delete-vs-modify anchors at the ancestor; both conflicts share path /o
  // and A#0, distinguished by the B operation they involve.
  assert.deepEqual(
    rec.conflicts.map((c) => c.operations.map((o) => [o.side, o.index])),
    [
      [
        ['A', 0],
        ['B', 0],
      ],
      [
        ['A', 0],
        ['B', 1],
      ],
    ],
  );
  // keep B at /o/x (A#0 dropped), keep A at /o/y (A#0 retained)
  const res = await preview(rec.id, [
    { conflict: 0, winner: 'B' },
    { conflict: 1, winner: 'A' },
  ]);
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.code, 'CONTRADICTORY_RESOLUTION');
  assert.equal(body.details.conflicts.length, 1);
  assert.deepEqual(
    {
      side: body.details.conflicts[0].side,
      index: body.details.conflicts[0].index,
      retainedIn: body.details.conflicts[0].retainedIn,
      droppedIn: body.details.conflicts[0].droppedIn,
    },
    { side: 'A', index: 0, retainedIn: [1], droppedIn: [0] },
  );
});

test('shared loser across conflicts is allowed: dropping A#0 resolves both /o conflicts', async () => {
  const rec = await createRecord({
    base: { o: { x: 1, y: 2 } },
    patchA: [{ op: 'remove', path: '/o' }],
    patchB: [
      { op: 'replace', path: '/o/x', value: 10 },
      { op: 'replace', path: '/o/y', value: 20 },
    ],
  });
  const res = await preview(rec.id, [
    { conflict: 0, winner: 'B' },
    { conflict: 1, winner: 'B' },
  ]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().merged, { o: { x: 10, y: 20 } });
  // A#0 is listed once with both conflict ordinals
  const droppedA0 = res.json().dropped.filter((o) => o.side === 'A' && o.index === 0);
  assert.equal(droppedA0.length, 1);
  assert.deepEqual(droppedA0[0].conflictIndices, [0, 1]);
});

test('filtering reveals a latent same-path op: 409 returns remaining conflicts', async () => {
  // A has last-wins replaces on /x: only A#1 (=2) reached the original merge
  // and conflicted with B#0 (=3). Dropping A#1 lets A#0 (=1) survive, which
  // still disagrees with B's value -> conflict remains after filtering.
  const rec = await createRecord({
    base: { x: 0 },
    patchA: [
      { op: 'replace', path: '/x', value: 1 },
      { op: 'replace', path: '/x', value: 2 },
    ],
    patchB: [{ op: 'replace', path: '/x', value: 3 }],
  });
  assert.equal(rec.conflicts.length, 1);
  assert.deepEqual(
    rec.conflicts[0].operations.map((o) => [o.side, o.index]),
    [
      ['A', 1],
      ['B', 0],
    ],
  );
  const res = await preview(rec.id, [{ conflict: 0, winner: 'B' }]);
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.status, 'conflict');
  assert.equal(body.merged, null);
  assert.equal(body.conflicts.length, 1);
  assert.equal(body.conflicts[0].path, '/x');
  assert.deepEqual(
    body.conflicts[0].operations.map((o) => [o.side, o.index]),
    [
      ['A', 0],
      ['B', 0],
    ],
  );
  // decision bookkeeping is still reported alongside the remaining conflicts
  assert.deepEqual(
    body.dropped.map((o) => [o.side, o.index]),
    [['A', 1]],
  );
  assert.equal(body.stats.conflicts, 1);
});

test('choosing A on the latent-op case applies A#0=1 cleanly', async () => {
  const rec = await createRecord({
    base: { x: 0 },
    patchA: [
      { op: 'replace', path: '/x', value: 1 },
      { op: 'replace', path: '/x', value: 2 },
    ],
    patchB: [{ op: 'replace', path: '/x', value: 3 }],
  });
  const res = await preview(rec.id, [{ conflict: 0, winner: 'A' }]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().merged, { x: 2 }); // B dropped; A's last-wins op remains
});

test('preview never mutates the stored record and repeated previews are byte-identical', async () => {
  const rec = await createRecord(EXAMPLE_CONFLICT_REQUEST);
  const payload = {
    resolutions: [
      { conflict: 0, winner: 'A' },
      { conflict: 1, winner: 'B' },
    ],
  };
  const first = await app.inject({
    method: 'POST',
    url: `/api/v1/merges/${rec.id}/resolution-preview`,
    payload,
  });
  const second = await app.inject({
    method: 'POST',
    url: `/api/v1/merges/${rec.id}/resolution-preview`,
    payload,
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body, second.body);

  // resolution order in the request must not matter (conflicts keyed by ordinal)
  const reversed = await app.inject({
    method: 'POST',
    url: `/api/v1/merges/${rec.id}/resolution-preview`,
    payload: { resolutions: [...payload.resolutions].reverse() },
  });
  const firstJson = first.json();
  delete firstJson.resolutions;
  const reversedJson = reversed.json();
  delete reversedJson.resolutions;
  assert.deepEqual(reversedJson, firstJson);

  const fetched = await app.inject({
    method: 'GET',
    url: `/api/v1/merges/${rec.id}`,
  });
  const stored = fetched.json();
  assert.equal(stored.status, 'conflict');
  assert.equal(stored.merged, null);
  assert.equal(stored.conflicts.length, 2);
  assert.deepEqual(stored.patchA, EXAMPLE_CONFLICT_REQUEST.patchA);
  assert.deepEqual(stored.patchB, EXAMPLE_CONFLICT_REQUEST.patchB);
});
