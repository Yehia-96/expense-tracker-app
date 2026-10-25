// The account and the server: Supabase auth, the et_rows table and the et-receipts bucket,
// spoken to directly with fetch. The same calls the desktop app makes (SupabaseRemote.cs).

// Public by design: the key only names the project; every row is guarded by login and RLS.
export const SUPABASE_URL = 'https://ljylvlolddaguzxenxdl.supabase.co';
export const SUPABASE_KEY = 'sb_publishable__N8b3FB_NBswTHthdJDnug_C55CC1d7';
const BUCKET = 'et-receipts';
const SESSION_KEY = 'et.session';

let session = readSession();

function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}

function saveSession(value) {
  session = value;
  if (value) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
  else localStorage.removeItem(SESSION_KEY);
}

export const isSignedIn = () => !!session;
export const userEmail = () => session?.user?.email ?? null;
export const userId = () => session?.user?.id ?? null;

async function authRequest(path, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = json.msg || json.error_description || json.message || `Sign-in failed (${res.status}).`;
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return json;
}

function accept(json) {
  saveSession({
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + json.expires_in * 1000,
    user: { id: json.user.id, email: json.user.email },
  });
}

export async function signIn(email, password) {
  accept(await authRequest('token?grant_type=password', { email: email.trim(), password }));
}

/** Emails a link that opens this app ready to set a new password. */
export async function requestPasswordReset(email) {
  const back = encodeURIComponent(location.origin + location.pathname);
  await authRequest(`recover?redirect_to=${back}`, { email: email.trim() });
}

/**
 * The reset link arrives as #access_token=…&refresh_token=…&type=recovery. Signs in with it
 * and says so; any other address is left alone.
 */
export function acceptRecoveryLink(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (params.get('type') !== 'recovery' || !params.get('access_token')) {
    const problem = params.get('error_description');
    return problem ? { error: problem.replace(/\+/g, ' ') } : null;
  }
  const token = params.get('access_token');
  // The user's id and email are inside the token itself.
  const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  saveSession({
    access_token: token,
    refresh_token: params.get('refresh_token'),
    expires_at: Date.now() + Number(params.get('expires_in') || 3600) * 1000,
    user: { id: claims.sub, email: claims.email },
  });
  return { recovered: true };
}

export async function setPassword(password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: 'PUT',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.msg || json.error_description || json.message || `Could not change it (${res.status}).`);
}

/** Where the Apple Pay shortcut sends payments (supabase/functions/et-capture). */
export const CAPTURE_URL = `${SUPABASE_URL}/functions/v1/et-capture`;

/**
 * Makes a new capture key for the shortcut and retires any earlier one. Only its SHA-256 goes
 * to the server; the key itself is shown here, to be pasted into the shortcut.
 */
export async function createCaptureKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const key = `etk_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

  await call(`${SUPABASE_URL}/rest/v1/et_capture_keys?user_id=eq.${userId()}`, { method: 'DELETE' });
  await call(`${SUPABASE_URL}/rest/v1/et_capture_keys`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ key_hash: hash }),
  });
  return key;
}

export async function signOut() {
  const token = session?.access_token;
  saveSession(null);
  if (token) {
    fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
}

let refreshing = null;

/** A valid access token, refreshed a minute before it runs out. One refresh at a time:
 *  refresh tokens are single use, and two at once would sign the phone out. */
export async function accessToken() {
  if (!session) throw new Error('Not signed in.');
  if (Date.now() < session.expires_at - 60_000) return session.access_token;
  refreshing ??= authRequest('token?grant_type=refresh_token', { refresh_token: session.refresh_token })
    .then(accept)
    .catch((e) => {
      if (e.status === 400 || e.status === 401) {
        saveSession(null);
        throw new Error('The sign-in has expired. Sign in again.');
      }
      throw e;
    })
    .finally(() => { refreshing = null; });
  await refreshing;
  return session.access_token;
}

async function call(url, options = {}) {
  const token = await accessToken();
  const res = await fetch(url, {
    ...options,
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    let message = json.message || json.error || `The server answered ${res.status}.`;
    if (/et_rows|et_upsert_rows/.test(message)) {
      message = `The account is not set up for Expense Tracker yet. ${message}`;
    }
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return res;
}

/** Rows stored after `since` (an ISO time), oldest first. */
export async function pullRows(since, limit = 1000) {
  const url = `${SUPABASE_URL}/rest/v1/et_rows?select=tbl,id,data,deleted,updated_at,device_id,synced_at`
    + `&synced_at=gt.${encodeURIComponent(since)}&order=synced_at.asc&limit=${limit}`;
  return (await call(url)).json();
}

/** Stores rows; each only replaces the stored one if newer (the server enforces it). */
export async function pushRows(rows) {
  await call(`${SUPABASE_URL}/rest/v1/rpc/et_upsert_rows`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }),
  });
}

const objectPath = (hash) => `${BUCKET}/${userId()}/${hash}`;

export async function uploadFile(hash, blob, mediaType) {
  await call(`${SUPABASE_URL}/storage/v1/object/${objectPath(hash)}`, {
    method: 'POST', headers: { 'Content-Type': mediaType || 'application/octet-stream', 'x-upsert': 'true' }, body: blob,
  });
}

/** The file as a Blob, or null when the server has no copy (yet). */
export async function downloadFile(hash) {
  try {
    return await (await call(`${SUPABASE_URL}/storage/v1/object/authenticated/${objectPath(hash)}`)).blob();
  } catch (e) {
    if (e.status === 400 || e.status === 404) return null;
    throw e;
  }
}
