/**
 * What the raw HTML says - and nothing about what JavaScript would add.
 *
 * The one honesty rule in this file: `checked` is always reported, and its value
 * is "raw_html_only". Plenty of sites inject <title> and <meta name=viewport>
 * from JavaScript, so "not present in the raw HTML" is a different claim from
 * "missing", and the API must not blur the two. Every issue this module feeds is
 * named ..._IN_RAW_HTML for the same reason.
 *
 * Parsing is HTMLRewriter, not a DOM library. It is native and streaming, which
 * is what keeps a 2 MB page inside the Worker's 10 ms CPU budget - a JS parse of
 * the same page would not fit.
 *
 * Mixed content is counted strictly: only sub-resources a browser would actually
 * block - img/script/iframe src and link rel=stylesheet href - and only when the
 * page itself was served over https.
 */

export const RAW_ONLY = "raw_html_only";
export const TRUNCATED = "truncated_2mb";
export const NOT_HTML = "not_html";
export const MAX_SAMPLES = 5;

export interface HtmlReport {
  checked: string;
  content_type?: string;
  title: { present: boolean; text?: string };
  viewport: { present: boolean; content?: string };
  mixed_content: { count: number; samples: string[] };
  stylesheets: number;
  scripts: number;
}

const isInsecure = (value: string): boolean => value.trim().toLowerCase().startsWith("http://");

export async function parseHtml(
  body: Uint8Array,
  opts: { finalUrl: string; contentType: string; truncated?: boolean },
): Promise<HtmlReport> {
  const checked = opts.truncated ? TRUNCATED : RAW_ONLY;

  if (opts.contentType && !opts.contentType.toLowerCase().includes("html")) {
    return {
      checked: NOT_HTML,
      content_type: opts.contentType,
      title: { present: false },
      viewport: { present: false },
      mixed_content: { count: 0, samples: [] },
      stylesheets: 0,
      scripts: 0,
    };
  }

  let baseIsHttps = false;
  try {
    baseIsHttps = new URL(opts.finalUrl).protocol === "https:";
  } catch {
    baseIsHttps = false;
  }

  let titleText = "";
  let inTitle = false;
  let viewportSeen = false;
  let viewportContent = "";
  let stylesheets = 0;
  let scripts = 0;
  const insecure: string[] = [];

  const note = (value: string | null) => {
    if (value && isInsecure(value)) insecure.push(value);
  };

  const rewriter = new HTMLRewriter()
    .on("title", {
      element() {
        // Only the first <title> counts; a browser ignores later ones.
        inTitle = titleText === "";
      },
      text(chunk) {
        if (inTitle) titleText += chunk.text;
      },
    })
    .on("meta", {
      element(el) {
        if ((el.getAttribute("name") ?? "").trim().toLowerCase() === "viewport" && !viewportSeen) {
          viewportSeen = true;
          viewportContent = (el.getAttribute("content") ?? "").trim();
        }
      },
    })
    .on("img, script, iframe", {
      element(el) {
        note(el.getAttribute("src"));
      },
    })
    .on("script", {
      element() {
        scripts += 1;
      },
    })
    .on("link", {
      element(el) {
        const rel = (el.getAttribute("rel") ?? "").trim().toLowerCase();
        if (!rel.split(/\s+/).includes("stylesheet")) return;
        stylesheets += 1;
        note(el.getAttribute("href"));
      },
    });

  // Transforming drives the parse; the output is thrown away.
  await rewriter.transform(new Response(body)).arrayBuffer();

  const title = titleText.trim();
  // An http:// page loading http:// sub-resources is not "mixed" content.
  const mixed = baseIsHttps ? insecure : [];

  return {
    checked,
    title: title ? { present: true, text: title } : { present: false },
    viewport: viewportSeen
      ? viewportContent
        ? { present: true, content: viewportContent }
        : { present: true }
      : { present: false },
    mixed_content: { count: mixed.length, samples: mixed.slice(0, MAX_SAMPLES) },
    stylesheets,
    scripts,
  };
}
