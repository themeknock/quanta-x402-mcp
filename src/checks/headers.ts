/**
 * Presence of the four response headers a browser acts on. Presence only - this
 * does not grade a CSP's contents, and does not claim to.
 */

export interface HeaderReport {
  hsts: boolean;
  csp: boolean;
  x_frame_options: boolean;
  x_content_type_options: boolean;
}

const WATCHED: Array<[keyof HeaderReport, string]> = [
  ["hsts", "strict-transport-security"],
  ["csp", "content-security-policy"],
  ["x_frame_options", "x-frame-options"],
  ["x_content_type_options", "x-content-type-options"],
];

export function readHeaders(headers: Record<string, string>): HeaderReport {
  const lowered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) lowered[key.toLowerCase()] = value;

  const out = {} as HeaderReport;
  for (const [name, header] of WATCHED) out[name] = Boolean((lowered[header] ?? "").trim());
  return out;
}
