import assert from 'node:assert/strict';
import test from 'node:test';
import { runGaleShapley } from '../src/domain/stableMatching.ts';

test('finds a stable capacity-constrained matching after a displacement', () => {
  const result = runGaleShapley(
    [
      { id: 'student-a', preferences: ['program-x', 'program-y'] },
      { id: 'student-b', preferences: ['program-x', 'program-y'] },
    ],
    [
      { id: 'program-x', capacity: 1, priority: ['student-b', 'student-a'] },
      { id: 'program-y', capacity: 1, priority: ['student-a', 'student-b'] },
    ],
  );
  assert.deepEqual(result.assignments, [
    { studentId: 'student-a', programId: 'program-y' },
    { studentId: 'student-b', programId: 'program-x' },
  ]);
  assert.ok(result.auditTrail.some((event) => event.action === 'displaced'));
  assert.deepEqual(result.auditTrail.map((event) => event.step), result.auditTrail.map((_, index) => index + 1));
});

test('leaves students unmatched when they have no acceptable available program', () => {
  const result = runGaleShapley(
    [{ id: 'student-a', preferences: ['missing-program'] }],
    [],
  );
  assert.deepEqual(result.assignments, [{ studentId: 'student-a', programId: null }]);
  assert.ok(result.auditTrail.some((event) => event.action === 'rejected'));
  assert.ok(result.auditTrail.some((event) => event.action === 'unmatched'));
});

test('rejects duplicate preferences and invalid capacities', () => {
  assert.throws(
    () => runGaleShapley(
      [{ id: 'student-a', preferences: ['program-x', 'program-x'] }],
      [{ id: 'program-x', capacity: 1, priority: [] }],
    ),
    /duplicate preferences/,
  );
  assert.throws(
    () => runGaleShapley(
      [{ id: 'student-a', preferences: ['program-x'] }],
      [{ id: 'program-x', capacity: -1, priority: [] }],
    ),
    RangeError,
  );
});
