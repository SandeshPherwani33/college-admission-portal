import { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../services/api';
import type { Profile, Recommendation } from '../types';

type HistoricalCutoff = {
  course: string;
  year: number | null;
  cap_round: number | null;
  seat_level: string | null;
  category: string | null;
  historical_closing_rank: number | null;
  exam: string;
  data_quality: string | null;
  source_url: string | null;
};

type VerifiedProgram = {
  program_id: string;
  course: string;
  admission_exam: string | null;
  minimum_percentage: number | null;
  minimum_marks: number | null;
  marks_out_of: number | null;
  examination_type: string | null;
  examination_cutoff: number | null;
  required_subjects: string[];
  required_qualifications: string[];
  required_category: string | null;
  required_domicile: string | null;
  admission_year: number | null;
  criteria_source: string;
  official_website: string | null;
  official_application_url: string | null;
  application_cycle: number | null;
};

type CollegeApplicationLink = {
  program_id: string;
  course: string;
  url: string;
};

type ExploreCollege = {
  college_id: string;
  name: string;
  source_record_id: string | null;
  short_name: string | null;
  city: string | null;
  state: string | null;
  state_source_note: string | null;
  address: string | null;
  logo_url: string | null;
  ug_fee: string | null;
  pg_fee: string | null;
  rating: number | null;
  academic_rating: number | null;
  accommodation_rating: number | null;
  faculty_rating: number | null;
  infrastructure_rating: number | null;
  placement_rating: number | null;
  social_life_rating: number | null;
  courses: string[];
  accepted_exams: string[];
  historical_exams: string[];
  categories: string[];
  historical_cutoffs: HistoricalCutoff[];
  verified_programs: VerifiedProgram[];
  official_website: string | null;
  application_links: CollegeApplicationLink[];
  data_sources: string[];
  verification_status: 'partial_uploaded_dataset';
  source_note: string | null;
};

type DirectoryResponse = {
  colleges: ExploreCollege[];
  total: number;
  data_status: 'partial_reference_dataset';
  source: string;
  disclaimer: string;
};

type ApplicationProgress = 'interested' | 'application_started' | 'application_submitted';
type TrackingEntry = { status?: ApplicationProgress; reference: string };
type SavedCollegeState = { collegeIds: string[]; applicationTracking: Record<string, TrackingEntry> };
type ViewMode = 'all' | 'saved';
type SortMode = 'name' | 'location' | 'courses';

const EMPTY_SAVED_STATE: SavedCollegeState = { collegeIds: [], applicationTracking: {} };
const PAGE_SIZE = 9;
const MAX_COMPARE_COLLEGES = 3;
const APPLICATION_PROGRESS_OPTIONS: Array<{ value: ApplicationProgress; label: string }> = [
  { value: 'interested', label: 'Interested' },
  { value: 'application_started', label: 'Application Started' },
  { value: 'application_submitted', label: 'Application Submitted (self-reported)' },
];

function isSavedCollegeState(value: unknown): value is SavedCollegeState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.collegeIds) || !candidate.applicationTracking
    || typeof candidate.applicationTracking !== 'object') return false;
  const tracking = candidate.applicationTracking as Record<string, unknown>;
  return candidate.collegeIds.every((collegeId) => typeof collegeId === 'string')
    && Object.values(tracking).every((entry) => (
      Boolean(entry)
      && typeof entry === 'object'
      && (
        (entry as Record<string, unknown>).status === undefined
        || APPLICATION_PROGRESS_OPTIONS.some((option) => (
          option.value === (entry as Record<string, unknown>).status
        ))
      )
      && typeof (entry as Record<string, unknown>).reference === 'string'
    ));
}

function safeHttpsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function includesIgnoreCase(values: string[], query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return !normalizedQuery || values.some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
}

