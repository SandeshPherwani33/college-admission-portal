import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Button,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as SecureStore from 'expo-secure-store';
import MhtcetRecommendations from './MhtcetRecommendations';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL?.trim().replace(/\/+$/, '');
const TOKEN_KEY = 'uniapply-token';

type Screen = 'home' | 'profile' | 'documents' | 'recommendations' | 'interview';
type Profile = {
  student_id: string;
  full_name: string;
  email: string;
  location?: string | null;
  stream?: string | null;
  board?: string | null;
  academic_score?: number | null;
  budget?: number | null;
  career_goal?: string | null;
  preferred_fields?: string[];
  completion_percent: number;
};
type Recommendation = {
  institution: string;
  program: string;
  course: string;
  location: string | null;
  eligibility_status: 'eligible' | 'ineligible' | 'insufficient_data';
  reasons: string[];
  missing_info: string[];
};
type DocumentRecord = {
  document_id: string;
  filename: string;
  status: string;
  processing_status: string;
  extracted_fields: Record<string, unknown>;
};
type InterviewTurn = {
  question: string;
  answer: string | null;
  generation_mode: 'ollama' | 'openai' | 'deterministic_fallback';
};
type Interview = {
  interview_id: string;
  student_id: string;
  program: string;
  interview_type: 'general' | 'technical' | 'behavioral' | 'admissions';
  question_count: number;
  status: 'created' | 'in_progress' | 'completed';
  turns: InterviewTurn[];
  generation_notice: string;
  feedback: {
    summary: string;
    disclaimer: string;
  } | null;
};

