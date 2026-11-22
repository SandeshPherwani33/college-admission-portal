import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { ApiError, apiRequest, apiUpload } from './services/api';
import { appLanguages, AppLanguage, translate } from './i18n';
import {
  DEFAULT_CGPA_MULTIPLIER,
  formatINR,
  normalizeAcademicScore,
  SAMPLE_LETTER_GRADE_PERCENTAGES,
} from './domain/academicScore';
import type { AcademicScoreScale } from './domain/academicScore';
import { runGaleShapley } from './domain/stableMatching';
import type { StableMatchingResult } from './domain/stableMatching';
import { CollegeCutoffLookup, MhtcetRecommendations, NationalExamCutoffLookup } from './components/MhtcetRecommendations';
import ApplicationsPanel from './components/ApplicationsPanel';
import ExploreApplyPage from './components/ExploreApplyPage';
import UniversityPortal from './components/UniversityPortal';
import AICollegePredictor from './components/AICollegePredictor';
import AdmissionChatWidget from './components/AdmissionChatWidget';
import type {
  AIStatus,
  AcademicDocumentFields,
  AdmissionDocumentType,
  ApplicationRecord,
  AllocationResult,
  DocumentRecord,
  InterviewSession,
  Profile,
  ProfileIntakeResponse,
  Recommendation,
} from './types';

const emptyProfileForm = {
  full_name: '',
  location: '',
  stream: '',
  board: '',
  academic_score: '',
  admission_year: '',
  budget: '',
  career_goal: '',
  reservation_category: '',
  domicile: '',
};

const EXAM_SCORE_FIELDS = ['JEE Main', 'NEET', 'CUET'] as const;
const emptyExamScoreDraft: Record<(typeof EXAM_SCORE_FIELDS)[number], string> = {
  'JEE Main': '',
  NEET: '',
  CUET: '',
};
const MAX_STUDENT_PREFERENCES = 10;
const MAX_ALLOCATION_HISTORY = 20;

const documentLabels: Record<AdmissionDocumentType, string> = {
  academic_marksheet: 'Academic marksheet',
  school_leaving_certificate: 'School leaving certificate',
  identity_proof: 'Identity proof',
  entrance_scorecard: 'Entrance scorecard',
  category_certificate: 'Category certificate',
  other: 'Other document',
};

const stableMatchingDemoStudents = [
  { id: 'sample-student-a', preferences: ['sample-program-x', 'sample-program-y'] },
  { id: 'sample-student-b', preferences: ['sample-program-x', 'sample-program-z'] },
  { id: 'sample-student-c', preferences: ['sample-program-y', 'sample-program-x'] },
  { id: 'sample-student-d', preferences: ['sample-program-y', 'sample-program-z'] },
];

const stableMatchingDemoPrograms = [
  { id: 'sample-program-x', capacity: 1, priority: ['sample-student-b', 'sample-student-a', 'sample-student-c'] },
  { id: 'sample-program-y', capacity: 1, priority: ['sample-student-c', 'sample-student-d', 'sample-student-a'] },
  { id: 'sample-program-z', capacity: 1, priority: ['sample-student-d', 'sample-student-b'] },
];

const stableMatchingDemoLabels: Record<string, string> = {
  'sample-program-x': 'Sample program X',
  'sample-program-y': 'Sample program Y',
  'sample-program-z': 'Sample program Z',
};

const allocationExamAliases: Record<string, string[]> = {
  JEE: ['jee', 'joint entrance'],
  NEET: ['neet'],
  CUET: ['cuet'],
  'MHT-CET': ['mht-cet', 'mhtcet'],
};

const interviewTracks = [
  {
    id: 'general',
    label: 'General admissions',
    interviewType: 'general',
    questions: [
      'What learning goal matters most to you in your chosen program?',
      'Describe a project or experience that shaped your interests.',
    ],
  },
  {
    id: 'btech-logic',
    label: 'B.Tech logic',
    interviewType: 'technical',
    questions: [
      'How would you break a complex problem into smaller, testable steps?',
      'Describe how you would find the cause of an unexpected result in a simple program.',
    ],
  },
  {
    id: 'bba-case',
    label: 'BBA case study',
    interviewType: 'admissions',
    questions: [
      'A campus service has fewer returning users. What information would you gather before suggesting a change?',
      'How would you compare two possible improvements with a limited budget?',
    ],
  },
  {
    id: 'behavioral',
    label: 'Behavioral reflection',
    interviewType: 'behavioral',
    questions: [
      'Describe a time you adapted your approach after receiving useful feedback.',
      'How do you organize a group task when people have different perspectives?',
    ],
  },
  {
    id: 'data-science',
    label: 'Data Science technical',
    interviewType: 'technical',
    questions: [
      'How would you approach a dataset with missing values before drawing a conclusion?',
      'Explain how you would check whether a model is performing consistently on new data.',
    ],
  },
] as const;

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};

const indianStates = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa',
  'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland',
  'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands',
  'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir',
  'Ladakh', 'Lakshadweep', 'Puducherry',
];

type SubjectScoreRow = { id: string; subject: string; score: string };
type AllocationHistoryEntry = { result: AllocationResult; preferences: string[] };
type AllocationHistoryIndexEntry = { run_id: string; preferences: string[] };

function isAllocationHistoryIndex(value: unknown): value is AllocationHistoryIndexEntry[] {
  return Array.isArray(value)
    && value.length <= MAX_ALLOCATION_HISTORY
    && value.every((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const candidate = entry as Record<string, unknown>;
      return typeof candidate.run_id === 'string'
        && /^allocation-[a-f0-9]{32}$/.test(candidate.run_id)
        && Array.isArray(candidate.preferences)
        && candidate.preferences.length <= MAX_STUDENT_PREFERENCES
        && candidate.preferences.every((programId) => typeof programId === 'string');
    });
}
type ProfileDraft = {
  form: typeof emptyProfileForm;
  subjectScores: SubjectScoreRow[];
  examScores?: Record<string, string>;
  academicScoreInput?: string;
  academicScoreScale?: AcademicScoreScale;
};
type GuidedProfile = {
  academic_background: string;
  stream: string;
  board: string;
  academic_score: string;
  budget: string;
  career_goal: string;
  interests: string;
  preferred_courses: string;
};

const emptyGuidedProfile: GuidedProfile = {
  academic_background: '',
  stream: '',
  board: '',
  academic_score: '',
  budget: '',
  career_goal: '',
  interests: '',
  preferred_courses: '',
};

function isProfileDraft(value: unknown): value is ProfileDraft {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (!candidate.form || typeof candidate.form !== 'object' || !Array.isArray(candidate.subjectScores)) return false;
  const form = candidate.form as Record<string, unknown>;
  return Object.keys(emptyProfileForm).every((key) => typeof form[key] === 'string')
    && (candidate.examScores === undefined || (
      Boolean(candidate.examScores)
      && typeof candidate.examScores === 'object'
      && EXAM_SCORE_FIELDS.every((exam) => typeof (candidate.examScores as Record<string, unknown>)[exam] === 'string')
    ))
    && (candidate.academicScoreInput === undefined || typeof candidate.academicScoreInput === 'string')
    && (candidate.academicScoreScale === undefined || ['percentage', 'cgpa10', 'letter'].includes(String(candidate.academicScoreScale)))
    && candidate.subjectScores.every((row) => (
      Boolean(row)
      && typeof row === 'object'
      && typeof (row as Record<string, unknown>).id === 'string'
      && typeof (row as Record<string, unknown>).subject === 'string'
      && typeof (row as Record<string, unknown>).score === 'string'
    ));
}

function parseExamScores(scores: Record<string, string>): Record<string, number> {
  return Object.fromEntries(EXAM_SCORE_FIELDS.flatMap((exam) => {
    const rawScore = scores[exam]?.trim();
    if (!rawScore) return [];
    const score = Number(rawScore);
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw new Error(`${exam} score or percentile must be between 0 and 100.`);
    }
    return [[exam, score]];
  }));
}

function toExamScoreDraft(scores: Record<string, number> = {}): Record<string, string> {
  return Object.fromEntries(EXAM_SCORE_FIELDS.map((exam) => {
    const savedScore = Object.entries(scores).find(
      ([savedExam]) => savedExam.toLocaleLowerCase() === exam.toLocaleLowerCase(),
    )?.[1];
    return [exam, savedScore === undefined ? '' : String(savedScore)];
  }));
}

function getAllocationPreferenceIds(value: string): string[] {
  return value.split(/[\n,]/).map((programId) => programId.trim()).filter(Boolean);
}

function parseSubjectScores(rows: SubjectScoreRow[]): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const row of rows) {
    if (!row.subject.trim() && !row.score.trim()) continue;
    const subject = row.subject.trim();
    const score = Number(row.score);
    if (!subject || !row.score.trim() || !Number.isFinite(score) || score < 0 || score > 100) {
      throw new Error('Enter both a subject and a score from 0 to 100 for each row.');
    }
    if (Object.keys(scores).some((item) => item.toLowerCase() === subject.toLowerCase())) {
      throw new Error(`Subject "${subject}" is listed more than once.`);
    }
    scores[subject] = score;
  }
  return scores;
}

