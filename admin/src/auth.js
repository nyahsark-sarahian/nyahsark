async function check(request, env, client) {
  if (!env.SUPABASE_URL || !env.SARAH_AUTH_SUB || !client?.auth?.getClaims || !client?.auth?.getUser) {
    throw Error('configuration');
  }
  const base = new URL(env.SUPABASE_URL);
  if (
    base.protocol !== 'https:' ||
    !base.hostname.endsWith('.supabase.co') ||
    base.pathname !== '/' ||
    base.search ||
    base.hash ||
    base.username ||
    base.password ||
    base.port
  ) throw Error('issuer');
  const token = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9._-]{1,16000})$/)?.[1];
  if (!token) throw Error('token');

  const checked = await client.auth.getClaims(token);
  if (checked.error) throw Error('claims');
  const claims = checked.data?.claims;
  const now = Math.floor(Date.now() / 1000);
  if (
    !claims ||
    claims.iss !== `${base.origin}/auth/v1` ||
    claims.sub !== env.SARAH_AUTH_SUB ||
    claims.aud !== 'authenticated' ||
    claims.role !== 'authenticated' ||
    !['aal1', 'aal2'].includes(claims.aal) ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= now ||
    !Array.isArray(claims.amr) ||
    !claims.amr.some((entry) => entry?.method === 'password')
  ) throw Error('authorization');

  const checkedUser = await client.auth.getUser(token);
  if (checkedUser.error) throw Error('user');
  const user = checkedUser.data?.user;
  if (user?.id !== claims.sub || !user.email_confirmed_at || user.is_anonymous === true) throw Error('identity');
  return {subject: claims.sub};
}

export async function requireSupabase(request, env, client) {
  try {
    return await check(request, env, client);
  } catch {
    const error = new Error('Verified administrator password sign-in required');
    error.status = 401;
    throw error;
  }
}

