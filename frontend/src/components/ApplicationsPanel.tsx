import { useEffect, useMemo, useState } from 'react';

import { apiRequest, apiUpload } from '../services/api';
import type {
  AdmissionDocumentType,
  ApplicationRecord,
  ApplicationStatus,
  DocumentRecord,
  Recommendation,
} from '../types';

type Props = {
  token: string;
  recommendations: Recommendation[];
  documents: DocumentRecord[];
};

type ApplicationListResponse = { applications: ApplicationRecord[]; total: number };
type StatusFilter = 'all' | 'draft' | 'submitted' | 'under_review' | 'accepted' | 'rejected';

const documentLabels: Record<AdmissionDocumentType, string> = {
  academic_marksheet: 'Academic marksheet',
  school_leaving_certificate: 'School leaving certificate',
  identity_proof: 'Identity proof',
  entrance_scorecard: 'Entrance scorecard',
  category_certificate: 'Category certificate',
  other: 'Other document',
};

const statusLabels: Record<ApplicationStatus, string> = {
  draft: 'Draft',
  application_started: 'Application started',
  submitted: 'Submitted',
  under_review: 'Under review',
  documents_requested: 'Documents requested',
  shortlisted: 'Shortlisted',
  accepted: 'Accepted',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Not available';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not available' : date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function statusFilterMatches(status: ApplicationStatus, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'submitted') return status === 'submitted' || status === 'application_started';
  if (filter === 'under_review') return status === 'under_review' || status === 'documents_requested' || status === 'shortlisted';
  return status === filter;
}

function StatusBadge({ status }: { status: ApplicationStatus }) {
  return <span className={`application-status application-status-${status}`}>{statusLabels[status]}</span>;
}

