let activeAuth = null;

export function setAuth(auth) {
  activeAuth = auth;
}

export function getAuth() {
  return activeAuth;
}

export async function privateFetch(path, options = {}) {
  if (!activeAuth) throw new Error('Sign in with the approved administrator password first.');
  return activeAuth.authorizedFetch(path, options);
}

export async function privateUpload(path, file, onProgress) {
  if (!activeAuth) throw new Error('Sign in with the approved administrator password first.');
  return activeAuth.authorizedUpload(path, file, onProgress);
}

export async function privateImage(image, path) {
  image.removeAttribute('src');
  try {
    const response = await privateFetch(path, {cache: 'no-store'});
    if (!response.ok || !/^image\/(?:png|jpeg|webp)$/.test(response.headers.get('content-type') || '')) throw new Error();
    const blob = await response.blob();
    if (!blob.size || blob.size > 5 * 1024 * 1024 || !image.isConnected) throw new Error();
    const url = URL.createObjectURL(blob);
    image.addEventListener('load', () => URL.revokeObjectURL(url), {once: true});
    image.addEventListener('error', () => URL.revokeObjectURL(url), {once: true});
    image.src = url;
  } catch {
    image.hidden = true;
    image.insertAdjacentText('afterend', 'Private image unavailable');
  }
}

