import {createClient} from '@supabase/supabase-js';
import {requireSupabase} from './auth.js';

export function makeClient(env, transport = fetch) {
  const url = new URL(env.SUPABASE_URL);
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.supabase.co') ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port
  ) throw Error('Invalid project URL');
  if (!env.SUPABASE_PUBLISHABLE_KEY?.startsWith('sb_publishable_') || !env.SARAH_AUTH_SUB) {
    throw Error('Missing project public key or approved subject');
  }
  return createClient(url.origin, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: {persistSession: false, autoRefreshToken: false, detectSessionInUrl: false},
    global: {fetch: transport}
  });
}

export function makeVerifier(env, transport = fetch) {
  const client = makeClient(env, transport);
  return (request) => requireSupabase(request, env, client);
}

