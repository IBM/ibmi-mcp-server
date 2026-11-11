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
body { font: 16px/1.5 system-ui, sans-serif; margin: 0; background: #f4f4f4; color: #161616; }
main { max-width: 34rem; margin: 2rem auto; padding: 1.5rem; background: #fff; border: 1px solid #c6c6c6; }
h1 { font-size: 1.4rem; margin-top: 0; }
label { display: block; margin-top: 1rem; font-weight: 600; }
input { box-sizing: border-box; width: 100%; padding: 0.5rem; font: inherit; border: 1px solid #8d8d8d; }
button { margin-top: 1.5rem; padding: 0.6rem 1.5rem; font: inherit; color: #fff; background: #0f62fe; border: 0; }
.destination { padding: 0.75rem; background: #edf5ff; border-left: 4px solid #0f62fe; font-size: 1.1rem; overflow-wrap: anywhere; }
.error { padding: 0.75rem; background: #fff1f1; border-left: 4px solid #da1e28; }
.hint { margin: 0.25rem 0 0; font-size: 0.875rem; color: #525252; }
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
      ? "an application that gave no name (not verified)"
      : `an application that calls itself &quot;${escapeHtml(view.client.unverifiedName)}&quot; (not verified)`;
  const message =
    view.message === undefined
      ? ""
      : `<p class="error" role="alert">${escapeHtml(view.message)}</p>\n`;
  const loopback = view.loopback
    ? `<p>This is a loopback address: it leads to a program on the computer this browser runs on, which should be the application you started.</p>\n`
    : "";
  return page(
    `Sign on to ${view.system}`,
    "",
    `<h1>Sign on to IBM i system ${system}</h1>
${message}<p>The request comes from ${client}. After you sign on, your browser is sent to:</p>
<p class="destination"><strong>${destination}</strong></p>
${loopback}<p>After you sign on, ${client} at ${destination} will be able to run SQL as your user profile on ${system}. Continue only if you started this from that application yourself.</p>
<form method="post" action="${escapeHtml(view.action)}">
<input type="hidden" name="login_request" value="${escapeHtml(view.loginRequest)}">
<label for="profile">User profile</label>
<input id="profile" name="profile" type="text" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" aria-describedby="profile-hint" required>
<p class="hint" id="profile-hint">Letters, digits, #, $ and _ only, not starting with a digit. Type national characters as # and $.</p>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign on</button>
</form>
<p>After signing on you may see a page that cannot be reached. Never send that page's address to anyone.</p>`,
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