function SummaryIcon({ kind }: { kind: 'all' | 'draft' | 'submitted' | 'review' | 'decision' }) {
  const paths = {
    all: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
    draft: <><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></>,
    submitted: <><path d="M5 12h13" /><path d="m13 7 5 5-5 5" /><path d="M5 5v14" /></>,
    review: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4 4M8 11l2 2 4-4" /></>,
    decision: <><path d="m5 12 4 4L19 6" /><path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z" /></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[kind]}</svg>;
}

export default function ApplicationsPanel({ token, recommendations, documents }: Props) {
  const [applications, setApplications] = useState<ApplicationRecord[]>([]);
  const [uploadedDocuments, setUploadedDocuments] = useState<DocumentRecord[]>([]);
  const [assignments, setAssignments] = useState<Record<string, Partial<Record<AdmissionDocumentType, string>>>>({});
  const [applicantDetails, setApplicantDetails] = useState<Record<string, ApplicationRecord['applicant_details']>>({});
  const [consents, setConsents] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [selectedProgram, setSelectedProgram] = useState<Recommendation | null>(null);
  const [workflowApplication, setWorkflowApplication] = useState<ApplicationRecord | null>(null);
  const [detailsApplication, setDetailsApplication] = useState<ApplicationRecord | null>(null);
  const [workflowStep, setWorkflowStep] = useState(0);
  const [uploadingType, setUploadingType] = useState<AdmissionDocumentType | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);

  const availableDocuments = useMemo(() => {
    const records = [...uploadedDocuments, ...documents];
    return records.filter((document, index) => (
      records.findIndex((item) => item.document_id === document.document_id) === index
    ));
  }, [documents, uploadedDocuments]);

  const verifiedPrograms = recommendations.filter((program) => program.criteria_status === 'verified');
  const directPrograms = verifiedPrograms.filter((program) => (
    program.eligibility_status === 'eligible'
    && program.application_mode === 'direct'
    && program.application_cycle !== null
  ));
  const filteredApplications = applications.filter((application) => statusFilterMatches(application.status, filter));

  const applyList = (response: ApplicationListResponse) => {
    setApplications(response.applications);
    setAssignments(Object.fromEntries(response.applications.map((application) => [
      application.application_id,
      application.document_assignments,
    ])));
    setApplicantDetails(Object.fromEntries(response.applications.map((application) => [
      application.application_id,
      application.applicant_details,
    ])));
  };

  const refresh = async () => {
    const response = await apiRequest<ApplicationListResponse>('/applications', {
      headers: { Authorization: `Bearer ${token}` },
    });
    applyList(response);
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    apiRequest<ApplicationListResponse>('/applications', {
      headers: { Authorization: `Bearer ${token}` },
    }).then((response) => {
      if (active) applyList(response);
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : 'Unable to load applications.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [token]);

  const runAction = async (action: () => Promise<void>, message: string) => {
    try {
      setLoading(true);
      setError(null);
      setSuccess(null);
      await action();
      await refresh();
      setSuccess(message);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Unable to update the application.');
    } finally {
      setLoading(false);
    }
  };

  const openWorkflow = (application: ApplicationRecord) => {
    setWorkflowApplication(application);
    setWorkflowStep(0);
    setApplicantDetails((current) => ({ ...current, [application.application_id]: application.applicant_details }));
    setAssignments((current) => ({ ...current, [application.application_id]: application.document_assignments }));
    setConsents((current) => ({ ...current, [application.application_id]: false }));
    setError(null);
    setSuccess(null);
  };

  const createDraft = async (program: Recommendation) => {
    try {
      setLoading(true);
      setError(null);
      setSuccess(null);
      const documentAssignments: Partial<Record<AdmissionDocumentType, string>> = {};
      for (const requirement of program.required_documents.filter((item) => item.required)) {
        const match = availableDocuments.find((document) => (
          document.document_type === requirement.document_type
          && document.verification_status === 'verified'
        ));
        if (match) documentAssignments[requirement.document_type] = match.document_id;
      }
      const created = await apiRequest<ApplicationRecord>('/applications', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ program_id: program.program_id, document_assignments: documentAssignments }),
      });
      await refresh();
      openWorkflow(created);
      setSuccess('Draft created. Review your details and required documents before submitting.');
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create an application draft.');
    } finally {
      setLoading(false);
    }
  };

  const saveDraft = async (application: ApplicationRecord) => runAction(async () => {
    const details = applicantDetails[application.application_id] ?? application.applicant_details;
    if (details.full_name.trim().length < 2) throw new Error('Enter your full name (at least 2 characters).');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email)) throw new Error('Enter a valid email address.');
    const updated = await apiRequest<ApplicationRecord>(`/applications/${encodeURIComponent(application.application_id)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        document_assignments: assignments[application.application_id] ?? {},
        applicant_details: details,
      }),
    });
    setWorkflowApplication(updated);
  }, 'Draft saved successfully.');

  const submitDraft = async (application: ApplicationRecord) => {
    const details = applicantDetails[application.application_id] ?? application.applicant_details;
    const assigned = assignments[application.application_id] ?? {};
    if (details.full_name.trim().length < 2) {
      setError('Enter your full name (at least 2 characters).');
      setWorkflowStep(0);
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email)) {
      setError('Enter a valid email address.');
      setWorkflowStep(0);
      return;
    }
    const requiredTypes = application.requirements.filter((item) => item.required).map((item) => item.document_type);
    if (requiredTypes.some((type) => !assigned[type])) {
      setError('Assign each required document before submitting.');
      setWorkflowStep(1);
      return;
    }
    if (!consents[application.application_id]) {
      setError('Confirm that the information is accurate and consent to submit.');
      setWorkflowStep(1);
      return;
    }
    if (!window.confirm('Submit this application and share the listed details and assigned documents with the institution? This action cannot be undone.')) return;
    await runAction(async () => {
      await apiRequest<ApplicationRecord>(`/applications/${encodeURIComponent(application.application_id)}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_assignments: assigned, applicant_details: details }),
      });
      const submitted = await apiRequest<ApplicationRecord>(`/applications/${encodeURIComponent(application.application_id)}/submit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ consent: true }),
      });
      setWorkflowApplication(submitted);
      setWorkflowApplication(null);
    }, 'Application submitted successfully.');
  };

  const startExternalApplication = async (program: Recommendation) => runAction(async () => {
    if (!program.official_application_url || !program.application_cycle) {
      throw new Error('Verified official application details are not available.');
    }
    await apiRequest<ApplicationRecord>('/applications/external-intent', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        exam: program.admission_exam || program.criteria.examination_type || 'External admission',
        institution: program.institution,
        programme: program.program,
        admission_cycle: program.application_cycle,
        official_application_url: program.official_application_url,
        official_website: program.official_website,
      }),
    });
    window.open(program.official_application_url, '_blank', 'noopener,noreferrer');
  }, 'Official application intent recorded.');

  const confirmExternalSubmission = async (application: ApplicationRecord) => runAction(async () => {
    await apiRequest<ApplicationRecord>(`/applications/${encodeURIComponent(application.application_id)}/confirm-external-submission`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  }, 'External application status updated.');

  const withdraw = async (application: ApplicationRecord) => {
    if (!window.confirm('Withdraw this application? This status change cannot be reversed here.')) return;
    await runAction(async () => {
      await apiRequest<ApplicationRecord>(`/applications/${encodeURIComponent(application.application_id)}/withdraw`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    }, 'Application withdrawn.');
  };

  const openDetails = async (application: ApplicationRecord) => {
    try {
      setLoading(true);
      setError(null);
      const result = await apiRequest<ApplicationRecord>(`/applications/${encodeURIComponent(application.application_id)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setDetailsApplication(result);
    } catch (detailsError) {
      setError(detailsError instanceof Error ? detailsError.message : 'Unable to load application details.');
    } finally {
      setLoading(false);
    }
  };

  const uploadApplicationDocument = async (
    application: ApplicationRecord,
    documentType: AdmissionDocumentType,
    file: File | undefined,
  ) => {
    if (!file) return;
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.type)) {
      setUploadError('Choose a PDF, JPEG, or PNG file.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setUploadError('The selected file exceeds the 10 MiB upload limit.');
      return;
    }
    try {
      setUploadingType(documentType);
      setUploadError(null);
      setUploadProgress(0);
      const formData = new FormData();
      formData.append('file', file);
      formData.append('document_type', documentType);
      const uploaded = await apiUpload<DocumentRecord>(
        '/documents/upload',
        formData,
        { Authorization: `Bearer ${token}` },
        setUploadProgress,
      );
      setUploadedDocuments((current) => [uploaded, ...current.filter((item) => item.document_id !== uploaded.document_id)]);
      setAssignments((current) => ({
        ...current,
        [application.application_id]: {
          ...(current[application.application_id] ?? {}),
          [documentType]: uploaded.document_id,
        },
      }));
      setSuccess(`${file.name} uploaded. Assign it to this application before submission.`);
    } catch (fileError) {
      setUploadError(fileError instanceof Error ? fileError.message : 'Document upload failed.');
    } finally {
      setUploadingType(null);
    }
  };

  const counts = {
    total: applications.length,
    draft: applications.filter((application) => application.status === 'draft').length,
    submitted: applications.filter((application) => application.status === 'submitted' || application.status === 'application_started').length,
    review: applications.filter((application) => ['under_review', 'documents_requested', 'shortlisted'].includes(application.status)).length,
    decision: applications.filter((application) => application.status === 'accepted' || application.status === 'rejected').length,
  };

  return (
    <section className="applications-page" aria-labelledby="applications-page-title">
      <header className="applications-hero">
        <div>
          <p className="applications-eyebrow">Admissions workspace</p>
          <h2 id="applications-page-title">Applications</h2>
          <p>Explore institution-provided opportunities and track each application through its latest backend status.</p>
        </div>
        <button type="button" className="applications-button applications-button-secondary" onClick={() => void runAction(refresh, 'Application list refreshed.')} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {error ? <p className="applications-alert applications-alert-error" role="alert">{error}</p> : null}
      {success ? <p className="applications-alert applications-alert-success" role="status">{success}</p> : null}
      {loading && applications.length === 0 ? <p className="applications-loading" role="status" aria-busy="true">Loading applications…</p> : null}

      <section className="applications-summary" aria-label="Application summary">
        {([
          ['Total applications', counts.total, 'all'],
          ['Draft applications', counts.draft, 'draft'],
          ['Submitted applications', counts.submitted, 'submitted'],
          ['Under review', counts.review, 'review'],
          ['Accepted / rejected', counts.decision, 'decision'],
        ] as const).map(([label, count, kind]) => (
          <article className={`applications-summary-card applications-summary-${kind}`} key={label}>
            <span className="applications-summary-icon"><SummaryIcon kind={kind} /></span>
            <div><p>{label}</p><strong>{loading && applications.length === 0 ? '—' : count}</strong></div>
            <span className="applications-summary-indicator" aria-hidden="true" />
          </article>
        ))}
      </section>

      <section className="applications-section" aria-labelledby="explore-programs-title">
        <div className="applications-section-heading">
          <div>
            <p className="applications-eyebrow">Institution-reported details</p>
            <h3 id="explore-programs-title">Explore Available Programs</h3>
            <p>Program details are shown only when criteria are marked verified by the institution. This status is not independently validated by UniApply-AI.</p>
          </div>
        </div>
        {verifiedPrograms.length === 0 ? (
          <div className="applications-empty">
            <span className="applications-empty-icon"><SummaryIcon kind="all" /></span>
            <h4>Verified opportunities are not available yet</h4>
            <p>No currently eligible program has institution-supplied verified application details. There are no verified application opportunities to display yet; check back after an institution publishes its application cycle and requirements.</p>
          </div>
        ) : (
          <div className="available-program-grid">
            {verifiedPrograms.map((program) => {
              const canApplyDirect = directPrograms.includes(program);
              const isExternal = program.eligibility_status === 'eligible'
                && program.application_mode === 'external'
                && Boolean(program.official_application_url)
                && Boolean(program.application_cycle);
              const alreadyStarted = applications.some((application) => (
                application.program_id === program.program_id
                && application.admission_cycle === program.application_cycle
              ));
              return (
                <article className="available-program-card" key={`${program.criteria_id}-${program.program_id}`}>
                  <div className="available-program-card-top">
                    <span className="program-mark" aria-hidden="true">{program.institution.trim().charAt(0).toUpperCase() || 'U'}</span>
                    <span className="program-verification">Institution-verified criteria</span>
                  </div>
                  <h4>{program.institution}</h4>
                  <p className="available-program-course">{program.course || program.program}</p>
                  <p className="available-program-location">{program.location || 'Location not provided'}</p>
                  <div className="available-program-facts">
                    <div><span>Eligibility</span><strong>{program.eligibility_status.replace(/_/g, ' ')}</strong></div>
                    <div><span>Cycle</span><strong>{program.application_cycle ?? 'Not provided'}</strong></div>
                    {program.application_deadline ? <div><span>Deadline</span><strong>{formatDate(program.application_deadline)}</strong></div> : null}
                  </div>
                  <div className="program-document-preview">
                    <span>Required documents</span>
                    <p>{program.required_documents.length
                      ? program.required_documents.filter((item) => item.required).map((item) => item.label).join(', ') || 'No required documents listed'
                      : 'Not provided by institution'}</p>
                  </div>
                  <div className="available-program-actions">
                    <button type="button" className="applications-button applications-button-secondary" onClick={() => setSelectedProgram(program)}>
                      View details
                    </button>
                    {canApplyDirect ? (
                      <button
                        type="button"
                        className="applications-button applications-button-primary"
                        disabled={loading || alreadyStarted}
                        onClick={() => void createDraft(program)}
                      >
                        {alreadyStarted ? 'Application started' : 'Apply now'}
                      </button>
                    ) : isExternal ? (
                      <button
                        type="button"
                        className="applications-button applications-button-primary"
                        disabled={loading || alreadyStarted}
                        onClick={() => void startExternalApplication(program)}
                      >
                        {alreadyStarted ? 'Intent recorded' : 'Open official application'}
                      </button>
                    ) : (
                      <span className="program-unavailable-note">
                        {program.application_mode === 'unavailable'
                          ? 'Application details unavailable'
                          : program.eligibility_status !== 'eligible'
                            ? 'Eligibility requirements not met or incomplete'
                            : 'Direct application is not configured'}
                      </span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="applications-section" aria-labelledby="my-applications-title">
        <div className="applications-section-heading applications-tracking-heading">
          <div>
            <p className="applications-eyebrow">Your application activity</p>
            <h3 id="my-applications-title">My Applications</h3>
            <p>Track drafts, submissions, and institution responses recorded by the application service.</p>
          </div>
          <label className="application-filter">
            <span>Filter by status</span>
            <select value={filter} onChange={(event) => setFilter(event.target.value as StatusFilter)}>
              <option value="all">All applications</option>
              <option value="draft">Draft</option>
              <option value="submitted">Submitted</option>
              <option value="under_review">Under review</option>
              <option value="accepted">Accepted</option>
              <option value="rejected">Rejected</option>
            </select>
          </label>
        </div>
        {!loading && applications.length === 0 ? (
          <div className="applications-empty applications-empty-compact">
            <span className="applications-empty-icon"><SummaryIcon kind="submitted" /></span>
            <h4>No applications started</h4>
            <p>Your applications will appear here after you start a verified direct application or open an institution’s verified external application.</p>
          </div>
        ) : null}
        {applications.length > 0 && filteredApplications.length === 0 ? (
          <div className="applications-empty applications-empty-compact">
            <h4>No applications match this filter</h4>
            <p>Choose another status to see your application activity.</p>
          </div>
        ) : null}
        <div className="application-tracking-list">
          {filteredApplications.map((application) => (
            <article className="application-tracking-card" key={application.application_id}>
              <div className="application-tracking-main">
                <div className="application-institution-mark" aria-hidden="true">
                  {application.institution.trim().charAt(0).toUpperCase() || 'U'}
                </div>
                <div className="application-tracking-title">
                  <h4>{application.institution}</h4>
                  <p>{application.program}</p>
                  <span>{application.reference_id ? `Reference ${application.reference_id}` : `Application ${application.application_id}`}</span>
                </div>
              </div>
              <div className="application-tracking-meta">
                <div><span>Submitted</span><strong>{formatDate(application.submitted_at)}</strong></div>
                <div><span>Last updated</span><strong>{formatDate(application.updated_at)}</strong></div>
                <StatusBadge status={application.status} />
              </div>
              <div className="application-tracking-actions">
                <button type="button" className="applications-button applications-button-secondary" onClick={() => void openDetails(application)} disabled={loading}>
                  View details
                </button>
                {(application.status === 'draft' || application.status === 'documents_requested') && application.source !== 'external_application' ? (
                  <button type="button" className="applications-button applications-button-primary" onClick={() => openWorkflow(application)} disabled={loading}>
                    {application.status === 'draft' ? 'Continue draft' : 'Respond to request'}
                  </button>
                ) : null}
                {application.source === 'external_application' && application.status === 'application_started' ? (
                  <>
                    {application.official_application_url ? (
                      <button type="button" className="applications-button applications-button-primary" onClick={() => window.open(application.official_application_url ?? '', '_blank', 'noopener,noreferrer')}>
                        Open official site
                      </button>
                    ) : null}
                    <button type="button" className="applications-button applications-button-secondary" disabled={loading} onClick={() => void confirmExternalSubmission(application)}>
                      Mark submitted
                    </button>
                  </>
                ) : null}
                {!['accepted', 'rejected', 'withdrawn'].includes(application.status) ? (
                  <button type="button" className="application-text-button" disabled={loading} onClick={() => void withdraw(application)}>Withdraw</button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </section>

      {selectedProgram ? (
        <div className="application-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedProgram(null); }}>
          <section className="application-modal" role="dialog" aria-modal="true" aria-labelledby="program-detail-title">
            <button type="button" className="application-modal-close" aria-label="Close program details" onClick={() => setSelectedProgram(null)}>×</button>
            <p className="applications-eyebrow">Institution-verified criteria</p>
            <h3 id="program-detail-title">{selectedProgram.institution}</h3>
            <p className="application-modal-subtitle">{selectedProgram.course || selectedProgram.program}{selectedProgram.location ? ` · ${selectedProgram.location}` : ''}</p>
            <p className="application-verification-note">Criteria are marked verified by the institution; UniApply-AI does not independently validate their source.</p>
            <dl className="application-detail-grid">
              <div><dt>Eligibility status</dt><dd>{selectedProgram.eligibility_status.replace(/_/g, ' ')}</dd></div>
              <div><dt>Admission cycle</dt><dd>{selectedProgram.application_cycle ?? 'Not provided'}</dd></div>
              <div><dt>Application deadline</dt><dd>{selectedProgram.application_deadline ? formatDate(selectedProgram.application_deadline) : 'Not provided'}</dd></div>
              <div><dt>Application fee</dt><dd>{selectedProgram.application_fee == null ? 'Not provided' : `₹${selectedProgram.application_fee.toLocaleString('en-IN')}`}</dd></div>
            </dl>
            <h4>Eligibility requirements</h4>
            {selectedProgram.evaluated_criteria.length ? (
              <ul className="application-detail-list">
                {selectedProgram.evaluated_criteria.map((criterion, index) => (
                  <li key={`${criterion.criterion}-${index}`}><strong>{criterion.requirement}</strong><span>{criterion.explanation}</span></li>
                ))}
              </ul>
            ) : <p className="application-muted">No explicit eligibility requirements were provided.</p>}
            <h4>Required documents</h4>
            {selectedProgram.required_documents.length ? (
              <ul className="application-detail-list">
                {selectedProgram.required_documents.map((item) => (
                  <li key={item.document_type}><strong>{item.label}</strong><span>{item.required ? 'Required' : 'Optional'}</span></li>
                ))}
              </ul>
            ) : <p className="application-muted">The institution has not listed document requirements.</p>}
          </section>
        </div>
      ) : null}

      {workflowApplication ? (
        <div className="application-modal-backdrop" role="presentation">
          <section className="application-modal application-workflow-modal" role="dialog" aria-modal="true" aria-labelledby="application-workflow-title">
            <button type="button" className="application-modal-close" aria-label="Close application form" onClick={() => setWorkflowApplication(null)}>×</button>
            <p className="applications-eyebrow">Application draft · Step {workflowStep + 1} of 2</p>
            <h3 id="application-workflow-title">{workflowApplication.institution}</h3>
            <p className="application-modal-subtitle">{workflowApplication.program} · Cycle {workflowApplication.admission_cycle}</p>
            <div className="application-step-progress" aria-label={`Step ${workflowStep + 1} of 2`}><span style={{ width: `${((workflowStep + 1) / 2) * 100}%` }} /></div>
            {error ? <p className="applications-alert applications-alert-error" role="alert">{error}</p> : null}
            {workflowStep === 0 ? (
              <div className="application-form-grid">
                <label>Full name
                  <input value={applicantDetails[workflowApplication.application_id]?.full_name ?? ''} maxLength={200} onChange={(event) => setApplicantDetails((current) => ({
                    ...current,
                    [workflowApplication.application_id]: { ...workflowApplication.applicant_details, ...(current[workflowApplication.application_id] ?? {}), full_name: event.target.value },
                  }))} />
                </label>
                <label>Email address
                  <input type="email" value={applicantDetails[workflowApplication.application_id]?.email ?? ''} onChange={(event) => setApplicantDetails((current) => ({
                    ...current,
                    [workflowApplication.application_id]: { ...workflowApplication.applicant_details, ...(current[workflowApplication.application_id] ?? {}), email: event.target.value },
                  }))} />
                </label>
                <label>Phone <span className="application-field-optional">Optional</span>
                  <input type="tel" maxLength={40} value={applicantDetails[workflowApplication.application_id]?.phone ?? ''} onChange={(event) => setApplicantDetails((current) => ({
                    ...current,
                    [workflowApplication.application_id]: { ...workflowApplication.applicant_details, ...(current[workflowApplication.application_id] ?? {}), phone: event.target.value || null },
                  }))} />
                </label>
                <label>Location <span className="application-field-optional">Optional</span>
                  <input maxLength={200} value={applicantDetails[workflowApplication.application_id]?.location ?? ''} onChange={(event) => setApplicantDetails((current) => ({
                    ...current,
                    [workflowApplication.application_id]: { ...workflowApplication.applicant_details, ...(current[workflowApplication.application_id] ?? {}), location: event.target.value || null },
                  }))} />
                </label>
                <p className="application-form-note">These fields are prefilled from your saved profile when available. Edit them here if needed.</p>
              </div>
            ) : (
              <div className="application-document-steps">
                {workflowApplication.requirements.length ? workflowApplication.requirements.map((requirement) => {
                  const mapped = assignments[workflowApplication.application_id] ?? {};
                  const matchingDocuments = availableDocuments.filter((document) => document.document_type === requirement.document_type);
                  return (
                    <div className="application-document-row" key={requirement.document_type}>
                      <div>
                        <strong>{requirement.label}{requirement.required ? ' *' : ' (optional)'}</strong>
                        <span>{requirement.required ? 'Required for this application' : 'Optional supporting document'}</span>
                      </div>
                      <select
                        aria-label={`Assign ${requirement.label}`}
                        value={mapped[requirement.document_type] ?? ''}
                        onChange={(event) => setAssignments((current) => ({
                          ...current,
                          [workflowApplication.application_id]: {
                            ...(current[workflowApplication.application_id] ?? {}),
                            [requirement.document_type]: event.target.value || undefined,
                          },
                        }))}
                      >
                        <option value="">Select an uploaded document</option>
                        {matchingDocuments.map((document) => (
                          <option key={document.document_id} value={document.document_id}>
                            {document.filename} — {document.verification_status.replace(/_/g, ' ')}
                          </option>
                        ))}
                      </select>
                      <label className="application-upload-label">
                        <span>{uploadingType === requirement.document_type ? `Uploading ${uploadProgress}%` : 'Upload a new document'}</span>
                        <input
                          type="file"
                          accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                          disabled={uploadingType !== null}
                          onChange={(event) => {
                            const file = event.currentTarget.files?.[0];
                            event.currentTarget.value = '';
                            void uploadApplicationDocument(workflowApplication, requirement.document_type, file);
                          }}
                        />
                      </label>
                      {mapped[requirement.document_type] ? (
                        <span className="application-document-selected">
                          {matchingDocuments.find((document) => document.document_id === mapped[requirement.document_type])?.filename ?? 'Assigned document'}
                        </span>
                      ) : null}
                    </div>
                  );
                }) : <p className="application-muted">No document requirements were provided for this application.</p>}
                {uploadError ? <p className="applications-alert applications-alert-error" role="alert">{uploadError}</p> : null}
                <label className="application-consent">
                  <input
                    type="checkbox"
                    checked={consents[workflowApplication.application_id] ?? false}
                    onChange={(event) => setConsents((current) => ({ ...current, [workflowApplication.application_id]: event.target.checked }))}
                  />
                  <span>I confirm these details are accurate and consent to sharing this application and assigned documents with the institution.</span>
                </label>
              </div>
            )}
            <div className="application-workflow-actions">
              <button type="button" className="applications-button applications-button-secondary" onClick={() => workflowStep === 0 ? setWorkflowApplication(null) : setWorkflowStep(0)}>
                {workflowStep === 0 ? 'Cancel' : 'Back'}
              </button>
              <button type="button" className="applications-button applications-button-secondary" disabled={loading} onClick={() => void saveDraft(workflowApplication)}>
                {loading ? 'Saving…' : 'Save draft'}
              </button>
              {workflowStep === 0 ? (
                <button type="button" className="applications-button applications-button-primary" onClick={() => {
                  const details = applicantDetails[workflowApplication.application_id] ?? workflowApplication.applicant_details;
                  if (details.full_name.trim().length < 2) {
                    setError('Enter your full name (at least 2 characters).');
                    return;
                  }
                  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email)) {
                    setError('Enter a valid email address.');
                    return;
                  }
                  setError(null);
                  setWorkflowStep(1);
                }}>
                  Continue
                </button>
              ) : (
                <button
                  type="button"
                  className="applications-button applications-button-primary"
                  disabled={loading || !consents[workflowApplication.application_id]}
                  onClick={() => void submitDraft(workflowApplication)}
                >
                  {loading ? 'Submitting…' : workflowApplication.status === 'documents_requested' ? 'Resubmit application' : 'Review and submit'}
                </button>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {detailsApplication ? (
        <div className="application-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetailsApplication(null); }}>
          <section className="application-modal" role="dialog" aria-modal="true" aria-labelledby="application-detail-title">
            <button type="button" className="application-modal-close" aria-label="Close application details" onClick={() => setDetailsApplication(null)}>×</button>
            <p className="applications-eyebrow">Application details</p>
            <div className="application-detail-heading">
              <div><h3 id="application-detail-title">{detailsApplication.institution}</h3><p className="application-modal-subtitle">{detailsApplication.program}</p></div>
              <StatusBadge status={detailsApplication.status} />
            </div>
            <dl className="application-detail-grid">
              <div><dt>Application ID</dt><dd>{detailsApplication.reference_id ?? detailsApplication.application_id}</dd></div>
              <div><dt>Admission cycle</dt><dd>{detailsApplication.admission_cycle}</dd></div>
              <div><dt>Submitted</dt><dd>{formatDate(detailsApplication.submitted_at)}</dd></div>
              <div><dt>Last updated</dt><dd>{formatDate(detailsApplication.updated_at)}</dd></div>
            </dl>
            <h4>Student information</h4>
            <dl className="application-detail-grid">
              <div><dt>Name</dt><dd>{detailsApplication.applicant_details.full_name}</dd></div>
              <div><dt>Email</dt><dd>{detailsApplication.applicant_details.email}</dd></div>
              <div><dt>Phone</dt><dd>{detailsApplication.applicant_details.phone || 'Not provided'}</dd></div>
              <div><dt>Location</dt><dd>{detailsApplication.applicant_details.location || 'Not provided'}</dd></div>
            </dl>
            <h4>Assigned documents</h4>
            {detailsApplication.documents.length ? (
              <ul className="application-detail-list">
                {detailsApplication.documents.map((document) => (
                  <li key={document.document_id}>
                    <strong>{document.filename}</strong>
                    <span>{documentLabels[document.document_type]} · {document.verification_status.replace(/_/g, ' ')}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="application-muted">No documents are assigned to this application.</p>}
            <h4>Application timeline</h4>
            <ol className="application-timeline">
              {detailsApplication.status_history.map((event, index) => (
                <li key={`${event.status}-${event.created_at}-${index}`}>
                  <span className="application-timeline-dot" />
                  <div><strong>{statusLabels[event.status]}</strong><time>{formatDate(event.created_at)}</time>{event.note ? <p>{event.note}</p> : null}</div>
                </li>
              ))}
            </ol>
            <p className="application-response-note">Institution response details are shown only when included in the backend status history.</p>
          </section>
        </div>
      ) : null}
    </section>
  );
}
