const note = document.getElementById('recovery-status');
const form = document.getElementById('recovery');
const fragment = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, '', '/auth/recovery');
const config = window.NYAH_PUBLIC_CONFIG;
let access = '';
let deadline = 0;
let busy = false;

const say = text => { note.textContent = text; };
const unavailable = () => say('This recovery link is invalid or expired. Return to sign-in and request another link.');
const tokenOk = value => typeof value === 'string' && /^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/.test(value) && value.length < 10000;
function clear() { access = ''; deadline = 0; form.reset(); form.hidden = true; }
window.addEventListener('pagehide', clear);

async function provider(path, method, body) {
  const headers = {apikey: config.publishableKey, Authorization: `Bearer ${access}`};
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(`${config.url}/auth/v1/${path}`, {method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer'});
}

async function verify() {
  const bearer = fragment.get('access_token');
  const duration = Number(fragment.get('expires_in'));
  const valid = fragment.getAll('access_token').length === 1 && fragment.getAll('type').length === 1 && fragment.get('type') === 'recovery' &&
    tokenOk(bearer) && Number.isSafeInteger(duration) && duration > 0 && /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config?.url || '') &&
    /^sb_publishable_[A-Za-z0-9_-]+$/.test(config?.publishableKey || '') && /^[\da-f-]{36}$/i.test(config?.subject || '');
  for (const key of [...fragment.keys()]) fragment.delete(key);
  if (!valid) return unavailable();
  try {
    access = bearer;
    deadline = Date.now() + Math.min(duration, 600) * 1000;
    const response = await provider('user', 'GET');
    if (!response.ok || (await response.json())?.id !== config.subject) { clear(); return unavailable(); }
    form.hidden = false;
    say('Choose a new password. A fresh ordinary password sign-in is required before inventory access.');
    form.elements.password.focus();
  } catch { clear(); unavailable(); }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  if (!access || Date.now() >= deadline) { clear(); return unavailable(); }
  const password = form.elements.password.value;
  if (password !== form.elements.confirmation.value) return say('The passwords do not match.');
  if (password.length < 12 || new TextEncoder().encode(password).length > 72) return say('Use at least 12 characters and no more than 72 bytes.');
  busy = true;
  const submit = form.querySelector('button');
  submit.disabled = true;
  try {
    const result = await provider('user', 'PUT', {password});
    if (result.status === 401 || result.status === 403) { clear(); return unavailable(); }
    if (!result.ok) { form.reset(); return say('The password could not be changed. Try a different password.'); }
    try { await provider('logout?scope=local', 'POST', {}); } catch {}
    clear();
    say('Password changed. Return to sign-in and use the new password.');
  } catch {
    form.reset();
    say('Could not confirm the change. Return to sign-in or retry before the link expires.');
  } finally { busy = false; submit.disabled = false; }
});

void verify();

