import assert from 'node:assert/strict';
import test from 'node:test';
import { matchSampleInstitutions } from '../src/domain/sampleMatcher.ts';

const institutions = [{
  id: 'sample',
  institution: 'Sample institution',
  program: 'Sample program',
  home_state: 'Maharashtra',
  exam: 'JEE Main',
  cutoffs: {
    General: { home_state: 90, other_state: 95 },
    SC: { home_state: 75, other_state: 80 },
  },
  source: 'Synthetic sample',
}];

test('uses the selected category and home-state quota cutoff', () => {
  const [match] = matchSampleInstitutions(
    { exam_scores: { 'JEE Main': 96 } },
    institutions,
    { category: 'General', domicile: 'Maharashtra' },
  );
  assert.equal(match.quota, 'home_state');
  assert.equal(match.cutoff, 90);
  assert.equal(match.band, 'safe');
});

test('uses the other-state quota and reports a target comparison', () => {
  const [match] = matchSampleInstitutions(
    { exam_scores: { 'JEE Main': 93 } },
    institutions,
    { category: 'General', domicile: 'Kerala' },
  );
  assert.equal(match.quota, 'other_state');
  assert.equal(match.cutoff, 95);
  assert.equal(match.band, 'target');
});

test('returns insufficient data instead of assuming category, quota, or score', () => {
  const missingCategory = matchSampleInstitutions(
    { exam_scores: { 'JEE Main': 100 } },
    institutions,
    { domicile: 'Maharashtra' },
  )[0];
  const missingDomicile = matchSampleInstitutions(
    { exam_scores: { 'JEE Main': 100 } },
    institutions,
    { category: 'General' },
  )[0];
  const missingScore = matchSampleInstitutions(
    {},
    institutions,
    { category: 'General', domicile: 'Maharashtra' },
  )[0];
  assert.equal(missingCategory.band, 'insufficient_data');
  assert.equal(missingDomicile.band, 'insufficient_data');
  assert.equal(missingScore.band, 'insufficient_data');
});