function Icon({ name, size = 20 }: { name: 'grid' | 'user' | 'document' | 'eligibility' | 'interview' | 'allocation' | 'privacy' | 'sparkles' | 'menu' | 'close' | 'bell' | 'chevron'; size?: number }) {
  const paths: Record<typeof name, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c.8-4.2 3.5-6.3 8-6.3S19.2 16.8 20 21" /></>,
    document: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></>,
    eligibility: <><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.2 2.2 4.8-5" /></>,
    interview: <><path d="M4 5h16v11H9l-5 4z" /><path d="M8 9h8M8 12h5" /></>,
    allocation: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
    privacy: <><path d="M12 3 20 6v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6z" /><path d="m9 12 2 2 4-4" /></>,
    sparkles: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" /></>,
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    bell: <><path d="M18 16H6l1.5-2V9a4.5 4.5 0 0 1 9 0v5z" /><path d="M10 19h4" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem('uniapply-token'));
  const [currentUser, setCurrentUser] = useState<{ id: string; email: string; full_name: string; role: 'student' | 'university'; institution_id?: string | null } | null>(null);
  const [auth, setAuth] = useState({ email: '', password: '' });
  const [registrationName, setRegistrationName] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [eligibilitySearch, setEligibilitySearch] = useState('');
  const [eligibilityCourseSearch, setEligibilityCourseSearch] = useState('');
  const [eligibilityLocationSearch, setEligibilityLocationSearch] = useState('');
  const [eligibilityStatusFilter, setEligibilityStatusFilter] = useState('all');
  const [appliedEligibilityFilters, setAppliedEligibilityFilters] = useState({
    institution: '',
    course: '',
    location: '',
    status: 'all',
  });
  const [eligibilityRefreshLoading, setEligibilityRefreshLoading] = useState(false);
  const [eligibilityRefreshError, setEligibilityRefreshError] = useState<string | null>(null);
  const [eligibilityRefreshSuccess, setEligibilityRefreshSuccess] = useState<string | null>(null);
  const [selectedEligibilityProgram, setSelectedEligibilityProgram] = useState<Recommendation | null>(null);
  const [interview, setInterview] = useState<InterviewSession | null>(null);
  const [interviewHistory, setInterviewHistory] = useState<InterviewSession[]>([]);
  const [interviewProgram, setInterviewProgram] = useState('');
  const [interviewType, setInterviewType] = useState<InterviewSession['interview_type']>('general');
  const [interviewTrack, setInterviewTrack] = useState<string>('general');
  const [interviewQuestionCount, setInterviewQuestionCount] = useState(5);
  const [interviewAnswer, setInterviewAnswer] = useState('');
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [cameraLoading, setCameraLoading] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [interviewSpeaking, setInterviewSpeaking] = useState(false);
  const [questionSecondsRemaining, setQuestionSecondsRemaining] = useState(90);
  const [voiceListening, setVoiceListening] = useState(false);
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraRequestIdRef = useRef(0);
  const cameraPreviewRef = useRef<HTMLVideoElement | null>(null);
  const lastSpokenQuestionRef = useRef<string | null>(null);
  const [interviewLoading, setInterviewLoading] = useState(false);
  const [interviewError, setInterviewError] = useState<string | null>(null);
  const [allocation, setAllocation] = useState<AllocationResult | null>(null);
  const [allocationPreferences, setAllocationPreferences] = useState('');
  const [allocationPreferenceError, setAllocationPreferenceError] = useState<string | null>(null);
  const [draggedPreferenceId, setDraggedPreferenceId] = useState<string | null>(null);
  const [selectedAllocationProgramId, setSelectedAllocationProgramId] = useState('');
  const [allocationExam, setAllocationExam] = useState('JEE');
  const [allocationCategoryOverride, setAllocationCategoryOverride] = useState('');
  const [allocationLoading, setAllocationLoading] = useState(false);
  const [allocationError, setAllocationError] = useState<string | null>(null);
  const [allocationHistory, setAllocationHistory] = useState<AllocationHistoryEntry[]>([]);
  const [allocationHistoryLoading, setAllocationHistoryLoading] = useState(false);
  const [allocationHistoryError, setAllocationHistoryError] = useState<string | null>(null);
  const [stableMatchingDemo, setStableMatchingDemo] = useState<StableMatchingResult | null>(null);
  const [privacyAcknowledged, setPrivacyAcknowledged] = useState(false);
  const [privacyExportLoading, setPrivacyExportLoading] = useState(false);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [deleteConfirmationText, setDeleteConfirmationText] = useState('');
  const [subjectScoreRows, setSubjectScoreRows] = useState<SubjectScoreRow[]>([]);
  const [examScoreDraft, setExamScoreDraft] = useState<Record<string, string>>(emptyExamScoreDraft);
  const [academicScoreInput, setAcademicScoreInput] = useState('');
  const [academicScoreScale, setAcademicScoreScale] = useState<AcademicScoreScale>('percentage');
  const [profileFormReady, setProfileFormReady] = useState(false);
  const [savedProfileSnapshot, setSavedProfileSnapshot] = useState('');
  const [profileValidationError, setProfileValidationError] = useState<string | null>(null);
  const [profileDraftRestored, setProfileDraftRestored] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [uploadDocumentType, setUploadDocumentType] = useState<AdmissionDocumentType>('academic_marksheet');
  const [selectedDocument, setSelectedDocument] = useState<DocumentRecord | null>(null);
  const [documentDraft, setDocumentDraft] = useState<AcademicDocumentFields | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedFilePreviewUrl, setSelectedFilePreviewUrl] = useState<string | null>(null);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [aiStatus, setAIStatus] = useState<AIStatus | null>(null);
  const [intakeDescription, setIntakeDescription] = useState('');
  const [intakeResult, setIntakeResult] = useState<ProfileIntakeResponse | null>(null);
  const [reviewedProfile, setReviewedProfile] = useState<ProfileIntakeResponse['profile'] | null>(null);
  const [intakeApplied, setIntakeApplied] = useState(false);
  const [intakeError, setIntakeError] = useState<string | null>(null);
  const [intakeProviderUnavailable, setIntakeProviderUnavailable] = useState(false);
  const [profileForm, setProfileForm] = useState(emptyProfileForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [systemStatusOpen, setSystemStatusOpen] = useState(false);
  const [language, setLanguage] = useState<AppLanguage>('en');
  const [initialDataReady, setInitialDataReady] = useState(false);
  const [guidedStep, setGuidedStep] = useState(0);
  const [guidedProfile, setGuidedProfile] = useState(emptyGuidedProfile);
  const [guidedReviewActive, setGuidedReviewActive] = useState(false);
  const [activePage, setActivePage] = useState(() => (
    window.location.hash.replace(/^#/, '') || 'dashboard'
  ));
  const [aiChatOpen, setAIChatOpen] = useState(false);
  const [aiChatCollegeContext, setAIChatCollegeContext] = useState<string | null>(null);
  const profileDraftSnapshot = JSON.stringify({
    form: profileForm,
    subjectScores: subjectScoreRows,
    examScores: examScoreDraft,
    academicScoreInput,
    academicScoreScale,
  });
  const hasUnsavedProfileChanges = Boolean(profile && profileFormReady && profileDraftSnapshot !== savedProfileSnapshot);
  const institutionSuppliedRecommendations = recommendations.filter(
    (item) => item.criteria_status === 'verified',
  );
  const allocationEligiblePrograms = institutionSuppliedRecommendations
    .filter((item) => item.eligibility_status === 'eligible')
    .filter((item, index, all) => all.findIndex((candidate) => candidate.program_id === item.program_id) === index);
  const filteredInstitutionRecommendations = institutionSuppliedRecommendations.filter((program) => {
    const matches = (value: string, query: string) => !query
      || value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    const status = appliedEligibilityFilters.status;
    const matchesStatus = status === 'all'
      || (status === 'eligible' && program.eligibility_status === 'eligible')
      || (status === 'ineligible' && program.eligibility_status === 'ineligible')
      || (status === 'needs_information' && ['insufficient_data', 'criteria_unavailable'].includes(program.eligibility_status));
    return matches(program.institution, appliedEligibilityFilters.institution)
      && matches(`${program.course} ${program.program}`, appliedEligibilityFilters.course)
      && matches(program.location ?? '', appliedEligibilityFilters.location)
      && matchesStatus;
  });
  const uniqueInstitutionRecommendations = filteredInstitutionRecommendations.filter((program, index, all) => all.findIndex((item) => (
    item.program_id === program.program_id && item.criteria_id === program.criteria_id
  )) === index);
  const personalizedEligibilityRecommendations = institutionSuppliedRecommendations
    .filter((program) => program.eligibility_status === 'eligible')
    .map((program) => {
      const preferredCourses = profile?.preferred_fields ?? [];
      const preferredCourseMatch = preferredCourses.some((course) => (
        `${program.course} ${program.program}`.toLocaleLowerCase().includes(course.toLocaleLowerCase())
        || course.toLocaleLowerCase().includes(program.course.toLocaleLowerCase())
      ));
      const preferredLocationMatch = Boolean(profile?.location && program.location
        && program.location.toLocaleLowerCase().includes(profile.location.toLocaleLowerCase()));
      const streamMatch = Boolean(profile?.stream && program.evaluated_criteria.some((item) => (
        /stream/i.test(`${item.criterion} ${item.requirement}`)
        && item.status === 'met'
      )));
      const examMatch = Boolean(program.criteria.examination_type && profile?.exam_scores
        && Object.keys(profile.exam_scores).some((exam) => (
          exam.toLocaleLowerCase().includes(program.criteria.examination_type?.toLocaleLowerCase() ?? '')
          || (program.criteria.examination_type?.toLocaleLowerCase() ?? '').includes(exam.toLocaleLowerCase())
        )));
      return {
        program,
        preferenceScore: Number(preferredCourseMatch) + Number(preferredLocationMatch) + Number(streamMatch) + Number(examMatch),
      };
    })
    .sort((left, right) => right.preferenceScore - left.preferenceScore)
    .map(({ program }) => program);
  const t = (key: string) => translate(language, key);
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    const handleHashChange = () => {
      setActivePage(window.location.hash.replace(/^#/, '') || 'dashboard');
      setMobileNavigationOpen(false);
      window.scrollTo({ top: 0, behavior: 'auto' });
    };
    window.addEventListener('hashchange', handleHashChange);
    handleHashChange();
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  useEffect(() => {
    const handleSessionExpired = () => {
      cameraRequestIdRef.current += 1;
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
      window.speechSynthesis?.cancel();
      setCameraEnabled(false);
      setCameraLoading(false);
      setVoiceListening(false);
      speechRecognitionRef.current?.stop();
      sessionStorage.removeItem('uniapply-token');
      setToken(null);
      setCurrentUser(null);
      setProfile(null);
      setDocuments([]);
      setRecommendations([]);
      setInterviewHistory([]);
      setAIStatus(null);
      setAIChatOpen(false);
      setAIChatCollegeContext(null);
      setError(null);
      setInitialDataReady(false);
    };
    window.addEventListener('uniapply:session-expired', handleSessionExpired);
    return () => window.removeEventListener('uniapply:session-expired', handleSessionExpired);
  }, []);

  const fetchDashboard = async (currentToken: string) => {
    const [
      profileResponse,
      documentsResponse,
      recommendationsResponse,
      aiStatusResponse,
      interviewResponse,
    ] = await Promise.all([
      apiRequest<Profile>('/profile', {
        headers: { Authorization: `Bearer ${currentToken}` },
      }),
      apiRequest<DocumentRecord[]>('/documents', {
        headers: { Authorization: `Bearer ${currentToken}` },
      }),
      apiRequest<Recommendation[]>('/eligibility', {
        headers: { Authorization: `Bearer ${currentToken}` },
      }),
      apiRequest<AIStatus>('/ai/status', {
        headers: { Authorization: `Bearer ${currentToken}` },
      }),
      apiRequest<InterviewSession[]>('/interviews', {
        headers: { Authorization: `Bearer ${currentToken}` },
      }),
    ]);

    setProfile(profileResponse);
    setDocuments(documentsResponse);
    setRecommendations(recommendationsResponse);
    setAIStatus(aiStatusResponse);
    setInterviewHistory(interviewResponse);
    setInterview(
      interviewResponse.find((item) => item.status === 'in_progress')
        ?? interviewResponse.find((item) => item.status === 'created')
        ?? null,
    );
    setInterviewProgram((current) => current || profileResponse.preferred_fields[0] || profileResponse.career_goal || '');
    const serverForm = {
      full_name: profileResponse.full_name ?? '',
      location: profileResponse.location ?? '',
      stream: profileResponse.stream ?? '',
      board: profileResponse.board ?? '',
      academic_score: profileResponse.academic_score == null
        ? ''
        : String(profileResponse.academic_score),
      admission_year: profileResponse.admission_year == null
        ? ''
        : String(profileResponse.admission_year),
      budget: profileResponse.budget == null ? '' : String(profileResponse.budget),
      career_goal: profileResponse.career_goal ?? '',
      reservation_category: profileResponse.reservation_category ?? '',
      domicile: profileResponse.domicile ?? '',
    };
    const serverSubjectScores = Object.entries(profileResponse.subject_scores ?? {}).map(
      ([subject, score], index) => ({ id: `subject-${index}`, subject, score: String(score) }),
    );
    const serverExamScores = Object.fromEntries(EXAM_SCORE_FIELDS.map((exam) => {
      const savedScore = Object.entries(profileResponse.exam_scores ?? {}).find(
        ([savedExam]) => savedExam.toLocaleLowerCase() === exam.toLocaleLowerCase(),
      )?.[1];
      return [exam, savedScore === undefined ? '' : String(savedScore)];
    }));
    const draftKey = `uniapply-profile-draft-${profileResponse.student_id}`;
    let restoredDraft: ProfileDraft | null = null;
    try {
      const savedDraft = sessionStorage.getItem(draftKey);
      if (savedDraft) {
        const parsed: unknown = JSON.parse(savedDraft);
        if (isProfileDraft(parsed)) restoredDraft = parsed;
      }
    } catch (draftError) {
      setError(draftError instanceof Error ? `Unable to restore the saved profile draft: ${draftError.message}` : 'Unable to restore the saved profile draft.');
    }
    const nextForm = restoredDraft?.form ?? serverForm;
    const nextSubjectScores = restoredDraft?.subjectScores ?? serverSubjectScores;
    const nextExamScores = restoredDraft?.examScores ?? serverExamScores;
    const nextAcademicScoreScale = restoredDraft?.academicScoreScale ?? 'percentage';
    const nextAcademicScoreInput = restoredDraft?.academicScoreInput
      ?? restoredDraft?.form.academic_score
      ?? serverForm.academic_score;
    setProfileForm(nextForm);
    setSubjectScoreRows(nextSubjectScores);
    setExamScoreDraft(nextExamScores);
    setAcademicScoreScale(nextAcademicScoreScale);
    setAcademicScoreInput(nextAcademicScoreInput);
    setSavedProfileSnapshot(JSON.stringify({
      form: nextForm,
      subjectScores: nextSubjectScores,
      examScores: nextExamScores,
      academicScoreInput: nextAcademicScoreInput,
      academicScoreScale: nextAcademicScoreScale,
    }));
    setProfileDraftRestored(Boolean(restoredDraft));
    setProfileFormReady(true);
  };

  useEffect(() => {
    if (!token) return;
    void (async () => {
      try {
        setLoading(true);
        const user = await apiRequest<{ id: string; email: string; full_name: string; role: 'student' | 'university'; institution_id: string | null }>(
          '/auth/me',
          { headers: { Authorization: `Bearer ${token}` } },
        );
        setCurrentUser(user);
        if (user.role === 'student') await fetchDashboard(token);
      } catch (loadError) {
        if (loadError instanceof ApiError && loadError.status === 401) {
          sessionStorage.removeItem('uniapply-token');
          setToken(null);
          setCurrentUser(null);
          setProfile(null);
          setRecommendations([]);
          setAIChatOpen(false);
          setAIChatCollegeContext(null);
          setDocuments([]);
          setInterviewHistory([]);
          setAIStatus(null);
          setError(null);
        } else {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load dashboard');
        }
      } finally {
        setLoading(false);
        setInitialDataReady(true);
      }
    })();
  }, [token]);

  useEffect(() => {
    if (!token || !profile?.student_id) {
      setAllocationHistory([]);
      setAllocationHistoryError(null);
      setAllocationHistoryLoading(false);
      setAllocation(null);
      setAllocationPreferences('');
      setSelectedAllocationProgramId('');
      setAllocationCategoryOverride('');
      setAllocationError(null);
      setAllocationPreferenceError(null);
      return;
    }

    let active = true;
    const storageKey = `uniapply-allocation-history-${profile.student_id}`;
    setAllocationHistory([]);
    setAllocationHistoryError(null);
    setAllocationHistoryLoading(true);
    setAllocation(null);
    setAllocationPreferences('');
    setSelectedAllocationProgramId('');
    setAllocationCategoryOverride('');
    setAllocationError(null);
    setAllocationPreferenceError(null);

    void (async () => {
      let savedRuns: unknown;
      try {
        const serializedRuns = localStorage.getItem(storageKey);
        if (!serializedRuns) return;
        savedRuns = JSON.parse(serializedRuns);
      } catch {
        if (active) setAllocationHistoryError('Could not read the saved run index from this browser.');
        return;
      }

      if (!isAllocationHistoryIndex(savedRuns)) {
        if (active) setAllocationHistoryError('The saved run index is invalid. New simulation runs can still be recorded.');
        return;
      }

      const entries: AllocationHistoryEntry[] = [];
      let unavailableRuns = 0;
      for (const savedRun of savedRuns) {
        try {
          const result = await apiRequest<AllocationResult>(
            `/allocation/runs/${encodeURIComponent(savedRun.run_id)}`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          entries.push({ result, preferences: savedRun.preferences });
        } catch {
          unavailableRuns += 1;
        }
      }

      if (active) {
        entries.sort((left, right) => right.result.created_at.localeCompare(left.result.created_at));
        setAllocationHistory(entries);
        if (entries[0]) {
          setAllocation(entries[0].result);
          setAllocationPreferences(entries[0].preferences.join('\n'));
        }
        if (unavailableRuns) {
          setAllocationHistoryError(
            `${unavailableRuns} saved run${unavailableRuns === 1 ? '' : 's'} could not be retrieved from the backend.`,
          );
        }
      }
    })().finally(() => {
      if (active) setAllocationHistoryLoading(false);
    });

    return () => {
      active = false;
    };
  }, [token, profile?.student_id]);

  useEffect(() => {
    if (!profile || !profileFormReady) return;
    const draftKey = `uniapply-profile-draft-${profile.student_id}`;
    if (!hasUnsavedProfileChanges) {
      sessionStorage.removeItem(draftKey);
      return;
    }
    const timer = window.setTimeout(() => {
      try {
        sessionStorage.setItem(draftKey, profileDraftSnapshot);
      } catch (draftError) {
        setProfileValidationError(
          draftError instanceof Error
            ? `Unable to autosave this draft: ${draftError.message}`
            : 'Unable to autosave this draft.',
        );
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [profile, profileFormReady, hasUnsavedProfileChanges, profileDraftSnapshot]);

  useEffect(() => {
    if (!hasUnsavedProfileChanges) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [hasUnsavedProfileChanges]);

  useEffect(() => {
    if (!toastMessage) return;
    const timer = window.setTimeout(() => setToastMessage(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toastMessage]);

  useEffect(() => {
    if (!selectedFile) {
      setSelectedFilePreviewUrl(null);
      return;
    }
    const previewUrl = URL.createObjectURL(selectedFile);
    setSelectedFilePreviewUrl(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [selectedFile]);

  const handleAuth = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setLoading(true);
      setError(null);
      const response = await apiRequest<{ token: string; user: { id: string; email: string; full_name: string; role: 'student' | 'university'; institution_id?: string | null } }>(
        isRegistering ? '/auth/register' : '/auth/login',
        {
        method: 'POST',
        body: JSON.stringify(isRegistering
          ? { full_name: registrationName, email: auth.email, password: auth.password, role: 'student' }
          : auth),
        },
      );
      sessionStorage.setItem('uniapply-token', response.token);
      setCurrentUser(response.user);
      setToken(response.token);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const openDigiLocker = () => {
    window.open(
      'https://www.digilocker.gov.in/',
      '_blank',
      'noopener,noreferrer',
    );
    setToastMessage('DigiLocker opened in a new tab. Sign in only on the official DigiLocker website.');
  };

  const clearStudentSession = () => {
    let sessionClearError: string | null = null;
    speechRecognitionRef.current?.stop();
    speechRecognitionRef.current = null;
    try {
      if (profile) sessionStorage.removeItem(`uniapply-profile-draft-${profile.student_id}`);
      sessionStorage.removeItem('uniapply-token');
    } catch (storageError) {
      sessionClearError = storageError instanceof Error
        ? `Unable to clear saved browser session data: ${storageError.message}`
        : 'Unable to clear saved browser session data.';
    }
    setToken(null);
    setCurrentUser(null);
    setProfile(null);
    setProfileForm(emptyProfileForm);
    setSubjectScoreRows([]);
    setExamScoreDraft(emptyExamScoreDraft);
    setAcademicScoreInput('');
    setAcademicScoreScale('percentage');
    setProfileFormReady(false);
    setSavedProfileSnapshot('');
    setProfileDraftRestored(false);
    setDocuments([]);
    setSelectedDocument(null);
    setDocumentDraft(null);
    setSelectedFile(null);
    setIntakeResult(null);
    setReviewedProfile(null);
    setIntakeApplied(false);
    setGuidedReviewActive(false);
    setGuidedProfile(emptyGuidedProfile);
    setInterview(null);
    setInterviewHistory([]);
    setInterviewAnswer('');
    setVoiceListening(false);
    setQuestionSecondsRemaining(90);
    setAllocation(null);
    setAllocationPreferences('');
    setAllocationPreferenceError(null);
    setDraggedPreferenceId(null);
    setStableMatchingDemo(null);
    setPrivacyAcknowledged(false);
    setRecommendations([]);
    setError(sessionClearError);
    setProfileValidationError(null);
    setIntakeError(null);
    setDocumentError(null);
    setInterviewError(null);
    setToastMessage(null);
    setInitialDataReady(false);
    setActivePage('dashboard');
    setAccountMenuOpen(false);
    window.location.hash = 'dashboard';
  };

  const handleSignOut = () => {
    if (hasUnsavedProfileChanges && !window.confirm('Your unsaved profile changes are saved only in this browser session. Signing out will clear that draft. Continue?')) return;
    clearStudentSession();
  };

  const handleDeleteAccount = async () => {
    if (!token) return;
    setDeleteConfirmationOpen(true);
    setDeleteConfirmationText('');
  };

  const confirmDeleteAccount = async () => {
    if (!token || deleteConfirmationText !== 'DELETE') return;
    try {
      setLoading(true);
      setError(null);
      await apiRequest<{ status: string }>('/profile', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      setDeleteConfirmationOpen(false);
      clearStudentSession();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete account');
    } finally {
      setLoading(false);
    }
  };

  const handleProfileIntake = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    try {
      setLoading(true);
      setIntakeError(null);
      setIntakeProviderUnavailable(false);
      setIntakeResult(null);
      setReviewedProfile(null);
      setIntakeApplied(false);
      const result = await apiRequest<ProfileIntakeResponse>('/profile/intake', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ description: intakeDescription }),
      });
      setIntakeResult(result);
      setReviewedProfile(result.profile);
      setGuidedReviewActive(false);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Profile extraction failed';
      setIntakeError(message);
      if (/ollama is unavailable|loopback ollama/i.test(message)) setIntakeProviderUnavailable(true);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmIntake = async () => {
    if (!token || !profile || !reviewedProfile) return;
    const extracted = reviewedProfile;
    if (extracted.academic_score !== null && (
      !Number.isFinite(extracted.academic_score)
      || extracted.academic_score < 0
      || extracted.academic_score > 100
    )) {
      setIntakeError('Academic percentage must be between 0 and 100.');
      return;
    }
    if (extracted.budget !== null && (!Number.isFinite(extracted.budget) || extracted.budget < 0)) {
      setIntakeError('Enter a valid non-negative annual budget in INR.');
      return;
    }
    if (Object.entries(extracted.exam_scores).some(([, score]) => (
      !Number.isFinite(score) || score < 0 || score > 100
    ))) {
      setIntakeError('Exam score or percentile values must be between 0 and 100.');
      return;
    }
    const updates: Record<string, unknown> = {};
    if (extracted.stream) updates.stream = extracted.stream;
    if (extracted.board) updates.board = extracted.board;
    if (extracted.academic_score !== null) updates.academic_score = extracted.academic_score;
    if (Object.keys(extracted.exam_scores).length) updates.exam_scores = extracted.exam_scores;
    if (extracted.budget !== null) updates.budget = extracted.budget;
    if (extracted.career_goal) updates.career_goal = extracted.career_goal;
    if (extracted.interests.length) updates.interests = extracted.interests;
    if (extracted.preferred_courses.length) updates.preferred_fields = extracted.preferred_courses;
    if (extracted.academic_background) {
      const notes = [...profile.notes];
      if (!notes.includes(extracted.academic_background)) notes.push(extracted.academic_background);
      updates.notes = notes;
    }
    if (!Object.keys(updates).length) {
      setIntakeError('No profile fields were extracted to save. Review the clarification questions and add more detail.');
      return;
    }
    try {
      setLoading(true);
      setIntakeError(null);
      const updated = await apiRequest<Profile>('/profile', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(updates),
      });
      setProfile(updated);
      const updatedForm = {
        ...profileForm,
        stream: updated.stream ?? '',
        board: updated.board ?? '',
        academic_score: String(updated.academic_score ?? ''),
        budget: String(updated.budget ?? ''),
        career_goal: updated.career_goal ?? '',
      };
      const updatedExamScores = toExamScoreDraft(updated.exam_scores);
      setProfileForm(updatedForm);
      setExamScoreDraft(updatedExamScores);
      setAcademicScoreScale('percentage');
      setAcademicScoreInput(updatedForm.academic_score);
      setSavedProfileSnapshot(JSON.stringify({
        form: updatedForm,
        subjectScores: subjectScoreRows,
        examScores: updatedExamScores,
        academicScoreInput: updatedForm.academic_score,
        academicScoreScale: 'percentage',
      }));
      setProfileFormReady(true);
      setIntakeApplied(true);
      setGuidedReviewActive(false);
      setToastMessage('Reviewed profile fields saved.');
    } catch (saveError) {
      setIntakeError(saveError instanceof Error ? saveError.message : 'Unable to save reviewed profile fields');
    } finally {
      setLoading(false);
    }
  };

  const handleAcademicScoreInput = (value: string) => {
    setAcademicScoreInput(value);
    try {
      const normalized = normalizeAcademicScore(value, academicScoreScale);
      setProfileForm((current) => ({
        ...current,
        academic_score: normalized === null ? '' : String(normalized),
      }));
      setProfileValidationError(null);
    } catch (scoreError) {
      setProfileForm((current) => ({ ...current, academic_score: '' }));
      setProfileValidationError(scoreError instanceof Error ? scoreError.message : 'Unable to normalize the academic score.');
    }
  };

  const handleAcademicScoreScaleChange = (scale: AcademicScoreScale) => {
    setAcademicScoreScale(scale);
    setAcademicScoreInput('');
    setProfileForm((current) => ({ ...current, academic_score: '' }));
    setProfileValidationError(null);
  };

  const handleReviewedExamScore = (exam: string, value: string) => {
    if (!reviewedProfile) return;
    const examScores = { ...reviewedProfile.exam_scores };
    if (!value.trim()) {
      delete examScores[exam];
    } else {
      examScores[exam] = Number(value);
    }
    setReviewedProfile({ ...reviewedProfile, exam_scores: examScores });
  };

  const handleProfileUpdate = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    try {
      if (!profileForm.full_name.trim()) {
        setProfileValidationError('Enter your full name before saving.');
        return;
      }
      const normalizedAcademicScore = normalizeAcademicScore(academicScoreInput, academicScoreScale);
      setLoading(true);
      setProfileValidationError(null);
      const subjectScores = parseSubjectScores(subjectScoreRows);
      const examScores = parseExamScores(examScoreDraft);
      const updated = await apiRequest<Profile>('/profile', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          full_name: profileForm.full_name,
          location: profileForm.location,
          stream: profileForm.stream,
          board: profileForm.board,
          academic_score: normalizedAcademicScore,
          exam_scores: examScores,
          subject_scores: subjectScores,
          admission_year: profileForm.admission_year ? Number(profileForm.admission_year) : null,
          budget: profileForm.budget.trim() ? Number(profileForm.budget.replace(/,/g, '')) : null,
          career_goal: profileForm.career_goal,
          reservation_category: profileForm.reservation_category || null,
          domicile: profileForm.domicile || null,
        }),
      });
      setProfile(updated);
      const updatedForm = {
        ...profileForm,
        academic_score: updated.academic_score == null ? '' : String(updated.academic_score),
      };
      setProfileForm(updatedForm);
      setSavedProfileSnapshot(JSON.stringify({
        form: updatedForm,
        subjectScores: subjectScoreRows,
        examScores: examScoreDraft,
        academicScoreInput,
        academicScoreScale,
      }));
      setProfileFormReady(true);
      setProfileDraftRestored(false);
      setToastMessage('Profile saved successfully.');
    } catch (profileError) {
      setProfileValidationError(profileError instanceof Error ? profileError.message : 'Profile update failed');
    } finally {
      setLoading(false);
    }
  };

  const handleDocumentUpload = async (event: FormEvent) => {
    event.preventDefault();
    if (!token || !selectedFile) return;
    try {
      setDocumentLoading(true);
      setDocumentError(null);
      setUploadProgress(0);
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('document_type', uploadDocumentType);
      const uploaded = await apiUpload<DocumentRecord>(
        '/documents/upload',
        formData,
        { Authorization: `Bearer ${token}` },
        setUploadProgress,
      );
      setUploadProgress(100);
      setDocuments((currentDocuments) => [
        uploaded,
        ...currentDocuments.filter((item) => item.document_id !== uploaded.document_id),
      ]);
      setSelectedDocument(uploaded);
      setDocumentDraft(uploaded.extracted_fields);
      setToastMessage('Document uploaded. Review the extracted draft before applying it.');
      setSelectedFile(null);
    } catch (uploadError) {
      setDocumentError(uploadError instanceof Error ? uploadError.message : 'Document upload failed');
    } finally {
      setDocumentLoading(false);
      window.setTimeout(() => setUploadProgress(null), 1200);
    }
  };

  const handleSelectDocument = (record: DocumentRecord) => {
    setSelectedDocument(record);
    setDocumentDraft(record.reviewed_fields ?? record.extracted_fields);
    setDocumentError(null);
  };

  const handleReprocessDocument = async () => {
    if (!token || !selectedDocument) return;
    try {
      setDocumentLoading(true);
      setDocumentError(null);
      const updated = await apiRequest<DocumentRecord>(
        `/documents/${encodeURIComponent(selectedDocument.document_id)}/reprocess`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      setSelectedDocument(updated);
      setDocumentDraft(updated.reviewed_fields ?? updated.extracted_fields);
      setDocuments((currentDocuments) => currentDocuments.map((item) => (
        item.document_id === updated.document_id ? updated : item
      )));
      setToastMessage(
        updated.ocr_status === 'completed'
          ? 'Local OCR completed. Review the extracted draft before applying it.'
          : updated.warnings[0] ?? 'Document processing completed.',
      );
    } catch (reprocessError) {
      setDocumentError(reprocessError instanceof Error ? reprocessError.message : 'Unable to reprocess document.');
    } finally {
      setDocumentLoading(false);
    }
  };

  const handleReviewDocumentField = (field: keyof AcademicDocumentFields, value: string) => {
    if (field === 'student_name' || field === 'institution' || field === 'qualification') {
      updateDocumentDraft(field, value || null);
      return;
    }
    updateDocumentDraft(field, value === '' ? null : Number(value));
  };

  const handleFileSelection = (file: File | undefined) => {
    if (!file) return;
    const supportedType = ['application/pdf', 'image/jpeg', 'image/png'].includes(file.type);
    if (!supportedType) {
      setDocumentError('Choose a PDF, JPEG, or PNG file.');
      setSelectedFile(null);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setDocumentError('The selected file exceeds the 10 MiB upload limit.');
      setSelectedFile(null);
      return;
    }
    setSelectedFile(file);
    setDocumentError(null);
    setUploadProgress(null);
  };

  const handleGuidedProfileReview = (event: FormEvent) => {
    event.preventDefault();
    const academicScore = guidedProfile.academic_score.trim() ? Number(guidedProfile.academic_score) : null;
    if (academicScore !== null && (!Number.isFinite(academicScore) || academicScore < 0 || academicScore > 100)) {
      setIntakeError('Academic percentage must be between 0 and 100.');
      return;
    }
    const budget = guidedProfile.budget.trim() ? Number(guidedProfile.budget.replace(/,/g, '')) : null;
    if (budget !== null && (!Number.isFinite(budget) || budget < 0)) {
      setIntakeError('Enter a valid non-negative annual budget in INR.');
      return;
    }
    setIntakeError(null);
    const interests = guidedProfile.interests.split(',').map((item) => item.trim()).filter(Boolean);
    const preferredCourses = guidedProfile.preferred_courses.split(',').map((item) => item.trim()).filter(Boolean);
    setReviewedProfile({
      academic_background: guidedProfile.academic_background.trim() || null,
      stream: guidedProfile.stream.trim() || null,
      board: guidedProfile.board.trim() || null,
      academic_score: academicScore,
      exam_scores: {},
      budget,
      career_goal: guidedProfile.career_goal.trim() || null,
      interests,
      preferred_courses: preferredCourses,
      missing_information: [],
      clarification_questions: [],
    });
    setIntakeResult(null);
    setIntakeApplied(false);
    setGuidedReviewActive(true);
  };

  const updateDocumentDraft = <K extends keyof AcademicDocumentFields>(
    field: K,
    value: AcademicDocumentFields[K],
  ) => {
    setDocumentDraft((currentDraft) => (
      currentDraft ? { ...currentDraft, [field]: value } : currentDraft
    ));
  };

  const handleApplyDocumentReview = async () => {
    if (!token || !selectedDocument || !documentDraft) return;
    try {
      setDocumentLoading(true);
      setDocumentError(null);
      const updated = await apiRequest<DocumentRecord>(
        `/documents/${encodeURIComponent(selectedDocument.document_id)}/apply`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify({ reviewed_fields: documentDraft }),
        },
      );
      setSelectedDocument(updated);
      setDocumentDraft(updated.reviewed_fields);
      setDocuments((currentDocuments) => currentDocuments.map((item) => (
        item.document_id === updated.document_id ? updated : item
      )));
      const updatedProfile = await apiRequest<Profile>('/profile', {
        headers: { Authorization: `Bearer ${token}` },
      });
      setProfile(updatedProfile);
      const updatedForm = { ...profileForm, academic_score: String(updatedProfile.academic_score ?? '') };
      setProfileForm(updatedForm);
      setAcademicScoreScale('percentage');
      setAcademicScoreInput(updatedForm.academic_score);
      if (!hasUnsavedProfileChanges) {
        setSavedProfileSnapshot(JSON.stringify({
          form: updatedForm,
          subjectScores: subjectScoreRows,
          examScores: examScoreDraft,
          academicScoreInput: updatedForm.academic_score,
          academicScoreScale: 'percentage',
        }));
      }
      setToastMessage('Reviewed document fields applied to your profile.');
    } catch (reviewError) {
      setDocumentError(reviewError instanceof Error ? reviewError.message : 'Unable to apply reviewed fields');
    } finally {
      setDocumentLoading(false);
    }
  };

  const saveInterviewInHistory = (session: InterviewSession) => {
    setInterviewHistory((current) => [
      session,
      ...current.filter((item) => item.interview_id !== session.interview_id),
    ]);
  };

  const handleInterview = async () => {
    if (!token || !interviewProgram.trim() || interviewLoading) return;
    try {
      setInterviewLoading(true);
      setInterviewError(null);
      const created = await apiRequest<InterviewSession>('/interviews', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          program: interviewProgram.trim(),
          interview_type: interviewType,
          question_count: interviewQuestionCount,
          mode: 'video',
        }),
      });
      setInterview(created);
      saveInterviewInHistory(created);
      const started = await apiRequest<InterviewSession>(
        `/interviews/${encodeURIComponent(created.interview_id)}/start`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      setInterview(started);
      saveInterviewInHistory(started);
    } catch (requestError) {
      setInterviewError(requestError instanceof Error ? requestError.message : 'Unable to start interview practice');
    } finally {
      setInterviewLoading(false);
    }
  };

  const startExistingInterview = async (session: InterviewSession) => {
    if (!token || session.status !== 'created' || interviewLoading) return;
    try {
      setInterviewLoading(true);
      setInterviewError(null);
      const started = await apiRequest<InterviewSession>(
        `/interviews/${encodeURIComponent(session.interview_id)}/start`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      setInterview(started);
      saveInterviewInHistory(started);
    } catch (requestError) {
      setInterviewError(requestError instanceof Error ? requestError.message : 'Unable to start interview practice');
    } finally {
      setInterviewLoading(false);
    }
  };

  const handleInterviewAnswer = async (event: FormEvent) => {
    event.preventDefault();
    if (!token || !interview || interview.status !== 'in_progress' || interviewLoading) return;
    try {
      speechRecognitionRef.current?.stop();
      setInterviewLoading(true);
      setInterviewError(null);
      const updated = await apiRequest<InterviewSession>(
        `/interviews/${encodeURIComponent(interview.interview_id)}/answers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify({ answer: interviewAnswer }),
        },
      );
      setInterview(updated);
      setInterviewAnswer('');
      saveInterviewInHistory(updated);
    } catch (requestError) {
      setInterviewError(requestError instanceof Error ? requestError.message : 'Unable to submit your answer');
    } finally {
      setInterviewLoading(false);
    }
  };

  const startInterviewVoiceInput = () => {
    const speechWindow = window as SpeechRecognitionWindow;
    const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Recognition) {
      setInterviewError('Voice input is not supported in this browser. You can type your answer instead.');
      return;
    }
    try {
      const recognition = new Recognition();
      recognition.lang = ({
        en: 'en-IN',
        hi: 'hi-IN',
        mr: 'mr-IN',
        ta: 'ta-IN',
        te: 'te-IN',
        kn: 'kn-IN',
        bn: 'bn-IN',
        gu: 'gu-IN',
      } as const)[language];
      recognition.interimResults = false;
      recognition.onresult = (event) => {
        const transcript = Array.from(event.results)
          .map((result) => result[0]?.transcript ?? '')
          .join(' ')
          .trim();
        if (transcript) {
          setInterviewAnswer((current) => `${current}${current.trim() ? ' ' : ''}${transcript}`.slice(0, 5000));
        }
      };
      recognition.onerror = (event) => {
        setInterviewError(`Browser voice input failed (${event.error}). You can continue by typing.`);
        setVoiceListening(false);
      };
      recognition.onend = () => {
        speechRecognitionRef.current = null;
        setVoiceListening(false);
      };
      speechRecognitionRef.current = recognition;
      recognition.start();
      setVoiceListening(true);
      setInterviewError(null);
    } catch (speechError) {
      speechRecognitionRef.current = null;
      setVoiceListening(false);
      setInterviewError(speechError instanceof Error
        ? `Unable to start browser voice input: ${speechError.message}`
        : 'Unable to start browser voice input. You can continue by typing.');
    }
  };

  const stopInterviewVoiceInput = () => {
    speechRecognitionRef.current?.stop();
    setVoiceListening(false);
  };

  const stopInterviewCamera = () => {
    cameraRequestIdRef.current += 1;
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    if (cameraPreviewRef.current) cameraPreviewRef.current.srcObject = null;
    setCameraEnabled(false);
    setCameraLoading(false);
  };

  useEffect(() => {
    if (cameraEnabled && cameraPreviewRef.current && cameraStreamRef.current) {
      cameraPreviewRef.current.srcObject = cameraStreamRef.current;
    }
  }, [cameraEnabled]);

  const startInterviewCamera = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('Camera access is not available in this browser. You can continue without video.');
      return;
    }
    const requestId = ++cameraRequestIdRef.current;
    try {
      setCameraLoading(true);
      setCameraError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      if (requestId !== cameraRequestIdRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = stream;
      if (cameraPreviewRef.current) cameraPreviewRef.current.srcObject = stream;
      setCameraEnabled(true);
    } catch (cameraRequestError) {
      if (requestId !== cameraRequestIdRef.current) return;
      const name = cameraRequestError instanceof DOMException ? cameraRequestError.name : '';
      setCameraError(
        name === 'NotAllowedError' || name === 'PermissionDeniedError'
          ? 'Camera permission was denied. Allow camera access in your browser settings, or continue without video.'
          : name === 'NotFoundError' || name === 'DevicesNotFoundError'
            ? 'No camera was found. You can continue with voice or text answers.'
            : `Unable to start the camera${cameraRequestError instanceof Error ? `: ${cameraRequestError.message}` : '.'}`,
      );
    } finally {
      if (requestId === cameraRequestIdRef.current) setCameraLoading(false);
    }
  };

  const speakInterviewQuestion = (question: string) => {
    if (!('speechSynthesis' in window)) {
      setInterviewError('Spoken questions are not supported in this browser. You can read the question on screen.');
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(question);
    utterance.lang = ({
      en: 'en-IN',
      hi: 'hi-IN',
      mr: 'mr-IN',
      ta: 'ta-IN',
      te: 'te-IN',
      kn: 'kn-IN',
      bn: 'bn-IN',
      gu: 'gu-IN',
    } as const)[language];
    utterance.onstart = () => setInterviewSpeaking(true);
    utterance.onend = () => setInterviewSpeaking(false);
    utterance.onerror = () => setInterviewSpeaking(false);
    window.speechSynthesis.speak(utterance);
  };

  const reviewInterview = async (interviewId: string) => {
    if (!token || interviewLoading) return;
    try {
      setInterviewLoading(true);
      setInterviewError(null);
      const session = await apiRequest<InterviewSession>(
        `/interviews/${encodeURIComponent(interviewId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setInterview(session);
      setInterviewAnswer('');
    } catch (requestError) {
      setInterviewError(requestError instanceof Error ? requestError.message : 'Unable to load interview session');
    } finally {
      setInterviewLoading(false);
    }
  };

  const handleAllocation = async () => {
    if (!token || !profile) {
      setAllocationError('Sign in and load your student profile before starting a simulation.');
      return;
    }

    const preferences = getAllocationPreferenceIds(allocationPreferences);
    const allowedProgramIds = new Set(allocationEligiblePrograms.map((program) => program.program_id));
    if (preferences.length === 0) {
      setAllocationError('Add at least one verified, eligible program preference.');
      return;
    }
    if (preferences.length > MAX_STUDENT_PREFERENCES) {
      setAllocationError(`Choose no more than ${MAX_STUDENT_PREFERENCES} program preferences.`);
      return;
    }
    if (new Set(preferences).size !== preferences.length) {
      setAllocationError('Each program may appear only once in the ordered preferences.');
      return;
    }
    if (preferences.some((programId) => !allowedProgramIds.has(programId))) {
      setAllocationError('A selected program is no longer a verified eligible option. Review your preferences and try again.');
      return;
    }

    try {
      setAllocationLoading(true);
      setAllocationError(null);
      const response = await apiRequest<AllocationResult>('/allocation/simulate', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          student_id: profile.student_id,
          preferences,
          category: allocationCategoryOverride || null,
        }),
      });
      setAllocation(response);
      const historyEntry = { result: response, preferences };
      const nextHistory = [
        historyEntry,
        ...allocationHistory.filter((entry) => entry.result.run_id !== response.run_id),
      ].slice(0, MAX_ALLOCATION_HISTORY);
      setAllocationHistory(nextHistory);
      setAllocationHistoryError(null);
      try {
        localStorage.setItem(
          `uniapply-allocation-history-${profile.student_id}`,
          JSON.stringify(nextHistory.map((entry) => ({
            run_id: entry.result.run_id,
            preferences: entry.preferences,
          }))),
        );
      } catch {
        setAllocationHistoryError('This result is available now but could not be saved to this browser’s run history.');
      }
    } catch (requestError) {
      setAllocationError(requestError instanceof Error ? requestError.message : 'Allocation simulation failed');
    } finally {
      setAllocationLoading(false);
    }
  };

  const moveAllocationPreference = (programId: string, destinationIndex: number) => {
    const preferences = getAllocationPreferenceIds(allocationPreferences);
    const currentIndex = preferences.indexOf(programId);
    if (currentIndex < 0 || destinationIndex < 0 || destinationIndex >= preferences.length) return;
    preferences.splice(currentIndex, 1);
    preferences.splice(destinationIndex, 0, programId);
    setAllocationPreferences(preferences.join('\n'));
  };

  const handleRunStableMatchingDemo = () => {
    try {
      setStableMatchingDemo(runGaleShapley(stableMatchingDemoStudents, stableMatchingDemoPrograms));
    } catch (matchingError) {
      setError(matchingError instanceof Error ? matchingError.message : 'Stable matching demonstration failed.');
    }
  };

  const activeInterviewQuestion = interview?.turns.find((turn) => turn.answer === null) ?? null;
  const answeredInterviewQuestions = interview?.turns.filter((turn) => turn.answer !== null).length ?? 0;
  useEffect(() => {
    if (!interview || interview.status !== 'in_progress' || !activeInterviewQuestion) {
      setQuestionSecondsRemaining(90);
      return;
    }
    const startedAt = Date.now();
    setQuestionSecondsRemaining(90);
    const timerId = window.setInterval(() => {
      setQuestionSecondsRemaining(Math.max(0, 90 - Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(timerId);
  }, [interview?.interview_id, interview?.status, interview?.turns.length, activeInterviewQuestion?.question]);

  useEffect(() => {
    if (activePage !== 'interview' || interview?.status !== 'in_progress' || !activeInterviewQuestion) {
      window.speechSynthesis?.cancel();
      setInterviewSpeaking(false);
      return;
    }
    const questionKey = `${interview.interview_id}:${activeInterviewQuestion.question}`;
    if (lastSpokenQuestionRef.current === questionKey) return;
    lastSpokenQuestionRef.current = questionKey;
    if ('speechSynthesis' in window) speakInterviewQuestion(activeInterviewQuestion.question);
  }, [activePage, interview?.interview_id, interview?.status, activeInterviewQuestion?.question, language]);

  useEffect(() => {
    if (activePage !== 'interview' || interview?.status !== 'in_progress') {
      stopInterviewCamera();
      stopInterviewVoiceInput();
    }
  }, [activePage, interview?.interview_id, interview?.status]);

  useEffect(() => () => {
    speechRecognitionRef.current?.stop();
    cameraRequestIdRef.current += 1;
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    window.speechSynthesis?.cancel();
  }, []);

  const onboardingSteps = [
    {
      label: 'Profile',
      description: !profile ? 'Loading your profile.' : profile.missing_fields.length
        ? `Complete ${profile.missing_fields.length} profile field${profile.missing_fields.length === 1 ? '' : 's'}.`
        : 'Profile details are complete.',
      href: '#profile',
      complete: Boolean(profile && profile.completion_percent >= 100 && profile.missing_fields.length === 0),
    },
    {
      label: 'Documents',
      description: documents.some((item) => item.status === 'reviewed')
        ? 'At least one document has been reviewed.'
        : documents.length
          ? 'Review the extracted fields before applying them.'
          : 'Upload an academic document to get started.',
      href: '#profile',
      complete: documents.some((item) => item.status === 'reviewed'),
    },
    {
      label: 'Eligibility',
      description: institutionSuppliedRecommendations.length
        ? 'Guidance is available from institution-supplied criteria.'
        : 'No institution-supplied program criteria are configured.',
      href: '#eligibility',
      complete: institutionSuppliedRecommendations.length > 0,
    },
    {
      label: 'Interview',
      description: interviewHistory.some((item) => item.status === 'completed')
        ? 'You have completed an interview practice session.'
        : interviewHistory.length
          ? 'Continue or review an existing practice session.'
          : 'Start a practice session when you are ready.',
      href: '#interview',
      complete: interviewHistory.some((item) => item.status === 'completed'),
    },
    {
      label: 'Allocation',
      description: allocation ? 'A local allocation simulation has been run.' : 'Run a simulation after reviewing eligibility.',
      href: '#allocation',
      complete: Boolean(allocation),
    },
  ];
  const nextOnboardingStep = onboardingSteps.findIndex((step) => !step.complete);
  const firstNameOrEmailPrefix = profile?.full_name?.trim()
    || profile?.email?.split('@')[0]
    || 'there';
  const allocationPreferenceIds = getAllocationPreferenceIds(allocationPreferences);
  const handleEligibilitySearch = (event: FormEvent) => {
    event.preventDefault();
    setAppliedEligibilityFilters({
      institution: eligibilitySearch,
      course: eligibilityCourseSearch,
      location: eligibilityLocationSearch,
      status: eligibilityStatusFilter,
    });
  };
  const clearEligibilityFilters = () => {
    setEligibilitySearch('');
    setEligibilityCourseSearch('');
    setEligibilityLocationSearch('');
    setEligibilityStatusFilter('all');
    setAppliedEligibilityFilters({ institution: '', course: '', location: '', status: 'all' });
  };
  const refreshEligibilityData = async () => {
    if (!token) {
      setEligibilityRefreshError('Sign in again to refresh eligibility guidance.');
      return;
    }
    setEligibilityRefreshLoading(true);
    setEligibilityRefreshError(null);
    setEligibilityRefreshSuccess(null);
    try {
      const rows = await apiRequest<Recommendation[]>('/eligibility', {
        headers: { Authorization: `Bearer ${token}` },
      });
      setRecommendations(rows);
      const verifiedCount = rows.filter((item) => item.criteria_status === 'verified').length;
      setEligibilityRefreshSuccess(
        verifiedCount
          ? `Eligibility data refreshed. ${verifiedCount} institution-provided verified program${verifiedCount === 1 ? '' : 's'} available.`
          : 'Eligibility data refreshed. No verified institution criteria are currently available.',
      );
    } catch (requestError) {
      setEligibilityRefreshError(requestError instanceof Error ? requestError.message : 'Unable to refresh eligibility data.');
    } finally {
      setEligibilityRefreshLoading(false);
    }
  };
  const handlePrivacyExport = async () => {
    if (!profile) {
      setError('Your profile is not available for export yet. Try again after the page finishes loading.');
      return;
    }
    if (!token) return;
    setPrivacyExportLoading(true);
    setError(null);
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [applications, aiRecommendationHistory, savedColleges, chatSessions] = await Promise.all([
        apiRequest<{ applications: ApplicationRecord[] }>('/applications', { headers }),
        apiRequest<unknown[]>('/ai/recommendations/history', { headers }),
        apiRequest<unknown[]>('/ai/saved-colleges', { headers }),
        apiRequest<Array<{ session_id: string }>>('/ai/chat/sessions', { headers }),
      ]);
      const aiChatHistory = await Promise.all(chatSessions.map((session) => (
        apiRequest<unknown>(`/ai/chat/sessions/${encodeURIComponent(session.session_id)}`, { headers })
      )));
      const exportPayload = {
        exported_at: new Date().toISOString(),
        notice: 'This export includes data currently available to this signed-in account in the web app. Uploaded source file contents are not included.',
        profile,
        documents,
        applications: applications.applications,
        eligibility_guidance: recommendations,
        interview_sessions: interviewHistory,
        current_allocation_preview: allocation,
        allocation_history: allocationHistory,
        ai_recommendation_history: aiRecommendationHistory,
        saved_colleges: savedColleges,
        ai_chat_sessions: aiChatHistory,
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'uniapply-account-data.json';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (requestError) {
      setError(requestError instanceof Error ? `Unable to export all account data: ${requestError.message}` : 'Unable to export all account data.');
    } finally {
      setPrivacyExportLoading(false);
    }
  };

  if (!token) {
    return (
      <main className="auth-page">
        <section className="auth-brand-panel" aria-label="UniApply-AI overview">
          <div className="auth-brand-mark">UA</div>
          <div>
            <p className="auth-brand-name">UniApply-AI</p>
            <p className="auth-brand-copy">Your admissions journey, organized in one place.</p>
          </div>
        </section>
        <section className="auth-form-panel">
          <div className="auth-card">
            <p className="eyebrow">Student portal</p>
            <h1>{isRegistering ? 'Create your account' : 'Welcome back'}</h1>
            <p className="auth-subtitle">
              {isRegistering
                ? 'Create a student account to organize your admissions journey.'
                : 'Sign in to continue to your UniApply-AI dashboard.'}
            </p>
            <form className="auth-form" onSubmit={handleAuth}>
            {isRegistering ? (
              <div className="field-group">
                <label htmlFor="register-name">Full name</label>
                <input id="register-name" required minLength={2} value={registrationName} onChange={(event) => setRegistrationName(event.target.value)} />
              </div>
            ) : null}
            <div className="field-group">
              <label htmlFor="auth-email">Email address</label>
              <input id="auth-email" type="email" required autoComplete="email" value={auth.email} onChange={(event) => setAuth({ ...auth, email: event.target.value })} />
            </div>
            <div className="field-group">
              <label htmlFor="auth-password">Password</label>
              <input id="auth-password" type="password" required minLength={8} autoComplete={isRegistering ? 'new-password' : 'current-password'} value={auth.password} onChange={(event) => setAuth({ ...auth, password: event.target.value })} />
            </div>
            {error ? <p role="alert" className="form-error">{error}</p> : null}
            <button type="submit" disabled={loading} className="button button-primary button-full">
                {loading ? 'Please wait...' : isRegistering ? 'Create student account' : 'Sign in'}
              </button>
            </form>
            <div className="auth-divider"><span>or</span></div>
            <button type="button" className="digilocker-button" onClick={openDigiLocker}>
              <span className="digilocker-mark" aria-hidden="true">DL</span>
              <span>Continue with DigiLocker</span>
            </button>
            <p className="digilocker-help">
              Opens the official DigiLocker website. UniApply-AI never receives your DigiLocker password.
            </p>
            <button type="button" onClick={() => { setIsRegistering(!isRegistering); setError(null); }} className="auth-switch">
              {isRegistering ? 'Already registered? Sign in' : 'New student? Create an account'}
            </button>
          </div>
        </section>
      </main>
    );
  }

  if (!currentUser) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <p role="status" className="rounded-xl bg-white px-6 py-4 shadow-sm">Loading your secure account…</p>
      </main>
    );
  }

  if (currentUser.role === 'university') {
    return (
      <UniversityPortal
        token={token}
        name={currentUser.full_name}
        onSignOut={handleSignOut}
      />
    );
  }

  return (
    <div className="app-shell">
      {mobileNavigationOpen ? (
        <button className="sidebar-backdrop" type="button" aria-label="Close navigation" onClick={() => setMobileNavigationOpen(false)} />
      ) : null}
      <aside className={`sidebar ${mobileNavigationOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-brand">
          <div className="brand-mark">UA</div>
          <div>
            <strong>UniApply-AI</strong>
            <span>Student portal</span>
          </div>
          <button type="button" className="icon-button sidebar-close" aria-label={t('closeNavigation')} onClick={() => setMobileNavigationOpen(false)}>
            <Icon name="close" />
          </button>
        </div>
        <nav id="primary-navigation" className="sidebar-nav" aria-label="Primary navigation">
          {[
            ['dashboard', 'overview', 'grid'],
            ['profile', 'profile', 'user'],
            ['eligibility', 'eligibility', 'eligibility'],
            ['applications', 'applications', 'document'],
            ['explore', 'explore', 'eligibility'],
            ['ai-predictor', 'predictor', 'sparkles'],
            ['interview', 'interview', 'interview'],
            ['allocation', 'allocation', 'allocation'],
            ['privacy', 'privacy', 'privacy'],
          ].map(([target, labelKey, icon]) => (
            <a
              key={target}
              href={`#${target}`}
              onClick={(event) => {
                if (hasUnsavedProfileChanges && !window.confirm('You have unsaved profile changes. Leave this page?')) {
                  event.preventDefault();
                  return;
                }
                setMobileNavigationOpen(false);
              }}
              className={activePage === target ? 'nav-item nav-item-active' : 'nav-item'}
              aria-current={activePage === target ? 'page' : undefined}
            >
              <Icon name={icon as 'grid' | 'user' | 'document' | 'eligibility' | 'interview' | 'allocation' | 'privacy' | 'sparkles'} />
              <span>{t(labelKey)}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-footer">
          <p>Admissions workspace</p>
          <span>{profile?.full_name || profile?.email || 'Student account'}</span>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <button
            type="button"
            className="icon-button mobile-menu-button"
            aria-label={t('openNavigation')}
            aria-expanded={mobileNavigationOpen}
            aria-controls="primary-navigation"
            onClick={() => setMobileNavigationOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <div className="topbar-title">
            <h1>{({
              dashboard: 'Student dashboard',
              profile: t('profile'),
              eligibility: t('eligibility'),
              applications: 'Applications',
              explore: t('explore'),
              'ai-predictor': t('predictor'),
              interview: t('interview'),
              allocation: t('allocation'),
              privacy: t('privacy'),
            } as Record<string, string>)[activePage] ?? 'Student dashboard'}</h1>
            <p>{profile?.full_name ? `Welcome back, ${profile.full_name}` : 'Welcome to your admissions workspace'}</p>
          </div>
          <div className="topbar-actions">
            <label className="language-control">
              <span className="sr-only">Language</span>
              <select aria-label="Language" value={language} onChange={(event) => setLanguage(event.target.value as AppLanguage)}>
                {appLanguages.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
            <div className="system-status-wrap">
              <button
                type="button"
                className="system-status-button"
                aria-expanded={systemStatusOpen}
                aria-controls="system-status-popover"
                onClick={() => setSystemStatusOpen((open) => !open)}
              >
                {t('systemStatus')}
              </button>
              {systemStatusOpen ? (
                <section id="system-status-popover" className="system-status-popover" role="dialog" aria-label={t('systemStatus')}>
                  <div className="system-status-heading">
                    <strong>{t('systemStatus')}</strong>
                    <button type="button" className="icon-button" aria-label="Close system status" onClick={() => setSystemStatusOpen(false)}><Icon name="close" size={16} /></button>
                  </div>
                  <dl>
                    <div><dt>AI provider</dt><dd>{aiStatus?.inference_verified ? `OLLAMA CONNECTED · Model: ${aiStatus.model} · Mode: Local AI` : aiStatus?.message ?? 'Loading status'}</dd></div>
                    <div><dt>Ollama</dt><dd>{aiStatus?.message ?? 'Checking local Ollama status'}</dd></div>
                    <div><dt>Document OCR</dt><dd>{documents.some((item) => item.ocr_status === 'completed')
                      ? 'Local OCR completed for at least one uploaded document'
                      : documents.some((item) => item.ocr_status === 'not_configured')
                        ? 'Tesseract OCR is not configured; retry after local setup'
                        : 'OCR status is shown per uploaded document'}</dd></div>
                    {interview ? <div><dt>Current interview content</dt><dd>{interview.generation_mode.replace(/_/g, ' ')}</dd></div> : null}
                  </dl>
                </section>
              ) : null}
            </div>
            <div className="account-menu-wrap">
              <button type="button" className="account-button" aria-haspopup="menu" aria-expanded={accountMenuOpen} onClick={() => setAccountMenuOpen((open) => !open)}>
                <span className="account-avatar">{(profile?.full_name || profile?.email || 'S').charAt(0).toUpperCase()}</span>
                <span className="account-copy">
                  <strong>{profile?.full_name || 'Student'}</strong>
                  <small>{profile?.email || 'Student account'}</small>
                </span>
                <Icon name="chevron" size={16} />
              </button>
              {accountMenuOpen ? (
                <div className="account-menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => void handleDeleteAccount()} disabled={loading}>Delete account</button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={handleSignOut}
                  >
                    Sign out
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        {toastMessage ? <div className="app-toast" role="status" aria-live="polite">{toastMessage}</div> : null}

        {deleteConfirmationOpen ? (
          <div className="delete-confirm-backdrop" role="presentation">
            <section className="delete-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-confirm-title" aria-describedby="delete-confirm-description">
              <p className="eyebrow">Irreversible account action</p>
              <h2 id="delete-confirm-title">Delete this account?</h2>
              <p id="delete-confirm-description">
                The backend will permanently delete your profile, documents, applications, interview records, saved colleges, recommendation history, and chat sessions. This cannot be undone.
              </p>
              <label className="field-group">
                Type <strong>DELETE</strong> to confirm
                <input
                  value={deleteConfirmationText}
                  onChange={(event) => setDeleteConfirmationText(event.target.value)}
                  autoComplete="off"
                />
              </label>
              {error ? <p className="form-error" role="alert">{error}</p> : null}
              <div className="delete-confirm-actions">
                <button type="button" className="button button-secondary" onClick={() => { setDeleteConfirmationOpen(false); setDeleteConfirmationText(''); }}>
                  Cancel
                </button>
                <button type="button" className="button button-danger" disabled={loading || deleteConfirmationText !== 'DELETE'} onClick={() => void confirmDeleteAccount()}>
                  {loading ? 'Deleting…' : 'Delete account permanently'}
                </button>
              </div>
            </section>
          </div>
        ) : null}

        <main className={`dashboard-content portal-page-${activePage}`} id="dashboard">
          {!initialDataReady ? (
            <section className="page-skeleton" aria-label="Loading admissions workspace" aria-busy="true">
              <span className="skeleton-line skeleton-heading" />
              <span className="skeleton-line skeleton-copy" />
              <div className="skeleton-block" />
              <div className="skeleton-block" />
            </section>
          ) : null}
          {initialDataReady ? (
          <>
          {activePage === 'dashboard' ? (
          <div className="dashboard-page">
          <section className="welcome-row">
            <div>
              <p className="eyebrow">{t('welcome')}</p>
              <h2>Good to see you, {firstNameOrEmailPrefix}</h2>
              <p>Review your profile, documents, eligibility guidance, and practice sessions.</p>
            </div>
          </section>

          <section className="dashboard-summary-grid" aria-label="Admissions overview">
            <article className="dashboard-summary-card">
              <span className="dashboard-summary-icon"><Icon name="user" size={18} /></span>
              <div>
                <p>Profile</p>
                <strong>{profile?.completion_percent ?? 0}%</strong>
                <span>{profile?.missing_fields.length ? `${profile.missing_fields.length} fields to complete` : 'Complete'}</span>
              </div>
            </article>
            <article className="dashboard-summary-card">
              <span className="dashboard-summary-icon"><Icon name="document" size={18} /></span>
              <div>
                <p>Documents</p>
                <strong>{documents.length}</strong>
                <span>{documents.filter((item) => item.status === 'reviewed').length} reviewed drafts</span>
              </div>
            </article>
            <article className="dashboard-summary-card">
              <span className="dashboard-summary-icon"><Icon name="eligibility" size={18} /></span>
              <div>
                <p>Eligibility</p>
                <strong>{institutionSuppliedRecommendations.length}</strong>
                <span>{institutionSuppliedRecommendations.length ? 'verified-criteria programs' : 'No verified criteria'}</span>
              </div>
            </article>
            <article className="dashboard-summary-card">
              <span className="dashboard-summary-icon"><Icon name="allocation" size={18} /></span>
              <div>
                <p>Allocation</p>
                <strong>{allocation ? allocation.waitlist_status : '—'}</strong>
                <span>{allocation ? 'Simulation completed' : 'No simulation run'}</span>
              </div>
            </article>
          </section>

          <section className="card checklist-card" aria-labelledby="checklist-title">
            <div className="checklist-heading">
              <div>
                <p className="eyebrow">Your admissions journey</p>
                <h2 id="checklist-title">Progress checklist</h2>
                <p>Complete each step when you are ready. Guidance is based on the information available in your account.</p>
              </div>
              <div className="completion-summary">
                <strong>{profile?.completion_percent ?? 0}%</strong>
                <span>profile completion</span>
              </div>
            </div>
            <ol className="journey-stepper">
              {onboardingSteps.map((step, index) => {
                const isNext = index === nextOnboardingStep;
                return (
                  <li key={step.label} className={`journey-step ${step.complete ? 'journey-step-complete' : ''} ${isNext ? 'journey-step-current' : ''}`}>
                    <span className="journey-step-number" aria-hidden="true">{step.complete ? '✓' : index + 1}</span>
                    <div className="journey-step-content">
                      <div className="journey-step-title">
                        <h3>{step.label}</h3>
                        <span>{step.complete ? 'Complete' : isNext ? 'Next step' : 'Not started'}</span>
                      </div>
                      <p>{step.description}</p>
                      <a href={step.href} onClick={(event) => {
                        if (hasUnsavedProfileChanges && !window.confirm('You have unsaved profile changes. Leave this page?')) event.preventDefault();
                      }}>
                        {isNext ? 'Go to this step' : 'Open step'} <Icon name="chevron" size={15} />
                      </a>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>

          <section className="card profile-completion-card">
            <div>
              <p className="eyebrow">Profile completion</p>
              <h2>{profile?.completion_percent ?? 0}% complete</h2>
              <div className="progress-track progress-track-wide" aria-label={`Profile ${profile?.completion_percent ?? 0}% complete`}>
                <span style={{ width: `${profile?.completion_percent ?? 0}%` }} />
              </div>
            </div>
            <div>
              <h3>{profile?.missing_fields.length ? 'Fields to complete' : 'No required profile fields are missing'}</h3>
              {profile?.missing_fields.length ? (
                <ul className="missing-fields-list">
                  {profile.missing_fields.map((field) => <li key={field}>{field.replace(/_/g, ' ')}</li>)}
                </ul>
              ) : <p>Your profile is ready for the next steps.</p>}
            </div>
          </section>
          </div>
          ) : null}

          {activePage === 'applications' ? (
            <section id="applications" className="grid gap-6">
              {token ? (
                <ApplicationsPanel
                  token={token}
                  recommendations={recommendations}
                  documents={documents}
                />
              ) : null}
            </section>
          ) : null}

        {activePage === 'profile' ? (
        <div>
        <section id="profile" className="grid gap-6 xl:grid-cols-[1.2fr_1fr]">
          <div className="card">
            <div className="profile-card-heading">
              <div>
                <h2>Student profile</h2>
                <p>Use your current details. This information is used only to compare against configured criteria.</p>
              </div>
              <span className={hasUnsavedProfileChanges ? 'save-state save-state-dirty' : 'save-state'}>
                {hasUnsavedProfileChanges ? 'Unsaved changes' : 'All changes saved'}
              </span>
            </div>
            <p className="profile-form-note">Your unsaved form draft is autosaved for this browser session. Saving updates your profile on the server.</p>
            {profileDraftRestored ? <p className="inline-notice" role="status">Restored an unsaved draft from this session.</p> : null}
            <form className="profile-form" onSubmit={handleProfileUpdate} noValidate>
              <div className="field-group">
                <label htmlFor="profile-full-name">Full name <span aria-hidden="true">*</span></label>
                <input id="profile-full-name" required maxLength={200} autoComplete="name" value={profileForm.full_name} onChange={(event) => { setProfileForm({ ...profileForm, full_name: event.target.value }); setProfileValidationError(null); }} />
                <small>Enter the name you want shown on your admissions workspace.</small>
              </div>
              <div className="field-group">
                <label htmlFor="profile-location">City / location</label>
                <input id="profile-location" autoComplete="address-level2" maxLength={200} value={profileForm.location} onChange={(event) => setProfileForm({ ...profileForm, location: event.target.value })} placeholder="e.g. Pune, Maharashtra" />
                <small>Use a city and state; do not enter a full street address.</small>
              </div>
              <div className="field-group">
                <label htmlFor="profile-stream">Academic stream</label>
                <select id="profile-stream" value={profileForm.stream} onChange={(event) => setProfileForm({ ...profileForm, stream: event.target.value })}>
                  <option value="">Select a stream</option>
                  {profileForm.stream && !['Science', 'Commerce', 'Arts', 'Vocational', 'Other'].includes(profileForm.stream) ? <option value={profileForm.stream}>{profileForm.stream}</option> : null}
                  {['Science', 'Commerce', 'Arts', 'Vocational', 'Other'].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
                <small>Choose the stream recorded in your latest academic qualification.</small>
              </div>
              <div className="field-group">
                <label htmlFor="profile-board">Board</label>
                <select id="profile-board" value={profileForm.board} onChange={(event) => setProfileForm({ ...profileForm, board: event.target.value })}>
                  <option value="">Select a board</option>
                  {profileForm.board && !['CBSE', 'CISCE', 'State board', 'Other'].includes(profileForm.board) ? <option value={profileForm.board}>{profileForm.board}</option> : null}
                  {['CBSE', 'CISCE', 'State board', 'Other'].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
                <small>Select the board for your latest qualification.</small>
              </div>
              <div className="field-group">
                <label htmlFor="profile-score-scale">Academic score scale</label>
                <select
                  id="profile-score-scale"
                  value={academicScoreScale}
                  onChange={(event) => handleAcademicScoreScaleChange(event.target.value as AcademicScoreScale)}
                  aria-describedby="profile-score-help"
                >
                  <option value="percentage">Percentage (%)</option>
                  <option value="cgpa10">CGPA / 10-point scale</option>
                  <option value="letter">Letter grade</option>
                </select>
                <small id="profile-score-help">The profile API stores normalized percentage from 0 to 100.</small>
              </div>
              <div className="field-group">
                <label htmlFor="profile-academic-score">Academic score</label>
                {academicScoreScale === 'letter' ? (
                  <select id="profile-academic-score" value={academicScoreInput} onChange={(event) => handleAcademicScoreInput(event.target.value)} aria-describedby="academic-score-conversion">
                    <option value="">Select a grade</option>
                    {Object.keys(SAMPLE_LETTER_GRADE_PERCENTAGES).map((grade) => <option key={grade} value={grade}>{grade}</option>)}
                  </select>
                ) : (
                  <div className="input-with-unit">
                    <input
                      id="profile-academic-score"
                      type="number"
                      min="0"
                      max={academicScoreScale === 'cgpa10' ? '10' : '100'}
                      step="any"
                      inputMode="decimal"
                      value={academicScoreInput}
                      onChange={(event) => handleAcademicScoreInput(event.target.value)}
                      aria-describedby="academic-score-conversion"
                    />
                    <span>{academicScoreScale === 'cgpa10' ? '/ 10' : '%'}</span>
                  </div>
                )}
                <small id="academic-score-conversion">
                  {academicScoreScale === 'cgpa10'
                    ? `Converted using the configurable ${DEFAULT_CGPA_MULTIPLIER} multiplier.`
                    : academicScoreScale === 'letter'
                      ? 'Illustrative grade mapping only; confirm the conversion with your examination board.'
                      : 'Enter a value between 0 and 100. Leave blank if not yet available.'}
                  {profileForm.academic_score !== '' ? ` Normalized percentage: ${profileForm.academic_score}%.` : ''}
                </small>
              </div>
              <div className="field-group">
                <label htmlFor="profile-admission-year">Intended admission year</label>
                <select id="profile-admission-year" value={profileForm.admission_year} onChange={(event) => setProfileForm({ ...profileForm, admission_year: event.target.value })}>
                  <option value="">Select year</option>
                  {Array.from({ length: 7 }, (_, index) => new Date().getFullYear() + index).map((year) => <option key={year} value={year}>{year}</option>)}
                </select>
                <small>Select the year you are planning to apply.</small>
              </div>
              <div className="field-group field-group-wide">
                <div>
                  <h3>Entrance exam scores</h3>
                  <p>Enter a percentile or normalized score on a 0–100 scale. Raw exam marks are not accepted by the current profile API.</p>
                </div>
                <div className="exam-score-grid">
                  {EXAM_SCORE_FIELDS.map((exam) => (
                    <label className="field-group" key={exam} htmlFor={`exam-score-${exam.replace(/\W/g, '-')}`}>
                      {exam} score / percentile
                      <div className="input-with-unit">
                        <input
                          id={`exam-score-${exam.replace(/\W/g, '-')}`}
                          type="number"
                          min="0"
                          max="100"
                          step="any"
                          inputMode="decimal"
                          value={examScoreDraft[exam] ?? ''}
                          onChange={(event) => setExamScoreDraft({ ...examScoreDraft, [exam]: event.target.value })}
                        />
                        <span>%</span>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
              <div className="field-group">
                <label htmlFor="profile-category">Reservation category <span className="field-optional">Optional</span></label>
                <select id="profile-category" value={profileForm.reservation_category} onChange={(event) => setProfileForm({ ...profileForm, reservation_category: event.target.value })}>
                  <option value="">Not provided</option>
                  {['General', 'EWS', 'OBC-NCL', 'SC', 'ST'].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
                <small>Self-reported. The platform does not verify category documents.</small>
              </div>
              <div className="field-group">
                <label htmlFor="profile-domicile">Domicile state <span className="field-optional">Optional</span></label>
                <select id="profile-domicile" value={profileForm.domicile} onChange={(event) => setProfileForm({ ...profileForm, domicile: event.target.value })}>
                  <option value="">Not provided</option>
                  {indianStates.map((state) => <option key={state} value={state}>{state}</option>)}
                </select>
                <small>Choose only if you want domicile-based criteria considered.</small>
              </div>
              <div className="field-group">
                <label htmlFor="profile-budget">Annual budget</label>
                <div className="input-with-unit">
                  <span>₹</span>
                  <input id="profile-budget" type="text" inputMode="numeric" value={profileForm.budget} onChange={(event) => setProfileForm({ ...profileForm, budget: event.target.value.replace(/[^\d,]/g, '') })} placeholder="e.g. 2,50,000" />
                </div>
                <small>
                  Enter your approximate annual budget in Indian rupees (INR).
                  {profileForm.budget ? ` Display: ${formatINR(Number(profileForm.budget.replace(/,/g, '')))}.` : ''}
                </small>
              </div>
              <div className="field-group">
                <label htmlFor="profile-career-goal">Career goal</label>
                <input id="profile-career-goal" maxLength={500} value={profileForm.career_goal} onChange={(event) => setProfileForm({ ...profileForm, career_goal: event.target.value })} placeholder="e.g. Environmental engineering" />
                <small>A short description helps personalize practice prompts.</small>
              </div>
              <div className="field-group field-group-wide">
                <div className="subject-scores-heading">
                  <div>
                    <h3>Subject scores</h3>
                    <p>Add scores on a 0–100 scale. These are student-provided and not verified.</p>
                  </div>
                  <button type="button" className="button button-secondary" onClick={() => setSubjectScoreRows([...subjectScoreRows, { id: crypto.randomUUID(), subject: '', score: '' }])}>Add subject</button>
                </div>
                {subjectScoreRows.length ? (
                  <div className="subject-score-list">
                    {subjectScoreRows.map((row) => (
                      <div className="subject-score-row" key={row.id}>
                        <label className="sr-only" htmlFor={`subject-${row.id}`}>Subject name</label>
                        <input id={`subject-${row.id}`} value={row.subject} onChange={(event) => setSubjectScoreRows(subjectScoreRows.map((item) => item.id === row.id ? { ...item, subject: event.target.value } : item))} placeholder="Subject name" />
                        <label className="sr-only" htmlFor={`score-${row.id}`}>Score out of 100</label>
                        <input id={`score-${row.id}`} type="number" min="0" max="100" step="any" inputMode="decimal" value={row.score} onChange={(event) => setSubjectScoreRows(subjectScoreRows.map((item) => item.id === row.id ? { ...item, score: event.target.value } : item))} placeholder="Score / 100" />
                        <button type="button" className="remove-row-button" aria-label={`Remove ${row.subject || 'subject'} score`} onClick={() => setSubjectScoreRows(subjectScoreRows.filter((item) => item.id !== row.id))}>Remove</button>
                      </div>
                    ))}
                  </div>
                ) : <p className="empty-inline">No subject scores added.</p>}
              </div>
              {profileValidationError ? <p className="form-error field-group-wide" role="alert">{profileValidationError}</p> : null}
              <div className="profile-form-actions field-group-wide">
                {hasUnsavedProfileChanges ? <span role="status">Changes are autosaved as a draft. Save to update your profile.</span> : <span role="status">Your profile is up to date.</span>}
                <button type="submit" className="button button-primary" disabled={loading}>
                  {loading ? 'Saving profile…' : 'Save profile'}
                </button>
              </div>
            </form>
          </div>

          <div className="card">
            <h2>Academic documents</h2>
            <p className="card-description">Upload a marksheet or transcript to review supported academic details. Uploading never updates your profile by itself.</p>
            <div className="digilocker-import-row">
              <div>
                <strong>Have a document in DigiLocker?</strong>
                <span>Open DigiLocker, download the PDF you need, then upload it here.</span>
              </div>
              <button type="button" className="button button-secondary" onClick={openDigiLocker}>
                Open DigiLocker
              </button>
            </div>
            <form className="document-upload-form" onSubmit={handleDocumentUpload}>
              <label className="field-group">
                Document type
                <select
                  value={uploadDocumentType}
                  onChange={(event) => setUploadDocumentType(event.target.value as AdmissionDocumentType)}
                >
                  <option value="academic_marksheet">Academic marksheet</option>
                  <option value="school_leaving_certificate">School leaving certificate</option>
                  <option value="identity_proof">Identity proof</option>
                  <option value="entrance_scorecard">Entrance scorecard</option>
                  <option value="category_certificate">Category certificate</option>
                  <option value="other">Other</option>
                </select>
                <small>Institutions use this label to match documents to application requirements.</small>
              </label>
              <label
                className={`upload-dropzone ${isDropTarget ? 'upload-dropzone-active' : ''}`}
                htmlFor="academic-document-file"
                onDragOver={(event) => { event.preventDefault(); setIsDropTarget(true); }}
                onDragLeave={(event) => { event.preventDefault(); setIsDropTarget(false); }}
                onDrop={(event) => {
                  event.preventDefault();
                  setIsDropTarget(false);
                  handleFileSelection(event.dataTransfer.files[0]);
                }}
              >
                <span className="upload-icon"><Icon name="document" size={24} /></span>
                <strong>Drop a file here or choose a file</strong>
                <span>PDF, JPEG, or PNG · 10 MiB default server limit</span>
                <span className="upload-security-note">Private upload · Server validates file type and size</span>
              </label>
              <input
                id="academic-document-file"
                aria-label="Academic document file"
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                onChange={(event) => {
                  handleFileSelection(event.target.files?.[0]);
                  event.currentTarget.value = '';
                }}
                className="file-input-hidden"
              />
              {selectedFile ? (
                <div className="selected-file-card">
                  <div className="selected-file-details">
                    <strong>{selectedFile.name}</strong>
                    <span>{(selectedFile.size / (1024 * 1024)).toFixed(2)} MiB · {selectedFile.type || 'File type unavailable'}</span>
                  </div>
                  <button type="button" className="remove-row-button" disabled={documentLoading} onClick={() => setSelectedFile(null)}>Remove</button>
                </div>
              ) : null}
              {selectedFilePreviewUrl && selectedFile?.type.startsWith('image/') ? (
                <img className="document-preview-image" src={selectedFilePreviewUrl} alt={`Preview of ${selectedFile.name}`} />
              ) : null}
              {selectedFilePreviewUrl && selectedFile?.type === 'application/pdf' ? (
                <object className="document-preview-pdf" data={selectedFilePreviewUrl} type="application/pdf" aria-label={`PDF preview of ${selectedFile.name}`}>
                  <p>PDF preview is unavailable in this browser.</p>
                </object>
              ) : null}
              {documentLoading && uploadProgress !== null ? (
                <div className="upload-progress" role="status" aria-live="polite">
                  <div className="upload-progress-label"><span>Uploading document…</span><strong>{uploadProgress}%</strong></div>
                  <progress value={uploadProgress} max="100" aria-label="Document upload progress">{uploadProgress}%</progress>
                </div>
              ) : null}
              <button
                type="submit"
                disabled={documentLoading || !selectedFile}
                className="button button-primary button-full"
              >
                {documentLoading ? 'Uploading…' : 'Upload document'}
              </button>
            </form>
            {documentError ? <p role="alert" className="form-error mt-3">{documentError}</p> : null}
            {documents.length ? (
              <div className="mt-5">
                <h3 className="document-list-title">Uploaded documents</h3>
                <ul className="document-list">
                  {documents.map((item) => (
                    <li key={item.document_id}>
                      <button
                        type="button"
                        onClick={() => handleSelectDocument(item)}
                        className={`document-list-item ${
                          selectedDocument?.document_id === item.document_id
                            ? 'document-list-item-active'
                            : ''
                        }`}
                      >
                        <span className="document-item-name">{item.filename}</span>
                        <span className="document-item-meta">
                          {(documentLabels[item.document_type ?? 'other'] ?? 'Other document')}
                          {' · '}
                          {item.created_at ? new Date(item.created_at).toLocaleDateString() : 'Upload date unavailable'}
                        </span>
                        <span className="document-chip-row">
                          <span className="status-chip status-uploaded">Uploaded</span>
                          {item.extraction_status === 'fields_extracted' ? <span className="status-chip status-extracted">Extracted</span> : null}
                          {item.status === 'reviewed' ? <span className="status-chip status-reviewed">Reviewed</span> : <span className="status-chip status-review">Needs review</span>}
                          <span className="status-chip status-unverified">Not verified</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="empty-state">
                <span className="empty-state-icon"><Icon name="document" size={22} /></span>
                <h3>No documents uploaded</h3>
                <p>Your uploaded file is stored privately. Extracted details stay a draft until you review and apply them.</p>
              </div>
            )}
            {selectedDocument && documentDraft ? (
              <div className="document-review-panel">
                <div className="document-review-heading">
                  <div>
                    <p className="eyebrow">Review before applying</p>
                    <h3>{selectedDocument.filename}</h3>
                    <p>Extracted values are drafts, not verified facts. Confirm or edit each value using your source document.</p>
                  </div>
                  <span className="status-chip status-unverified">Not verified</span>
                </div>
                <div className="document-status-detail">
                  <span>Status: {selectedDocument.processing_status.replace(/_/g, ' ')}</span>
                  <span>Extraction: {selectedDocument.extraction_status.replace(/_/g, ' ')}</span>
                  <span>OCR: {selectedDocument.ocr_status.replace(/_/g, ' ')}</span>
                </div>
                {(selectedDocument.ocr_status === 'not_configured' || selectedDocument.ocr_status === 'failed')
                  && selectedDocument.extraction_status !== 'encrypted_pdf' ? (
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={documentLoading}
                      onClick={() => void handleReprocessDocument()}
                    >
                      {documentLoading ? 'Processing document…' : 'Retry local OCR'}
                    </button>
                  ) : null}
                <p className="document-hash">SHA-256: {selectedDocument.sha256 ?? 'Unavailable for earlier metadata-only records'}</p>
                {selectedDocument.warnings.map((warning) => (
                  <p key={warning} className="inline-notice">{warning}</p>
                ))}
                {Object.entries(selectedDocument.extraction_evidence ?? {}).length ? (
                  <div className="source-evidence">
                    <h4>Source excerpts</h4>
                    <ul>
                      {Object.entries(selectedDocument.extraction_evidence ?? {}).map(([field, excerpts]) => (
                        <li key={field}>
                          <span className="font-medium">{field.replace(/_/g, ' ')} ({(selectedDocument.extraction_methods?.[field] ?? 'extracted').replace(/_/g, ' ')}): </span>
                          {excerpts.map((excerpt, index) => (
                            <span key={`${field}-${index}`} className="mr-1">“{excerpt}”</span>
                          ))}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : <p className="mt-3 text-sm text-slate-600">No source excerpts are available for this draft.</p>}
                <div className="review-table-wrap">
                  <table className="review-table">
                    <thead><tr><th scope="col">Field</th><th scope="col">Extracted draft</th><th scope="col">Reviewed value</th></tr></thead>
                    <tbody>
                      {([
                        ['student_name', 'Student name', 'text'],
                        ['institution', 'Institution', 'text'],
                        ['qualification', 'Qualification', 'text'],
                        ['marks', 'Marks', 'number'],
                        ['maximum_marks', 'Maximum marks', 'number'],
                        ['percentage', 'Percentage (%)', 'number'],
                        ['examination_year', 'Examination year', 'number'],
                        ['cgpa', 'CGPA (unconverted)', 'number'],
                      ] as Array<[keyof AcademicDocumentFields, string, 'text' | 'number']>).map(([field, label, inputType]) => (
                        <tr key={field}>
                          <th scope="row">{label}</th>
                          <td>{selectedDocument.extracted_fields[field] ?? 'Not extracted'}</td>
                          <td>
                            <label className="sr-only" htmlFor={`review-${field}`}>Reviewed {label}</label>
                            <input
                              id={`review-${field}`}
                              aria-label={`Review document ${label.toLowerCase()}`}
                              type={inputType}
                              min={inputType === 'number' ? '0' : undefined}
                              max={field === 'percentage' ? '100' : field === 'examination_year' ? '2100' : undefined}
                              step={inputType === 'number' ? 'any' : undefined}
                              value={documentDraft[field] ?? ''}
                              onChange={(event) => handleReviewDocumentField(field, event.target.value)}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button
                  type="button"
                  disabled={documentLoading || selectedDocument.status === 'reviewed'}
                  onClick={handleApplyDocumentReview}
                  className="button button-primary mt-4"
                >
                  {selectedDocument.status === 'reviewed' ? 'Reviewed fields applied' : 'Apply these reviewed fields to my profile'}
                </button>
              </div>
            ) : null}
          </div>
        </section>

        <section className="card">
          <div className="intake-card-heading">
            <div>
              <p className="eyebrow">Optional guided setup</p>
              <h2>AI profile intake</h2>
              <p>Share admissions-relevant details only. Do not enter passwords, Aadhaar numbers, or other sensitive identifiers.</p>
            </div>
            <span className="status-chip status-information">
              {aiStatus?.profile_intake_enabled && !intakeProviderUnavailable ? 'Local Ollama configured' : 'Guided form available'}
            </span>
          </div>
          {aiStatus?.profile_intake_enabled && !intakeProviderUnavailable ? (
            <form className="intake-form" onSubmit={handleProfileIntake}>
              <label className="field-group">
                <span>Academic background and preferences</span>
                <textarea
                  id="profile-intake-description"
                  required
                  minLength={20}
                  maxLength={5000}
                  value={intakeDescription}
                  onChange={(event) => setIntakeDescription(event.target.value)}
                  placeholder="Describe your stream, interests, preferred courses, and approximate annual budget. Do not include passwords or government identifiers."
                  aria-describedby="intake-privacy-helper"
                />
                <small id="intake-privacy-helper">Local Ollama only. Extracted information is shown for review and is not saved until you apply it.</small>
              </label>
              <button disabled={loading} className="button button-primary">
                {loading ? 'Extracting for review…' : 'Extract profile for review'}
              </button>
            </form>
          ) : (
            <form className="guided-intake" onSubmit={handleGuidedProfileReview}>
              <div className="guided-stepper" aria-label={`Guided profile step ${guidedStep + 1} of 3`}>
                <div className="guided-progress"><span style={{ width: `${((guidedStep + 1) / 3) * 100}%` }} /></div>
                <p>Step {guidedStep + 1} of 3 · {['Academic background', 'Interests and goals', 'Courses and budget'][guidedStep]}</p>
              </div>
              {guidedStep === 0 ? (
                <div className="guided-fields">
                  <label className="field-group">Academic background
                    <textarea value={guidedProfile.academic_background} onChange={(event) => setGuidedProfile({ ...guidedProfile, academic_background: event.target.value })} maxLength={1000} placeholder="e.g. Completed Grade 12 in science" />
                    <small>Do not include student numbers or government identifiers.</small>
                  </label>
                  <label className="field-group">Stream
                    <input value={guidedProfile.stream} onChange={(event) => setGuidedProfile({ ...guidedProfile, stream: event.target.value })} maxLength={100} />
                  </label>
                  <label className="field-group">Board
                    <input value={guidedProfile.board} onChange={(event) => setGuidedProfile({ ...guidedProfile, board: event.target.value })} maxLength={100} />
                  </label>
                  <label className="field-group">Academic percentage
                    <input type="number" min="0" max="100" step="any" value={guidedProfile.academic_score} onChange={(event) => setGuidedProfile({ ...guidedProfile, academic_score: event.target.value })} />
                    <small>Percentage only; CGPA conversion is not currently supported.</small>
                  </label>
                </div>
              ) : null}
              {guidedStep === 1 ? (
                <div className="guided-fields">
                  <label className="field-group">Interests
                    <input value={guidedProfile.interests} onChange={(event) => setGuidedProfile({ ...guidedProfile, interests: event.target.value })} placeholder="Separate interests with commas" />
                  </label>
                  <label className="field-group">Career goal
                    <input value={guidedProfile.career_goal} onChange={(event) => setGuidedProfile({ ...guidedProfile, career_goal: event.target.value })} maxLength={500} placeholder="A short goal or area you are exploring" />
                  </label>
                </div>
              ) : null}
              {guidedStep === 2 ? (
                <div className="guided-fields">
                  <label className="field-group">Preferred courses
                    <input value={guidedProfile.preferred_courses} onChange={(event) => setGuidedProfile({ ...guidedProfile, preferred_courses: event.target.value })} placeholder="Separate courses with commas" />
                  </label>
                  <label className="field-group">Annual budget (INR)
                    <div className="input-with-unit"><span>₹</span><input type="text" inputMode="numeric" value={guidedProfile.budget} onChange={(event) => setGuidedProfile({ ...guidedProfile, budget: event.target.value.replace(/[^\d,]/g, '') })} placeholder="e.g. 2,50,000" /></div>
                  </label>
                </div>
              ) : null}
              <div className="guided-actions">
                <button type="button" className="button button-secondary" disabled={guidedStep === 0} onClick={() => setGuidedStep(guidedStep - 1)}>Back</button>
                {guidedStep < 2 ? (
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={() => {
                      if (guidedStep === 0 && !guidedProfile.academic_background.trim() && !guidedProfile.stream.trim() && !guidedProfile.board.trim() && !guidedProfile.academic_score.trim()) {
                        setIntakeError('Enter at least one academic-background field before continuing.');
                        return;
                      }
                      if (guidedStep === 1 && !guidedProfile.interests.trim() && !guidedProfile.career_goal.trim()) {
                        setIntakeError('Enter an interest or career goal before continuing.');
                        return;
                      }
                      setIntakeError(null);
                      setGuidedStep(guidedStep + 1);
                    }}
                  >
                    Continue
                  </button>
                ) : (
                  <button type="submit" className="button button-primary">Review profile fields</button>
                )}
              </div>
            </form>
          )}
          {intakeError ? <p className="form-error mt-3" role="alert">{intakeError}</p> : null}
          {(intakeResult || guidedReviewActive) && reviewedProfile ? (
            <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-sm font-medium text-emerald-950">
                {intakeResult
                  ? `Model-generated by ${intakeResult.provider} (${intakeResult.model}). Not saved yet.`
                  : 'Guided profile entered by you. Review and edit these fields; nothing is saved yet.'}
              </p>
              <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
                <div>
                  <label className="font-semibold" htmlFor="review-academic-background">Academic background</label>
                  <textarea id="review-academic-background" aria-label="Review academic background" value={reviewedProfile.academic_background ?? ''} onChange={(event) => setReviewedProfile({ ...reviewedProfile, academic_background: event.target.value || null })} className="mt-1 w-full rounded-lg border border-emerald-300 bg-white px-2 py-1" />
                </div>
                <div className="grid gap-2">
                  <label className="font-semibold" htmlFor="review-stream">Stream</label>
                  <input id="review-stream" aria-label="Review stream" value={reviewedProfile.stream ?? ''} onChange={(event) => setReviewedProfile({ ...reviewedProfile, stream: event.target.value || null })} className="rounded-lg border border-emerald-300 bg-white px-2 py-1" />
                  <label className="font-semibold" htmlFor="review-board">Board</label>
                  <input id="review-board" aria-label="Review board" value={reviewedProfile.board ?? ''} onChange={(event) => setReviewedProfile({ ...reviewedProfile, board: event.target.value || null })} className="rounded-lg border border-emerald-300 bg-white px-2 py-1" />
                </div>
                <div>
                  <label className="font-semibold" htmlFor="review-academic-score">Academic score</label>
                  <input id="review-academic-score" aria-label="Review academic score" type="number" min="0" max="100" value={reviewedProfile.academic_score ?? ''} onChange={(event) => setReviewedProfile({ ...reviewedProfile, academic_score: event.target.value === '' ? null : Number(event.target.value) })} className="mt-1 w-full rounded-lg border border-emerald-300 bg-white px-2 py-1" />
                </div>
                <div>
                  <label className="font-semibold" htmlFor="review-budget">Budget</label>
                  <input id="review-budget" aria-label="Review budget" type="number" min="0" value={reviewedProfile.budget ?? ''} onChange={(event) => setReviewedProfile({ ...reviewedProfile, budget: event.target.value === '' ? null : Number(event.target.value) })} className="mt-1 w-full rounded-lg border border-emerald-300 bg-white px-2 py-1" />
                </div>
                <div>
                  <label className="font-semibold" htmlFor="review-career-goal">Career goal</label>
                  <input id="review-career-goal" aria-label="Review career goal" value={reviewedProfile.career_goal ?? ''} onChange={(event) => setReviewedProfile({ ...reviewedProfile, career_goal: event.target.value || null })} className="mt-1 w-full rounded-lg border border-emerald-300 bg-white px-2 py-1" />
                </div>
                <div>
                  <label className="font-semibold" htmlFor="review-interests">Interests (comma-separated)</label>
                  <input id="review-interests" aria-label="Review interests" value={reviewedProfile.interests.join(', ')} onChange={(event) => setReviewedProfile({ ...reviewedProfile, interests: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} className="mt-1 w-full rounded-lg border border-emerald-300 bg-white px-2 py-1" />
                </div>
                <div>
                  <label className="font-semibold" htmlFor="review-preferred-courses">Preferred courses (comma-separated)</label>
                  <input id="review-preferred-courses" aria-label="Review preferred courses" value={reviewedProfile.preferred_courses.join(', ')} onChange={(event) => setReviewedProfile({ ...reviewedProfile, preferred_courses: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} className="mt-1 w-full rounded-lg border border-emerald-300 bg-white px-2 py-1" />
                </div>
                <div className="md:col-span-2">
                  <p className="font-semibold">Exam scores / percentiles</p>
                  {Object.entries(reviewedProfile.exam_scores).length ? (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {Object.entries(reviewedProfile.exam_scores).map(([exam, score]) => (
                        <label className="field-group" key={exam} htmlFor={`review-exam-${exam.replace(/\W/g, '-')}`}>
                          {exam} score / percentile
                          <input
                            id={`review-exam-${exam.replace(/\W/g, '-')}`}
                            type="number"
                            min="0"
                            max="100"
                            step="any"
                            value={score}
                            onChange={(event) => handleReviewedExamScore(exam, event.target.value)}
                          />
                        </label>
                      ))}
                    </div>
                  ) : <p className="text-sm text-slate-600">Not provided</p>}
                </div>
                {intakeResult ? (
                  <>
                    <div className="md:col-span-2"><dt className="font-semibold">Clarification questions</dt><dd>{intakeResult.profile.clarification_questions.join(' ') || 'None'}</dd></div>
                    <div className="md:col-span-2"><dt className="font-semibold">Missing information</dt><dd>{intakeResult.profile.missing_information.join(', ') || 'None identified'}</dd></div>
                  </>
                ) : null}
              </dl>
              <button
                type="button"
                disabled={loading || intakeApplied}
                onClick={handleConfirmIntake}
                className="mt-4 rounded-xl bg-emerald-700 px-4 py-2.5 font-medium text-white disabled:opacity-60"
              >
                {intakeApplied ? 'Reviewed fields saved' : 'Apply these reviewed fields to my profile'}
              </button>
            </div>
          ) : null}
        </section>
        </div>
        ) : null}

        {activePage === 'eligibility' ? (
        <section id="eligibility" className="eligibility-page">
          <section className="eligibility-search-panel" aria-labelledby="eligibility-page-title">
            <div className="eligibility-page-heading">
              <div>
                <p className="eyebrow">College and course eligibility guidance</p>
                <h2 id="eligibility-page-title">Find your eligibility</h2>
                <p>College and course eligibility guidance compares institution-provided criteria with your saved student profile. Results are guidance only and never guarantee admission.</p>
              </div>
              <button type="button" className="button button-secondary" disabled={eligibilityRefreshLoading} onClick={() => void refreshEligibilityData()}>
                {eligibilityRefreshLoading ? 'Refreshing…' : 'Refresh eligibility data'}
              </button>
            </div>
            {eligibilityRefreshError ? <p className="eligibility-message eligibility-message-error" role="alert">{eligibilityRefreshError}</p> : null}
            {eligibilityRefreshSuccess ? <p className="eligibility-message eligibility-message-success" role="status">{eligibilityRefreshSuccess}</p> : null}
            {eligibilityRefreshLoading ? <p className="eligibility-loading" role="status" aria-busy="true">Loading the latest eligibility data…</p> : null}
            <form className="eligibility-search-form" onSubmit={handleEligibilitySearch}>
              <label className="field-group">
                College / University
                <input type="search" value={eligibilitySearch} onChange={(event) => setEligibilitySearch(event.target.value)} placeholder="Search institution" />
              </label>
              <label className="field-group">
                Course / Branch
                <input type="search" value={eligibilityCourseSearch} onChange={(event) => setEligibilityCourseSearch(event.target.value)} placeholder="Search course or branch" />
              </label>
              <label className="field-group">
                Location
                <input type="search" value={eligibilityLocationSearch} onChange={(event) => setEligibilityLocationSearch(event.target.value)} placeholder="City or region" />
              </label>
              <label className="field-group">
                Eligibility status
                <select value={eligibilityStatusFilter} onChange={(event) => setEligibilityStatusFilter(event.target.value)}>
                  <option value="all">All statuses</option>
                  <option value="eligible">Eligible</option>
                  <option value="ineligible">Not eligible</option>
                  <option value="needs_information">Needs more information</option>
                </select>
              </label>
              <div className="eligibility-search-actions">
                <button type="submit" className="button button-primary">Search</button>
                <button type="button" className="button button-secondary" onClick={clearEligibilityFilters}>Clear filters</button>
              </div>
            </form>
          </section>

          {institutionSuppliedRecommendations.length === 0 ? (
            <section className="eligibility-empty-state" aria-labelledby="eligibility-empty-title">
              <span className="eligibility-empty-icon" aria-hidden="true"><Icon name="eligibility" size={24} /></span>
              <div>
                <p className="eyebrow">Verified criteria unavailable</p>
                <h3 id="eligibility-empty-title">No verified institution criteria are available yet</h3>
                <p>We’ll show eligibility results when institutions configure criteria. Sample or illustrative data cannot determine your actual eligibility. The search remains ready for when verified data is published.</p>
                <button type="button" className="button button-primary" disabled={eligibilityRefreshLoading} onClick={() => void refreshEligibilityData()}>
                  {eligibilityRefreshLoading ? 'Refreshing…' : 'Refresh eligibility data'}
                </button>
              </div>
            </section>
          ) : (
            <section className="eligibility-results-section" aria-labelledby="eligibility-results-title">
              <div className="eligibility-results-heading">
                <div>
                  <p className="eyebrow">Institution-reported information</p>
                  <h3 id="eligibility-results-title">College &amp; course results</h3>
                </div>
                <span>{uniqueInstitutionRecommendations.length} matching program{uniqueInstitutionRecommendations.length === 1 ? '' : 's'}</span>
              </div>
              {uniqueInstitutionRecommendations.length ? (
                <div className="eligibility-program-grid">
                  {uniqueInstitutionRecommendations.map((program) => {
                    const statusClass = program.eligibility_status === 'eligible'
                      ? 'eligibility-status-eligible'
                      : program.eligibility_status === 'ineligible'
                        ? 'eligibility-status-ineligible'
                        : 'eligibility-status-information';
                    const examRequirement = program.criteria.examination_type
                      ? `${program.criteria.examination_type}${program.criteria.examination_cutoff !== null
                        ? ` ${program.criteria.examination_comparison === 'minimum' ? 'minimum' : 'maximum'} ${program.criteria.examination_cutoff}`
                        : ''}`
                      : null;
                    return (
                      <article className="eligibility-program-card" key={`${program.criteria_id}-${program.program_id}`}>
                        <div className="eligibility-program-card-heading">
                          <div>
                            <span className="eligibility-verified-chip">Institution-supplied · verified</span>
                            <h4>{program.institution}</h4>
                            <p>{program.location || 'Location not provided'}</p>
                          </div>
                          <span className={`eligibility-status-chip ${statusClass}`}>
                            {program.eligibility_status === 'ineligible'
                              ? 'Not eligible'
                              : program.eligibility_status === 'insufficient_data' || program.eligibility_status === 'criteria_unavailable'
                                ? 'Needs more information'
                                : 'Eligible'}
                          </span>
                        </div>
                        <p className="eligibility-program-course">{program.course || program.program}</p>
                        <dl className="eligibility-program-facts">
                          <div>
                            <dt>Required academic percentage</dt>
                            <dd>{program.criteria.minimum_percentage === null ? 'Not specified' : `${program.criteria.minimum_percentage}%`}</dd>
                          </div>
                          <div>
                            <dt>Accepted entrance examination</dt>
                            <dd>{examRequirement ?? 'Not specified'}</dd>
                          </div>
                        </dl>
                        <p className="eligibility-program-explanation">
                          {program.evaluated_criteria.find((item) => item.status !== 'met')?.explanation
                            ?? program.evaluated_criteria[0]?.explanation
                            ?? 'No additional rule explanation was supplied.'}
                        </p>
                        <div className="eligibility-program-footer">
                          <span>Source: {program.source} · Effective year {program.effective_year}</span>
                          <button type="button" className="button button-secondary" onClick={() => setSelectedEligibilityProgram(program)}>
                            View details
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="eligibility-empty-state eligibility-empty-state-small">
                  <h4>No programs match these filters</h4>
                  <p>Adjust your search or clear the filters to see available institution criteria.</p>
                </div>
              )}
            </section>
          )}

          {institutionSuppliedRecommendations.length > 0 ? (
            <section className="eligibility-results-section" aria-labelledby="eligibility-recommendations-title">
              <div className="eligibility-results-heading">
                <div>
                  <p className="eyebrow">Based on your saved profile</p>
                  <h3 id="eligibility-recommendations-title">Recommended Colleges for You</h3>
                  <p>Recommendations include only programs with verified institution criteria that currently assess your profile as eligible.</p>
                </div>
              </div>
              {personalizedEligibilityRecommendations.length ? (
                <div className="eligibility-recommendation-list">
                  {personalizedEligibilityRecommendations.map((program) => {
                    const matchedPreferences = [
                      profile?.preferred_fields.some((course) => (
                        `${program.course} ${program.program}`.toLocaleLowerCase().includes(course.toLocaleLowerCase())
                      )) ? 'preferred course' : null,
                      profile?.location && program.location?.toLocaleLowerCase().includes(profile.location.toLocaleLowerCase()) ? 'preferred location' : null,
                      profile?.stream && program.evaluated_criteria.some((item) => (
                        /stream/i.test(`${item.criterion} ${item.requirement}`) && item.status === 'met'
                      )) ? 'stream requirement' : null,
                      profile?.exam_scores && program.criteria.examination_type
                        && Object.keys(profile.exam_scores).some((exam) => exam.toLocaleLowerCase().includes(program.criteria.examination_type?.toLocaleLowerCase() ?? ''))
                        ? 'recorded exam score' : null,
                    ].filter((item): item is string => Boolean(item));
                    return (
                      <article className="eligibility-recommendation-card" key={`${program.criteria_id}-${program.program_id}`}>
                        <span className="eligibility-recommendation-mark" aria-hidden="true"><Icon name="eligibility" size={19} /></span>
                        <div className="eligibility-recommendation-copy">
                          <h4>{program.institution}</h4>
                          <p>{program.course || program.program}{program.location ? ` · ${program.location}` : ''}</p>
                          <span>{matchedPreferences.length ? `Profile matches: ${matchedPreferences.join(', ')}` : 'Meets the available criteria in your saved profile.'}</span>
                        </div>
                        <button type="button" className="button button-secondary" onClick={() => setSelectedEligibilityProgram(program)}>View details</button>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="eligibility-empty-state eligibility-empty-state-small">
                  <h4>No personalized recommendations yet</h4>
                  <p>Recommendations appear only when verified criteria and your saved profile provide enough information to assess eligibility. No admission probability is estimated.</p>
                  <a className="button button-secondary" href="#profile">Review your profile</a>
                </div>
              )}
            </section>
          ) : null}

          {selectedEligibilityProgram ? (
            <div className="eligibility-modal-backdrop" role="presentation" onMouseDown={(event) => {
              if (event.target === event.currentTarget) setSelectedEligibilityProgram(null);
            }}>
              <section className="eligibility-detail-modal" role="dialog" aria-modal="true" aria-labelledby="eligibility-detail-title">
                <button type="button" className="eligibility-modal-close" aria-label="Close eligibility details" onClick={() => setSelectedEligibilityProgram(null)}>×</button>
                <p className="eyebrow">Institution-supplied verified criteria</p>
                <h3 id="eligibility-detail-title">{selectedEligibilityProgram.institution}</h3>
                <p className="eligibility-detail-subtitle">{selectedEligibilityProgram.course || selectedEligibilityProgram.program}{selectedEligibilityProgram.location ? ` · ${selectedEligibilityProgram.location}` : ''}</p>
                <p className="eligibility-verification-note">The institution marks this criteria record as verified. UniApply-AI does not independently confirm the source. This guidance is not an admission guarantee.</p>
                <div className="eligibility-detail-status">
                  <strong>Personalized result</strong>
                  <span className={`eligibility-status-chip ${
                    selectedEligibilityProgram.eligibility_status === 'eligible'
                      ? 'eligibility-status-eligible'
                      : selectedEligibilityProgram.eligibility_status === 'ineligible'
                        ? 'eligibility-status-ineligible'
                        : 'eligibility-status-information'
                  }`}>
                    {selectedEligibilityProgram.eligibility_status === 'eligible'
                      ? 'Eligible'
                      : selectedEligibilityProgram.eligibility_status === 'ineligible'
                        ? 'Not eligible'
                        : 'Insufficient information'}
                  </span>
                </div>
                <h4>Student academic information</h4>
                <dl className="eligibility-detail-grid">
                  <div><dt>Academic background</dt><dd>{profile?.stream || 'Not provided'}</dd></div>
                  <div><dt>Board</dt><dd>{profile?.board || 'Not provided'}</dd></div>
                  <div><dt>Academic percentage</dt><dd>{profile?.academic_score == null ? 'Not provided' : `${profile.academic_score}%`}</dd></div>
                  <div><dt>Entrance exam scores</dt><dd>{profile?.exam_scores && Object.keys(profile.exam_scores).length
                    ? Object.entries(profile.exam_scores).map(([exam, score]) => `${exam}: ${score}`).join(', ')
                    : 'Not provided'}</dd></div>
                  <div><dt>Preferred courses</dt><dd>{profile?.preferred_fields.length ? profile.preferred_fields.join(', ') : 'Not provided'}</dd></div>
                  <div><dt>Preferred location</dt><dd>{profile?.location || 'Not provided'}</dd></div>
                </dl>
                <h4>Official eligibility criteria and evaluation</h4>
                {selectedEligibilityProgram.evaluated_criteria.length ? (
                  <ul className="eligibility-detail-list">
                    {selectedEligibilityProgram.evaluated_criteria.map((criterion, index) => (
                      <li key={`${criterion.criterion}-${index}`}>
                        <div>
                          <strong>{criterion.requirement}</strong>
                          <span className={`eligibility-rule-status eligibility-rule-${criterion.status}`}>{criterion.status.replace(/_/g, ' ')}</span>
                        </div>
                        <p>{criterion.explanation}</p>
                        {criterion.student_value !== null ? <small>Available student value: {Array.isArray(criterion.student_value) ? criterion.student_value.join(', ') : criterion.student_value}</small> : null}
                      </li>
                    ))}
                  </ul>
                ) : <p className="eligibility-muted">No explicit eligibility rules are available in this record.</p>}
                {selectedEligibilityProgram.missing_info.length ? (
                  <>
                    <h4>Missing information</h4>
                    <ul className="eligibility-missing-list">{selectedEligibilityProgram.missing_info.map((item) => <li key={item}>{item}</li>)}</ul>
                  </>
                ) : null}
                <dl className="eligibility-detail-grid eligibility-source-grid">
                  <div><dt>Criteria source</dt><dd>{selectedEligibilityProgram.source || 'Not provided'}</dd></div>
                  <div><dt>Effective year</dt><dd>{selectedEligibilityProgram.effective_year || 'Not provided'}</dd></div>
                  <div><dt>Last verified date</dt><dd>Not provided by the eligibility API</dd></div>
                </dl>
              </section>
            </div>
          ) : null}
          <NationalExamCutoffLookup token={token} />
          <CollegeCutoffLookup token={token} />
          <MhtcetRecommendations token={token} />
        </section>
        ) : null}

        {activePage === 'explore' ? (
          <ExploreApplyPage
            token={token}
            profile={profile}
            verifiedRecommendations={institutionSuppliedRecommendations}
          />
        ) : null}

        {activePage === 'ai-predictor' ? (
          <AICollegePredictor
            token={token}
            profile={profile}
            onProfileUpdated={setProfile}
            onAskAboutCollege={(collegeId) => {
              setAIChatCollegeContext(collegeId);
              setAIChatOpen(true);
            }}
          />
        ) : null}

        {activePage === 'interview' ? (
          <section id="interview" className="grid gap-6">
          <div className="card">
            <h2 className="text-xl font-semibold">Interactive interview practice</h2>
            <p className="mt-2 text-sm text-slate-600">
              Join a solo AI-led video practice room. Questions are spoken aloud, and you can answer by voice or text. Your camera preview stays on this device; video is not recorded or uploaded. This is not a live call with a person.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block text-sm font-medium text-slate-700">
                Program or course
                <input
                  required
                  maxLength={200}
                  value={interviewProgram}
                  onChange={(event) => setInterviewProgram(event.target.value)}
                  placeholder="e.g. Synthetic Data Science Program"
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
                />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Interview type
                <select
                  value={interviewType}
                  onChange={(event) => {
                    const selectedType = event.target.value as InterviewSession['interview_type'];
                    setInterviewType(selectedType);
                    const matchingTrack = interviewTracks.find((track) => track.interviewType === selectedType);
                    if (matchingTrack) setInterviewTrack(matchingTrack.id);
                  }}
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
                >
                  <option value="general">General</option>
                  <option value="technical">Technical</option>
                  <option value="behavioral">Behavioral</option>
                  <option value="admissions">Admissions</option>
                </select>
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Practice track
                <select
                  value={interviewTrack}
                  onChange={(event) => {
                    setInterviewTrack(event.target.value);
                    const selectedTrack = interviewTracks.find((track) => track.id === event.target.value);
                    if (selectedTrack) setInterviewType(selectedTrack.interviewType);
                  }}
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
                >
                  {interviewTracks.map((track) => <option key={track.id} value={track.id}>{track.label}</option>)}
                </select>
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Number of questions
                <select
                  value={interviewQuestionCount}
                  onChange={(event) => setInterviewQuestionCount(Number(event.target.value))}
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
                >
                  {[3, 5, 7].map((count) => <option key={count} value={count}>{count} questions</option>)}
                </select>
              </label>
            </div>
            <aside className="question-bank-preview">
              <p><strong>Sample question bank · {interviewTracks.find((track) => track.id === interviewTrack)?.label}</strong></p>
              <p>These are preparation examples, not promised session questions. The active session continues to use the configured server provider or its disclosed deterministic fallback.</p>
              <ul>
                {(interviewTracks.find((track) => track.id === interviewTrack) ?? interviewTracks[0]).questions.map((question) => <li key={question}>{question}</li>)}
              </ul>
            </aside>
            <button
              type="button"
              onClick={handleInterview}
              disabled={interviewLoading || !interviewProgram.trim()}
              className="mt-4 w-full rounded-xl bg-indigo-600 px-4 py-2.5 font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {interviewLoading ? 'Starting practice…' : 'Start a new practice session'}
            </button>
            {interviewError ? <p role="alert" className="mt-3 text-sm text-red-700">{interviewError}</p> : null}
            {interview ? (
              <div className="mt-5 space-y-4">
                <div className="rounded-xl bg-slate-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-semibold">{interview.program}</p>
                      <p className="text-sm capitalize text-slate-600">{interview.interview_type} practice · {interview.status.replace(/_/g, ' ')}</p>
                    </div>
                    <p className="text-sm text-slate-600">
                      Progress: {answeredInterviewQuestions}/{interview.question_count} answered
                    </p>
                  </div>
                  <div
                    className="interview-progress-track"
                    role="progressbar"
                    aria-label="Interview question progress"
                    aria-valuemin={0}
                    aria-valuemax={interview.question_count}
                    aria-valuenow={answeredInterviewQuestions}
                  >
                    <span style={{ width: `${(answeredInterviewQuestions / interview.question_count) * 100}%` }} />
                  </div>
                  {interview.status === 'in_progress' && activeInterviewQuestion ? (
                    <p className="interview-timer" role="status" aria-live="polite">
                      Time guidance for this question: {String(Math.floor(questionSecondsRemaining / 60)).padStart(2, '0')}:{String(questionSecondsRemaining % 60).padStart(2, '0')}
                      {questionSecondsRemaining === 0 ? ' · No hard time limit; continue at your own pace.' : ''}
                    </p>
                  ) : null}
                </div>

                {interview.status === 'in_progress' && activeInterviewQuestion ? (
                  <section className="interview-video-room" aria-label="AI video interview room">
                    <div className="interview-video-tiles">
                      <article className="interview-video-tile interview-ai-tile">
                        <div className="interview-ai-avatar" aria-hidden="true">AI</div>
                        <p className="interview-tile-label">AI interviewer</p>
                        <p className="interview-tile-caption">Asking one question at a time</p>
                      </article>
                      <article className="interview-video-tile interview-camera-tile">
                        {cameraEnabled ? (
                          <video
                            ref={cameraPreviewRef}
                            autoPlay
                            muted
                            playsInline
                            aria-label="Your live camera preview"
                          />
                        ) : (
                          <div className="interview-camera-placeholder">
                            <span aria-hidden="true">Camera off</span>
                            <span>Your video is not being shared</span>
                          </div>
                        )}
                        <p className="interview-tile-label">You {cameraEnabled ? '· Camera on' : '· Camera off'}</p>
                      </article>
                    </div>
                    <div className="interview-live-question">
                      <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
                        AI interviewer · Question {answeredInterviewQuestions + 1}
                      </p>
                      <p className="mt-2 text-lg font-semibold text-slate-900">{activeInterviewQuestion.question}</p>
                      <div className="interview-room-controls">
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() => speakInterviewQuestion(activeInterviewQuestion.question)}
                        >
                          {interviewSpeaking ? 'Replay question' : 'Hear question'}
                        </button>
                        <button
                          type="button"
                          className="button button-secondary"
                          aria-pressed={cameraEnabled}
                          disabled={cameraLoading}
                          onClick={cameraEnabled ? stopInterviewCamera : startInterviewCamera}
                        >
                          {cameraLoading ? 'Requesting camera…' : cameraEnabled ? 'Turn camera off' : 'Turn camera on'}
                        </button>
                      </div>
                      {cameraError ? <p className="mt-2 text-sm text-red-700" role="alert">{cameraError}</p> : null}
                      <p className="mt-2 text-xs text-slate-500">
                        Camera video stays local and is not recorded or sent to the AI. Only your submitted answer text is used for feedback; browser voice recognition may use its own speech service to create that transcript.
                      </p>
                    </div>
                  </section>
                ) : null}

                {interview.status === 'created' ? (
                  <button
                    type="button"
                    onClick={() => startExistingInterview(interview)}
                    disabled={interviewLoading}
                    className="w-full rounded-xl bg-indigo-600 px-4 py-2.5 font-medium text-white disabled:opacity-60"
                  >
                    {interviewLoading ? 'Starting…' : 'Start this session'}
                  </button>
                ) : null}

                {interview.turns.map((turn, index) => (
                  <article key={`${interview.interview_id}-${index}`} className="rounded-xl border border-slate-200 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Question {index + 1}</p>
                    <p className="mt-1 font-medium text-slate-900" aria-live={turn.answer === null ? 'polite' : undefined}>{turn.question}</p>
                    {turn.answer !== null ? (
                      <div className="mt-3 rounded-lg bg-slate-50 p-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Your answer</p>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{turn.answer}</p>
                      </div>
                    ) : null}
                  </article>
                ))}

                {interview.status === 'in_progress' && activeInterviewQuestion ? (
                  <form onSubmit={handleInterviewAnswer} className="space-y-3">
                    <label className="block text-sm font-medium text-slate-700" htmlFor="interview-answer">
                      Your answer (up to 5,000 characters)
                    </label>
                    <textarea
                      id="interview-answer"
                      required
                      maxLength={5000}
                      rows={5}
                      value={interviewAnswer}
                      onChange={(event) => setInterviewAnswer(event.target.value)}
                      disabled={interviewLoading}
                      className="w-full rounded-xl border border-slate-200 px-3 py-2"
                    />
                    <div className="voice-input-row">
                      <button
                        type="button"
                        className="button button-secondary"
                        aria-pressed={voiceListening}
                        disabled={interviewLoading}
                        onClick={voiceListening ? stopInterviewVoiceInput : startInterviewVoiceInput}
                      >
                        {voiceListening ? 'Stop voice input' : 'Use browser voice input'}
                      </button>
                      <p>Optional voice input uses your browser's speech-recognition service when available. Typing remains available.</p>
                    </div>
                    <button
                      type="submit"
                      disabled={interviewLoading || !interviewAnswer.trim()}
                      className="w-full rounded-xl bg-emerald-700 px-4 py-2.5 font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {interviewLoading ? 'Submitting…' : 'Submit answer'}
                    </button>
                  </form>
                ) : null}

                {interview.status === 'completed' && interview.feedback ? (
                  <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4">
                    <h3 className="font-semibold text-indigo-950">Practice feedback</h3>
                    <p className="mt-1 text-sm text-indigo-900">{interview.feedback.summary}</p>
                    <p className="mt-2 text-xs text-indigo-800">
                      {interview.feedback.generation_mode === 'ollama'
                        ? 'Generated by local Ollama'
                        : interview.feedback.generation_mode === 'openai'
                          ? 'Generated by configured hosted AI'
                          : 'Deterministic practice fallback'}
                      {' · '}Subjective practice only; not a validated measurement.
                    </p>
                    <p className="mt-2 text-xs text-indigo-800">This backend rubric covers relevance, clarity, reasoning, and completeness. It does not measure confidence.</p>
                    <ul className="mt-3 space-y-3">
                      {interview.feedback.dimensions.map((dimension) => (
                        <li key={dimension.dimension} className="rounded-lg bg-white p-3">
                          <p className="font-medium capitalize">{dimension.dimension} · {dimension.score}/5</p>
                          <p className="mt-1 text-sm text-slate-700">{dimension.explanation}</p>
                          <blockquote className="mt-2 border-l-2 border-indigo-300 pl-3 text-xs text-slate-600">
                            Evidence: “{dimension.evidence}”
                          </blockquote>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-3 text-xs text-slate-600">{interview.feedback.disclaimer}</p>
                  </div>
                ) : null}
              </div>
            ) : <p className="mt-5 text-slate-500">No practice session selected.</p>}

            <div className="mt-6 border-t border-slate-200 pt-4">
              <h3 className="font-semibold">Session history</h3>
              {interviewHistory.length ? (
                <ul className="mt-2 space-y-2">
                  {interviewHistory.map((session) => (
                    <li key={session.interview_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 p-3">
                      <span className="text-sm">{session.program} · {session.status.replace(/_/g, ' ')}</span>
                      {session.status === 'created' ? (
                        <button
                          type="button"
                          disabled={interviewLoading}
                          onClick={() => startExistingInterview(session)}
                          className="text-sm font-medium text-indigo-700 disabled:opacity-60"
                        >
                          Start
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={interviewLoading}
                          onClick={() => reviewInterview(session.interview_id)}
                          className="text-sm font-medium text-indigo-700 disabled:opacity-60"
                        >
                          Review
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : <p className="mt-2 text-sm text-slate-500">No saved sessions yet.</p>}
            </div>
          </div>
          </section>
        ) : null}

        {activePage === 'allocation' ? (
        <section id="allocation" className="allocation-dashboard">
          <header className="allocation-page-heading">
            <div>
              <p className="eyebrow">Configured data only</p>
              <h2>Seat allocation simulator</h2>
              <p>Review your profile readiness, rank verified eligible programs, and run the configured simulator. Results are not official admission decisions.</p>
            </div>
            <a className="button button-secondary" href="#profile">Open Profile &amp; Documents</a>
          </header>

          <div className="allocation-summary-grid" aria-label="Allocation readiness summary">
            <article className="allocation-summary-card">
              <span className="allocation-summary-icon"><Icon name="user" size={18} /></span>
              <div>
                <p>Profile completion</p>
                <strong>{profile ? `${profile.completion_percent}%` : 'Unavailable'}</strong>
                {profile ? (
                  <div className="allocation-progress-track" role="progressbar" aria-label="Profile completion" aria-valuemin={0} aria-valuemax={100} aria-valuenow={profile.completion_percent}>
                    <span style={{ width: `${Math.max(0, Math.min(100, profile.completion_percent))}%` }} />
                  </div>
                ) : null}
              </div>
            </article>
            <article className="allocation-summary-card">
              <span className="allocation-summary-icon"><Icon name="document" size={18} /></span>
              <div><p>Academic documents</p><strong>{documents.length} uploaded</strong><span>{documents.filter((item) => item.verification_status === 'verified').length} verified</span></div>
            </article>
            <article className="allocation-summary-card">
              <span className="allocation-summary-icon"><Icon name="eligibility" size={18} /></span>
              <div><p>Verified eligible options</p><strong>{allocationEligiblePrograms.length}</strong><span>Available preference choices</span></div>
            </article>
            <article className="allocation-summary-card">
              <span className="allocation-summary-icon"><Icon name="allocation" size={18} /></span>
              <div>
                <p>Application readiness</p>
                <strong>
                  {profile && profile.completion_percent === 100 && documents.length > 0 && allocationEligiblePrograms.length > 0
                    ? 'Ready to review'
                    : 'Needs attention'}
                </strong>
                <span>Simulation uses saved profile data and configured criteria</span>
              </div>
            </article>
          </div>

          <div className="allocation-tracking-card card">
            <div className="allocation-section-heading">
              <div>
                <p className="eyebrow">Student snapshot</p>
                <h3>Application tracking</h3>
              </div>
              <a href="#profile" className="allocation-text-link">Update profile &amp; documents</a>
            </div>
            {profile ? (
              <div className="allocation-tracking-grid">
                <div><span>Student</span><strong>{profile.full_name || profile.email}</strong></div>
                <div><span>Academic documents</span><strong>{documents.length === 0 ? 'None uploaded' : `${documents.length} uploaded · ${documents.filter((item) => item.verification_status === 'verified').length} verified`}</strong></div>
                <div><span>Eligibility status</span><strong>{allocationEligiblePrograms.length ? `${allocationEligiblePrograms.length} verified eligible program${allocationEligiblePrograms.length === 1 ? '' : 's'}` : 'No verified eligible criteria available'}</strong></div>
                <div><span>Simulation readiness</span><strong>{allocationEligiblePrograms.length ? 'Select program preferences to continue' : 'Waiting for verified program criteria'}</strong></div>
              </div>
            ) : <p className="allocation-empty-note">Student profile data is not available yet.</p>}
            <p className="allocation-data-note">Document uploads and profile completion are shown for readiness context. The current allocation API evaluates saved profile fields and configured program criteria; it does not use document files to decide allocation.</p>
          </div>

          <div className="allocation-simulation-card card">
            <div className="allocation-section-heading">
              <div>
                <p className="eyebrow">Profile-backed inputs</p>
                <h3>Configure your simulation</h3>
              </div>
              <span className="allocation-max-badge">Up to {MAX_STUDENT_PREFERENCES} preferences</span>
            </div>
            <p className="allocation-data-note">The simulator uses your saved profile and configured program criteria. Only the optional category override and ordered verified program IDs are accepted as simulation inputs. Other fields below are shown from your profile where available and are not separate API overrides.</p>
            <div className="allocation-input-grid">
              <label>
                Entrance examination
                <select value={allocationExam} onChange={(event) => setAllocationExam(event.target.value)}>
                  {Object.keys(allocationExamAliases).map((exam) => <option key={exam} value={exam}>{exam}</option>)}
                </select>
              </label>
              <label>
                Saved entrance score / percentile
                <input
                  readOnly
                  value={Object.entries(profile?.exam_scores ?? {}).find(([name]) => (
                    allocationExamAliases[allocationExam].some((alias) => name.toLocaleLowerCase().includes(alias))
                  ))?.[1] ?? ''}
                  placeholder="Not saved in profile"
                />
              </label>
              <label>
                Saved academic percentage
                <input readOnly value={profile?.academic_score ?? ''} placeholder="Not saved in profile" />
              </label>
              <label>
                Category override
                <select value={allocationCategoryOverride} onChange={(event) => setAllocationCategoryOverride(event.target.value)}>
                  <option value="">Use saved profile category</option>
                  {[profile?.reservation_category, 'General', 'EWS', 'OBC-NCL', 'SC', 'ST']
                    .filter((category, index, all): category is string => Boolean(category) && all.indexOf(category) === index)
                    .map((category) => <option key={category} value={category}>{category}</option>)}
                </select>
              </label>
              <label>
                Preferred branch / course
                <input readOnly value={profile?.preferred_fields.join(', ') ?? ''} placeholder="Not set in profile" />
              </label>
              <label>
                Preferred city
                <input readOnly value={profile?.location ?? ''} placeholder="Not set in profile" />
              </label>
              <label>
                Seat pool / quota
                <input readOnly value="Not supported by the configured API" />
              </label>
              <label>
                Admission year
                <input readOnly value={profile?.admission_year ?? ''} placeholder="Not set in profile" />
              </label>
            </div>
            <p className="allocation-input-caveat">Exam rank is not a separate saved profile field. A displayed score is informational; the simulator reads all relevant saved profile scores against each program’s configured criteria.</p>

            <div className="allocation-preference-picker">
              <label htmlFor="allocation-program-choice">Add a verified eligible program</label>
              <div className="allocation-picker-row">
                <select
                  id="allocation-program-choice"
                  value={selectedAllocationProgramId}
                  onChange={(event) => setSelectedAllocationProgramId(event.target.value)}
                  disabled={!allocationEligiblePrograms.length || allocationPreferenceIds.length >= MAX_STUDENT_PREFERENCES}
                >
                  <option value="">Choose a college and course</option>
                  {allocationEligiblePrograms.map((program) => (
                    <option key={program.program_id} value={program.program_id}>
                      {program.institution} · {program.course || program.program} · {program.program_id}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="button button-primary"
                  disabled={!selectedAllocationProgramId || allocationPreferenceIds.includes(selectedAllocationProgramId) || allocationPreferenceIds.length >= MAX_STUDENT_PREFERENCES}
                  onClick={() => {
                    if (!allocationEligiblePrograms.some((program) => program.program_id === selectedAllocationProgramId)) {
                      setAllocationPreferenceError('Choose a program from the verified eligible results.');
                      return;
                    }
                    setAllocationPreferences([...allocationPreferenceIds, selectedAllocationProgramId].join('\n'));
                    setAllocationPreferenceError(null);
                    setAllocationError(null);
                  }}
                >
                  Add preference
                </button>
              </div>
              {!allocationEligiblePrograms.length ? (
                <div className="allocation-empty-state">
                  <strong>No verified eligible program options are available.</strong>
                  <span>Preferences are disabled until institution-supplied verified criteria produce eligible results. Sample programs cannot be used for a student allocation simulation.</span>
                  <a href="#eligibility">Review Eligibility</a>
                </div>
              ) : null}
            </div>

            <div className="allocation-preference-heading">
              <h4>College preferences</h4>
              <span>{allocationPreferenceIds.length} / {MAX_STUDENT_PREFERENCES}</span>
            </div>
            <p className="allocation-data-note">Drag to reorder, or use the move controls. Preference order is sent to the configured simulator.</p>
            {allocationPreferenceIds.length ? (
              <ol className="allocation-preference-list" aria-label="Ranked program preferences">
                {allocationPreferenceIds.map((programId, index) => {
                  const program = allocationEligiblePrograms.find((item) => item.program_id === programId);
                  return (
                    <li
                      className={`allocation-preference-item ${draggedPreferenceId === programId ? 'is-dragging' : ''}`}
                      key={programId}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', programId);
                        setDraggedPreferenceId(programId);
                      }}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        const draggedId = event.dataTransfer.getData('text/plain') || draggedPreferenceId;
                        if (draggedId) moveAllocationPreference(draggedId, index);
                        setDraggedPreferenceId(null);
                      }}
                      onDragEnd={() => setDraggedPreferenceId(null)}
                    >
                      <span className="preference-rank" aria-label={`Preference priority ${index + 1}`}>{index + 1}</span>
                      <div className="preference-program">
                        <strong>{program?.institution ?? 'Verified institution'}</strong>
                        <span>{program?.course || program?.program} · Program ID: {programId}</span>
                      </div>
                      <div className="preference-actions">
                        <button type="button" className="icon-button" disabled={index === 0} aria-label={`Move preference ${index + 1} up`} onClick={() => moveAllocationPreference(programId, index - 1)}>↑</button>
                        <button type="button" className="icon-button" disabled={index === allocationPreferenceIds.length - 1} aria-label={`Move preference ${index + 1} down`} onClick={() => moveAllocationPreference(programId, index + 1)}>↓</button>
                        <button type="button" className="remove-row-button" aria-label={`Remove ${program?.program ?? programId} from preferences`} onClick={() => {
                          setAllocationPreferences(allocationPreferenceIds.filter((item) => item !== programId).join('\n'));
                          setAllocationError(null);
                        }}>Remove</button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : <p className="allocation-empty-note">Add verified eligible colleges and courses to set your preference order.</p>}
            {allocationPreferenceError ? <p className="form-error mt-2" role="alert">{allocationPreferenceError}</p> : null}
            <button
              type="button"
              onClick={handleAllocation}
              disabled={allocationLoading || allocationHistoryLoading || !allocationPreferenceIds.length || Boolean(allocationPreferenceError)}
              className="button button-primary allocation-run-button"
            >
              {allocationLoading ? 'Running configured simulation…' : 'Run configured allocation simulation'}
            </button>
            {allocationError ? <p className="form-error mt-3" role="alert">{allocationError}</p> : null}
            {allocationLoading ? <p className="allocation-loading-note" role="status">Evaluating your preferences against configured criteria and capacities…</p> : null}
          </div>

          <section id="allocation-results" className="allocation-results-card card" aria-labelledby="allocation-results-title">
            <div className="allocation-section-heading">
              <div>
                <p className="eyebrow">Backend result</p>
                <h3 id="allocation-results-title">Allocation results</h3>
              </div>
              {allocation ? (
                <span className={`allocation-status-badge ${allocation.waitlist_status === 'allocated' ? 'is-allocated' : 'is-not-allocated'}`}>
                  {allocation.waitlist_status === 'allocated' ? 'Allocated in simulation' : 'Not allocated'}
                </span>
              ) : <span className="allocation-status-badge is-pending">Pending simulation</span>}
            </div>
            {allocation ? (
              <>
                <div className="allocation-result-grid">
                  <div><span>Institution</span><strong>{allocation.allocated_college ?? 'No allocation'}</strong></div>
                  <div><span>Course</span><strong>{allocation.allocated_course ?? 'No allocation'}</strong></div>
                  <div><span>Program ID</span><strong>{allocation.allocated_program_id ?? 'Not allocated'}</strong></div>
                  <div><span>Preference number</span><strong>{allocation.preference_rank ?? 'Not allocated'}</strong></div>
                  <div><span>Run date</span><strong>{new Date(allocation.created_at).toLocaleString()}</strong></div>
                  <div><span>Status</span><strong>{allocation.waitlist_status === 'allocated' ? 'Allocated' : 'Not allocated'}</strong></div>
                </div>
                {allocation.unallocated_reason ? (
                  <div className="allocation-reason"><strong>Reason</strong><p>{allocation.unallocated_reason}</p></div>
                ) : null}
                {(() => {
                  const resultProgramIds = allocation.allocated_program_id
                    ? [allocation.allocated_program_id]
                    : allocationPreferenceIds;
                  const resultPrograms = resultProgramIds
                    .map((programId) => allocationEligiblePrograms.find((program) => program.program_id === programId))
                    .filter((program): program is Recommendation => program !== undefined);
                  return resultPrograms.length ? (
                    <div className="allocation-criteria-detail">
                      <h4>Relevant verified eligibility criteria</h4>
                      {resultPrograms.map((program) => (
                        <article key={program.program_id}>
                          <h5>{program.institution} · {program.course || program.program}</h5>
                          <p>Program ID: {program.program_id}</p>
                          <ul>
                            {program.evaluated_criteria.map((criterion, index) => (
                              <li key={`${criterion.criterion}-${index}`}><strong>{criterion.criterion}:</strong> {criterion.requirement} · {criterion.status}</li>
                            ))}
                          </ul>
                          <small>Criteria source: {program.source || 'Not provided by the configured data source'}</small>
                        </article>
                      ))}
                    </div>
                  ) : null;
                })()}
                <div className="allocation-explanation">
                  <h4>Why this result</h4>
                  <ul>
                    {[...allocation.explanation, ...allocation.reasons].filter((reason, index, all) => all.indexOf(reason) === index).map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}
                  </ul>
                </div>
                {Object.keys(allocation.seats_remaining).length ? (
                  <div className="allocation-seat-summary">
                    <h4>Configured capacity remaining after this run</h4>
                    <ul>{Object.entries(allocation.seats_remaining).map(([programId, remaining]) => (
                      <li key={programId}><span>{programId}</span><strong>{remaining}</strong></li>
                    ))}</ul>
                  </div>
                ) : null}
                {allocation.notes.length ? <p className="allocation-data-note">{allocation.notes.join(' ')}</p> : null}
                <p className="allocation-result-disclaimer">A simulated result is not a confirmed seat, waitlist position, or official admission offer.</p>
                <p className="allocation-result-metadata">Run {allocation.run_id} · {allocation.algorithm_version}</p>
              </>
            ) : (
              <div className="allocation-empty-state">
                <strong>No simulation result yet.</strong>
                <span>Run the configured simulator after selecting verified eligible programs. No seat capacity, quota, or result is assumed.</span>
              </div>
            )}
          </section>

          <section className="allocation-history-card card" aria-labelledby="allocation-history-title">
            <div className="allocation-section-heading">
              <div>
                <p className="eyebrow">Retrieved from backend by run ID</p>
                <h3 id="allocation-history-title">Allocation history</h3>
              </div>
            </div>
            <p className="allocation-data-note">This browser stores only the IDs and preference order of your recent runs; each result is fetched from the backend. The current API does not provide a server-side list of all past runs.</p>
            {allocationHistoryLoading ? <p className="allocation-loading-note" role="status">Loading saved simulation runs…</p> : null}
            {allocationHistoryError ? <p className="form-error" role="alert">{allocationHistoryError}</p> : null}
            {allocationHistory.length ? (
              <ul className="allocation-history-list">
                {allocationHistory.map((entry) => (
                  <li key={entry.result.run_id}>
                    <div>
                      <strong>{new Date(entry.result.created_at).toLocaleString()}</strong>
                      <span>{entry.result.waitlist_status === 'allocated'
                        ? `${entry.result.allocated_college ?? 'Institution'} · ${entry.result.allocated_course ?? 'Course'}`
                        : 'Not allocated in this simulation'}</span>
                      <small>{entry.preferences.map((programId) => {
                        const program = allocationEligiblePrograms.find((item) => item.program_id === programId);
                        return program ? `${program.institution} · ${program.course || program.program}` : programId;
                      }).join(' → ')}</small>
                    </div>
                    <button type="button" className="button button-secondary" onClick={() => {
                      setAllocation(entry.result);
                      setAllocationPreferences(entry.preferences.join('\n'));
                      setAllocationError(null);
                      document.getElementById('allocation-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}>View results</button>
                  </li>
                ))}
              </ul>
            ) : !allocationHistoryLoading ? (
              <p className="allocation-empty-note">No saved simulation runs are indexed in this browser.</p>
            ) : null}
          </section>

          <div className="card stable-matching-demo allocation-demo-card">
            <div className="stable-matching-heading">
              <div>
                <p className="eyebrow">Synthetic cohort only</p>
                <h3>Gale–Shapley stable matching demonstration</h3>
                <p>This separate educational exercise uses fictional applicants, preferences, institution priorities, and seat capacities. It is never mixed with your backend allocation results.</p>
              </div>
              <button type="button" className="button button-primary" onClick={handleRunStableMatchingDemo}>Run demonstration</button>
            </div>
            <div className="allocation-demo-inputs">
              <div>
                <h4>Synthetic applicant preferences</h4>
                <ul>{stableMatchingDemoStudents.map((student) => (
                  <li key={student.id}><strong>{student.id.replace('sample-student-', 'Applicant ').toUpperCase()}</strong><span>{student.preferences.map((programId) => stableMatchingDemoLabels[programId]).join(' → ')}</span></li>
                ))}</ul>
              </div>
              <div>
                <h4>Synthetic institution priorities &amp; seats</h4>
                <ul>{stableMatchingDemoPrograms.map((program) => (
                  <li key={program.id}><strong>{stableMatchingDemoLabels[program.id]} · {program.capacity} seat</strong><span>Priority: {program.priority.map((studentId) => studentId.replace('sample-student-', 'Applicant ').toUpperCase()).join(' → ')}</span></li>
                ))}</ul>
              </div>
            </div>
            {stableMatchingDemo ? (
              <div className="stable-matching-results" aria-live="polite">
                <div>
                  <h4>Synthetic final matching</h4>
                  <ul className="stable-assignment-list">
                    {stableMatchingDemo.assignments.map((assignment) => (
                      <li key={assignment.studentId}>
                        <strong>{assignment.studentId.replace('sample-student-', 'Applicant ').toUpperCase()}</strong>
                        <span>{assignment.programId ? stableMatchingDemoLabels[assignment.programId] : 'Unmatched'}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4>Proposals, holds &amp; rejections ({stableMatchingDemo.auditTrail.length} steps)</h4>
                  <ol className="stable-audit-list">
                    {stableMatchingDemo.auditTrail.map((event) => (
                      <li key={event.step}>
                        <span>{event.step}</span>
                        <p><strong>{event.studentId.replace('sample-student-', 'Applicant ').toUpperCase()}</strong> · {event.action} {event.programId ? stableMatchingDemoLabels[event.programId] ?? event.programId : ''}</p>
                        <small>{event.detail}</small>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            ) : <p className="empty-inline">Run the synthetic demonstration to see proposals, holds, rejections, and final matching results.</p>}
          </div>
        </section>
        ) : null}
        {activePage === 'privacy' ? (
          <section className="privacy-page">
            <section className="card privacy-notice-card" aria-labelledby="privacy-title">
              <p className="eyebrow">Student data and choices</p>
              <h2 id="privacy-title">DPDP notice and consent</h2>
              <div className="privacy-notice-grid">
                <article>
                  <h3>Data and purpose</h3>
                  <p>The portal may process the profile details, academic scores, uploaded document metadata and extracted fields, preferences, and interview answers you provide. They support admissions guidance and interview practice.</p>
                </article>
                <article>
                  <h3>AI and external services</h3>
                  <p>
                    {aiStatus
                      ? `Configured AI provider: ${aiStatus.configured_provider}. Active provider: ${aiStatus.active_provider}. ${aiStatus.message}`
                      : 'AI provider status is loading.'}
                    {' '}Admission AI chat is available only with loopback Ollama; chat messages and the profile context used to answer them are stored with your account. Clear a conversation from the chat panel or delete your account to remove its records. Document OCR uses local Tesseract/PyMuPDF processing when configured; document contents are not sent to an external OCR service. DigiLocker is an external official-website link; UniApply-AI does not collect credentials or receive documents automatically. Aadhaar, ABC, NTA, and ZKP are not connected.
                  </p>
                </article>
                <article>
                  <h3>Accuracy and retention</h3>
                  <p>Sample cutoffs and practice feedback are not official admissions decisions or verified assessments. Production retention periods and service-operator contact details must be supplied by the operator; this page does not claim they are configured.</p>
                </article>
                <article>
                  <h3>Your controls</h3>
                  <p>Download the account data currently loaded in this app or request account deletion below. The JSON export does not include original uploaded file contents.</p>
                </article>
              </div>
              <label className="privacy-consent">
                <input
                  type="checkbox"
                  checked={privacyAcknowledged}
                  onChange={(event) => setPrivacyAcknowledged(event.target.checked)}
                  aria-describedby="privacy-consent-helper"
                />
                <span>I have read this notice and consent to using this portal for the purposes described above.</span>
              </label>
              <p id="privacy-consent-helper" className="privacy-helper">This acknowledgment is held only in this page's memory. It is not sent to or recorded by the backend and is not a production consent record.</p>
              {privacyAcknowledged ? <p className="privacy-acknowledgement" role="status">Acknowledgment active for this page session only; no server-side consent was recorded.</p> : null}
            </section>
            <section className="card privacy-actions-card" aria-labelledby="privacy-actions-title">
              <h2 id="privacy-actions-title">Manage your account data</h2>
              <div className="privacy-action-row">
                <div>
                  <h3>Download available data</h3>
                  <p>Creates a JSON file with profile, document and application records, eligibility guidance, interview sessions, allocation runs, AI recommendation history, saved colleges, and AI chat history.</p>
                </div>
                <button type="button" className="button button-secondary" onClick={() => void handlePrivacyExport()} disabled={!profile || privacyExportLoading}>{privacyExportLoading ? 'Preparing…' : 'Download JSON'}</button>
              </div>
              <div className="privacy-action-row privacy-delete-row">
                <div>
                  <h3>Delete account and owned records</h3>
                  <p>Uses the existing account deletion endpoint. The app will ask you to confirm before requesting deletion.</p>
                </div>
                <button type="button" className="button button-danger" onClick={() => void handleDeleteAccount()} disabled={loading}>Delete account</button>
              </div>
            </section>
          </section>
        ) : null}
          </>
          ) : null}

        {error ? <div role="alert" className="form-error full-width-error">{error}</div> : null}
        </main>
        <AdmissionChatWidget
          token={token}
          open={aiChatOpen}
          onOpen={() => setAIChatOpen(true)}
          onClose={() => setAIChatOpen(false)}
          contextCollegeId={aiChatCollegeContext}
          onClearContext={() => setAIChatCollegeContext(null)}
        />
      </div>
    </div>
  );
}
