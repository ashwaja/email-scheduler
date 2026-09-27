import { useEffect, useMemo, useState } from 'react';
import { maxRecipientFileBytes, parseRecipientText } from './recipient-parser';

type SessionUser = {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
};

type Sender = {
  id: string;
  label: string;
  emailAddress: string;
  enabled: boolean;
  createdAt: string;
};

type EmailRow = {
  id: string;
  email: string;
  subject: string;
  scheduledAt: string;
  sentAt: string | null;
  status: 'scheduled' | 'sent' | 'failed' | 'sending';
};

type ViewMode = 'scheduled' | 'sent';

const emptyForm = {
  senderId: '',
  subject: 'Weekly update',
  body: 'Hello team,\n\nThis is a test send from the scheduler dashboard.',
  recipients: 'a@example.com\nb@example.com',
  startsAt: toDateTimeLocal(new Date(Date.now() + 60_000)),
  delayBetweenEmailsMs: 2000,
  hourlyLimit: 20,
};

function toDateTimeLocal(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function ProfileAvatar({ user }: { user: SessionUser }) {
  const [imageFailed, setImageFailed] = useState(false);
  if (!user.avatarUrl || imageFailed) {
    return <div className="avatar" aria-hidden="true">{user.name.trim().charAt(0).toUpperCase() || 'U'}</div>;
  }
  return <img className="avatar" src={user.avatarUrl} alt={`${user.name}'s Google profile`} onError={() => setImageFailed(true)} />;
}

export default function App() {
  const [health, setHealth] = useState<'checking' | 'ok' | 'error'>('checking');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('scheduled');
  const [senders, setSenders] = useState<Sender[]>([]);
  const [emails, setEmails] = useState<EmailRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [loadingSenders, setLoadingSenders] = useState(false);
  const [sendersError, setSendersError] = useState<string | null>(null);
  const [loadingEmails, setLoadingEmails] = useState(false);
  const [emailListError, setEmailListError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsedRecipients = useMemo(() => parseRecipientText(form.recipients), [form.recipients]);

  const loadUser = async () => {
    try {
      const response = await fetch('/api/auth/me', { credentials: 'include' });
      if (response.status === 401) {
        setUser(null);
        setSessionError(null);
        return;
      }
      if (!response.ok) {
        throw new Error('Session fetch failed');
      }
      const payload = await response.json() as { user?: SessionUser };
      setUser(payload.user ?? null);
      setSessionError(payload.user ? null : 'The server did not return a signed-in profile.');
    } catch {
      setSessionError('Could not check your sign-in session. Check your connection and retry.');
    } finally {
      setLoadingUser(false);
    }
  };

  const loadSenders = async () => {
    try {
      setLoadingSenders(true);
      setSendersError(null);
      const response = await fetch('/api/senders', { credentials: 'include' });
      if (!response.ok) {
        throw new Error('Failed to load senders');
      }
      const payload = await response.json() as { senders?: Sender[] };
      const nextSenders = payload.senders ?? [];
      setSenders(nextSenders);
      setForm((current) => ({
        ...current,
        senderId: nextSenders.some((sender) => sender.id === current.senderId)
          ? current.senderId
          : nextSenders[0]?.id ?? '',
      }));
    } catch (caughtError) {
      setSenders([]);
      setSendersError(caughtError instanceof Error ? caughtError.message : 'Could not load senders.');
    } finally {
      setLoadingSenders(false);
    }
  };

  const loadEmails = async (mode: ViewMode = view, query = searchQuery, cursor?: string, append = false) => {
    setLoadingEmails(true);
    setEmailListError(null);
    try {
      const endpoint = query.trim()
        ? `/api/search?q=${encodeURIComponent(query.trim())}&status=${mode}&limit=20`
        : `/api/emails?view=${mode}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = await fetch(endpoint, { credentials: 'include' });
      if (!response.ok) {
        throw new Error(`Could not load ${mode} emails (HTTP ${response.status}).`);
      }
      const payload = await response.json() as {
        emails?: Array<EmailRow & { recipient?: string }>;
        nextCursor?: string | null;
      };
      if (!Array.isArray(payload.emails)) throw new Error('The email list response was invalid.');
      const normalized = payload.emails.map((email) => ({ ...email, email: email.email ?? email.recipient ?? '' }));
      setEmails((current) => append ? [...current, ...normalized] : normalized);
      setNextCursor(query.trim() ? null : payload.nextCursor ?? null);
    } catch (caughtError) {
      setEmailListError(caughtError instanceof Error ? caughtError.message : 'Could not load emails.');
    } finally {
      setLoadingEmails(false);
    }
  };

  useEffect(() => {
    void fetch('/api/health')
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Health check failed');
        }
        const data = await response.json() as { status?: string };
        setHealth(data.status === 'ok' ? 'ok' : 'error');
      })
      .catch(() => setHealth('error'));

    void loadUser();
  }, []);

  useEffect(() => {
    if (!user) return;
    void loadSenders();
    void loadEmails();
  }, [user, view]);

  async function handleSearchSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) return;
    await loadEmails(view, searchQuery);
  }

  async function provisionSender() {
    setError(null);
    setNotice('Provisioning a fresh Ethereal sender...');
    try {
      const response = await fetch('/api/senders/ethereal', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Ethereal test sender' }),
      });
      const payload = await response.json() as { sender?: Sender; error?: { message?: string } };
      if (!response.ok) {
        throw new Error(payload.error?.message ?? 'Sender provisioning failed');
      }
      setNotice(`New sender ready: ${payload.sender?.emailAddress ?? 'Ethereal account'}`);
      await loadSenders();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Sender provisioning failed');
    }
  }

  async function handleFileUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      setUploading(true);
      setError(null);
      setNotice(null);
      const extension = file.name.split('.').pop()?.toLowerCase();
      const allowedTypes = ['text/csv', 'text/plain', 'application/vnd.ms-excel'];
      if (!['csv', 'txt'].includes(extension ?? '') || (file.type && !allowedTypes.includes(file.type))) {
        throw new Error('Choose a CSV or plain-text (.csv or .txt) file.');
      }
      if (file.size > maxRecipientFileBytes) {
        throw new Error(`The file exceeds the ${maxRecipientFileBytes / 1024 / 1024} MB upload limit.`);
      }
      const text = await file.text();
      const parsed = parseRecipientText(text);
      setForm((current) => ({
        ...current,
        recipients: parsed.accepted.join('\n'),
      }));
      setNotice(`Loaded ${parsed.accepted.length} unique recipient(s); ${parsed.duplicateCount} duplicate(s), ${parsed.invalidCount} invalid address(es), ${parsed.rejectedRows} rejected row(s).`);
      if (parsed.errors.length) setError(parsed.errors.join(' '));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Could not read the uploaded recipient file.');
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const startsAt = new Date(form.startsAt);
    if (!user || !form.senderId) {
      setError('Choose a sender or sign in first.');
      return;
    }
    if (!form.subject.trim() || !form.body.trim()) {
      setError('Enter both a subject and message body.');
      return;
    }
    if (!Number.isFinite(startsAt.getTime()) || startsAt.getTime() <= Date.now()) {
      setError('Choose a start time in the future.');
      return;
    }
    if (!parsedRecipients.accepted.length) {
      setError('Add at least one valid, unique recipient before scheduling.');
      return;
    }

    setSubmitting(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch('/api/email-batches', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        },
        body: JSON.stringify({
          senderId: form.senderId,
          subject: form.subject,
          body: form.body,
          recipients: parsedRecipients.accepted,
          startsAt: startsAt.toISOString(),
          delayBetweenEmailsMs: Number(form.delayBetweenEmailsMs),
          hourlyLimit: Number(form.hourlyLimit),
        }),
      });

      const payload = await response.json() as {
        error?: { message?: string; fields?: Array<{ field: string; message: string }> };
        batchId?: string;
        recipientCount?: number;
      };
      if (!response.ok) {
        const fieldErrors = payload.error?.fields?.map(({ field, message }) => `${field}: ${message}`) ?? [];
        throw new Error([payload.error?.message ?? 'Schedule failed', ...fieldErrors].join(' '));
      }

      const scheduledCount = payload.recipientCount ?? parsedRecipients.accepted.length;
      setNotice(scheduledCount === parsedRecipients.accepted.length
        ? `Batch queued for ${scheduledCount} recipient(s).`
        : `Server accepted ${scheduledCount} recipient(s) from ${parsedRecipients.accepted.length} submitted.`);
      setForm((current) => ({ ...current, recipients: '', body: current.body }));
      await loadEmails();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Schedule failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function connectSlack() {
    window.location.href = '/api/auth/slack';
  }

  async function disconnectSlack() {
    try {
      const response = await fetch('/api/auth/slack', { method: 'DELETE', credentials: 'include' });
      if (!response.ok) throw new Error(`Slack disconnect failed (HTTP ${response.status}).`);
      setNotice('Slack integration disconnected.');
      setError(null);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Slack disconnect failed.');
    }
  }

  async function logout() {
    setLoggingOut(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message ?? `Logout failed (HTTP ${response.status}).`);
      }
      setUser(null);
      setEmails([]);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Logout failed. Try again.');
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">Scheduler</p>
            <h1>Email Dispatch Dashboard</h1>
          </div>
          {user ? (
            <div className="user-box">
              <ProfileAvatar user={user} />
              <div>
                <strong>{user.name}</strong>
                <small>{user.email}</small>
              </div>
              <button type="button" className="ghost-button" onClick={logout} disabled={loggingOut}>
                {loggingOut ? 'Signing out…' : 'Logout'}
              </button>
            </div>
          ) : (
            <button type="button" className="primary-button" onClick={() => { window.location.href = '/api/auth/google'; }}>
              Sign in with Google
            </button>
          )}
        </header>

        <div className="stats">
          <div>
            <span>API</span>
            <strong>{health === 'ok' ? 'Responding' : health === 'error' ? 'Unavailable' : 'Checking…'}</strong>
          </div>
          <div>
            <span>Auth</span>
            <strong>{loadingUser ? 'Checking…' : user ? 'Signed in' : sessionError ? 'Unavailable' : 'Signed out'}</strong>
          </div>
        </div>

        {!user ? (
          <div className="empty-state">
            {loadingUser ? <h2>Checking your sign-in session…</h2> : sessionError ? (
              <>
                <h2>Could not check your sign-in session</h2>
                <p role="alert">{sessionError}</p>
                <button type="button" className="secondary-button" onClick={() => { setLoadingUser(true); void loadUser(); }}>Retry</button>
              </>
            ) : (
              <>
                <h2>Sign in to manage email campaigns</h2>
                <p>Use Google OAuth to access sender configuration and scheduling.</p>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="card-row">
              <div className="info-card wide-card">
                <div className="inline-actions">
                  <h2>Compose</h2>
                  <button type="button" className="secondary-button" onClick={provisionSender} disabled={loadingSenders}>New Ethereal sender</button>
                </div>

                <form onSubmit={handleSubmit} className="compose-form">
                  <label>
                    Sender
                    <select
                      value={form.senderId}
                      onChange={(event) => setForm((current) => ({ ...current, senderId: event.target.value }))}
                      required
                      disabled={loadingSenders || Boolean(sendersError)}
                    >
                      <option value="">Select sender</option>
                      {senders.map((sender) => (
                        <option key={sender.id} value={sender.id}>
                          {sender.label} ({sender.emailAddress})
                        </option>
                      ))}
                    </select>
                    {loadingSenders ? <small role="status">Loading senders…</small> : null}
                    {sendersError ? <small className="field-error" role="alert">{sendersError} <button type="button" className="text-button" onClick={() => void loadSenders()}>Retry</button></small> : null}
                    {!loadingSenders && !sendersError && senders.length === 0 ? <small>No sender yet. Create an Ethereal sender to schedule mail.</small> : null}
                  </label>

                  <label>
                    Subject
                    <input maxLength={998} required value={form.subject} onChange={(event) => setForm((current) => ({ ...current, subject: event.target.value }))} />
                  </label>

                  <label>
                    Message body
                    <textarea maxLength={250000} required value={form.body} rows={6} onChange={(event) => setForm((current) => ({ ...current, body: event.target.value }))} />
                  </label>

                  <label>
                    Recipients
                    <textarea aria-describedby="recipient-summary" value={form.recipients} rows={5} onChange={(event) => setForm((current) => ({ ...current, recipients: event.target.value }))} />
                    <small id="recipient-summary" role="status">
                      {parsedRecipients.accepted.length} accepted · {parsedRecipients.duplicateCount} duplicate · {parsedRecipients.invalidCount} invalid · {parsedRecipients.rejectedRows} rejected row(s)
                    </small>
                  </label>

                  <label className="upload-box">
                    Upload CSV / text leads
                    <input type="file" accept=".csv,.txt,text/csv,text/plain" disabled={uploading} onChange={handleFileUpload} />
                    {uploading ? <small role="status">Reading recipient file…</small> : <small>CSV or text, up to 2 MB. A CSV email column can be named Email, Recipient, or Address.</small>}
                  </label>

                  <div className="field-grid">
                    <label>
                      Start time
                      <input
                        type="datetime-local"
                        value={form.startsAt}
                        min={toDateTimeLocal(new Date())}
                        required
                        onChange={(event) => setForm((current) => ({ ...current, startsAt: event.target.value }))}
                      />
                    </label>

                    <label>
                      Delay (ms)
                      <input
                        type="number"
                        min={0}
                        max={3600000}
                        step={1}
                        required
                        value={form.delayBetweenEmailsMs}
                        onChange={(event) => setForm((current) => ({ ...current, delayBetweenEmailsMs: Number(event.target.value) }))}
                      />
                    </label>

                    <label>
                      Hourly cap
                      <input
                        type="number"
                        min={1}
                        max={100000}
                        required
                        value={form.hourlyLimit}
                        onChange={(event) => setForm((current) => ({ ...current, hourlyLimit: Number(event.target.value) }))}
                      />
                    </label>
                  </div>

                  <div className="meta-row">
                    <span>{parsedRecipients.accepted.length} unique valid recipient(s) ready</span>
                    <button type="submit" className="primary-button" disabled={submitting || uploading || loadingSenders || Boolean(sendersError) || !form.senderId || parsedRecipients.accepted.length === 0}>
                      {submitting ? 'Scheduling...' : 'Schedule batch'}
                    </button>
                  </div>
                </form>
              </div>

              <div className="info-card">
                <h2>Integrations</h2>
                <div className="stacked-actions">
                  <button type="button" className="secondary-button" onClick={connectSlack}>Connect Slack</button>
                  <button type="button" className="ghost-button" onClick={disconnectSlack}>Disconnect Slack</button>
                </div>
              </div>
            </div>

            <div className="list-panel">
              <div className="inline-actions">
                <h2>Campaigns</h2>
                <button type="button" className="ghost-button" onClick={() => void loadEmails()} disabled={loadingEmails}>
                  {loadingEmails ? 'Refreshing…' : 'Refresh'}
                </button>
                <div className="tab-buttons" aria-label="Email views">
                  <button type="button" className={view === 'scheduled' ? 'tab active' : 'tab'} onClick={() => setView('scheduled')}>Scheduled</button>
                  <button type="button" className={view === 'sent' ? 'tab active' : 'tab'} onClick={() => setView('sent')}>Sent</button>
                </div>
              </div>

              <form className="search-row" onSubmit={handleSearchSubmit}>
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search by email or subject"
                />
                <button type="submit" className="secondary-button" disabled={loadingEmails}>
                  {loadingEmails ? 'Loading…' : 'Search'}
                </button>
                {searchQuery ? <button type="button" className="ghost-button" onClick={() => { setSearchQuery(''); void loadEmails(view, ''); }} disabled={loadingEmails}>Clear</button> : null}
              </form>

              {notice ? <div className="notice success">{notice}</div> : null}
              {error ? <div className="notice error">{error}</div> : null}

              {emailListError ? (
                <div className="list-feedback error" role="alert">
                  <span>{emailListError}</span>
                  <button type="button" className="secondary-button" onClick={() => void loadEmails()} disabled={loadingEmails}>Retry</button>
                </div>
              ) : loadingEmails ? (
                <div className="list-feedback" role="status">Loading {view} emails…</div>
              ) : emails.length === 0 ? (
                <div className="list-feedback empty-state-inline">
                  {searchQuery.trim()
                    ? 'No emails match your search.'
                    : view === 'scheduled' ? 'No scheduled emails yet.' : 'No successfully sent emails yet.'}
                </div>
              ) : <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Subject</th>
                      <th>{view === 'sent' ? 'Sent at' : 'Scheduled'}</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {emails.map((email) => (
                        <tr key={email.id}>
                          <td>{email.email}</td>
                          <td>{email.subject}</td>
                          <td>{new Date(view === 'sent' ? email.sentAt ?? email.scheduledAt : email.scheduledAt).toLocaleString()}</td>
                          <td><span className={`status-pill ${email.status}`}>{email.status}</span></td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>}
              {!emailListError && !loadingEmails && nextCursor && !searchQuery.trim() ? (
                <button type="button" className="secondary-button load-more" onClick={() => void loadEmails(view, '', nextCursor, true)}>
                  Load more
                </button>
              ) : null}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
