// Bind-time sanitize entry: re-export the zero-dep leaf so other catalog files
// route untrusted strings through one chokepoint. The strip impl lives in
// @minitui/sanitizer, never here.
export { sanitize, sanitizeSpecStrings } from '@minitui/sanitizer';
