import {setAuth} from '../session.js';

const status = document.getElementById('auth-message');
const form = document.getElementById('sign-in');
let client = null;
let access = '';

function loginEmail(value) {
  const normalized = String(value || '').trim();
  if (/^SarahDeCicco$/i.test(normalized)) return 'nyahsark@gmail.com';
  return normalized;
}

function configuration() {
  const config = window.NYAH_PUBLIC_CONFIG;
  const expectedOrigin = config?.adminOrigin || 'https://thearkadmin.nyahsark.com';
  if (location.origin !== expectedOrigin || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config?.url || '') ||
      !/^sb_publishable_[A-Za-z0-9_-]+$/.test(config?.publishableKey || '') || !/^[\da-f-]{36}$/i.test(config?.subject || '')) {
    throw new Error('Invalid administrator configuration.');
  }
  return config;
}

function clear() {
  access = '';
  setAuth(null);
}

function authorizedFetch(path, init = {}) {
  if (!path.startsWith('/api/admin/') || path.startsWith('//') || !access) throw new Error('Administrator sign-in required.');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${access}`);
  return fetch(path, {...init, headers, credentials: 'same-origin', redirect: 'error', cache: init.cache || 'no-store'});
}

function authorizedUpload(path, file, onProgress) {
  if (!path.startsWith('/api/admin/uploads/') || !access) throw new Error('Administrator sign-in required.');
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', path);
    request.setRequestHeader('Authorization', `Bearer ${access}`);
    request.setRequestHeader('Content-Type', file.type);
    request.responseType = 'json';
    request.upload.onprogress = event => {
      if (event.lengthComputable && onProgress) onProgress(Math.round(event.loaded * 100 / event.total));
    };
    request.onerror = () => reject(new Error('Upload interrupted. The previous saved photo remains unchanged.'));
    request.onload = () => {
      const data = request.response || {};
      if (request.status >= 200 && request.status < 300) resolve(data);
      else reject(new Error(data.error || `Upload failed (${request.status}). The previous saved photo remains unchanged.`));
    };
    request.send(file);
  });
}

window.addEventListener('pagehide', clear);

form?.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  clear();
  status.textContent = 'Signing in…';
  try {
    const config = configuration();
    client ||= supabase.createClient(config.url, config.publishableKey, {auth: {persistSession: false, autoRefreshToken: false, detectSessionInUrl: false}});
    const {data, error} = await client.auth.signInWithPassword({email: loginEmail(form.elements.email.value), password: form.elements.password.value});
    if (error || data?.user?.id !== config.subject || !data?.session?.access_token) throw new Error();
    access = data.session.access_token;
    const response = await authorizedFetch('/api/admin/artworks?page=1&status=all');
    if (!response.ok) throw new Error();
    setAuth({authorizedFetch, authorizedUpload, async signOut() { clear(); await client.auth.signOut({scope: 'local'}); }});
    document.getElementById('auth-panel').hidden = true;
    document.getElementById('admin-shell').hidden = false;
    await import('../admin.js');
  } catch {
    clear();
    status.textContent = 'Sign-in unavailable. Check the approved account and password.';
  } finally {
    form.elements.password.value = '';
    button.disabled = false;
  }
});

