// Invite links (#join=<code>).
//
// 2026-09-18 user request: "그 코드가 적용된채로 특정 url을 주는 방식" — a host
// should be able to hand someone a single URL that already carries the seat
// code, instead of a bare code that has to be pasted into the lobby form.
//
// Design notes:
// * The code travels in the URL fragment, so it is never sent to the server in
//   a request line or a Referer header; only the browser sees it.
// * A code is still a single-use seat capability.  Redeeming it in /api/join
//   binds the seat and invalidates the code, so a link that has already been
//   opened cannot be replayed; inviteLinkFor() is only a convenience wrapper.
export const JOIN_PARAM_KEYS = ["join", "invite", "초대"];
const JOIN_CODE = /^[A-Za-z0-9_-]{6,64}$/;

function paramsOf(raw) {
  return new URLSearchParams(String(raw ?? "").replace(/^[#?]/, ""));
}

/** Read a seat code out of a URL (search or fragment). Returns null when absent. */
export function readJoinCode(href) {
  let url;
  try {
    url = new URL(String(href ?? ""), "http://localhost");
  } catch {
    return null;
  }
  for (const source of [url.hash, url.search])
    for (const key of JOIN_PARAM_KEYS) {
      const value = (paramsOf(source).get(key) ?? "").trim();
      if (JOIN_CODE.test(value)) return value;
    }
  return null;
}

/** The same URL with every join parameter removed (for history.replaceState). */
export function withoutJoinCode(href) {
  let url;
  try {
    url = new URL(String(href ?? ""), "http://localhost");
  } catch {
    return String(href ?? "");
  }
  const clean = (raw) => {
    const params = paramsOf(raw);
    for (const key of JOIN_PARAM_KEYS) params.delete(key);
    return params.toString();
  };
  url.search = clean(url.search);
  url.hash = clean(url.hash);
  return url.toString();
}

/** Build the shareable invite URL for a seat code. */
export function inviteLinkFor(origin, code) {
  const base = String(origin ?? "").replace(/\/+$/, "");
  return `${base}/#join=${encodeURIComponent(String(code ?? ""))}`;
}
