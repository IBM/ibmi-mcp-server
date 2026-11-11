/**
 * @fileoverview The pages of the built-in OAuth authorization server: the
 * sign-in form, a message, and the page that sends the browser back to a
 * client. Plain HTML with inline CSS and no script. Every value put
 * into a page goes through `escapeHtml`; nothing typed into the form is ever
 * put back into a page.
 * @module src/ibmi-mcp-server/oauth/signInPage
 */

import type { ClientDisplay } from "./clients.js";

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Text as it may stand in HTML content or in a quoted attribute value. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]!);
}

/**
 * The response headers of every page. They replace the transport's
 * `secureHeaders`, whose defaults would stop the form post.
 *
 * @param redirectUri - Where the form's answer redirects to. Browsers apply
 *   `form-action` to that redirect too, so its origin (or, for an application
 *   scheme, the scheme) is allowed besides this server. An IPv6 literal is
 *   left out: `[::1]` is not a host a policy can name, a browser ignores the
 *   entry, and the form's answer for such a destination is a page, not a
 *   redirect.
 */
export function pageHeaders(redirectUri?: string): Record<string, string> {
  let formAction = "'self'";
  const url = redirectUri === undefined ? undefined : new URL(redirectUri);
  if (url && !url.hostname.startsWith("[")) {
    formAction += ` ${url.origin === "null" ? url.protocol : url.origin}`;
  }
  return {
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action ${formAction}`,
    "Referrer-Policy": "same-origin",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}

const STYLE = `
:root { --bg: #f4f4f4; --layer: #fff; --field: #f4f4f4; --text: #161616; --text-2: #525252; --rule: #e0e0e0; --field-line: #8d8d8d; --focus: #0f62fe; --link: #0f62fe; --error-bg: #fff1f1; --error: #da1e28; }
@media (prefers-color-scheme: dark) { :root { --bg: #161616; --layer: #262626; --field: #393939; --text: #f4f4f4; --text-2: #c6c6c6; --rule: #393939; --field-line: #6f6f6f; --focus: #fff; --link: #78a9ff; --error-bg: #2d0709; --error: #fa4d56; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.43 "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: 0.16px; background: var(--bg); color: var(--text); }
header { height: 48px; display: flex; align-items: center; padding: 0 16px; background: #161616; color: #f4f4f4; border-bottom: 1px solid #393939; }
header strong { font-weight: 600; margin-right: 0.25em; }
main { max-width: 400px; margin: 48px auto; padding: 32px 16px 24px; background: var(--layer); }
@media (min-width: 432px) { main { padding: 32px 32px 24px; } }
h1 { font-size: 28px; line-height: 36px; font-weight: 400; letter-spacing: 0; margin: 0 0 16px; }
a { color: var(--link); }
.system { margin: -12px 0 24px; color: var(--text-2); overflow-wrap: anywhere; }
label { display: block; margin: 24px 0 8px; font-size: 12px; line-height: 16px; letter-spacing: 0.32px; color: var(--text-2); }
input { width: 100%; height: 40px; padding: 0 16px; font: inherit; color: var(--text); background: var(--field); border: 0; border-bottom: 1px solid var(--field-line); border-radius: 0; outline: 2px solid transparent; outline-offset: -2px; }
input:focus { outline-color: var(--focus); }
button { display: block; width: 100%; min-height: 48px; margin-top: 32px; padding: 0 16px; font: inherit; text-align: left; color: #fff; background: #0f62fe; border: 0; border-radius: 0; cursor: pointer; outline: 2px solid transparent; outline-offset: -2px; }
button:hover { background: #0050e6; }
button:active { background: #002d9c; }
button:focus-visible { outline-color: var(--focus); box-shadow: inset 0 0 0 3px var(--layer); }
.error { margin: 0 0 8px; padding: 12px 16px; background: var(--error-bg); border-left: 3px solid var(--error); }
.note { margin: 24px 0 0; padding-top: 16px; border-top: 1px solid var(--rule); font-size: 12px; line-height: 16px; letter-spacing: 0.32px; color: var(--text-2); overflow-wrap: anywhere; }
.note + .note { margin-top: 8px; padding-top: 0; border-top: 0; }
`;

/** A whole document. `head` and `body` are HTML, already escaped. */
function page(title: string, head: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${head}<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header><strong>IBM i</strong> MCP Server</header>
<main>
${body}
</main>
</body>
</html>
`;
}

/** What the sign-in form shows. Every member is plain text. */
export interface SignInView {
  /** The IBM i system users sign on to. */
  system: string;
  /** Path the form posts to. */
  action: string;
  /** The signed login request, carried in a hidden field. */
  loginRequest: string;
  /** Who asks, and where the authorization code goes. */
  client: ClientDisplay;
  /** Whether that destination is a loopback address. */
  loopback: boolean;
  /** Why the last sign-on did not succeed. */
  message?: string;
}

/** The sign-in form. */
export function signInPage(view: SignInView): string {
  const system = escapeHtml(view.system);
  const destination = escapeHtml(view.client.destination);
  const client =
    view.client.unverifiedName === undefined
      ? "An application that gave no name"
      : `&quot;${escapeHtml(view.client.unverifiedName)}&quot; (not verified)`;
  const message =
    view.message === undefined
      ? ""
      : `<p class="error" role="alert">${escapeHtml(view.message)}</p>\n`;
  const loopback = view.loopback
    ? `<p class="note">If your browser then shows a page that can't be reached, don't share its address.</p>\n`
    : "";
  return page(
    `Sign on to ${view.system}`,
    "",
    `<h1>Sign on to IBM i</h1>
<p class="system">${system}</p>
${message}<form method="post" action="${escapeHtml(view.action)}">
<input type="hidden" name="login_request" value="${escapeHtml(view.loginRequest)}">
<label for="profile">User profile</label>
<input id="profile" name="profile" type="text" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" required>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign on</button>
</form>
<p class="note">${client} will run SQL as you, then return to <strong>${destination}</strong>. Sign on only if you started this from that application.</p>
${loopback}`,
  );
}

/** A page that says why signing on cannot go on. No form. */
export function messagePage(message: string): string {
  return page(
    "Sign-on cannot continue",
    "",
    `<h1>Sign-on cannot continue</h1>
<p class="error" role="alert">${escapeHtml(message)}</p>`,
  );
}

/**
 * The page for a sign-in form submitted again after its sign-on worked. It
 * carries no code: the first answer had it.
 */
export function completedPage(): string {
  return page(
    "Signed on",
    "",
    `<h1>Signed on</h1>
<p>This sign-on has already completed. You can close this window.</p>`,
  );
}

/**
 * The page that sends the browser on to its client after a sign-on, for a
 * destination a redirect of the form post cannot reach.
 *
 * @param target - The client's redirect URI with the authorization response.
 */
export function redirectPage(target: string): string {
  const url = escapeHtml(target);
  return page(
    "Signed on",
    `<meta http-equiv="refresh" content="0;url=${url}">\n`,
    `<h1>Signed on</h1>
<p>Returning to the application. <a href="${url}">Continue</a> if nothing happens.</p>`,
  );
}
