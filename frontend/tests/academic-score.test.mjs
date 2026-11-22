import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatINR,
  normalizeAcademicScore,
} from '../src/domain/academicScore.ts';

test('normalizes percentage and leaves empty values unset', () => {
  assert.equal(normalizeAcademicScore('82.5', 'percentage'), 82.5);
  assert.equal(normalizeAcademicScore('', 'percentage'), null);
});

test('normalizes 10-point CGPA with a configurable multiplier', () => {
  assert.equal(normalizeAcademicScore(8, 'cgpa10'), 76);
  assert.equal(normalizeAcademicScore('8.5', 'cgpa10', { cgpaMultiplier: 10 }), 85);
});

test('uses an explicitly configurable illustrative letter-grade map', () => {
  assert.equal(normalizeAcademicScore('a+', 'letter'), 96);
  assert.equal(
    normalizeAcademicScore('A', 'letter', { letterGradePercentages: { A: 88 } }),
    88,
  );
});

test('rejects invalid scales and unsafe conversions', () => {
  assert.throws(() => normalizeAcademicScore(101, 'percentage'), RangeError);
  assert.throws(() => normalizeAcademicScore(10.1, 'cgpa10'), RangeError);
  assert.throws(() => normalizeAcademicScore('Z', 'letter'), RangeError);
  assert.throws(() => normalizeAcademicScore(10, 'cgpa10', { cgpaMultiplier: 10.1 }), RangeError);
});

test('formats non-negative amounts in Indian rupees', () => {
  assert.equal(formatINR(250000), '₹2,50,000');
  assert.throws(() => formatINR(-1), RangeError);
});
