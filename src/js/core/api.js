import { state, t } from './state.js';;
import { showToast } from '../components/toast.js';

async function api(url, options = {}) {
  try {
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };
    // Add CSRF token for mutating requests
    if (state.csrfToken && options.method && options.method !== 'GET') {
      headers['X-CSRF-Token'] = state.csrfToken;
    }
    const res = await fetch(url, {
      credentials: 'include',
      ...options,
      headers,
    });
    if (res.status === 401) {
      showToast(t('toast.sessionExpired'), 'error');
      setLocked(true);
      return { ok: false, error: 'unauthorized' };
    }
    if (res.status === 429) {
      showToast(t('toast.rateLimited'), 'warning');
      return { ok: false, error: 'rate-limited' };
    }
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return res.json();
    }
    // Non-JSON response (HTML error page, etc.)
    const text = await res.text();
    return { ok: false, error: text.substring(0, 200) };
  } catch (err) {
    showToast(t('toast.networkError'), 'error');
    return { ok: false, error: 'network' };
  }
}

export { api };
