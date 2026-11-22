import { FormEvent, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../services/api';

type ChatSource = {
  source_id: string;
  label: string;
  data_status: string;
  source_url: string | null;
};

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  sources: ChatSource[];
};

type ChatSession = {
  session_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
};

type ChatSessionDetail = ChatSession & { messages: ChatMessage[] };
type ChatResponse = { session: ChatSession; answer: string; sources: ChatSource[] };
const QUICK_PROMPTS = [
  'Which information about this college is verified?',
  'What profile details are missing for a useful comparison?',
  'Explain how to interpret historical cutoff records.',
];

export default function AdmissionChatWidget({
  token,
  open,
  onOpen,
  onClose,
  contextCollegeId,
  onClearContext,
}: {
  token: string | null;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  contextCollegeId: string | null;
  onClearContext: () => void;
}) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || !token) return undefined;
    let active = true;
    setError(null);
    void (async () => {
      try {
        const available = await apiRequest<ChatSession[]>('/ai/chat/sessions', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!active) return;
        setSessions(available);
        const latestSession = available[0];
        setSessionId(latestSession?.session_id ?? null);
        if (latestSession) {
          const detail = await apiRequest<ChatSessionDetail>(
            `/ai/chat/sessions/${encodeURIComponent(latestSession.session_id)}`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          if (active) setMessages(detail.messages);
        } else {
          setMessages([]);
        }
      } catch (requestError) {
        if (active) setError(requestError instanceof Error ? requestError.message : 'Could not load chat history.');
      }
    })();
    return () => { active = false; };
  }, [open, token]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, loading]);

  async function loadSession(nextSessionId: string) {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const detail = await apiRequest<ChatSessionDetail>(
        `/ai/chat/sessions/${encodeURIComponent(nextSessionId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setSessionId(nextSessionId);
      setMessages(detail.messages);
      onClearContext();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not open this conversation.');
    } finally {
      setLoading(false);
    }
  }

  async function startNewChat() {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const session = await apiRequest<ChatSession>('/ai/chat/new-session', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      setSessionId(session.session_id);
      setMessages([]);
      setSessions((items) => [session, ...items]);
      onClearContext();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not start a new conversation.');
    } finally {
      setLoading(false);
    }
  }

  async function clearChat() {
    if (!token || !sessionId) {
      setMessages([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await apiRequest(`/ai/chat/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      setSessions((items) => items.filter((item) => item.session_id !== sessionId));
      setSessionId(null);
      setMessages([]);
      onClearContext();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not clear this conversation.');
    } finally {
      setLoading(false);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!token || !message || loading) return;
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const response = await apiRequest<ChatResponse>('/ai/chat', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          message,
          ...(sessionId ? { session_id: sessionId } : {}),
          ...(contextCollegeId ? { context_college_id: contextCollegeId } : {}),
        }),
      });
      const timestamp = new Date().toISOString();
      setSessionId(response.session.session_id);
      setMessages((items) => [
        ...items,
        { role: 'user', content: message, created_at: timestamp, sources: [] },
        { role: 'assistant', content: response.answer, created_at: timestamp, sources: response.sources },
      ]);
      setDraft('');
      setSessions((items) => [
        response.session,
        ...items.filter((item) => item.session_id !== response.session.session_id),
      ]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The AI assistant could not answer this message.');
    } finally {
      setLoading(false);
    }
  }

  async function copyLatestAnswer() {
    const answer = [...messages].reverse().find((item) => item.role === 'assistant')?.content;
    if (!answer) return;
    try {
      await navigator.clipboard.writeText(answer);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('Could not copy the answer. Check your browser clipboard permissions.');
    }
  }

  return (
    <>
      <button
        type="button"
        className="ai-chat-launcher"
        aria-label={open ? 'Close AI admission assistant' : 'Open AI admission assistant'}
        aria-expanded={open}
        onClick={open ? onClose : onOpen}
      >
        <span aria-hidden="true">AI</span>
        <span>Ask AI</span>
      </button>
      {open ? (
        <div className="ai-chat-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}>
          <section className="ai-chat-panel" role="dialog" aria-modal="true" aria-labelledby="ai-chat-title">
            <header className="ai-chat-header">
              <div>
                <p className="ai-predictor-eyebrow">LOCAL OLLAMA ASSISTANT</p>
                <h2 id="ai-chat-title">Admission AI</h2>
                <span>Answers are grounded in available portal records.</span>
              </div>
              <button type="button" className="ai-chat-close" aria-label="Close chat" onClick={onClose}>×</button>
            </header>

            <div className="ai-chat-toolbar">
              <label>
                <span className="sr-only">Conversation history</span>
                <select value={sessionId ?? ''} onChange={(event) => void loadSession(event.target.value)} disabled={loading}>
                  <option value="">New conversation</option>
                  {sessions.map((session) => <option key={session.session_id} value={session.session_id}>{session.title}</option>)}
                </select>
              </label>
              <button type="button" onClick={() => void startNewChat()} disabled={loading}>New chat</button>
              <button type="button" onClick={() => void clearChat()} disabled={loading || (!sessionId && messages.length === 0)}>Clear</button>
            </div>

            {contextCollegeId ? (
              <div className="ai-chat-context">
                Asking about a selected college
                <button type="button" onClick={onClearContext}>Remove context</button>
              </div>
            ) : null}
            {error ? <p className="ai-chat-error" role="alert">{error}</p> : null}

            <div className="ai-chat-messages" aria-live="polite">
              {!messages.length ? (
                <div className="ai-chat-welcome">
                  <strong>How can I help with your admissions research?</strong>
                  <p>I only use records available to this portal. Missing or unverified facts will be identified, not guessed.</p>
                  <div className="ai-chat-quick-prompts">
                    {QUICK_PROMPTS.map((prompt) => (
                      <button key={prompt} type="button" onClick={() => setDraft(prompt)}>{prompt}</button>
                    ))}
                  </div>
                </div>
              ) : null}
              {messages.map((message, index) => (
                <article className={`ai-chat-message ai-chat-message-${message.role}`} key={`${message.created_at}-${index}`}>
                  <div className="ai-chat-message-content">{message.content}</div>
                  {message.role === 'assistant' && message.sources.length ? (
                    <div className="ai-chat-sources">
                      <strong>Sources</strong>
                      {message.sources.map((source) => (
                        <div key={source.source_id}>
                          {source.source_url
                            ? <a href={source.source_url} target="_blank" rel="noopener noreferrer">{source.label}</a>
                            : <span>{source.label}</span>}
                          <small>{source.data_status}</small>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))}
              {loading ? <p className="ai-chat-typing" role="status">Checking available records…</p> : null}
              <div ref={messagesEndRef} />
            </div>

            {messages.some((item) => item.role === 'assistant') ? (
              <div className="ai-chat-copy-row">
                <button type="button" onClick={() => void copyLatestAnswer()}>{copied ? 'Copied' : 'Copy latest answer'}</button>
              </div>
            ) : null}
            <form className="ai-chat-compose" onSubmit={(event) => void sendMessage(event)}>
              <label htmlFor="ai-chat-input" className="sr-only">Ask a question</label>
              <textarea
                id="ai-chat-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                maxLength={2000}
                rows={2}
                placeholder="Ask about verified admission information…"
                disabled={loading}
              />
              <button type="submit" className="button button-primary" disabled={loading || !draft.trim()}>
                {loading ? 'Working…' : 'Send'}
              </button>
            </form>
            <p className="ai-chat-disclaimer">Historical records are not current eligibility decisions or admission guarantees. Chat data is stored with your account.</p>
          </section>
        </div>
      ) : null}
    </>
  );
}