async function apiRequest<T>(path: string, token?: string, body?: unknown): Promise<T> {
  if (!API_BASE_URL) {
    throw new Error('Set EXPO_PUBLIC_API_BASE_URL in mobile/.env.local to your reachable backend URL.');
  }
  const isMultipart = body instanceof FormData;
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined || isMultipart ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: isMultipart ? body : JSON.stringify(body) }),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>('home');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileForm, setProfileForm] = useState({
    full_name: '',
    location: '',
    stream: '',
    board: '',
    academic_score: '',
    budget: '',
    career_goal: '',
  });
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [interview, setInterview] = useState<Interview | null>(null);
  const [interviewHistory, setInterviewHistory] = useState<Interview[]>([]);
  const [interviewAnswer, setInterviewAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadProfile = async (activeToken: string) => {
    const result = await apiRequest<Profile>('/profile', activeToken);
    setProfile(result);
    setProfileForm({
      full_name: result.full_name ?? '',
      location: result.location ?? '',
      stream: result.stream ?? '',
      board: result.board ?? '',
      academic_score: result.academic_score == null ? '' : String(result.academic_score),
      budget: result.budget == null ? '' : String(result.budget),
      career_goal: result.career_goal ?? '',
    });
  };

  useEffect(() => {
    let active = true;
    SecureStore.getItemAsync(TOKEN_KEY).then((savedToken) => {
      if (active && savedToken) setToken(savedToken);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!token) return;
    setBusy(true);
    setError('');
    loadProfile(token)
      .catch(async (loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : 'Unable to load profile.');
        await SecureStore.deleteItemAsync(TOKEN_KEY);
        setToken(null);
      })
      .finally(() => setBusy(false));
  }, [token]);

  const authenticate = async () => {
    setBusy(true);
    setError('');
    try {
      const path = isRegistering ? '/auth/register' : '/auth/login';
      const body = isRegistering
        ? { full_name: fullName, email, password, role: 'student' }
        : { email, password };
      const result = await apiRequest<{ token: string }>(path, undefined, body);
      await SecureStore.setItemAsync(TOKEN_KEY, result.token);
      setToken(result.token);
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : 'Authentication failed.');
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'The request failed.');
    } finally {
      setBusy(false);
    }
  };

  const updateProfile = () => runAction(async () => {
    if (!token) return;
    const result = await apiRequest<Profile>('/profile', token, {
      ...profileForm,
      academic_score: profileForm.academic_score === '' ? null : Number(profileForm.academic_score),
      budget: profileForm.budget === '' ? null : Number(profileForm.budget),
    });
    setProfile(result);
    setNotice('Profile saved.');
  });

  const loadDocuments = () => runAction(async () => {
    if (!token) return;
    setDocuments(await apiRequest<DocumentRecord[]>('/documents', token));
  });

  const uploadDocument = () => runAction(async () => {
    if (!token) return;
    const selection = await DocumentPicker.getDocumentAsync({
      type: ['application/pdf', 'image/png', 'image/jpeg'],
      copyToCacheDirectory: false,
    });
    if (selection.canceled) return;
    const file = selection.assets[0];
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    const fileType = extension === 'jpeg' ? 'jpg' : extension;
    if (!['pdf', 'png', 'jpg'].includes(fileType)) {
      throw new Error('Choose a PDF, PNG, or JPG file.');
    }
    const formData = new FormData();
    formData.append('file', {
      uri: file.uri,
      name: file.name,
      type: file.mimeType || (fileType === 'pdf'
        ? 'application/pdf'
        : fileType === 'png'
          ? 'image/png'
          : 'image/jpeg'),
    } as unknown as Blob);
    const record = await apiRequest<DocumentRecord>('/documents/upload', token, formData);
    setDocuments((current) => [record, ...current]);
    setNotice('Document added for review.');
  });

  const loadRecommendations = () => runAction(async () => {
    if (!token) return;
    setRecommendations(await apiRequest<Recommendation[]>('/eligibility', token));
  });

  const loadInterviews = () => runAction(async () => {
    if (!token) return;
    const history = await apiRequest<Interview[]>('/interviews', token);
    setInterviewHistory(history);
    setInterview(
      history.find((item) => item.status === 'in_progress')
      ?? history.find((item) => item.status === 'created')
      ?? history[0]
      ?? null,
    );
  });

  const createInterview = () => runAction(async () => {
    if (!token || !profile) throw new Error('Your profile is still loading.');
    const created = await apiRequest<Interview>('/interviews', token, {
      program: profile.preferred_fields?.[0] || profile.career_goal || 'General Studies',
      interview_type: 'general',
      question_count: 5,
      mode: 'text',
    });
    const started = await apiRequest<Interview>(
      `/interviews/${encodeURIComponent(created.interview_id)}/start`,
      token,
    );
    setInterview(started);
    setInterviewHistory((current) => [started, ...current.filter((item) => item.interview_id !== started.interview_id)]);
  });

  const submitInterviewAnswer = () => runAction(async () => {
    if (!token || !interview) throw new Error('There is no active interview.');
    if (!interviewAnswer.trim()) throw new Error('Enter an answer before submitting.');
    const updated = await apiRequest<Interview>(
      `/interviews/${encodeURIComponent(interview.interview_id)}/answers`,
      token,
      { answer: interviewAnswer.trim() },
    );
    setInterviewAnswer('');
    setInterview(updated);
    setInterviewHistory((current) => [updated, ...current.filter((item) => item.interview_id !== updated.interview_id)]);
  });

  const openScreen = (nextScreen: Screen) => {
    setScreen(nextScreen);
    if (nextScreen === 'documents') void loadDocuments();
    if (nextScreen === 'recommendations') void loadRecommendations();
    if (nextScreen === 'interview') void loadInterviews();
  };

  const signOut = async () => {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    setToken(null);
    setProfile(null);
    setDocuments([]);
    setRecommendations([]);
    setInterview(null);
    setInterviewHistory([]);
    setScreen('home');
  };

  if (!token) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="light-content" />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.safeArea}>
          <ScrollView contentContainerStyle={styles.authContainer} keyboardShouldPersistTaps="handled">
            <Text style={styles.brand}>UniApply-AI</Text>
            <Text style={styles.subtitle}>Your admissions journey, in one place.</Text>
            <View style={styles.card}>
              <Text style={styles.heading}>{isRegistering ? 'Create student account' : 'Student sign in'}</Text>
              {isRegistering ? (
                <Field label="Full name" value={fullName} onChangeText={setFullName} />
              ) : null}
              <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" />
              <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry />
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Button title={busy ? 'Please wait...' : isRegistering ? 'Create account' : 'Sign in'} disabled={busy} onPress={authenticate} />
              <Pressable onPress={() => { setIsRegistering(!isRegistering); setError(''); }}>
                <Text style={styles.link}>{isRegistering ? 'Already registered? Sign in' : 'New here? Create an account'}</Text>
              </Pressable>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" />
      <View style={styles.header}>
        <View>
          <Text style={styles.brand}>UniApply-AI</Text>
          <Text style={styles.headerCaption}>{profile?.full_name || 'Student workspace'}</Text>
        </View>
        <Pressable onPress={signOut}><Text style={styles.headerAction}>Sign out</Text></Pressable>
      </View>
      <View style={styles.tabs}>
        {(['home', 'profile', 'documents', 'recommendations', 'interview'] as Screen[]).map((item) => (
          <Pressable key={item} style={[styles.tab, screen === item && styles.activeTab]} onPress={() => openScreen(item)}>
            <Text style={[styles.tabText, screen === item && styles.activeTabText]}>{item === 'home' ? 'Home' : item === 'documents' ? 'Docs' : item === 'recommendations' ? 'Matches' : item === 'interview' ? 'Practice' : 'Profile'}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {busy ? <ActivityIndicator color="#127c8a" /> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {notice ? <Text style={styles.success}>{notice}</Text> : null}
        {screen === 'home' ? (
          <>
            <Text style={styles.heading}>Student dashboard</Text>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Profile completion</Text>
              <Text style={styles.metric}>{profile?.completion_percent ?? 0}%</Text>
              <Text style={styles.bodyText}>Keep your profile up to date to improve your college matches.</Text>
            </View>
            <Text style={styles.cardTitle}>Your next steps</Text>
            <ActionRow title="Complete your profile" onPress={() => openScreen('profile')} />
            <ActionRow title="Add a document for review" onPress={() => openScreen('documents')} />
            <ActionRow title="Explore recommendations" onPress={() => openScreen('recommendations')} />
            <ActionRow title="Start interview practice" onPress={() => openScreen('interview')} />
          </>
        ) : null}
        {screen === 'profile' ? (
          <View style={styles.card}>
            <Text style={styles.heading}>Your profile</Text>
            {([
              ['full_name', 'Full name'],
              ['location', 'Location'],
              ['stream', 'Stream'],
              ['board', 'Education board'],
              ['academic_score', 'Academic score'],
              ['budget', 'Annual budget'],
              ['career_goal', 'Career goal'],
            ] as const).map(([key, label]) => (
              <Field
                key={key}
                label={label}
                value={profileForm[key]}
                onChangeText={(value) => setProfileForm((current) => ({ ...current, [key]: value }))}
                keyboardType={key === 'budget' || key === 'academic_score' ? 'decimal-pad' : 'default'}
              />
            ))}
            <Button title="Save profile" disabled={busy} onPress={() => void updateProfile()} />
          </View>
        ) : null}
        {screen === 'documents' ? (
          <>
            <Text style={styles.heading}>Documents</Text>
            <View style={styles.card}>
              <Text style={styles.bodyText}>Choose a PDF or image document to add it to your review list.</Text>
              <View style={styles.buttonGap}><Button title="Choose document" disabled={busy} onPress={() => void uploadDocument()} /></View>
              <Button title="Refresh list" disabled={busy} onPress={() => void loadDocuments()} />
            </View>
            {documents.map((item) => <View key={item.document_id} style={styles.listItem}><Text style={styles.cardTitle}>{item.filename}</Text><Text style={styles.muted}>{item.status.replaceAll('_', ' ')}</Text></View>)}
          </>
        ) : null}
        {screen === 'recommendations' ? (
          <>
            <Text style={styles.heading}>Recommended colleges</Text>
            <Button title="Refresh recommendations" disabled={busy} onPress={() => void loadRecommendations()} />
            {recommendations.map((item) => (
              <View key={`${item.institution}-${item.program}`} style={styles.card}>
                <Text style={styles.cardTitle}>{item.institution}</Text>
                <Text style={styles.bodyText}>{item.program}{item.location ? ` · ${item.location}` : ''}</Text>
                <Text style={styles.metricSmall}>{item.eligibility_status.replaceAll('_', ' ')}</Text>
                {item.reasons.map((reason, index) => (
                  <Text key={`${item.institution}-${index}`} style={styles.muted}>{reason}</Text>
                ))}
                {item.missing_info.length ? (
                  <Text style={styles.muted}>Missing: {item.missing_info.join(', ')}</Text>
                ) : null}
              </View>
            ))}
            {!recommendations.length ? (
              <Text style={styles.bodyText}>No configured eligibility results are available yet.</Text>
            ) : null}
            <MhtcetRecommendations token={token} apiRequest={apiRequest} />
          </>
        ) : null}
        {screen === 'interview' ? (
          <>
            <Text style={styles.heading}>Interview practice</Text>
            <View style={styles.card}>
              <Text style={styles.bodyText}>Generate a practice interview using your current study stream.</Text>
              <View style={styles.buttonGap}><Button title="Start practice" disabled={busy} onPress={() => void createInterview()} /></View>
            </View>
            {interview ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{interview.program}</Text>
                <Text style={styles.muted}>{interview.status.replaceAll('_', ' ')}</Text>
                <Text style={styles.bodyText}>{interview.generation_notice}</Text>
                {interview.status === 'created' ? (
                  <Button
                    title="Start this session"
                    disabled={busy}
                    onPress={() => runAction(async () => {
                      if (!token) return;
                      const started = await apiRequest<Interview>(
                        `/interviews/${encodeURIComponent(interview.interview_id)}/start`,
                        token,
                      );
                      setInterview(started);
                      setInterviewHistory((current) => [started, ...current.filter((item) => item.interview_id !== started.interview_id)]);
                    })}
                  />
                ) : null}
                {interview.turns.map((turn, index) => (
                  <View key={`${interview.interview_id}-${index}`} style={styles.listItem}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cardTitle}>Question {index + 1}</Text>
                      <Text style={styles.bodyText}>{turn.question}</Text>
                      {turn.answer ? <Text style={styles.muted}>Your answer: {turn.answer}</Text> : null}
                    </View>
                  </View>
                ))}
                {interview.status === 'in_progress' && interview.turns.at(-1)?.answer == null ? (
                  <>
                    <Field
                      label="Your answer"
                      value={interviewAnswer}
                      onChangeText={setInterviewAnswer}
                    />
                    <Button title="Submit answer" disabled={busy || !interviewAnswer.trim()} onPress={() => void submitInterviewAnswer()} />
                  </>
                ) : null}
                {interview.status === 'completed' && interview.feedback ? (
                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>Practice feedback</Text>
                    <Text style={styles.bodyText}>{interview.feedback.summary}</Text>
                    <Text style={styles.muted}>{interview.feedback.disclaimer}</Text>
                  </View>
                ) : null}
              </View>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  keyboardType?: 'default' | 'email-address' | 'decimal-pad';
  secureTextEntry?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      <TextInput
        value={props.value}
        onChangeText={props.onChangeText}
        autoCapitalize={props.keyboardType === 'email-address' ? 'none' : 'sentences'}
        keyboardType={props.keyboardType ?? 'default'}
        secureTextEntry={props.secureTextEntry}
        style={styles.input}
        placeholder={props.label}
        placeholderTextColor="#8b9aaa"
      />
    </View>
  );
}

function ActionRow({ title, onPress }: { title: string; onPress: () => void }) {
  return <Pressable style={styles.listItem} onPress={onPress}><Text style={styles.cardTitle}>{title}</Text><Text style={styles.link}>Open ›</Text></Pressable>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#f1f5f8' },
  authContainer: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  header: { backgroundColor: '#10243a', paddingHorizontal: 20, paddingVertical: 18, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  brand: { color: '#ffffff', fontSize: 24, fontWeight: '700' },
  headerCaption: { color: '#bfcedb', marginTop: 4 },
  headerAction: { color: '#8de0dd', fontWeight: '600' },
  subtitle: { color: '#526476', marginTop: 8, marginBottom: 22 },
  tabs: { flexDirection: 'row', backgroundColor: '#ffffff', paddingHorizontal: 6, borderBottomWidth: 1, borderColor: '#dce4eb' },
  tab: { flex: 1, paddingVertical: 13, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  activeTab: { borderBottomColor: '#127c8a' },
  tabText: { color: '#607284', fontSize: 11, fontWeight: '600' },
  activeTabText: { color: '#127c8a' },
  content: { padding: 18, gap: 14, paddingBottom: 36 },
  card: { backgroundColor: '#ffffff', borderColor: '#dce4eb', borderWidth: 1, borderRadius: 16, padding: 18, gap: 12 },
  heading: { color: '#10243a', fontSize: 22, fontWeight: '700', marginBottom: 4 },
  cardTitle: { color: '#172d40', fontSize: 16, fontWeight: '700' },
  bodyText: { color: '#526476', lineHeight: 21 },
  metric: { color: '#127c8a', fontSize: 36, fontWeight: '700' },
  metricSmall: { color: '#127c8a', fontSize: 18, fontWeight: '700' },
  muted: { color: '#718296', fontSize: 13, textTransform: 'capitalize' },
  field: { gap: 6 },
  fieldLabel: { color: '#42566a', fontSize: 13, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: '#cbd6df', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: '#172d40', backgroundColor: '#ffffff' },
  link: { color: '#127c8a', fontWeight: '600', textAlign: 'center', marginTop: 12 },
  error: { color: '#b42318', backgroundColor: '#fff1f0', padding: 12, borderRadius: 10, lineHeight: 20 },
  success: { color: '#176b48', backgroundColor: '#eaf7ef', padding: 12, borderRadius: 10 },
  listItem: { backgroundColor: '#ffffff', borderColor: '#dce4eb', borderWidth: 1, borderRadius: 12, padding: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  question: { color: '#42566a', lineHeight: 21, marginTop: 4 },
  buttonGap: { marginTop: 4 },
});
