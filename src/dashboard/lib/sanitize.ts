// DOMPurify wrapper for the /support page. The config is locked here so it
// can't drift between render sites — every caller in the support flow goes
// through sanitizeMarkdown.
//
// FORBID_TAGS: a prompt-injected HubSpot ticket body could otherwise render
// a phishing form ("session expired, paste token to continue") inside the
// answer panel. The CSP meta tag (form-action 'none', script-src 'self') is
// the belt to this brace.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — vendored ESM, no .d.ts shipped
import DOMPurify from '../vendor/dompurify.esm.js';

export function sanitizeMarkdown(html: string): DocumentFragment {
  return DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'option', 'style'],
    FORBID_ATTR: ['style'],
  }) as DocumentFragment;
}
