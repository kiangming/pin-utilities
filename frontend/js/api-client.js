/**
 * api-client.js — Wrapper cho tất cả API calls đến backend.
 *
 * - Tự động redirect về /login khi nhận 401
 * - Tất cả request đều kèm credentials (cookie)
 * - Expose: ApiClient.get(), ApiClient.post(), ApiClient.me()
 */
const ApiClient = (() => {
  const BASE = '';  // same origin

  async function _request(method, path, body = null) {
    const opts = {
      method,
      credentials: 'include',   // gửi cookie session_id
      headers: {},
    };
    if (body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    const resp = await fetch(BASE + path, opts);

    if (resp.status === 401) {
      // Session hết hạn hoặc chưa login → về login page
      window.location.href = '/login';
      return null;
    }

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new ApiError(resp.status, err.detail || resp.statusText);
    }

    return resp.json();
  }

  async function get(path) {
    return _request('GET', path);
  }

  async function post(path, body) {
    return _request('POST', path, body);
  }

  /** Lấy thông tin user đang login. Trả về { email, name, picture } */
  async function me() {
    return get('/auth/me');
  }

  /** Logout — POST /auth/logout rồi redirect về /login */
  async function logout() {
    await post('/auth/logout');
    window.location.href = '/login';
  }

  return { get, post, me, logout };
})();


class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}
