export type Profile = {
  student_id: string;
  full_name: string;
  email: string;
  phone?: string | null;
  location?: string | null;
  stream?: string | null;
  board?: string | null;
  academic_score?: number | null;
  exam_scores?: Record<string, number>;
  exam_ranks?: Record<string, number>;
  subject_scores?: Record<string, number>;
  admission_year?: number | null;
  budget?: number | null;
  career_goal?: string | null;
  interests: string[];
  preferred_fields: string[];
  reservation_category?: string | null;
  domicile?: string | null;
  completion_percent: number;
  missing_fields: string[];
  notes: string[];
  academic_documents: AcademicDocumentRecord[];
};

export type AcademicDocumentFields = {
  student_name: string | null;
  institution: string | null;
  qualification: string | null;
  marks: number | null;
  maximum_marks: number | null;
  percentage: number | null;
  examination_year: number | null;
  cgpa: number | null;
};

export type AcademicDocumentRecord = AcademicDocumentFields & {
  document_id: string;
  filename: string;
  reviewed_at: string;
  verification_status: 'not_verified' | 'verified' | 'rejected';
};

export type AdmissionDocumentType =
  | 'academic_marksheet'
  | 'school_leaving_certificate'
  | 'identity_proof'
  | 'entrance_scorecard'
  | 'category_certificate'
  | 'other';

export type AdmissionRequirementStatus = {
  document_type: AdmissionDocumentType;
  label: string;
  required: boolean;
  status: 'completed' | 'missing' | 'pending_verification' | 'not_applicable';
  documents: Array<{
    document_id?: string;
    filename?: string;
    verification_status?: 'not_verified' | 'verified' | 'rejected';
    created_at?: string | null;
  }>;
};

export type DocumentRecord = {
  document_id: string;
  student_id: string;
  filename: string;
  content_type: 'application/pdf' | 'image/jpeg' | 'image/png' | null;
  file_size_bytes: number;
  file_hash: string;
  sha256: string | null;
  document_type: AdmissionDocumentType | null;
  status: string;
  processing_status: string;
  extraction_status: string;
  ocr_status: 'not_required' | 'not_configured' | 'completed' | 'failed';
  verification_status: 'not_verified' | 'verified' | 'rejected';
  verification_note: string | null;
  verified_by_institution_id: string | null;
  verified_at: string | null;
  extracted_fields: AcademicDocumentFields;
  extraction_evidence: Record<string, string[]>;
  extraction_methods: Record<string, string>;
  reviewed_fields: AcademicDocumentFields | null;
  warnings: string[];
  confidence: number | null;
  created_at: string | null;
  updated_at: string | null;
  reviewed_at: string | null;
};

export type Recommendation = {
  program_id: string;
  criteria_id: string;
  institution_id: string;
  institution: string;
  program: string;
  course: string;
  location: string | null;
  tuition_budget: number | null;
  eligibility_status: 'eligible' | 'ineligible' | 'insufficient_data' | 'criteria_unavailable';
  evaluated_criteria: Array<{
    criterion: string;
    requirement: string;
    student_value: string | number | string[] | null;
    status: 'met' | 'not_met' | 'unknown';
    explanation: string;
  }>;
  criteria: {
    seat_capacity?: number | null;
    priority_rules?: Array<{
      field: 'academic_score' | 'exam_score';
      exam_type: string | null;
      direction: 'highest' | 'lowest';
    }>;
    minimum_percentage: number | null;
    minimum_marks: number | null;
    marks_out_of: number | null;
    required_subjects: string[];
    required_qualifications: string[];
    examination_type: string | null;
    examination_cutoff: number | null;
    examination_comparison: 'minimum' | 'maximum';
    admission_year: number | null;
    required_category: string | null;
    required_domicile: string | null;
  };
  criteria_status: 'illustrative' | 'verified';
  effective_year: number;
  admission_year: number | null;
  match_score: number | null;
  competitiveness: string;
  reasons: string[];
  missing_info: string[];
  source: string;
  required_documents: Array<{ document_type: AdmissionDocumentType; label: string; required: boolean }>;
  application_mode: 'unavailable' | 'direct' | 'external';
  application_cycle: number | null;
  application_deadline: string | null;
  application_fee: number | null;
  official_application_url: string | null;
  official_website: string | null;
  admission_exam: string | null;
  application_status: 'not_applied' | 'application_started' | 'submitted';
  requirements: AdmissionRequirementStatus[];
  requirements_complete: boolean;
  requirements_completion_percent: number;
  can_apply: boolean;
};

