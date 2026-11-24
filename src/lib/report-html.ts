/**
 * report-html.ts - the report as one self-contained HTML page: the preview
 * on the Report tab shows it in a frame, and printing that frame makes the
 * PDF. Everything the user typed is escaped; the page has no scripts and
 * loads nothing from the network (images are data URLs).
 */
import type { ReportBlock, ReportModel } from "./report";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Only our own image data URLs go into src attributes. */
const safeImageSrc = (src: string | null) =>
  src && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(src)
    ? src
    : null;

/** Line breaks the user typed stay line breaks. */
const lines = (text: string) => escapeHtml(text).replace(/\n/g, "<br>");

function block(b: ReportBlock): string {
  switch (b.kind) {
    case "text":
      return `<p${b.muted ? ' class="muted"' : ""}>${lines(b.text)}</p>`;
    case "list":
      return `<ul>${b.items.map((i) => `<li>${lines(i)}</li>`).join("")}</ul>`;
    case "facts":
      return `<table class="facts"><tbody>${b.rows
        .map(
          ([k, v]) =>
            `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`,
        )
        .join("")}</tbody></table>`;
    case "table": {
      const cls = (i: number) =>
        b.align?.[i] === "right" ? ' class="num"' : "";
      return `<table class="data"><thead><tr>${b.head
        .map((h, i) => `<th${cls(i)}>${escapeHtml(h)}</th>`)
        .join("")}</tr></thead><tbody>${b.rows
        .map(
          (r) =>
            `<tr>${r.map((c, i) => `<td${cls(i)}>${lines(c)}</td>`).join("")}</tr>`,
        )
        .join("")}</tbody></table>`;
    }
    case "image": {
      const src = safeImageSrc(b.image.src);
      if (!src) return "";
      return `<figure><img src="${src}" alt="${escapeHtml(b.image.title)}" width="${b.image.width}" height="${b.image.height}"><figcaption>${escapeHtml(b.image.caption)}</figcaption></figure>`;
    }
  }
}

const STYLE = `
@page { size: A4; margin: 16mm 14mm 18mm; }
* { box-sizing: border-box; }
html { background: #eef0f3; }
body { margin: 0; font: 10.5pt/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #14181f; }
.page { background: #fff; width: 210mm; min-height: 297mm; margin: 12px auto; padding: 16mm 14mm 18mm; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
.cover { display: flex; flex-direction: column; }
.brand { display: flex; align-items: center; gap: 12px; min-height: 48px; }
.brand img { max-height: 64px; max-width: 220px; object-fit: contain; }
.brand .company { font-size: 13pt; font-weight: 600; }
.cover h1 { font-size: 26pt; line-height: 1.15; margin: 34mm 0 4px; }
.cover .subtitle { font-size: 15pt; color: #4b5563; margin: 0 0 18mm; }
h2 { font-size: 15pt; margin: 0 0 10px; padding-bottom: 4px; border-bottom: 2px solid #14181f; }
section { margin-bottom: 18px; }
section.new-page { break-before: page; }
p { margin: 0 0 8px; }
p.muted, figcaption { color: #4b5563; font-size: 9pt; }
ul { margin: 0 0 10px; padding-left: 18px; }
li { margin-bottom: 3px; }
figure { margin: 0 0 10px; break-inside: avoid; }
figure img { display: block; width: 100%; height: auto; border: 1px solid #d5d9de; }
figcaption { margin-top: 3px; }
table { border-collapse: collapse; width: 100%; margin-bottom: 12px; }
table.facts { width: auto; min-width: 60%; }
table.facts th { text-align: left; font-weight: 500; color: #4b5563; padding: 3px 18px 3px 0; }
table.facts td { padding: 3px 0; font-weight: 600; }
table.data { font-size: 8.5pt; }
table.data th { background: #f1f3f5; text-align: left; font-weight: 600; }
table.data th, table.data td { border: 1px solid #d5d9de; padding: 3px 5px; vertical-align: top; }
table.data tr { break-inside: avoid; }
.num { text-align: right !important; white-space: nowrap; }
.footer { margin-top: 18px; padding-top: 6px; border-top: 1px solid #d5d9de; font-size: 8pt; color: #6b7280; }
@media print {
  html { background: #fff; }
  .page { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
  .page + .page { break-before: page; }
  .footer { display: none; }
}
`;

/** The whole report as an HTML document. */
export function reportHtml(model: ReportModel): string {
  const logo = safeImageSrc(model.logo);
  const brand =
    logo || model.companyName
      ? `<div class="brand">${logo ? `<img src="${logo}" alt="">` : ""}${model.companyName ? `<span class="company">${escapeHtml(model.companyName)}</span>` : ""}</div>`
      : "";
  const cover = `<div class="page cover">${brand}<h1>${escapeHtml(model.title)}</h1><p class="subtitle">${escapeHtml(model.subtitle)}</p>${block({ kind: "facts", rows: model.cover })}</div>`;
  const body = model.sections
    .map(
      (s) =>
        `<section id="${escapeHtml(s.id)}"${s.newPage ? ' class="new-page"' : ""}><h2>${escapeHtml(s.heading)}</h2>${s.blocks.map(block).join("")}</section>`,
    )
    .join("");
  const footer = model.footer
    ? `<div class="footer">${escapeHtml(model.footer)}</div>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(
    [model.title, model.subtitle].filter(Boolean).join(" – "),
  )}</title><style>${STYLE}</style></head><body>${cover}<div class="page">${body}${footer}</div></body></html>`;
}
