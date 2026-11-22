export type ReservationCategory = 'General' | 'EWS' | 'OBC-NCL' | 'SC' | 'ST';
export type CutoffQuota = 'home_state' | 'other_state';
export type MatchBand = 'safe' | 'target' | 'reach' | 'insufficient_data';

export type SampleCutoffInstitution = {
  id: string;
  institution: string;
  program: string;
  home_state: string;
  exam: string;
  cutoffs: Partial<Record<ReservationCategory, Partial<Record<CutoffQuota, number>>>>;
  source: string;
};

export type SampleMatchProfile = {
  reservation_category?: string | null;
  domicile?: string | null;
  exam_scores?: Record<string, number>;
};

export type SampleMatchResult = {
  institution: SampleCutoffInstitution;
  category: ReservationCategory | null;
  quota: CutoffQuota | null;
  student_score: number | null;
  cutoff: number | null;
  band: MatchBand;
  reason: string;
};

export function matchSampleInstitutions(
  profile: SampleMatchProfile,
  institutions: SampleCutoffInstitution[],
  selection: { category?: string; domicile?: string },
): SampleMatchResult[] {
  const category = selection.category as ReservationCategory | undefined;
  const recognizedCategory = ['General', 'EWS', 'OBC-NCL', 'SC', 'ST'].includes(category ?? '')
    ? category as ReservationCategory
    : null;
  const domicile = selection.domicile?.trim() || null;

  return institutions.map((institution) => {
    if (!recognizedCategory) {
      return {
        institution,
        category: null,
        quota: null,
        student_score: null,
        cutoff: null,
        band: 'insufficient_data',
        reason: 'Select a reservation category to view the corresponding illustrative sample.',
      };
    }
    if (!domicile) {
      return {
        institution,
        category: recognizedCategory,
        quota: null,
        student_score: null,
        cutoff: null,
        band: 'insufficient_data',
        reason: 'Select a domicile state to determine the sample home-state or other-state quota.',
      };
    }

    const quota: CutoffQuota = domicile.toLocaleLowerCase() === institution.home_state.toLocaleLowerCase()
      ? 'home_state'
      : 'other_state';
    const examScore = Object.entries(profile.exam_scores ?? {}).find(
      ([exam]) => exam.toLocaleLowerCase() === institution.exam.toLocaleLowerCase(),
    )?.[1];
    const cutoff = institution.cutoffs[recognizedCategory]?.[quota];

    if (typeof examScore !== 'number' || !Number.isFinite(examScore) || examScore < 0 || examScore > 100) {
      return {
        institution,
        category: recognizedCategory,
        quota,
        student_score: null,
        cutoff: cutoff ?? null,
        band: 'insufficient_data',
        reason: `Add a ${institution.exam} score or percentile from 0 to 100 to compare with this sample.`,
      };
    }
    if (typeof cutoff !== 'number' || !Number.isFinite(cutoff)) {
      return {
        institution,
        category: recognizedCategory,
        quota,
        student_score: examScore,
        cutoff: null,
        band: 'insufficient_data',
        reason: 'No illustrative cutoff is available for this category and quota.',
      };
    }

    const band: MatchBand = examScore >= cutoff + 5
      ? 'safe'
      : examScore >= cutoff - 5
        ? 'target'
        : 'reach';
    const distance = Math.round((examScore - cutoff) * 100) / 100;
    const comparison = distance >= 0
      ? `${distance} points above`
      : `${Math.abs(distance)} points below`;
    return {
      institution,
      category: recognizedCategory,
      quota,
      student_score: examScore,
      cutoff,
      band,
      reason: `The entered ${institution.exam} score is ${comparison} the illustrative ${recognizedCategory} ${quota.replace('_', '-')} sample cutoff. This comparison is not an eligibility decision or admission prediction.`,
    };
  });
}