export type ApplicationStatus =
  | 'draft'
  | 'application_started'
  | 'submitted'
  | 'under_review'
  | 'documents_requested'
  | 'shortlisted'
  | 'accepted'
  | 'rejected'
  | 'withdrawn';

export type ApplicationRecord = {
  application_id: string;
  reference_id: string | null;
  student_id: string;
  institution_id: string;
  institution: string;
  program_id: string;
  program: string;
  admission_cycle: number;
  status: ApplicationStatus;
  applicant_details: { full_name: string; email: string; phone: string | null; location: string | null };
  document_assignments: Partial<Record<AdmissionDocumentType, string>>;
  documents: Array<{
    document_id: string;
    filename: string;
    document_type: AdmissionDocumentType;
    verification_status: 'not_verified' | 'verified' | 'rejected';
    created_at: string | null;
    reviewed_at: string | null;
  }>;
  requirements: AdmissionRequirementStatus[];
  requirements_complete: boolean;
  requested_documents: AdmissionDocumentType[];
  status_history: Array<{ status: ApplicationStatus; actor: string; note: string | null; created_at: string }>;
  source: string;
  application_deadline: string | null;
  application_fee: number | null;
  official_application_url: string | null;
  official_website: string | null;
  admission_exam: string | null;
  consented_at: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
};

export type AllocationResult = {
  student_id: string;
  candidate: string;
  allocated_program_id: string | null;
  allocated_college: string | null;
  allocated_course: string | null;
  preference_rank: number | null;
  priority_position: number | null;
  round_number: number;
  waitlist_status: 'allocated' | 'unallocated';
  reasons: string[];
  explanation: string[];
  unallocated_reason: string | null;
  seats_remaining: Record<string, number>;
  notes: string[];
  run_id: string;
  input_hash: string;
  created_at: string;
  algorithm_version: string;
};

export type InterviewTurn = {
  question: string;
  answer: string | null;
  asked_at: string;
  answered_at: string | null;
  generation_mode: 'ollama' | 'openai' | 'deterministic_fallback';
};

export type InterviewPracticeFeedback = {
  summary: string;
  dimensions: Array<{
    dimension: 'relevance' | 'clarity' | 'reasoning' | 'completeness';
    score: number;
    explanation: string;
    evidence: string;
  }>;
  generation_mode: 'ollama' | 'openai' | 'deterministic_fallback';
  disclaimer: string;
};

export type InterviewSession = {
  interview_id: string;
  student_id: string;
  program: string;
  stream: string;
  interview_type: 'general' | 'technical' | 'behavioral' | 'admissions';
  question_count: number;
  mode: string;
  status: 'created' | 'in_progress' | 'completed';
  turns: InterviewTurn[];
  questions: string[];
  generation_mode: 'pending' | 'ollama' | 'openai' | 'deterministic_fallback' | 'mixed';
  generation_notice: string;
  feedback: InterviewPracticeFeedback | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type AIStatus = {
  configured_provider: string;
  active_provider: string;
  model: string;
  mode: string;
  profile_intake_enabled: boolean;
  fallback_active: boolean;
  message: string;
  connected: boolean;
  service_reachable: boolean;
  model_available: boolean;
  inference_verified: boolean;
  error_code: string | null;
};

export type ProfileIntakeData = {
  academic_background: string | null;
  stream: string | null;
  board: string | null;
  academic_score: number | null;
  exam_scores: Record<string, number>;
  budget: number | null;
  career_goal: string | null;
  interests: string[];
  preferred_courses: string[];
  missing_information: string[];
  clarification_questions: string[];
};

export type ProfileIntakeResponse = {
  status: 'model_generated';
  provider: string;
  model: string;
  profile: ProfileIntakeData;
  persisted: false;
  message: string;
};
