/**
 * Resolution preview for a previously stored conflicted rehearsal.
 *
 * The client chooses a winner (A or B) for every conflict reported by the
 * baseline-coordinate merge engine. Losing original operations are stripped
 * from the raw patchA / patchB arrays and the SAME merge logic
 * (mergePatches from ./merge.js) runs again over the filtered inputs.
 *
 * Pure function: inputs are never mutated, nothing is stored, identical
 * resolutions always produce identical results.
 */

import { mergePatches } from './merge.js';

export class ResolutionError extends Error {
  constructor(statusCode, code, message, details = {}) {
    super(message);
    this.name = 'ResolutionError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function opRefOf(ref, conflictIndices) {
  const out = {
    side: ref.side,
    index: ref.index,
    op: ref.op,
    path: ref.path,
    conflictIndices: [...conflictIndices],
  };
  if ('value' in ref) out.value = ref.value;
  return out;
}

/**
 * Preview a conflict resolution.
 *
 * @param {object} record      stored rehearsal record ({ status, conflicts,
 *                             base, patchA, patchB })
 * @param {Array}  resolutions [{ conflict: <0-based conflict ordinal>,
 *                             winner: 'A' | 'B' }]
 * @returns {{ status: 'clean'|'conflict', merged, conflicts, retained, dropped, stats }}
 * @throws {ResolutionError} 409 non-conflict record; 422 incomplete/ambiguous resolution
 */
export function previewResolution(record, resolutions) {
  if (record.status !== 'conflict') {
    throw new ResolutionError(
      409,
      'NOT_CONFLICTED',
      `rehearsal ${record.id} has status "${record.status}"; resolution preview is only available for status "conflict"`,
      { status: record.status },
    );
  }

  const conflicts = record.conflicts;
  if (!Array.isArray(resolutions)) {
    throw new ResolutionError(
      422,
      'INVALID_RESOLUTION',
      '"resolutions" must be an array',
      { conflictCount: conflicts.length },
    );
  }

  const byConflict = new Map();
  const duplicate = [];
  const outOfRange = [];
  for (const r of resolutions) {
    if (
      r === null ||
      typeof r !== 'object' ||
      typeof r.conflict !== 'number' ||
      (r.winner !== 'A' && r.winner !== 'B')
    ) {
      // Structural problems of individual entries are meant to be caught by
      // the request schema; guard here keeps the pure function safe.
      throw new ResolutionError(
        422,
        'INVALID_RESOLUTION',
        'each resolution must be { conflict: integer, winner: "A"|"B" }',
        { conflictCount: conflicts.length },
      );
    }
    const { conflict, winner } = r;
    if (!Number.isInteger(conflict) || conflict < 0 || conflict >= conflicts.length) {
      outOfRange.push(conflict);
      continue;
    }
    if (byConflict.has(conflict)) duplicate.push(conflict);
    else byConflict.set(conflict, winner);
  }
  const missing = conflicts.map((_, i) => i).filter((i) => !byConflict.has(i));
  if (missing.length || duplicate.length || outOfRange.length) {
    throw new ResolutionError(
      422,
      'INCOMPLETE_RESOLUTION',
      'resolutions must cover every conflict exactly once',
      {
        conflictCount: conflicts.length,
        provided: resolutions.length,
        missing,
        duplicate,
        outOfRange,
      },
    );
  }

  // For every original operation collect the conflict ordinals in which it
  // was asked to be retained (winner) and those in which it was dropped
  // (loser). The same operation participating with both roles is ambiguous.
  const retainedIn = new Map(); // "A#3" -> [conflict ordinals]
  const droppedIn = new Map();
  const touch = (map, key, i) => {
    const list = map.get(key);
    if (list) list.push(i);
    else map.set(key, [i]);
  };

  for (let i = 0; i < conflicts.length; i++) {
    const winnerSide = byConflict.get(i);
    for (const op of conflicts[i].operations) {
      const key = `${op.side}#${op.index}`;
      touch(op.side === winnerSide ? retainedIn : droppedIn, key, i);
    }
  }

  const contradictions = [];
  for (const [key, droppedAt] of droppedIn) {
    const retainedAt = retainedIn.get(key);
    if (retainedAt) {
      const [side, indexText] = key.split('#');
      const index = Number(indexText);
      contradictions.push({
        side,
        index,
        retainedIn: retainedAt,
        droppedIn: droppedAt,
      });
    }
  }
  contradictions.sort(
    (x, y) => x.side.localeCompare(y.side) || x.index - y.index,
  );
  if (contradictions.length) {
    throw new ResolutionError(
      422,
      'CONTRADICTORY_RESOLUTION',
      'the same original operation is retained in one conflict and dropped in another',
      { conflicts: contradictions },
    );
  }

  const droppedKeys = new Set(droppedIn.keys());
  const filteredA = record.patchA.filter((_, i) => !droppedKeys.has(`A#${i}`));
  const filteredB = record.patchB.filter((_, i) => !droppedKeys.has(`B#${i}`));

  const result = mergePatches(record.base, filteredA, filteredB);

  const sortEntries = (x, y) =>
    x.side.localeCompare(y.side) || x.index - y.index;

  const retained = [];
  for (const [key, ordinals] of retainedIn) {
    const [side, indexText] = key.split('#');
    const index = Number(indexText);
    const ref = conflicts[ordinals[0]].operations.find(
      (o) => o.side === side && o.index === index,
    );
    retained.push(opRefOf(ref, ordinals));
  }
  retained.sort(sortEntries);

  const dropped = [];
  for (const [key, ordinals] of droppedIn) {
    const [side, indexText] = key.split('#');
    const index = Number(indexText);
    const ref = conflicts[ordinals[0]].operations.find(
      (o) => o.side === side && o.index === index,
    );
    dropped.push(opRefOf(ref, ordinals));
  }
  dropped.sort(sortEntries);

  return {
    status: result.status,
    merged: result.merged,
    conflicts: result.conflicts,
    retained,
    dropped,
    stats: result.stats,
  };
}
