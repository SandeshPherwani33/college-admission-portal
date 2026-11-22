import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

type ApiRequest = <T>(path: string, token?: string, body?: unknown) => Promise<T>;

type MhtcetOptions = {
  categories: string[];
  branches: string[];
  cities: string[];
  cap_rounds: number[];
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
};

type MhtcetResponse = {
  data_status: 'partial_historical_data' | 'insufficient_data';
  recommendations: MhtcetRecommendation[];
  message: string | null;
  disclaimer: string;
};

export default function MhtcetRecommendations({
  token,
  apiRequest,
}: {
  token: string | null;
  apiRequest: ApiRequest;
}) {
  const [options, setOptions] = useState<MhtcetOptions | null>(null);
  const [optionsError, setOptionsError] = useState('');
  const [rank, setRank] = useState('');
  const [branch, setBranch] = useState('');
  const [city, setCity] = useState('');
  const [category, setCategory] = useState('');
  const [capRound, setCapRound] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<MhtcetResponse | null>(null);

  useEffect(() => {
    if (!token) return;
    let active = true;
    apiRequest<MhtcetOptions>('/recommendations/mhtcet/options', token)
      .then((response) => {
        if (active) setOptions(response);
      })
      .catch((requestError: unknown) => {
        if (active) {
          setOptionsError(requestError instanceof Error ? requestError.message : 'Could not load MHT-CET filters.');
        }
      });
    return () => {
      active = false;
    };
  }, [apiRequest, token]);

  async function search() {
    setError('');
    setResult(null);
    const parsedRank = Number(rank);
    if (!Number.isSafeInteger(parsedRank) || parsedRank <= 0) {
      setError('Enter a positive whole-number MHT-CET CAP rank.');
      return;
    }
    if (!category.trim()) {
      setError('Enter a category supported by the available cutoff data.');
      return;
    }
    if (capRound && (!Number.isInteger(Number(capRound)) || Number(capRound) < 1 || Number(capRound) > 4)) {
      setError('Enter a CAP round from 1 to 4.');
      return;
    }
    if (!token) {
      setError('Sign in again to search MHT-CET cutoffs.');
      return;
    }

    setLoading(true);
    try {
      const response = await apiRequest<MhtcetResponse>('/recommendations/mhtcet', token, {
        rank: parsedRank,
        branch: branch.trim() || null,
        city: city.trim() || null,
        category: category.trim(),
        cap_round: capRound ? Number(capRound) : null,
        seat_level: 'State',
      });
      setResult(response);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'MHT-CET recommendations could not be loaded.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>MHT-CET College Recommendations</Text>
      <Text style={styles.body}>
        Compare your MHT-CET CAP rank with matching historical cutoffs. No percentile conversion or admission probability is inferred.
      </Text>
      <Text style={styles.disclaimer}>
        Recommendations are based on available historical cutoff data and do not guarantee admission. Available cutoff records are partial 2026 secondary, unverified data.
      </Text>
      {optionsError ? <Text accessibilityRole="alert" style={styles.error}>{optionsError}</Text> : null}
      {!options && !optionsError ? (
        <View accessibilityLiveRegion="polite" style={styles.loading}>
          <ActivityIndicator />
          <Text style={styles.body}>Loading available MHT-CET filters…</Text>
        </View>
      ) : null}
      <TextInput
        accessibilityLabel="MHT-CET CAP rank"
        keyboardType="number-pad"
        value={rank}
        onChangeText={setRank}
        placeholder="MHT-CET CAP rank"
        style={styles.input}
      />
      <Text style={styles.helper}>
        Branches in this dataset: {(options?.branches ?? []).join(', ') || 'Unavailable'}
      </Text>
      <TextInput
        accessibilityLabel="Preferred branch"
        value={branch}
        onChangeText={setBranch}
        placeholder="Preferred branch (optional)"
        style={styles.input}
      />
      <Text style={styles.helper}>
        Cities in the supplied reference: {(options?.cities ?? []).join(', ') || 'Unavailable'}
      </Text>
      <TextInput
        accessibilityLabel="Preferred city"
        value={city}
        onChangeText={setCity}
        placeholder="Preferred city (optional)"
        style={styles.input}
      />
      <Text style={styles.helper}>
        Available categories: {(options?.categories ?? []).join(', ') || 'Unavailable'}
      </Text>
      <TextInput
        accessibilityLabel="Category"
        value={category}
        onChangeText={setCategory}
        placeholder="Category, for example General/Open"
        style={styles.input}
      />
      <Text style={styles.helper}>
        Available CAP rounds: {(options?.cap_rounds ?? []).join(', ') || 'Unavailable'}
      </Text>
      <TextInput
        accessibilityLabel="CAP round"
        keyboardType="number-pad"
        value={capRound}
        onChangeText={setCapRound}
        placeholder="CAP round (optional)"
        style={styles.input}
      />
      <Text style={styles.helper}>
        Comparisons use the State pool. All India seats are not compared with MHT-CET ranks because the supplied reference identifies them as JEE Main based.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: loading || !options }}
        disabled={loading || !options}
        onPress={() => void search()}
        style={[styles.button, (loading || !options) && styles.buttonDisabled]}
      >
        {loading ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.buttonText}>Search recommendations</Text>}
      </Pressable>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {result ? (
        <View accessibilityLiveRegion="polite" style={styles.results}>
          {result.recommendations.length ? result.recommendations.map((item, index) => {
            const withinCutoff = item.comparison === 'within_historical_cutoff';
            return (
              <View key={`${item.institute}-${item.branch}-${item.year}-${item.cap_round}-${index}`} style={styles.resultCard}>
                <Text style={styles.cardTitle}>{item.institute}</Text>
                <Text style={styles.body}>{item.branch}{item.city ? ` · ${item.city}` : ''}</Text>
                <Text style={[styles.status, withinCutoff ? styles.within : styles.outside]}>
                  {withinCutoff ? 'Within historical cutoff' : 'Outside historical cutoff'}
                </Text>
                <Text style={styles.body}>Historical closing rank: {item.historical_closing_rank.toLocaleString('en-IN')}</Text>
                <Text style={styles.body}>Year {item.year} · CAP round {item.cap_round} · {item.category} · {item.seat_level}</Text>
                <Text style={styles.helper}>Data verification: {item.data_quality.replace(/_/g, ' ')}</Text>
                <Pressable
                  accessibilityRole="link"
                  onPress={() => {
                    void Linking.openURL(item.source_url).catch(() => {
                      setError('The cutoff source link could not be opened on this device.');
                    });
                  }}
                >
                  <Text style={styles.link}>View cutoff source</Text>
                </Pressable>
              </View>
            );
          }) : (
            <Text style={styles.empty}>{result.message ?? 'No comparable historical cutoff data is available for these filters.'}</Text>
          )}
        </View>
      ) : null}
      <Text style={styles.helper}>{result?.disclaimer ?? 'Historical rank comparison only; this is not an admission guarantee.'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    backgroundColor: '#ffffff',
    borderColor: '#dce4eb',
    borderWidth: 1,
    borderRadius: 16,
    padding: 18,
    gap: 12,
  },
  heading: { color: '#10243a', fontSize: 20, fontWeight: '700' },
  body: { color: '#526476', lineHeight: 21 },
  disclaimer: { color: '#7a4b00', backgroundColor: '#fff7e6', padding: 12, borderRadius: 10, lineHeight: 20 },
  helper: { color: '#718296', fontSize: 12, lineHeight: 18 },
  input: { borderWidth: 1, borderColor: '#cbd6df', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: '#172d40', backgroundColor: '#ffffff' },
  button: { backgroundColor: '#127c8a', borderRadius: 10, padding: 12, alignItems: 'center' },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#ffffff', fontWeight: '700' },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  error: { color: '#b42318', backgroundColor: '#fff1f0', padding: 12, borderRadius: 10, lineHeight: 20 },
  results: { gap: 10 },
  resultCard: { borderColor: '#dce4eb', borderWidth: 1, borderRadius: 12, padding: 14, gap: 7 },
  cardTitle: { color: '#172d40', fontSize: 16, fontWeight: '700' },
  status: { fontWeight: '700' },
  within: { color: '#176b48' },
  outside: { color: '#7a4b00' },
  link: { color: '#127c8a', fontWeight: '600', paddingVertical: 4 },
  empty: { color: '#526476', borderColor: '#cbd6df', borderWidth: 1, borderStyle: 'dashed', borderRadius: 10, padding: 12 },
});