function profileMatchSignals(
  college: ExploreCollege,
  profile: Profile | null,
  verifiedRecommendations: Recommendation[],
): string[] {
  if (!profile) return [];
  const signals: string[] = [];
  if (profile.location && college.city
    && college.city.toLocaleLowerCase().includes(profile.location.toLocaleLowerCase())) {
    signals.push(`College city matches your saved location (${profile.location}).`);
  }
  if (profile.location && college.state
    && college.state.toLocaleLowerCase() === profile.location.toLocaleLowerCase()) {
    signals.push(`Dataset state matches your saved location (${profile.location}).`);
  }

  const preferredBranches = profile.preferred_fields.filter((field) => (
    college.courses.some((course) => course.toLocaleLowerCase().includes(field.toLocaleLowerCase())
      || field.toLocaleLowerCase().includes(course.toLocaleLowerCase()))
  ));
  if (preferredBranches.length) {
    signals.push(`Course information matches saved preference${preferredBranches.length === 1 ? '' : 's'}: ${preferredBranches.join(', ')}.`);
  }

  const recommendationsById = new Map(verifiedRecommendations.map((item) => [item.program_id, item]));
  const verifiedMatches = college.verified_programs
    .map((program) => ({ program, recommendation: recommendationsById.get(program.program_id) }))
    .filter((entry) => entry.recommendation);
  for (const { program, recommendation } of verifiedMatches) {
    if (recommendation?.evaluated_criteria.some((item) => (
      /stream/i.test(`${item.criterion} ${item.requirement}`)
      && item.status === 'met'
    ))) {
      signals.push(`Your saved academic stream matches verified criteria for ${program.course}.`);
    }
    if (profile.academic_score !== null && profile.academic_score !== undefined
      && program.minimum_percentage !== null) {
      signals.push(profile.academic_score >= program.minimum_percentage
        ? `Your saved academic percentage meets the verified minimum for ${program.course}.`
        : `Your saved academic percentage is below the verified minimum for ${program.course}.`);
    }
    const exam = program.admission_exam || program.examination_type;
    if (exam && Object.keys(profile.exam_scores ?? {}).some((savedExam) => (
      savedExam.toLocaleLowerCase().includes(exam.toLocaleLowerCase())
      || exam.toLocaleLowerCase().includes(savedExam.toLocaleLowerCase())
    ))) {
      signals.push(`A saved entrance score is available for ${exam}; this profile does not store a rank.`);
    }
  }

  return [...new Set(signals)];
}

