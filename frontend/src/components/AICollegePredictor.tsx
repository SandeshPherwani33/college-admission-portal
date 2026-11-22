import { useEffect, useMemo, useState } from 'react';
import { ApiError, apiRequest } from '../services/api';
import type { Profile } from '../types';

type HistoricalCutoff = {
  course: string;
  exam: string;
  year: number | null;
  cap_round: number | null;
  category: string | null;
  student_rank: number;
  historical_closing_rank: number;
  comparison: 'within_historical_cutoff' | 'outside_historical_cutoff';
  data_quality: string | null;
  source_url: string | null;
};

type CollegeRecommendation = {
  college_id: string;
  college_name: string;
  city: string | null;
  state: string | null;
  course: string;
  tier: 'safe' | 'moderate' | 'ambitious' | 'insufficient_data';
  exam: string;
  student_rank: number | null;
  category: string;
  historical_cutoffs: HistoricalCutoff[];
  matching_criteria: string[];
  missing_criteria: string[];
  reasons: string[];
  data_verification_status: string;
  application_url: string | null;
  official_website: string | null;
  criteria_source: string | null;
};

type RecommendationRun = {
  recommendation_id: string;
  created_at: string;
  status: 'ready' | 'insufficient_data';
  recommendations: CollegeRecommendation[];
  missing_information: string[];
  disclaimer: string;
};

