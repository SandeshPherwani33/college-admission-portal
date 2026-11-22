import { FormEvent, useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../services/api';

type MhtcetOption = {
  value: string;
  label: string;
  selectable: boolean;
  reason: string | null;
};

type MhtcetOptions = {
  categories: string[];
  branches: string[];
  cities: string[];
  institutes: string[];
  institute_cutoffs: Array<{
    institute: string;
    branch: string;
    city: string | null;
    historical_closing_rank: number;
    year: number;
    cap_round: number;
    category: string;
  }>;
  cap_rounds: number[];
  seat_pools: MhtcetOption[];
  data_status: 'partial_historical_data';
  disclaimer: string;
};

type MhtcetRecommendation = {
  institute: string;
  branch: string;
  city: string | null;
  historical_closing_rank: number;
  year: number;
  cap_round: number;
  category: string;
  seat_level: string;
  comparison: 'within_historical_cutoff' | 'outside_historical_cutoff';
  data_quality: string;
  source_url: string;
  city_source_note: string | null;
};

type MhtcetResponse = {
  success: boolean;
  data_status: 'partial_historical_data' | 'insufficient_data';
  recommendations: MhtcetRecommendation[];
  message: string | null;
  disclaimer: string;
  filter_suggestions?: Array<{
    filter: 'branch' | 'city' | 'cap_round' | 'all';
    label: string;
    matching_rows: number;
  }>;
};

type SortOrder = 'within-first' | 'college' | 'closing-rank';
type RelaxedFilter = 'branch' | 'city' | 'cap_round' | 'all';

export function CollegeCutoffLookup({ token }: { token: string | null }) {
  const [options, setOptions] = useState<MhtcetOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [institute, setInstitute] = useState('');
  const [category, setCategory] = useState('');

  useEffect(() => {
    if (!token) return;
    let active = true;
    apiRequest<MhtcetOptions>('/recommendations/mhtcet/options', {
      headers: { Authorization: `Bearer ${token}` },
    }).then((response) => {
      if (active) setOptions(response);
    }).catch((requestError: unknown) => {
      if (active) setError(requestError instanceof Error ? requestError.message : 'Could not load cutoff data.');
    });
    return () => {
      active = false;
    };
  }, [token]);

  const rows = (options?.institute_cutoffs ?? [])
    .filter((row) => !institute || row.institute === institute)
    .filter((row) => !category || row.category === category)
    .sort((left, right) => (
      left.branch.localeCompare(right.branch)
      || left.category.localeCompare(right.category)
      || left.historical_closing_rank - right.historical_closing_rank
    ));

  async function applyNow(row: (typeof rows)[number]) {
    if (!token) {
      setError('Sign in again to record your application intent.');
      return;
    }
    try {
      await apiRequest('/applications/external-intent', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          exam: 'MHT-CET',
          institution: row.institute,
          programme: row.branch,
          admission_cycle: row.year,
          official_application_url: 'https://cetcell.mahacet.org/',
          official_website: 'https://cetcell.mahacet.org/',
        }),
      });
      window.open('https://cetcell.mahacet.org/', '_blank', 'noopener,noreferrer');
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not record application intent.');
    }
  }

  return (
    <div className="college-cutoff-lookup">
      <div>
        <h3 className="text-base font-semibold text-slate-900">College cutoff data</h3>
        <p className="mt-1 text-sm text-slate-600">
          Select a college to view available historical MHT-CET closing ranks. The dataset is partial and unverified.
        </p>
      </div>
      <div className="college-cutoff-filters">
        <label className="field-group" htmlFor="college-cutoff-institute">
          College name
          <select
            id="college-cutoff-institute"
            value={institute}
            onChange={(event) => setInstitute(event.target.value)}
          >
            <option value="">Select a college</option>
            {(options?.institutes ?? []).map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </label>
        <label className="field-group" htmlFor="college-cutoff-category">
          Category
          <select
            id="college-cutoff-category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="">All categories</option>
            {(options?.categories ?? []).map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </label>
      </div>
      {error ? <p role="alert" className="form-error">{error}</p> : null}
      {!options && !error ? <p role="status" className="college-cutoff-status">Loading cutoff data…</p> : null}
      {institute && options ? (
        <div className="college-cutoff-results" aria-live="polite">
          {rows.length ? (
            <div className="review-table-wrap">
              <table className="review-table">
                <caption className="sr-only">Historical closing ranks for {institute}</caption>
                <thead>
                  <tr>
                    <th scope="col">Branch</th>
                    <th scope="col">Category</th>
                    <th scope="col">Year / round</th>
                    <th scope="col">Closing rank</th>
                    <th scope="col">Application</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={`${row.branch}-${row.category}-${row.year}-${row.cap_round}-${index}`}>
                      <th scope="row">{row.branch}</th>
                      <td>{row.category}</td>
                      <td>{row.year} / Round {row.cap_round}</td>
                      <td className="college-cutoff-rank">{row.historical_closing_rank.toLocaleString('en-IN')}</td>
                      <td>
                        <button type="button" className="button button-primary" onClick={() => void applyNow(row)}>
                          Apply Now
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="college-cutoff-status">No matching cutoff rows are available for these filters.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

type NationalCutoffRow = {
  exam: string;
  year: number;
  institute: string;
  programme: string;
  category: string | null;
  quota: string | null;
  round: number | string | null;
  metric_value: number;
  metric_type: 'closing_rank' | 'closing_score';
  data_status: string;
  source_url: string;
  comparison: 'within_historical_cutoff' | 'outside_historical_cutoff' | null;
  admission_exam: string;
  official_application_url: string | null;
  official_website: string | null;
  application_status: 'not_applied' | 'application_started' | 'submitted';
};

type NationalCutoffResponse = {
  success: boolean;
  exam: string;
  data_status: 'partial_historical_data' | 'insufficient_data';
  recommendations: NationalCutoffRow[];
  message: string | null;
  disclaimer: string;
};

export function NationalExamCutoffLookup({ token }: { token: string | null }) {
  const [exam, setExam] = useState<'JEE Advanced via JoSAA' | 'NEET UG' | 'CUET UG'>('JEE Advanced via JoSAA');
  const [year, setYear] = useState('2025');
  const [metric, setMetric] = useState('');
  const [institute, setInstitute] = useState('');
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<NationalCutoffResponse | null>(null);

  function changeExam(nextExam: 'JEE Advanced via JoSAA' | 'NEET UG' | 'CUET UG') {
    setExam(nextExam);
    setYear(nextExam === 'CUET UG' ? '2026' : '2025');
    setMetric('');
    setInstitute('');
    setCategory('');
    setResult(null);
    setError(null);
  }

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setResult(null);
    if (!token) {
      setError('Sign in again to search national exam cutoffs.');
      return;
    }
    if (exam !== 'NEET UG') {
      const parsedMetric = Number(metric);
      if (!Number.isFinite(parsedMetric) || parsedMetric <= 0) {
        setError(exam === 'CUET UG' ? 'Enter a positive CUET score.' : 'Enter a positive JEE rank.');
        return;
      }
      setLoading(true);
      try {
        const response = await apiRequest<NationalCutoffResponse>('/recommendations/national', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            exam,
            year: Number(year),
            rank_or_score: Number(metric),
            institute_or_university: institute || null,
            category: category || null,
          }),
        });
        setResult(response);
      } catch (requestError: unknown) {
        setError(requestError instanceof Error ? requestError.message : 'Could not load cutoff data.');
      } finally {
        setLoading(false);
      }
      return;
    }
    setLoading(true);
    try {
      const response = await apiRequest<NationalCutoffResponse>('/recommendations/national', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ exam, year: Number(year), rank_or_score: 1 }),
      });
      setResult(response);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not load cutoff data.');
    } finally {
      setLoading(false);
    }
  }

  async function applyNow(row: NationalCutoffRow) {
    if (!token) {
      setError('Sign in again to record your application intent.');
      return;
    }
    if (!row.official_application_url) {
      setError('Official application link unavailable.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await apiRequest('/applications/external-intent', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          exam: row.admission_exam || row.exam,
          institution: row.institute,
          programme: row.programme,
          admission_cycle: row.year,
          official_application_url: row.official_application_url,
          official_website: row.official_website,
        }),
      });
      window.open(row.official_application_url, '_blank', 'noopener,noreferrer');
      setResult((current) => current ? {
        ...current,
        recommendations: current.recommendations.map((item) => (
          item.institute === row.institute && item.programme === row.programme
            ? { ...item, application_status: 'application_started' }
            : item
        )),
      } : current);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not record application intent.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="card grid gap-5" aria-labelledby="national-cutoff-title">
      <div>
        <p className="eyebrow">National exam cutoff explorer</p>
        <h2 id="national-cutoff-title" className="text-xl font-semibold">JEE, NEET and CUET colleges</h2>
        <p className="mt-2 text-sm text-slate-600">
          Compare against the supplied partial workbook only. NEET has no invented cutoff values.
        </p>
      </div>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="National exam">
        {(['JEE Advanced via JoSAA', 'NEET UG', 'CUET UG'] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={exam === item}
            className={exam === item ? 'button button-primary' : 'button button-secondary'}
            onClick={() => changeExam(item)}
          >
            {item.startsWith('JEE') ? 'JEE' : item.startsWith('NEET') ? 'NEET' : 'CUET'}
          </button>
        ))}
      </div>

      <form className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" onSubmit={handleSearch}>
        <label className="field-group" htmlFor="national-year">
          Year
          <select id="national-year" value={year} onChange={(event) => setYear(event.target.value)}>
            {exam === 'CUET UG'
              ? <option value="2026">2026</option>
              : exam === 'JEE Advanced via JoSAA'
                ? <option value="2025">2025</option>
                : <option value="2025">Source year not supplied</option>}
          </select>
        </label>
        {exam !== 'NEET UG' ? (
          <label className="field-group" htmlFor="national-metric">
            {exam === 'CUET UG' ? 'CUET score' : 'JEE closing-rank comparison'}
            <input
              id="national-metric"
              type="number"
              min="0"
              step={exam === 'CUET UG' ? '0.01' : '1'}
              value={metric}
              onChange={(event) => setMetric(event.target.value)}
              placeholder={exam === 'CUET UG' ? 'Enter CUET score' : 'Enter your rank'}
            />
          </label>
        ) : null}
        {exam === 'CUET UG' ? (
          <label className="field-group" htmlFor="national-category">
            Category
            <select id="national-category" value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">All sample categories</option>
              <option value="UR">UR</option>
            </select>
          </label>
        ) : null}
        <label className="field-group" htmlFor="national-institute">
          {exam === 'CUET UG' ? 'College' : exam === 'JEE Advanced via JoSAA' ? 'IIT' : 'College'}
          <input
            id="national-institute"
            value={institute}
            onChange={(event) => setInstitute(event.target.value)}
            placeholder="Optional name filter"
          />
        </label>
        <div className="flex items-end">
          <button type="submit" className="button button-primary w-full" disabled={loading}>
            {loading ? 'Searching…' : exam === 'NEET UG' ? 'Check NEET data' : 'Search cutoffs'}
          </button>
        </div>
      </form>

      {error ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
      {result ? (
        <div aria-live="polite">
          {result.message ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p> : null}
          {result.recommendations.length ? (
            <div className="review-table-wrap mt-3">
              <table className="review-table">
                <thead>
                  <tr>
                    <th scope="col">{exam === 'CUET UG' ? 'College' : 'Institute'}</th>
                    <th scope="col">Programme</th>
                    <th scope="col">{exam === 'CUET UG' ? 'Closing score' : 'Closing rank'}</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {result.recommendations.map((row, index) => (
                    <tr key={`${row.institute}-${row.programme}-${index}`}>
                      <th scope="row">{row.institute}</th>
                      <td>{row.programme}</td>
                      <td>{row.metric_value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                      <td>
                        <span>{row.comparison === 'within_historical_cutoff' ? 'Within supplied cutoff' : row.comparison === 'outside_historical_cutoff' ? 'Outside supplied cutoff' : row.data_status}</span>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {row.official_application_url ? (
                            <button
                              type="button"
                              className="button button-primary"
                              disabled={loading}
                              onClick={() => void applyNow(row)}
                            >
                              Apply Now
                            </button>
                          ) : (
                            <span className="text-xs text-amber-800">Official application link unavailable</span>
                          )}
                          {row.official_website ? (
                            <a className="button button-secondary" href={row.official_website} target="_blank" rel="noopener noreferrer">
                              Official website
                            </a>
                          ) : null}
                          <a className="text-xs text-indigo-700 underline self-center" href={row.source_url} target="_blank" rel="noreferrer">
                            View cutoff source
                          </a>
                        </div>
                        <p className="mt-2 text-xs text-slate-600">Status: {row.application_status.replace(/_/g, ' ')}</p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <p className="mt-3 text-xs text-slate-600">{result.disclaimer}</p>
        </div>
      ) : null}
    </section>
  );
}

export function MhtcetRecommendations({ token }: { token: string | null }) {
  const [options, setOptions] = useState<MhtcetOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [rank, setRank] = useState('');
  const [branch, setBranch] = useState('');
  const [city, setCity] = useState('');
  const [category, setCategory] = useState('');
  const [capRound, setCapRound] = useState('');
  const [seatLevel, setSeatLevel] = useState('State');
  const [sortOrder, setSortOrder] = useState<SortOrder>('within-first');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MhtcetResponse | null>(null);

  useEffect(() => {
    if (!token) return;
    let active = true;
    apiRequest<MhtcetOptions>('/recommendations/mhtcet/options', {
      headers: { Authorization: `Bearer ${token}` },
    }).then((response) => {
      if (active) setOptions(response);
    }).catch((requestError: unknown) => {
      if (active) {
        setOptionsError(requestError instanceof Error ? requestError.message : 'Could not load MHT-CET filters.');
      }
    });
    return () => {
      active = false;
    };
  }, [token]);

  const sortedRecommendations = useMemo(() => {
    const recommendations = [...(result?.recommendations ?? [])];
    if (sortOrder === 'college') {
      return recommendations.sort((left, right) => left.institute.localeCompare(right.institute));
    }
    if (sortOrder === 'closing-rank') {
      return recommendations.sort((left, right) => left.historical_closing_rank - right.historical_closing_rank);
    }
    return recommendations.sort((left, right) => (
      Number(right.comparison === 'within_historical_cutoff')
      - Number(left.comparison === 'within_historical_cutoff')
      || left.historical_closing_rank - right.historical_closing_rank
    ));
  }, [result, sortOrder]);

  async function runSearch(relaxedFilter: RelaxedFilter | null = null) {
    setError(null);
    setResult(null);
    const parsedRank = Number(rank);
    if (!Number.isSafeInteger(parsedRank) || parsedRank <= 0) {
      setError('Enter a positive whole-number MHT-CET CAP rank.');
      return;
    }
    if (!category) {
      setError('Select a category supported by the available cutoff data.');
      return;
    }
    if (!token) {
      setError('Sign in again to search MHT-CET cutoffs.');
      return;
    }

    const clearBranch = relaxedFilter === 'branch' || relaxedFilter === 'all';
    const clearCity = relaxedFilter === 'city' || relaxedFilter === 'all';
    const clearCapRound = relaxedFilter === 'cap_round' || relaxedFilter === 'all';
    if (clearBranch) setBranch('');
    if (clearCity) setCity('');
    if (clearCapRound) setCapRound('');

    setLoading(true);
    try {
      const response = await apiRequest<MhtcetResponse>('/recommendations/mhtcet', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          rank: parsedRank,
          branch: clearBranch ? null : branch || null,
          city: clearCity ? null : city || null,
          category,
          cap_round: !clearCapRound && capRound ? Number(capRound) : null,
          seat_level: seatLevel,
        }),
      });
      setResult(response);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'MHT-CET recommendations could not be loaded.');
    } finally {
      setLoading(false);
    }
  }

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runSearch();
  }

  async function applyNow(item: MhtcetRecommendation) {
    if (!token) {
      setError('Sign in again to record your application intent.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await apiRequest('/applications/external-intent', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          exam: 'MHT-CET',
          institution: item.institute,
          programme: item.branch,
          admission_cycle: item.year,
          official_application_url: 'https://cetcell.mahacet.org/',
          official_website: 'https://cetcell.mahacet.org/',
        }),
      });
      window.open('https://cetcell.mahacet.org/', '_blank', 'noopener,noreferrer');
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not record application intent.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="card grid gap-5" aria-labelledby="mhtcet-recommendations-title">
      <div>
        <p className="eyebrow">Separate historical cutoff comparison</p>
        <h2 id="mhtcet-recommendations-title" className="text-xl font-semibold">MHT-CET College Recommendations</h2>
        <p className="mt-2 text-sm text-slate-600">
          Compare an MHT-CET CAP rank with matching historical closing ranks. No percentile conversion or admission probability is inferred.
        </p>
      </div>

      {optionsError ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{optionsError}</p> : null}
      {!options && !optionsError ? <p role="status" aria-live="polite" className="text-sm text-slate-600">Loading available MHT-CET filters…</p> : null}

      <form className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" onSubmit={handleSearch}>
        <label className="field-group" htmlFor="mhtcet-rank">
          MHT-CET CAP rank
          <input
            id="mhtcet-rank"
            type="number"
            inputMode="numeric"
            min="1"
            step="1"
            required
            value={rank}
            onChange={(event) => setRank(event.target.value)}
            placeholder="Enter your rank"
          />
        </label>
        <label className="field-group" htmlFor="mhtcet-branch">
          Preferred branch
          <select id="mhtcet-branch" value={branch} onChange={(event) => setBranch(event.target.value)}>
            <option value="">All available branches</option>
            {(options?.branches ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label className="field-group" htmlFor="mhtcet-city">
          Preferred city
          <select id="mhtcet-city" value={city} onChange={(event) => setCity(event.target.value)}>
            <option value="">All cities in reference</option>
            {(options?.cities ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label className="field-group" htmlFor="mhtcet-category">
          Category
          <select id="mhtcet-category" required value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">Select category</option>
            {(options?.categories ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <small>Only categories present in the supplied cutoff data are available.</small>
        </label>
        <label className="field-group" htmlFor="mhtcet-cap-round">
          CAP round
          <select id="mhtcet-cap-round" value={capRound} onChange={(event) => setCapRound(event.target.value)}>
            <option value="">Any available round</option>
            {(options?.cap_rounds ?? []).map((item) => <option key={item} value={item}>Round {item}</option>)}
          </select>
        </label>
        <label className="field-group" htmlFor="mhtcet-seat-pool">
          Seat pool
          <select id="mhtcet-seat-pool" value={seatLevel} onChange={(event) => setSeatLevel(event.target.value)}>
            {(options?.seat_pools ?? [])
              .map((item) => (
                <option key={item.value} value={item.value} disabled={!item.selectable} title={item.reason ?? undefined}>
                  {item.label}
                </option>
              ))}
          </select>
          <small>All India seats are not compared with MHT-CET rank because the supplied reference identifies them as JEE Main based.</small>
        </label>
        <div className="flex items-end">
          <button type="submit" className="button button-primary w-full" disabled={loading || !options}>
            {loading ? 'Searching historical cutoffs…' : 'Search recommendations'}
          </button>
        </div>
      </form>

      {error ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
      {loading ? <p role="status" aria-live="polite" className="text-sm text-slate-600">Comparing your rank with matching historical records…</p> : null}
      {result ? (
        <div aria-live="polite" aria-busy={loading}>
          {result.recommendations.length ? (
            <>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-slate-600">
                  {result.recommendations.length} matching historical record{result.recommendations.length === 1 ? '' : 's'}
                </p>
                <label className="field-group">
                  Sort results
                  <select value={sortOrder} onChange={(event) => setSortOrder(event.target.value as SortOrder)}>
                    <option value="within-first">Within historical cutoff first</option>
                    <option value="college">College name</option>
                    <option value="closing-rank">Closing rank: low to high</option>
                  </select>
                </label>
              </div>
              <div className="grid gap-3">
                {sortedRecommendations.map((item, index) => {
                  const withinCutoff = item.comparison === 'within_historical_cutoff';
                  return (
                    <article
                      key={`${item.institute}-${item.branch}-${item.year}-${item.cap_round}-${index}`}
                      className="rounded-xl border border-slate-200 p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h3 className="font-semibold text-slate-900">{item.institute}</h3>
                          <p className="text-sm text-slate-700">{item.branch}</p>
                          <p className="text-sm text-slate-600">{item.city ?? 'City unavailable in supplied college reference'}</p>
                        </div>
                        <span className={`rounded-full px-3 py-1 text-sm font-medium ${
                          withinCutoff ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'
                        }`}>
                          {withinCutoff ? 'Within historical cutoff' : 'Outside historical cutoff'}
                        </span>
                      </div>
                      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                        <div><dt className="inline font-medium">Historical closing rank: </dt><dd className="inline">{item.historical_closing_rank.toLocaleString('en-IN')}</dd></div>
                        <div><dt className="inline font-medium">Year and CAP round: </dt><dd className="inline">{item.year} · Round {item.cap_round}</dd></div>
                        <div><dt className="inline font-medium">Category and seat pool: </dt><dd className="inline">{item.category} · {item.seat_level}</dd></div>
                        <div><dt className="inline font-medium">Data verification: </dt><dd className="inline">{item.data_quality.replace(/_/g, ' ')}</dd></div>
                      </dl>
                      <p className="mt-2 text-xs text-slate-600">
                        {withinCutoff
                          ? 'Your rank is at or below this historical closing-rank boundary.'
                          : 'Your rank is beyond this historical closing-rank boundary.'}
                      </p>
                      <a className="mt-2 inline-block break-all text-sm text-indigo-700 underline" href={item.source_url} target="_blank" rel="noreferrer">
                        View cutoff source
                      </a>
                      <div className="mt-3">
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => void applyNow(item)}
                          className="button button-primary"
                        >
                          Apply Now
                        </button>
                        <a
                          className="ml-2 text-sm text-indigo-700 underline"
                          href="https://cetcell.mahacet.org/"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Maharashtra CET Cell
                        </a>
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-700">
              <p>{result.message ?? 'No comparable historical cutoff data is available for these filters.'}</p>
              {result.filter_suggestions?.length ? (
                <div className="mt-3">
                  <p className="mb-2 font-medium">Available dataset matches if you relax a filter:</p>
                  <div className="flex flex-wrap gap-2">
                    {result.filter_suggestions.map((suggestion) => (
                      <button
                        key={suggestion.filter}
                        type="button"
                        className="button button-secondary"
                        disabled={loading}
                        onClick={() => void runSearch(suggestion.filter)}
                      >
                        {suggestion.label} ({suggestion.matching_rows})
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
          <p className="mt-3 text-xs text-slate-600">{result.disclaimer}</p>
        </div>
      ) : null}
    </section>
  );
}