export default function ExploreApplyPage({
  token,
  profile,
  verifiedRecommendations,
}: {
  token: string | null;
  profile: Profile | null;
  verifiedRecommendations: Recommendation[];
}) {
  const [directory, setDirectory] = useState<DirectoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('all');
  const [nameSearch, setNameSearch] = useState('');
  const [citySearch, setCitySearch] = useState('');
  const [stateSearch, setStateSearch] = useState('');
  const [courseFilter, setCourseFilter] = useState('');
  const [examFilter, setExamFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('name');
  const [page, setPage] = useState(1);
  const [savedCollegeIds, setSavedCollegeIds] = useState<string[]>([]);
  const [applicationTracking, setApplicationTracking] = useState<Record<string, TrackingEntry>>({});
  const [savedStateStudentId, setSavedStateStudentId] = useState<string | null>(null);
  const [savedStateError, setSavedStateError] = useState<string | null>(null);
  const [savedStateWritable, setSavedStateWritable] = useState(true);
  const [compareCollegeIds, setCompareCollegeIds] = useState<string[]>([]);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [applicationTargets, setApplicationTargets] = useState<Record<string, string>>({});
  const [selectedCollege, setSelectedCollege] = useState<ExploreCollege | null>(null);
  const [trackingCollege, setTrackingCollege] = useState<ExploreCollege | null>(null);
  const [trackingStatus, setTrackingStatus] = useState<ApplicationProgress | ''>('');
  const [trackingReference, setTrackingReference] = useState('');
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setLoadError('Sign in to browse the college directory.');
      return;
    }
    let active = true;
    setLoading(true);
    setLoadError(null);
    apiRequest<DirectoryResponse>('/explore/colleges', {
      headers: { Authorization: `Bearer ${token}` },
    }).then((response) => {
      if (active) setDirectory(response);
    }).catch((requestError: unknown) => {
      if (active) {
        setLoadError(requestError instanceof Error ? requestError.message : 'Unable to load the college directory.');
      }
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [token]);

  useEffect(() => {
    if (!profile?.student_id) {
      setSavedCollegeIds([]);
      setApplicationTracking({});
      setSavedStateStudentId(null);
      setSavedStateError(null);
      return;
    }

    const studentId = profile.student_id;
    const storageKey = `uniapply-explore-colleges-${studentId}`;
    setSavedStateStudentId(null);
    setSavedStateError(null);
    try {
      const serialized = localStorage.getItem(storageKey);
      const parsed: unknown = serialized ? JSON.parse(serialized) : EMPTY_SAVED_STATE;
      if (!isSavedCollegeState(parsed)) {
        throw new Error('Saved college data is invalid.');
      }
      setSavedCollegeIds([...new Set(parsed.collegeIds)]);
      setApplicationTracking(parsed.applicationTracking);
      setSavedStateWritable(true);
    } catch (storageError) {
      setSavedCollegeIds([]);
      setApplicationTracking({});
      setSavedStateWritable(false);
      setSavedStateError(storageError instanceof Error
        ? `${storageError.message} Changes can be used in this session but will not be saved.`
        : 'Saved college data could not be read. Changes can be used in this session but will not be saved.');
    }
    setSavedStateStudentId(studentId);
  }, [profile?.student_id]);

  useEffect(() => {
    if (!profile?.student_id || savedStateStudentId !== profile.student_id || !savedStateWritable) return;
    try {
      localStorage.setItem(
        `uniapply-explore-colleges-${profile.student_id}`,
        JSON.stringify({ collegeIds: savedCollegeIds, applicationTracking }),
      );
    } catch {
      setSavedStateWritable(false);
      setSavedStateError('Unable to save favorites or application notes in this browser.');
    }
  }, [applicationTracking, profile?.student_id, savedCollegeIds, savedStateStudentId, savedStateWritable]);

  const colleges = directory?.colleges ?? [];
  const filterOptions = useMemo(() => ({
    courses: [...new Set(colleges.flatMap((college) => college.courses))].sort((a, b) => a.localeCompare(b)),
    exams: [...new Set(colleges.flatMap((college) => [...college.accepted_exams, ...college.historical_exams]))].sort((a, b) => a.localeCompare(b)),
    categories: [...new Set(colleges.flatMap((college) => college.categories))].sort((a, b) => a.localeCompare(b)),
  }), [colleges]);

  const filteredColleges = useMemo(() => {
    const filtered = colleges
      .filter((college) => viewMode === 'all' || savedCollegeIds.includes(college.college_id))
      .filter((college) => includesIgnoreCase([college.name, college.short_name ?? ''], nameSearch))
      .filter((college) => includesIgnoreCase([college.city ?? ''], citySearch))
      .filter((college) => includesIgnoreCase([college.state ?? ''], stateSearch))
      .filter((college) => !courseFilter || college.courses.includes(courseFilter))
      .filter((college) => !examFilter
        || college.accepted_exams.includes(examFilter)
        || college.historical_exams.includes(examFilter))
      .filter((college) => !categoryFilter || college.categories.includes(categoryFilter));

    if (sortMode === 'location') {
      filtered.sort((left, right) => (
        (left.city ?? '').localeCompare(right.city ?? '')
        || (left.state ?? '').localeCompare(right.state ?? '')
        || left.name.localeCompare(right.name)
      ));
    } else if (sortMode === 'courses') {
      filtered.sort((left, right) => (
        right.courses.length - left.courses.length || left.name.localeCompare(right.name)
      ));
    } else {
      filtered.sort((left, right) => left.name.localeCompare(right.name));
    }
    return filtered;
  }, [
    categoryFilter,
    citySearch,
    colleges,
    courseFilter,
    examFilter,
    nameSearch,
    savedCollegeIds,
    sortMode,
    stateSearch,
    viewMode,
  ]);

  const pageCount = Math.max(1, Math.ceil(filteredColleges.length / PAGE_SIZE));
  const visiblePage = Math.min(page, pageCount);
  const visibleColleges = filteredColleges.slice((visiblePage - 1) * PAGE_SIZE, visiblePage * PAGE_SIZE);
  const comparedColleges = colleges.filter((college) => compareCollegeIds.includes(college.college_id));

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  function clearFilters() {
    setNameSearch('');
    setCitySearch('');
    setStateSearch('');
    setCourseFilter('');
    setExamFilter('');
    setCategoryFilter('');
    setSortMode('name');
    setPage(1);
  }

  function toggleFavorite(collegeId: string) {
    setSavedCollegeIds((current) => current.includes(collegeId)
      ? current.filter((item) => item !== collegeId)
      : [...current, collegeId]);
  }

  function toggleCompare(collegeId: string) {
    setCompareError(null);
    if (compareCollegeIds.includes(collegeId)) {
      setCompareCollegeIds(compareCollegeIds.filter((item) => item !== collegeId));
    } else if (compareCollegeIds.length >= MAX_COMPARE_COLLEGES) {
      setCompareError(`Compare up to ${MAX_COMPARE_COLLEGES} colleges at a time.`);
    } else {
      setCompareCollegeIds([...compareCollegeIds, collegeId]);
    }
  }

  function openTracking(college: ExploreCollege) {
    const saved = applicationTracking[college.college_id];
    setTrackingCollege(college);
    setTrackingStatus(saved?.status ?? '');
    setTrackingReference(saved?.reference ?? '');
  }

  function saveTracking() {
    if (!trackingCollege) return;
    setApplicationTracking((current) => {
      const next = { ...current };
      if (!trackingStatus && !trackingReference.trim()) {
        delete next[trackingCollege.college_id];
      } else {
        next[trackingCollege.college_id] = {
          ...(trackingStatus ? { status: trackingStatus } : {}),
          reference: trackingReference.trim(),
        };
      }
      return next;
    });
    setStatusNotice('Your status is self-reported and saved in this browser; the external portal was not checked.');
    setTrackingCollege(null);
  }

  function renderApplicationActions(college: ExploreCollege) {
    const availableLinks = college.application_links
      .map((link) => ({ ...link, url: safeHttpsUrl(link.url) }))
      .filter((link): link is CollegeApplicationLink & { url: string } => Boolean(link.url));
    if (!availableLinks.length) {
      return <span className="explore-apply-unavailable">Official Application Link Not Available</span>;
    }

    const targetProgramId = applicationTargets[college.college_id]
      || (availableLinks.length === 1 ? availableLinks[0].program_id : '');
    const target = availableLinks.find((link) => link.program_id === targetProgramId);
    return (
      <div className="explore-apply-actions">
        {availableLinks.length > 1 ? (
          <label>
            Application course
            <select
              value={targetProgramId}
              onChange={(event) => setApplicationTargets((current) => ({
                ...current,
                [college.college_id]: event.target.value,
              }))}
            >
              <option value="">Choose a course</option>
              {availableLinks.map((link) => <option key={link.program_id} value={link.program_id}>{link.course}</option>)}
            </select>
          </label>
        ) : null}
        {target ? (
          <a
            className="explore-apply-button"
            href={target.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => openTracking(college)}
          >
            Apply Now
            <span aria-hidden="true">↗</span>
          </a>
        ) : <button type="button" className="explore-apply-button" disabled>Choose course for official link</button>}
        <p>Opens the application portal configured by verified institution criteria. Submission is not tracked automatically.</p>
      </div>
    );
  }

  return (
    <section className="explore-apply-page" aria-labelledby="explore-apply-title">
      <header className="explore-hero">
        <div>
          <p className="explore-eyebrow">College discovery</p>
          <h2 id="explore-apply-title">Explore &amp; Apply</h2>
          <p>Browse the uploaded Indian engineering-college dataset, review its fee and rating values, and open an application portal only when a verified institution link is available.</p>
        </div>
        <div className="explore-count-badge"><strong>{directory?.total ?? 0}</strong><span>dataset records</span></div>
      </header>

      <div className="explore-data-notice" role="note">
        <strong>Know what this directory contains</strong>
        <span>{directory?.disclaimer ?? 'College data and historical cutoffs are shown only when available from configured sources. Missing official links, logos, addresses, and current admission details are not invented.'}</span>
        {directory?.source ? <small>Sources: {directory.source}</small> : null}
      </div>

      <div className="explore-stat-grid" aria-label="College directory summary">
        <article><span>College records in source file</span><strong>{directory?.total ?? '—'}</strong></article>
        <article><span>With historical cutoffs</span><strong>{colleges.filter((college) => college.historical_cutoffs.length > 0).length}</strong></article>
        <article><span>Verified application links</span><strong>{colleges.reduce((total, college) => total + college.application_links.length, 0)}</strong></article>
        <article><span>Saved colleges</span><strong>{savedCollegeIds.length}</strong></article>
      </div>

      <section className="explore-filter-panel" aria-label="College search and filters">
        <div className="explore-view-tabs" role="group" aria-label="College directory view">
          <button type="button" className={viewMode === 'all' ? 'is-active' : ''} onClick={() => { setViewMode('all'); setPage(1); }}>
            All colleges <span>{directory?.total ?? 0}</span>
          </button>
          <button type="button" className={viewMode === 'saved' ? 'is-active' : ''} onClick={() => { setViewMode('saved'); setPage(1); }}>
            Saved colleges <span>{savedCollegeIds.length}</span>
          </button>
        </div>
        <div className="explore-filter-grid">
          <label>
            Search college
            <input value={nameSearch} onChange={(event) => { setNameSearch(event.target.value); setPage(1); }} placeholder="College name" />
          </label>
          <label>
            Search city
            <input value={citySearch} onChange={(event) => { setCitySearch(event.target.value); setPage(1); }} placeholder="City" />
          </label>
          <label>
            Search state
            <input value={stateSearch} onChange={(event) => { setStateSearch(event.target.value); setPage(1); }} placeholder="State or dataset region" />
          </label>
          <label>
            Course / branch
            <select value={courseFilter} onChange={(event) => { setCourseFilter(event.target.value); setPage(1); }}>
              <option value="">All available course data</option>
              {filterOptions.courses.map((course) => <option key={course} value={course}>{course}</option>)}
            </select>
          </label>
          <label>
            Entrance exam / dataset
            <select value={examFilter} onChange={(event) => { setExamFilter(event.target.value); setPage(1); }}>
              <option value="">All available exam data</option>
              {filterOptions.exams.map((exam) => {
                const hasVerifiedAcceptance = colleges.some((college) => college.accepted_exams.includes(exam));
                return <option key={exam} value={exam}>{exam}{hasVerifiedAcceptance ? '' : ' (historical data only)'}</option>;
              })}
            </select>
          </label>
          <label>
            Category in available data
            <select value={categoryFilter} onChange={(event) => { setCategoryFilter(event.target.value); setPage(1); }}>
              <option value="">All categories</option>
              {filterOptions.categories.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
          </label>
          <label>
            Sort colleges
            <select value={sortMode} onChange={(event) => { setSortMode(event.target.value as SortMode); setPage(1); }}>
              <option value="name">College name A–Z</option>
              <option value="location">Location</option>
              <option value="courses">Course availability (most first)</option>
            </select>
          </label>
          <button type="button" className="explore-clear-button" onClick={clearFilters}>Clear filters</button>
        </div>
        <p className="explore-filter-footnote">Exam and category filters may reflect historical cutoff rows, not current exam acceptance or eligibility.</p>
      </section>

      {savedStateError ? <p className="explore-message explore-message-warning" role="status">{savedStateError}</p> : null}
      {statusNotice ? <p className="explore-message explore-message-success" role="status">{statusNotice}</p> : null}
      {loadError ? (
        <div className="explore-empty-state" role="alert">
          <h3>College directory unavailable</h3>
          <p>{loadError}</p>
          <button type="button" className="explore-secondary-button" onClick={() => {
            setDirectory(null);
            setLoadError(null);
            setLoading(true);
            if (token) {
              apiRequest<DirectoryResponse>('/explore/colleges', {
                headers: { Authorization: `Bearer ${token}` },
              }).then(setDirectory).catch((requestError: unknown) => {
                setLoadError(requestError instanceof Error ? requestError.message : 'Unable to load the college directory.');
              }).finally(() => setLoading(false));
            }
          }}>Retry loading colleges</button>
        </div>
      ) : null}
      {loading ? <p className="explore-loading" role="status" aria-busy="true">Loading colleges and available source data…</p> : null}

      {!loading && !loadError ? (
        <section className="explore-results" aria-labelledby="explore-results-title">
          <div className="explore-results-heading">
            <div>
              <p className="explore-eyebrow">{viewMode === 'saved' ? 'Your shortlist' : 'Uploaded college dataset'}</p>
              <h3 id="explore-results-title">{viewMode === 'saved' ? 'My Saved Colleges' : 'College directory'}</h3>
            </div>
            <span>{filteredColleges.length} result{filteredColleges.length === 1 ? '' : 's'}</span>
          </div>

          {filteredColleges.length ? (
            <div className="explore-college-grid">
              {visibleColleges.map((college) => {
                const isSaved = savedCollegeIds.includes(college.college_id);
                const isCompared = compareCollegeIds.includes(college.college_id);
                const matchSignals = profileMatchSignals(college, profile, verifiedRecommendations);
                const validWebsite = safeHttpsUrl(college.official_website);
                const cutoffYears = [...new Set(college.historical_cutoffs.map((item) => item.year).filter((year): year is number => year !== null))].sort((a, b) => b - a);
                const currentTracking = applicationTracking[college.college_id];
                return (
                  <article className="explore-college-card" key={college.college_id}>
                    <div className="explore-college-card-header">
                      <div className="explore-college-avatar" aria-hidden="true">
                        {college.logo_url && safeHttpsUrl(college.logo_url)
                          ? <img src={safeHttpsUrl(college.logo_url) ?? undefined} alt="" />
                          : college.name.split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join('').toUpperCase()}
                      </div>
                      <div className="explore-college-title">
                        <span className="explore-source-badge">Uploaded dataset record</span>
                        <h4>{college.name}</h4>
                        <p>{college.short_name ? `${college.short_name} · ` : ''}{college.city ?? 'City not available'} · {college.state ?? 'State not available'}</p>
                        <small>{college.state_source_note}</small>
                      </div>
                      <button
                        type="button"
                        className={`explore-favorite-button ${isSaved ? 'is-saved' : ''}`}
                        aria-label={isSaved ? `Remove ${college.name} from saved colleges` : `Save ${college.name}`}
                        aria-pressed={isSaved}
                        onClick={() => toggleFavorite(college.college_id)}
                      >
                        {isSaved ? '★' : '☆'}
                      </button>
                    </div>

                    <div className="explore-college-facts">
                      <div>
                        <span>Courses in dataset</span>
                        <strong>{college.courses.length ? college.courses.slice(0, 3).join(', ') : 'Not available in source'}</strong>
                        {college.courses.length > 3 ? <small>+{college.courses.length - 3} more</small> : null}
                      </div>
                      <div>
                        <span>Entrance exam information</span>
                        <strong>{college.accepted_exams.length ? college.accepted_exams.join(', ') : college.historical_exams.length ? `${college.historical_exams.join(', ')} historical cutoff data only` : 'Not provided'}</strong>
                      </div>
                      <div>
                        <span>Historical cutoff data</span>
                        <strong>{college.historical_cutoffs.length
                          ? `${college.historical_cutoffs.length} records${cutoffYears.length ? ` · ${cutoffYears.join(', ')}` : ''}`
                          : 'Not available'}</strong>
                      </div>
                      <div>
                        <span>Category data</span>
                        <strong>{college.categories.length ? college.categories.join(', ') : 'Not provided'}</strong>
                      </div>
                      <div>
                        <span>Rating (source value)</span>
                        <strong>{college.rating ?? 'Not provided'}</strong>
                      </div>
                      <div>
                        <span>UG / PG fee values</span>
                        <strong>{college.ug_fee ?? 'Not provided'} / {college.pg_fee ?? 'Not provided'}</strong>
                        <small>Currency and billing period are not specified in the source.</small>
                      </div>
                    </div>

                    <div className="explore-profile-match">
                      <strong>Profile discovery</strong>
                      {matchSignals.length ? (
                        <ul>{matchSignals.slice(0, 3).map((signal) => <li key={signal}>{signal}</li>)}</ul>
                      ) : (
                        <p>No verified profile match can be established from the available college data. Historical ranks are not compared to saved scores or percentiles.</p>
                      )}
                    </div>

                    <div className="explore-college-meta">
                      {validWebsite ? (
                        <a href={validWebsite} target="_blank" rel="noopener noreferrer">Official website ↗</a>
                      ) : <span>Official website not provided</span>}
                      <span>{college.verified_programs.length} verified program criteria</span>
                    </div>

                    {currentTracking ? (
                      <div className="explore-tracking-summary">
                        <span>{APPLICATION_PROGRESS_OPTIONS.find((item) => item.value === currentTracking.status)?.label ?? 'Reference saved'}</span>
                        {currentTracking.reference ? <small>Reference: {currentTracking.reference}</small> : null}
                        <button type="button" onClick={() => openTracking(college)}>Edit</button>
                      </div>
                    ) : null}

                    <div className="explore-college-actions">
                      <button type="button" className="explore-secondary-button" onClick={() => setSelectedCollege(college)}>View details</button>
                      <label className="explore-compare-toggle">
                        <input
                          type="checkbox"
                          checked={isCompared}
                          onChange={() => toggleCompare(college.college_id)}
                          aria-label={`Compare ${college.name}`}
                        />
                        Compare
                      </label>
                    </div>
                    {renderApplicationActions(college)}
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="explore-empty-state">
              <h3>{viewMode === 'saved' && !savedCollegeIds.length ? 'No saved colleges yet' : 'No colleges match these filters'}</h3>
              <p>{viewMode === 'saved' && !savedCollegeIds.length
                ? 'Save colleges with the star button to build a shortlist on this browser.'
                : 'Try a different search or clear filters. The directory only contains records from the uploaded college dataset.'}</p>
              <button type="button" className="explore-secondary-button" onClick={clearFilters}>Clear filters</button>
            </div>
          )}

          {filteredColleges.length > PAGE_SIZE ? (
            <nav className="explore-pagination" aria-label="College directory pages">
              <button type="button" className="explore-secondary-button" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</button>
              <span>Page {visiblePage} of {pageCount}</span>
              <button type="button" className="explore-secondary-button" disabled={page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}>Next</button>
            </nav>
          ) : null}
        </section>
      ) : null}

      {compareError ? <p className="explore-message explore-message-warning" role="alert">{compareError}</p> : null}
      {comparedColleges.length ? (
        <section className="explore-compare-section" aria-labelledby="explore-compare-title">
          <div className="explore-results-heading">
            <div><p className="explore-eyebrow">Side-by-side</p><h3 id="explore-compare-title">Compare selected colleges</h3></div>
            <button type="button" className="explore-text-button" onClick={() => setCompareCollegeIds([])}>Clear comparison</button>
          </div>
          <div className="explore-compare-scroll">
            <table>
              <thead><tr><th>College</th>{comparedColleges.map((college) => <th key={college.college_id}>{college.name}</th>)}</tr></thead>
              <tbody>
                <tr><th>Location</th>{comparedColleges.map((college) => <td key={college.college_id}>{college.city ?? 'Not provided'}, {college.state ?? 'Not provided'}</td>)}</tr>
                <tr><th>Rating (source value)</th>{comparedColleges.map((college) => <td key={college.college_id}>{college.rating ?? 'Not provided'}</td>)}</tr>
                <tr><th>UG fee value (source)</th>{comparedColleges.map((college) => <td key={college.college_id}>{college.ug_fee ?? 'Not provided'}</td>)}</tr>
                <tr><th>PG fee value (source)</th>{comparedColleges.map((college) => <td key={college.college_id}>{college.pg_fee ?? 'Not provided'}</td>)}</tr>
                <tr><th>Courses in dataset</th>{comparedColleges.map((college) => <td key={college.college_id}>{college.courses.join(', ') || 'Not provided'}</td>)}</tr>
                <tr><th>Accepted exams in verified criteria</th>{comparedColleges.map((college) => <td key={college.college_id}>{college.accepted_exams.join(', ') || 'Not provided'}</td>)}</tr>
                <tr><th>Historical cutoff records</th>{comparedColleges.map((college) => <td key={college.college_id}>{college.historical_cutoffs.length || 'Not available'}</td>)}</tr>
                <tr><th>Official application link</th>{comparedColleges.map((college) => <td key={college.college_id}>{college.application_links.length ? `${college.application_links.length} verified link(s)` : 'Not available'}</td>)}</tr>
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {selectedCollege ? (
        <div className="explore-modal-backdrop">
          <section className="explore-modal" role="dialog" aria-modal="true" aria-labelledby="explore-detail-title">
            <button type="button" className="explore-modal-close" aria-label="Close college details" onClick={() => setSelectedCollege(null)}>×</button>
            <p className="explore-eyebrow">College details · {selectedCollege.verification_status.replace(/_/g, ' ')}</p>
            <h3 id="explore-detail-title">{selectedCollege.name}</h3>
            <p className="explore-detail-location">
              {[selectedCollege.address, selectedCollege.city, selectedCollege.state].filter(Boolean).join(', ') || 'Address and location are not fully provided in the source dataset.'}
            </p>
            <p className="explore-detail-source-note">{selectedCollege.state_source_note}</p>
            <dl className="explore-detail-grid">
              <div><dt>Source record ID</dt><dd>{selectedCollege.source_record_id ?? 'Not provided'}</dd></div>
              <div><dt>Fee values as supplied</dt><dd>UG: {selectedCollege.ug_fee ?? 'Not provided'} · PG: {selectedCollege.pg_fee ?? 'Not provided'}. Currency and billing period are not specified in the source.</dd></div>
              <div><dt>Ratings as supplied</dt><dd>{[
                ['Overall', selectedCollege.rating],
                ['Academic', selectedCollege.academic_rating],
                ['Accommodation', selectedCollege.accommodation_rating],
                ['Faculty', selectedCollege.faculty_rating],
                ['Infrastructure', selectedCollege.infrastructure_rating],
                ['Placement', selectedCollege.placement_rating],
                ['Social life', selectedCollege.social_life_rating],
              ].filter(([, value]) => value !== null).map(([label, value]) => `${label}: ${value}`).join(' · ') || 'Not provided'}</dd></div>
              <div><dt>Courses / branches</dt><dd>{selectedCollege.courses.join(', ') || 'Not provided by the uploaded dataset'}</dd></div>
              <div><dt>Accepted entrance examinations</dt><dd>{selectedCollege.accepted_exams.join(', ') || 'No current exam requirements in verified institution criteria'}</dd></div>
              <div><dt>Historical exam dataset</dt><dd>{selectedCollege.historical_exams.length ? `${selectedCollege.historical_exams.join(', ')} historical data only` : 'Not available'}</dd></div>
              <div><dt>Official website</dt><dd>{safeHttpsUrl(selectedCollege.official_website)
                ? <a href={safeHttpsUrl(selectedCollege.official_website) ?? undefined} target="_blank" rel="noopener noreferrer">{selectedCollege.official_website}</a>
                : 'Not available from verified institution criteria'}</dd></div>
              <div><dt>Official application links</dt><dd>{selectedCollege.application_links.length
                ? selectedCollege.application_links.map((link) => (
                  <p key={link.program_id}>
                    <span>{link.course}</span>{' · '}
                    <a href={safeHttpsUrl(link.url) ?? undefined} target="_blank" rel="noopener noreferrer" onClick={() => openTracking(selectedCollege)}>Apply Now ↗</a>
                  </p>
                ))
                : 'Official Application Link Not Available'}</dd></div>
              <div><dt>Data sources</dt><dd>{selectedCollege.data_sources.join(', ')}</dd></div>
              <div><dt>Source note</dt><dd>{selectedCollege.source_note ?? 'No additional source note was included.'}</dd></div>
            </dl>

            <section className="explore-detail-section">
              <h4>Verified eligibility criteria</h4>
              {selectedCollege.verified_programs.length ? selectedCollege.verified_programs.map((program) => (
                <article key={program.program_id}>
                  <h5>{program.course}</h5>
                  <p>Program ID: {program.program_id} · Source: {program.criteria_source}</p>
                  <ul>
                    {program.minimum_percentage !== null ? <li>Minimum academic percentage: {program.minimum_percentage}%</li> : null}
                    {program.minimum_marks !== null ? <li>Minimum marks: {program.minimum_marks}{program.marks_out_of !== null ? ` / ${program.marks_out_of}` : ''}</li> : null}
                    {program.required_subjects.length ? <li>Required subjects: {program.required_subjects.join(', ')}</li> : null}
                    {program.required_qualifications.length ? <li>Required qualifications: {program.required_qualifications.join(', ')}</li> : null}
                    {program.admission_exam || program.examination_type ? <li>Entrance examination: {program.admission_exam || program.examination_type}{program.examination_cutoff !== null ? ` · criterion ${program.examination_cutoff}` : ''}</li> : null}
                    {program.required_category ? <li>Category: {program.required_category}</li> : null}
                    {program.required_domicile ? <li>Domicile: {program.required_domicile}</li> : null}
                    {program.admission_year ? <li>Admission year: {program.admission_year}</li> : null}
                  </ul>
                </article>
              )) : <p>No verified institution criteria are currently linked to this college record.</p>}
            </section>

            <section className="explore-detail-section">
              <h4>Historical cutoff information</h4>
              {selectedCollege.historical_cutoffs.length ? (
                <>
                  <p>Partial, secondary_unverified historical information only. It is not a current cutoff or a promise of admission.</p>
                  <div className="explore-cutoff-table-wrap">
                    <table>
                      <thead><tr><th>Course</th><th>Exam data</th><th>Year / round</th><th>Category / seat pool</th><th>Historical closing rank</th><th>Source quality</th></tr></thead>
                      <tbody>{selectedCollege.historical_cutoffs.map((cutoff, index) => (
                        <tr key={`${cutoff.course}-${cutoff.year}-${cutoff.cap_round}-${cutoff.category}-${index}`}>
                          <td>{cutoff.course}</td>
                          <td>{cutoff.exam}</td>
                          <td>{cutoff.year ?? '—'} / {cutoff.cap_round ?? '—'}</td>
                          <td>{cutoff.category ?? '—'} / {cutoff.seat_level ?? '—'}</td>
                          <td>{cutoff.historical_closing_rank ?? 'Not available'}</td>
                          <td>
                            {cutoff.data_quality ?? 'Not classified'}
                            {safeHttpsUrl(cutoff.source_url) ? <a href={safeHttpsUrl(cutoff.source_url) ?? undefined} target="_blank" rel="noopener noreferrer">Source ↗</a> : null}
                          </td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                </>
              ) : <p>No historical cutoff rows are linked to this college in the uploaded data.</p>}
            </section>
            <p className="explore-disclaimer">Historical cutoffs do not establish current eligibility, an admission probability, or a guaranteed seat.</p>
          </section>
        </div>
      ) : null}

      {trackingCollege ? (
        <div className="explore-modal-backdrop">
          <section className="explore-tracking-modal" role="dialog" aria-modal="true" aria-labelledby="explore-tracking-title">
            <button type="button" className="explore-modal-close" aria-label="Close application tracking" onClick={() => setTrackingCollege(null)}>×</button>
            <p className="explore-eyebrow">Optional · self-reported</p>
            <h3 id="explore-tracking-title">Track your application</h3>
            <p>{trackingCollege.name}</p>
            <p className="explore-detail-source-note">Opening the external portal does not tell UniApply-AI whether you started or submitted an application. Choose a status only if you want to record it here.</p>
            <label>
              My status
              <select value={trackingStatus} onChange={(event) => setTrackingStatus(event.target.value as ApplicationProgress | '')}>
                <option value="">Do not track</option>
                {APPLICATION_PROGRESS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label>
              Application reference (optional)
              <input value={trackingReference} maxLength={200} onChange={(event) => setTrackingReference(event.target.value)} placeholder="Enter a reference only if you received one" />
            </label>
            <div className="explore-modal-actions">
              <button type="button" className="explore-secondary-button" onClick={() => setTrackingCollege(null)}>Cancel</button>
              <button type="button" className="explore-primary-button" onClick={saveTracking}>Save status</button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
