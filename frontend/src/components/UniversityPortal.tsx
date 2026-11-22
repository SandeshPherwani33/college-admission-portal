import { useEffect, useState } from 'react';

import { API_BASE_URL, apiRequest } from '../services/api';
import type { AdmissionDocumentType, ApplicationRecord, ApplicationStatus } from '../types';

type Props = {
  token: string;
  name: string;
  onSignOut: () => void;
};

type UniversityDashboard = {
  total_applicants: number;
  pending_reviews: number;
  verified_documents: number;
  applicants: Array<{ application_id: string; full_name: string | null; program: string; status: string }>;
};

const transitions: Record<ApplicationStatus, ApplicationStatus[]> = {
  draft: [],
  application_started: [],
  submitted: ['under_review', 'documents_requested', 'shortlisted', 'rejected'],
  under_review: ['documents_requested', 'shortlisted', 'accepted', 'rejected'],
  documents_requested: ['under_review', 'shortlisted', 'rejected'],
  shortlisted: ['accepted', 'rejected'],
  accepted: [],
  rejected: [],
  withdrawn: [],
};

const labelForDocument = (type: AdmissionDocumentType) => type.replace(/_/g, ' ');

export default function UniversityPortal({ token, name, onSignOut }: Props) {
  const [dashboard, setDashboard] = useState<UniversityDashboard | null>(null);
  const [applications, setApplications] = useState<ApplicationRecord[]>([]);
  const [nextStatus, setNextStatus] = useState<Record<string, ApplicationStatus>>({});
  const [requestedDocuments, setRequestedDocuments] = useState<Record<string, AdmissionDocumentType[]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const headers = { Authorization: `Bearer ${token}` };
    const [dashboardData, applicationData] = await Promise.all([
      apiRequest<UniversityDashboard>('/university/dashboard', { headers }),
      apiRequest<{ applications: ApplicationRecord[]; total: number }>('/university/applications', { headers }),
    ]);
    setDashboard(dashboardData);
    setApplications(applicationData.applications);
    setNextStatus(Object.fromEntries(applicationData.applications.map((application) => [
      application.application_id,
      transitions[application.status][0] ?? application.status,
    ])));
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const headers = { Authorization: `Bearer ${token}` };
    Promise.all([
      apiRequest<UniversityDashboard>('/university/dashboard', { headers }),
      apiRequest<{ applications: ApplicationRecord[]; total: number }>('/university/applications', { headers }),
    ]).then(([dashboardData, applicationData]) => {
      if (!active) return;
      setDashboard(dashboardData);
      setApplications(applicationData.applications);
      setNextStatus(Object.fromEntries(applicationData.applications.map((application) => [
        application.application_id,
        transitions[application.status][0] ?? application.status,
      ])));
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : 'Unable to load university applications.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [token]);

  const review = async (application: ApplicationRecord) => {
    const status = nextStatus[application.application_id];
    if (!status || status === application.status) return;
    try {
      setLoading(true);
      setError(null);
      await apiRequest<ApplicationRecord>(`/university/applications/${encodeURIComponent(application.application_id)}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status,
          requested_documents: status === 'documents_requested'
            ? requestedDocuments[application.application_id] ?? []
            : [],
          note: notes[application.application_id] || null,
        }),
      });
      await refresh();
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Unable to update this application.');
    } finally {
      setLoading(false);
    }
  };

  const verifyDocument = async (
    application: ApplicationRecord,
    documentId: string,
    verificationStatus: 'verified' | 'rejected',
  ) => {
    const note = window.prompt(`Add a short verification note for this ${verificationStatus === 'verified' ? 'approval' : 'rejection'}:`);
    if (!note?.trim()) return;
    try {
      setLoading(true);
      setError(null);
      await apiRequest(
        `/university/applications/${encodeURIComponent(application.application_id)}/documents/${encodeURIComponent(documentId)}/verification`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ verification_status: verificationStatus, note: note.trim() }),
        },
      );
      await refresh();
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Unable to review this document.');
    } finally {
      setLoading(false);
    }
  };

  const openDocument = async (application: ApplicationRecord, documentId: string) => {
    try {
      const response = await fetch(
        `${API_BASE_URL}/university/applications/${encodeURIComponent(application.application_id)}/documents/${encodeURIComponent(documentId)}/content`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) throw new Error(`Unable to open document (${response.status}).`);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (documentError) {
      setError(documentError instanceof Error ? documentError.message : 'Unable to open document.');
    }
  };

  return (
    <main className="min-h-screen bg-slate-50 p-4 sm:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-white p-5 shadow-sm">
          <div>
            <p className="text-sm text-slate-500">UniApply-AI · University portal</p>
            <h1 className="text-2xl font-semibold">Welcome, {name}</h1>
          </div>
          <button type="button" onClick={onSignOut} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">Sign out</button>
        </header>

        {dashboard ? (
          <section className="grid gap-4 sm:grid-cols-3">
            {[
              ['Submitted applications', dashboard.total_applicants],
              ['Pending reviews', dashboard.pending_reviews],
              ['Verified documents', dashboard.verified_documents],
            ].map(([label, count]) => (
              <article key={label} className="rounded-2xl bg-white p-5 shadow-sm">
                <p className="text-sm text-slate-500">{label}</p>
                <p className="mt-2 text-3xl font-semibold">{count}</p>
              </article>
            ))}
          </section>
        ) : null}

        <section className="rounded-2xl bg-white p-5 shadow-sm">
          <h2 className="text-xl font-semibold">Application review</h2>
          <p className="mt-1 text-sm text-slate-600">Only submitted applications for your institution are shown here.</p>
          {error ? <p role="alert" className="mt-4 text-sm text-red-700">{error}</p> : null}
          {loading ? <p className="mt-4 text-sm text-slate-500">Loading or saving…</p> : null}
          {!loading && applications.length === 0 ? (
            <p className="mt-4 text-sm text-slate-600">There are no submitted applications to review.</p>
          ) : null}
          <div className="mt-4 grid gap-4">
            {applications.map((application) => {
              const choices = transitions[application.status];
              return (
                <article key={application.application_id} className="rounded-xl border border-slate-200 p-4">
                  <div className="flex flex-wrap justify-between gap-3">
                    <div>
                      <p className="font-semibold">{application.applicant_details.full_name} · {application.program}</p>
                      <p className="text-sm text-slate-600">
                        {application.reference_id ?? application.application_id} · Cycle {application.admission_cycle} · {application.status.replace(/_/g, ' ')}
                      </p>
                      <p className="text-sm text-slate-600">
                        {application.applicant_details.email}
                        {application.applicant_details.phone ? ` · ${application.applicant_details.phone}` : ''}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    {application.documents.map((item) => (
                      <div key={item.document_id} className="rounded-lg bg-slate-50 p-3 text-sm">
                        <p className="font-medium">{labelForDocument(item.document_type)} · {item.filename}</p>
                        <p className="mt-1 text-slate-600">Verification: {item.verification_status.replace(/_/g, ' ')}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button type="button" onClick={() => void openDocument(application, item.document_id)} className="rounded border border-slate-300 px-3 py-1">Open securely</button>
                          {item.verification_status !== 'verified' ? (
                            <button type="button" disabled={loading} onClick={() => void verifyDocument(application, item.document_id, 'verified')} className="rounded bg-emerald-700 px-3 py-1 text-white disabled:opacity-50">Verify</button>
                          ) : null}
                          {item.verification_status !== 'rejected' ? (
                            <button type="button" disabled={loading} onClick={() => void verifyDocument(application, item.document_id, 'rejected')} className="rounded border border-red-300 px-3 py-1 text-red-700 disabled:opacity-50">Reject</button>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>

                  {application.requirements.length ? (
                    <ul className="mt-3 space-y-1 text-sm">
                      {application.requirements.map((requirement) => (
                        <li key={requirement.document_type}>
                          {requirement.label}: {requirement.status.replace(/_/g, ' ')}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {choices.length ? (
                    <div className="mt-4 grid gap-2 sm:grid-cols-2">
                      <label className="text-sm">
                        Review decision
                        <select
                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                          value={nextStatus[application.application_id] ?? choices[0]}
                          onChange={(event) => setNextStatus((current) => ({
                            ...current,
                            [application.application_id]: event.target.value as ApplicationStatus,
                          }))}
                        >
                          {choices.map((choice) => <option key={choice} value={choice}>{choice.replace(/_/g, ' ')}</option>)}
                        </select>
                      </label>
                      {(nextStatus[application.application_id] ?? choices[0]) === 'documents_requested' ? (
                        <fieldset className="text-sm">
                          <legend>Documents to request</legend>
                          {application.requirements.filter((item) => item.required).map((requirement) => (
                            <label key={requirement.document_type} className="mr-3 inline-flex items-center gap-1">
                              <input
                                type="checkbox"
                                checked={(requestedDocuments[application.application_id] ?? []).includes(requirement.document_type)}
                                onChange={(event) => setRequestedDocuments((current) => {
                                  const previous = current[application.application_id] ?? [];
                                  return {
                                    ...current,
                                    [application.application_id]: event.target.checked
                                      ? [...previous, requirement.document_type]
                                      : previous.filter((item) => item !== requirement.document_type),
                                  };
                                })}
                              />
                              {requirement.label}
                            </label>
                          ))}
                        </fieldset>
                      ) : null}
                    </div>
                  ) : null}
                  {choices.length ? (
                    <>
                      <label className="mt-3 block text-sm">
                        Internal review note
                        <textarea
                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                          rows={2}
                          value={notes[application.application_id] ?? ''}
                          onChange={(event) => setNotes((current) => ({ ...current, [application.application_id]: event.target.value }))}
                        />
                      </label>
                      <button type="button" disabled={loading} onClick={() => void review(application)} className="mt-3 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">Save review decision</button>
                    </>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
