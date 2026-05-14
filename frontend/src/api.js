// Thin fetch wrapper for the Noviustec API.
//
// In dev (Vite serving on :5173), BASE_URL is empty and Vite's proxy
// forwards /api/* to http://127.0.0.1:3000. In prod, VITE_API_URL is set
// at build time via .env.production to https://api.noviustec.com.

const BASE_URL = import.meta.env.VITE_API_URL || "";

async function request(token, method, path, body) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}` },
  };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}${path}`, opts);
  let data = {};
  try {
    data = await res.json();
  } catch {
    // body was empty or non-JSON; treat as `{}`
  }
  if (!res.ok) {
    const err = new Error(data.error || data.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const listPending = (token, status = "pending") =>
  request(token, "GET", `/api/pending?status=${encodeURIComponent(status)}`);

export const getPending = (token, id) =>
  request(token, "GET", `/api/pending/${encodeURIComponent(id)}`);

export const approvePending = (token, id, body) =>
  request(token, "POST", `/api/pending/${encodeURIComponent(id)}/approve`, body);

export const rejectPending = (token, id, body) =>
  request(token, "POST", `/api/pending/${encodeURIComponent(id)}/reject`, body);

export const getCategories = (token) =>
  request(token, "GET", "/api/categories");

export const getPaymentSources = (token) =>
  request(token, "GET", "/api/sources");

/** Quick health check, no auth. */
export async function healthCheck() {
  const res = await fetch(`${BASE_URL}/health`);
  return res.json();
}