type SavedCollege = {
  college_id: string;
  saved_at: string;
  college_name?: string | null;
  city?: string | null;
  state?: string | null;
};
type TierFilter = 'all' | CollegeRecommendation['tier'];
type SortOrder = 'tier' | 'name' | 'course';
const AUTH = (token: string) => ({ Authorization: `Bearer ${token}` });
const TIER_ORDER: Record<CollegeRecommendation['tier'], number> = {
  safe: 0,
  moderate: 1,
  ambitious: 2,
  insufficient_data: 3,
};

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function AICollegePredictor({
  token,
  profile,
  onProfileUpdated,
  onAskAboutCollege,
}: {
  token: string | null;
  profile: Profile | null;
  onProfileUpdated: (profile: Profile) => void;
  onAskAboutCollege: (collegeId: string) => void;
}) {
  const [run, setRun] = useState<RecommendationRun | null>(null);
  const [history, setHistory] = useState<RecommendationRun[]>([]);
  const [savedColleges, setSavedColleges] = useState<SavedCollege[]>([]);
  const [rankDraft, setRankDraft] = useState({ 'MHT-CET': '', 'JEE Main': '' });
  const [savingRanks, setSavingRanks] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rankError, setRankError] = useState<string | null>(null);
  const [tierFilter, setTierFilter] = useState<TierFilter>('all');
  const [sortOrder, setSortOrder] = useState<SortOrder>('tier');
  const [expandedCollege, setExpandedCollege] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);

  useEffect(() => {
    setRankDraft({
      'MHT-CET': profile?.exam_ranks?.['MHT-CET']?.toString() ?? '',
      'JEE Main': profile?.exam_ranks?.['JEE Main']?.toString() ?? '',
    });
  }, [profile?.exam_ranks]);

  useEffect(() => {
    if (!token) return undefined;
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [saved, runs] = await Promise.all([
          apiRequest<SavedCollege[]>('/ai/saved-colleges', { headers: AUTH(token) }),
          apiRequest<RecommendationRun[]>('/ai/recommendations/history', { headers: AUTH(token) }),
        ]);
        let latest: RecommendationRun | null = null;
        try {
          latest = await apiRequest<RecommendationRun>('/ai/recommendations', { headers: AUTH(token) });
        } catch (requestError) {
          if (!(requestError instanceof ApiError) || requestError.status !== 404) throw requestError;
        }
        if (active) {
          setSavedColleges(saved);
          setHistory(runs);
          setRun(latest);
        }
      } catch (requestError) {
        if (active) setError(requestError instanceof Error ? requestError.message : 'Could not load recommendation data.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [token]);

  const filteredRecommendations = useMemo(() => {
    const items = (run?.recommendations ?? [])
      .filter((item) => tierFilter === 'all' || item.tier === tierFilter);
    return items.sort((left, right) => (
      sortOrder === 'name'
        ? left.college_name.localeCompare(right.college_name)
        : sortOrder === 'course'
          ? left.course.localeCompare(right.course) || left.college_name.localeCompare(right.college_name)
          : TIER_ORDER[left.tier] - TIER_ORDER[right.tier]
            || left.college_name.localeCompare(right.college_name)
    ));
  }, [run, sortOrder, tierFilter]);
  const comparedColleges = (run?.recommendations ?? []).filter((item, index, all) => (
    compareIds.includes(item.college_id)
    && all.findIndex((candidate) => candidate.college_id === item.college_id) === index
  ));
  const savedIds = new Set(savedColleges.map((item) => item.college_id));

  async function generateRecommendations() {
    if (!token) return;
    setGenerating(true);
    setError(null);
    try {
      const generated = await apiRequest<RecommendationRun>('/ai/recommendations/generate', {
        method: 'POST',
        headers: AUTH(token),
      });
      setRun(generated);
      const updatedHistory = await apiRequest<RecommendationRun[]>('/ai/recommendations/history', {
        headers: AUTH(token),
      });
      setHistory(updatedHistory);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not generate recommendations.');
    } finally {
      setGenerating(false);
    }
  }

  async function saveRanks() {
    if (!token || !profile) return;
    setSavingRanks(true);
    setRankError(null);
    try {
      const nextRanks = { ...(profile.exam_ranks ?? {}) };
      for (const exam of ['MHT-CET', 'JEE Main'] as const) {
        const rawRank = rankDraft[exam].trim();
        if (!rawRank) {
          delete nextRanks[exam];
          continue;
        }
        const rank = Number(rawRank);
        if (!Number.isSafeInteger(rank) || rank < 1 || rank > 10_000_000) {
          throw new Error(`${exam} rank must be a whole number between 1 and 10,000,000.`);
        }
        nextRanks[exam] = rank;
      }
      const updated = await apiRequest<Profile>('/profile', {
        method: 'POST',
        headers: AUTH(token),
        body: JSON.stringify({ exam_ranks: nextRanks }),
      });
      onProfileUpdated(updated);
    } catch (requestError) {
      setRankError(requestError instanceof Error ? requestError.message : 'Could not save your exam ranks.');
    } finally {
      setSavingRanks(false);
    }
  }

  async function toggleSaved(collegeId: string) {
    if (!token) return;
    setError(null);
    try {
      if (savedIds.has(collegeId)) {
        await apiRequest(`/ai/saved-colleges/${encodeURIComponent(collegeId)}`, {
          method: 'DELETE',
          headers: AUTH(token),
        });
        setSavedColleges((items) => items.filter((item) => item.college_id !== collegeId));
      } else {
        const saved = await apiRequest<SavedCollege>(`/ai/saved-colleges`, {
          method: 'POST',
          headers: AUTH(token),
          body: JSON.stringify({ college_id: collegeId }),
        });
        setSavedColleges((items) => [saved, ...items.filter((item) => item.college_id !== collegeId)]);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not update saved colleges.');
    }
  }

  function toggleCompare(collegeId: string) {
    if (compareIds.includes(collegeId)) {
      setCompareIds((items) => items.filter((item) => item !== collegeId));
      setError(null);
      return;
    }
    if (compareIds.length >= 4) {
      setError('Compare up to four colleges at a time.');
      return;
    }
    setCompareIds((items) => [...items, collegeId]);
    setError(null);
  }

  return (
    <div className="ai-predictor-page">
      <section className="ai-predictor-hero">
        <div>
          <p className="ai-predictor-eyebrow">PERSONALIZED DISCOVERY</p>
          <h2>AI College Predictor</h2>
          <p>Explore colleges using your saved profile and available historical cutoff data. Recommendations are informational, not admission predictions.</p>
        </div>
        <button type="button" className="button button-primary" disabled={generating || loading} onClick={() => void generateRecommendations()}>
          {generating ? 'Generating…' : 'Generate recommendations'}
        </button>
      </section>

      <section className="ai-predictor-profile card" aria-labelledby="predictor-profile-title">
        <div className="ai-predictor-section-heading">
          <div>
            <p className="ai-predictor-eyebrow">YOUR PROFILE</p>
            <h3 id="predictor-profile-title">Personalize your results</h3>
          </div>
          <span className="ai-predictor-profile-status">{profile?.full_name || 'Student profile'}</span>
        </div>
        <div className="ai-predictor-facts">
          <div><span>Academic score</span><strong>{profile?.academic_score != null ? `${profile.academic_score}%` : 'Not provided'}</strong></div>
          <div><span>Stream</span><strong>{profile?.stream || 'Not provided'}</strong></div>
          <div><span>Category</span><strong>{profile?.reservation_category || 'Not provided'}</strong></div>
          <div><span>Preferred courses</span><strong>{profile?.preferred_fields?.join(', ') || 'Not provided'}</strong></div>
          <div><span>Preferred location</span><strong>{profile?.location || 'Not provided'}</strong></div>
        </div>
        <div className="ai-predictor-rank-editor">
          {(['MHT-CET', 'JEE Main'] as const).map((exam) => (
            <label key={exam} className="field-group">
              {exam} rank
              <input
                type="number"
                min={1}
                max={10_000_000}
                step={1}
                inputMode="numeric"
                value={rankDraft[exam]}
                onChange={(event) => setRankDraft((draft) => ({ ...draft, [exam]: event.target.value }))}
                placeholder="Add a verified rank"
              />
            </label>
          ))}
          <button type="button" className="button button-secondary" disabled={savingRanks || !profile} onClick={() => void saveRanks()}>
            {savingRanks ? 'Saving…' : 'Save exam ranks'}
          </button>
        </div>
        {rankError ? <p className="ai-predictor-error" role="alert">{rankError}</p> : null}
      </section>

      {error ? <p className="ai-predictor-error" role="alert">{error}</p> : null}

      <section className="ai-predictor-results" aria-labelledby="predictor-results-title">
        <div className="ai-predictor-section-heading">
          <div>
            <p className="ai-predictor-eyebrow">MATCHED OPPORTUNITIES</p>
            <h3 id="predictor-results-title">Recommendations for you</h3>
          </div>
          <div className="ai-predictor-controls">
            <label>
              <span className="sr-only">Filter by recommendation tier</span>
              <select value={tierFilter} onChange={(event) => setTierFilter(event.target.value as TierFilter)}>
                <option value="all">All tiers</option>
                <option value="safe">Safe historical fit</option>
                <option value="moderate">Moderate historical fit</option>
                <option value="ambitious">Ambitious historical fit</option>
                <option value="insufficient_data">Verified criteria only</option>
              </select>
            </label>
            <label>
              <span className="sr-only">Sort recommendations</span>
              <select value={sortOrder} onChange={(event) => setSortOrder(event.target.value as SortOrder)}>
                <option value="tier">Sort by historical fit</option>
                <option value="name">College name A-Z</option>
                <option value="course">Course name</option>
              </select>
            </label>
          </div>
        </div>

        {loading ? <div className="ai-predictor-empty" role="status">Loading your saved recommendations…</div> : null}
        {!loading && !error && !run ? (
          <div className="ai-predictor-empty">
            <h4>No recommendation run yet</h4>
            <p>Save an MHT-CET or JEE Main rank, then generate a profile-based comparison from the available records.</p>
          </div>
        ) : null}
        {!loading && run && filteredRecommendations.length === 0 ? (
          <div className="ai-predictor-empty">
            <h4>{run.status === 'insufficient_data' ? 'More verified information is needed' : 'No results match this filter'}</h4>
            {run.missing_information.map((item) => <p key={item}>{item}</p>)}
            {run.status === 'insufficient_data' ? <p>No college, cutoff, or admission outcome has been invented.</p> : null}
          </div>
        ) : null}

        {run && filteredRecommendations.length ? (
          <div className="ai-predictor-grid">
            {filteredRecommendations.map((item) => {
              const isSaved = savedIds.has(item.college_id);
              const isCompared = compareIds.includes(item.college_id);
              const expanded = expandedCollege === `${item.college_id}:${item.course}`;
              return (
                <article className="ai-predictor-card" key={`${item.college_id}:${item.course}`}>
                  <div className="ai-predictor-card-top">
                    <span className={`ai-tier-badge ai-tier-${item.tier}`}>{item.tier.replace(/_/g, ' ')}</span>
                    <button
                      type="button"
                      className="ai-text-button"
                      aria-pressed={isSaved}
                      onClick={() => void toggleSaved(item.college_id)}
                    >{isSaved ? '♥ Saved' : '♡ Save college'}</button>
                  </div>
                  <h4>{item.college_name}</h4>
                  <p className="ai-predictor-course">{item.course}</p>
                  <p className="ai-predictor-location">{[item.city, item.state].filter(Boolean).join(', ') || 'Location not provided'}</p>
                  {item.student_rank != null ? (
                    <p className="ai-predictor-rank">{item.exam} rank {item.student_rank.toLocaleString('en-IN')} · {item.category}</p>
                  ) : <p className="ai-predictor-rank">Exam rank or comparable category cutoff unavailable</p>}
                  <p className="ai-predictor-data-status">{item.data_verification_status}</p>
                  <ul className="ai-predictor-reasons">
                    {item.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                  </ul>
                  {item.historical_cutoffs.length ? (
                    <div className="ai-predictor-cutoffs">
                      <strong>Historical cutoff comparisons</strong>
                      {item.historical_cutoffs.map((cutoff, index) => (
                        <div key={`${cutoff.year}-${cutoff.cap_round}-${index}`}>
                          <span>{cutoff.year ?? 'Year unavailable'} · Round {cutoff.cap_round ?? '—'}</span>
                          <span>Closing rank {cutoff.historical_closing_rank.toLocaleString('en-IN')}</span>
                          {cutoff.source_url ? <a href={cutoff.source_url} target="_blank" rel="noopener noreferrer">Source</a> : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div className="ai-predictor-actions">
                    <button
                      type="button"
                      className="button button-secondary"
                      aria-expanded={expanded}
                      onClick={() => setExpandedCollege(expanded ? null : `${item.college_id}:${item.course}`)}
                    >{expanded ? 'Hide details' : 'View details'}</button>
                    <button type="button" className="button button-secondary" onClick={() => onAskAboutCollege(item.college_id)}>
                      Why this college?
                    </button>
                    {item.application_url ? (
                      <a className="button button-primary" href={item.application_url} target="_blank" rel="noopener noreferrer">
                        Official Apply Now
                      </a>
                    ) : <span className="ai-predictor-link-unavailable">Official application link unavailable</span>}
                  </div>
                  {expanded ? (
                    <div className="ai-predictor-details">
                      <h5>Why it matched</h5>
                      {item.matching_criteria.length ? <ul>{item.matching_criteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul> : <p>No matching verified criteria were returned.</p>}
                      {item.missing_criteria.length ? (
                        <>
                          <h5>Unavailable or unmet information</h5>
                          <ul>{item.missing_criteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
                        </>
                      ) : null}
                      <p><strong>Criteria source:</strong> {item.criteria_source || 'No current verified institution criteria'}</p>
                      {item.official_website ? <a href={item.official_website} target="_blank" rel="noopener noreferrer">Official institution website</a> : null}
                    </div>
                  ) : null}
                  <label className="ai-compare-toggle">
                    <input type="checkbox" checked={isCompared} onChange={() => toggleCompare(item.college_id)} />
                    Compare
                  </label>
                </article>
              );
            })}
          </div>
        ) : null}
      </section>

      {comparedColleges.length > 1 ? (
        <section className="ai-predictor-compare card" aria-labelledby="ai-compare-title">
          <div className="ai-predictor-section-heading">
            <div><p className="ai-predictor-eyebrow">SIDE-BY-SIDE</p><h3 id="ai-compare-title">Compare selected colleges</h3></div>
            <button type="button" className="button button-secondary" onClick={() => setCompareIds([])}>Clear comparison</button>
          </div>
          <div className="ai-predictor-table-scroll">
            <table>
              <thead><tr><th>Details</th>{comparedColleges.map((item) => <th key={item.college_id}>{item.college_name}</th>)}</tr></thead>
              <tbody>
                <tr><th>Course</th>{comparedColleges.map((item) => <td key={item.college_id}>{item.course}</td>)}</tr>
                <tr><th>Location</th>{comparedColleges.map((item) => <td key={item.college_id}>{[item.city, item.state].filter(Boolean).join(', ') || 'Not provided'}</td>)}</tr>
                <tr><th>Historical-fit tier</th>{comparedColleges.map((item) => <td key={item.college_id}>{item.tier.replace(/_/g, ' ')}</td>)}</tr>
                <tr><th>Verification</th>{comparedColleges.map((item) => <td key={item.college_id}>{item.data_verification_status}</td>)}</tr>
                <tr><th>Official application</th>{comparedColleges.map((item) => <td key={item.college_id}>{item.application_url ? <a href={item.application_url} target="_blank" rel="noopener noreferrer">Open portal</a> : 'Not available'}</td>)}</tr>
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {savedColleges.length ? (
        <section className="ai-predictor-saved card" aria-labelledby="saved-colleges-title">
          <div className="ai-predictor-section-heading">
            <div><p className="ai-predictor-eyebrow">YOUR SHORTLIST</p><h3 id="saved-colleges-title">Saved colleges</h3></div>
            <span>{savedColleges.length} saved</span>
          </div>
          <ul>
            {savedColleges.map((item) => {
              const college = run?.recommendations.find((candidate) => candidate.college_id === item.college_id);
              return (
                <li key={item.college_id}>
                  <span>{college?.college_name ?? item.college_name ?? item.college_id}</span>
                  <small>{[college?.city ?? item.city, college?.state ?? item.state].filter(Boolean).join(', ') || 'Location not provided'}</small>
                  <small>Saved {formatDate(item.saved_at)}</small>
                  <button type="button" className="ai-text-button" onClick={() => void toggleSaved(item.college_id)}>Remove</button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {history.length ? (
        <section className="ai-predictor-history card" aria-labelledby="recommendation-history-title">
          <div className="ai-predictor-section-heading">
            <div><p className="ai-predictor-eyebrow">PREVIOUS RUNS</p><h3 id="recommendation-history-title">Recommendation history</h3></div>
            <span>Most recent 20 runs</span>
          </div>
          <div className="ai-predictor-history-list">
            {history.map((item) => (
              <button type="button" key={item.recommendation_id} onClick={() => setRun(item)}>
                <span>{formatDate(item.created_at)}</span>
                <strong>{item.recommendations.length} result(s)</strong>
                <small>{item.recommendation_id === run?.recommendation_id ? 'Currently viewing' : 'View results'}</small>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {run ? <p className="ai-predictor-disclaimer">{run.disclaimer}</p> : null}
    </div>
  );
}
