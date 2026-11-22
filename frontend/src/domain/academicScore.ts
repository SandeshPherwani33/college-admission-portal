export type AcademicScoreScale = 'percentage' | 'cgpa10' | 'letter';

export const DEFAULT_CGPA_MULTIPLIER = 9.5;

export const SAMPLE_LETTER_GRADE_PERCENTAGES: Readonly<Record<string, number>> = {
  'A+': 96,
  A: 90,
  'B+': 85,
  B: 80,
  'C+': 75,
  C: 70,
  D: 60,
  F: 0,
};

type NormalizationOptions = {
  cgpaMultiplier?: number;
  letterGradePercentages?: Readonly<Record<string, number>>;
};

export function normalizeAcademicScore(
  value: string | number,
  scale: AcademicScoreScale,
  options: NormalizationOptions = {},
): number | null {
  if (typeof value === 'string' && !value.trim()) return null;

  if (scale === 'letter') {
    const grade = String(value).trim().toUpperCase();
    const gradeMap = options.letterGradePercentages ?? SAMPLE_LETTER_GRADE_PERCENTAGES;
    const percentage = gradeMap[grade];
    if (percentage === undefined || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      throw new RangeError(`Letter grade "${grade}" has no valid percentage mapping.`);
    }
    return percentage;
  }

  const score = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(score)) throw new RangeError('Enter a valid numeric academic score.');

  if (scale === 'percentage') {
    if (score < 0 || score > 100) throw new RangeError('Percentage must be between 0 and 100.');
    return score;
  }

  const multiplier = options.cgpaMultiplier ?? DEFAULT_CGPA_MULTIPLIER;
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new RangeError('The CGPA multiplier must be a positive finite number.');
  }
  if (score < 0 || score > 10) throw new RangeError('CGPA must be between 0 and 10.');
  const percentage = score * multiplier;
  if (percentage > 100) throw new RangeError('The configured multiplier produces a percentage above 100.');
  return Math.round(percentage * 100) / 100;
}

export function formatINR(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new RangeError('Amount must be a finite non-negative number.');
  }
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount);
}
