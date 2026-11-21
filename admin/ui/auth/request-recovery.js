const button = document.getElementById('request-recovery');
const status = document.getElementById('auth-message');

button?.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const config = window.NYAH_PUBLIC_CONFIG;
    const expectedOrigin = config?.adminOrigin || 'https://thearkadmin.nyahsark.com';
    if (location.origin !== expectedOrigin || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config?.url || '') || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(config?.publishableKey || '')) throw new Error();
    const client = supabase.createClient(config.url, config.publishableKey, {auth: {persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'implicit'}});
    const result = await client.auth.resetPasswordForEmail('nyahsark@gmail.com', {redirectTo: `${expectedOrigin}/auth/recovery`});
    if (result.error) throw new Error();
    status.textContent = 'Check the approved administrator inbox for the reset link.';
  } catch {
    status.textContent = 'Could not send a reset link. Wait a minute before trying again.';
    button.disabled = false;
  }
});

