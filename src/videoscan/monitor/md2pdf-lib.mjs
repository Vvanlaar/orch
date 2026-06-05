// MD -> HTML converter + print CSS for md2pdf.mjs (headings, tables, lists,
// bold, inline code, fenced code). Kept dependency-free.

export function inline(s) {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

export function mdToHtml(md) {
  const lines = md.replace(/^﻿/, "").split(/\r?\n/);
  const out = [];
  let inList = false, inCode = false, i = 0;
  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith("```")) {
      closeList();
      out.push(inCode ? "</pre>" : "<pre>");
      inCode = !inCode; i++; continue;
    }
    if (inCode) { out.push(l.replace(/&/g, "&amp;").replace(/</g, "&lt;")); i++; continue; }
    // table: header row + separator row
    if (l.startsWith("|") && lines[i + 1] && /^\|[\s\-|]+\|?\s*$/.test(lines[i + 1])) {
      closeList();
      const cells = (r) => r.split("|").slice(1, -1).map((c) => inline(c.trim()));
      out.push("<table><thead><tr>" + cells(l).map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>");
      i += 2;
      while (i < lines.length && lines[i].startsWith("|")) {
        out.push("<tr>" + cells(lines[i]).map((c) => `<td>${c}</td>`).join("") + "</tr>");
        i++;
      }
      out.push("</tbody></table>");
      continue;
    }
    const h = l.match(/^(#{1,3})\s+(.*)/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    const li = l.match(/^(\s*)-\s+(.*)/);
    if (li) {
      if (!inList) { out.push("<ul>"); inList = true; }
      // continuation lines (indented, not a new bullet) belong to this item
      let item = li[2]; let j = i + 1;
      while (j < lines.length && /^\s{2,}\S/.test(lines[j]) && !/^\s*-\s/.test(lines[j])) { item += " " + lines[j].trim(); j++; }
      out.push(`<li>${inline(item)}</li>`); i = j; continue;
    }
    const isStructural = (s) =>
      s.trim() === "" || s.startsWith("#") || s.startsWith("|") ||
      s.startsWith("```") || /^\s*-\s/.test(s) || /^\d+\.\s/.test(s);
    if (l.match(/^(\d+)\.\s/)) { // ordered list item: keep the number, join wrapped lines
      closeList();
      let item = l; let j = i + 1;
      while (j < lines.length && !isStructural(lines[j])) { item += " " + lines[j].trim(); j++; }
      out.push(`<p class="ol">${inline(item)}</p>`); i = j; continue;
    }
    if (l.trim() === "") { closeList(); i++; continue; }
    closeList();
    // join hard-wrapped source lines into one paragraph
    let para = l; let j = i + 1;
    while (j < lines.length && !isStructural(lines[j])) { para += " " + lines[j].trim(); j++; }
    out.push(`<p>${inline(para)}</p>`); i = j;
  }
  closeList();
  return out.join("\n");
}

export const CSS = `
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 10.5pt; color: #1a1a1a;
         line-height: 1.45; max-width: 100%; }
  h1 { font-size: 17pt; border-bottom: 2px solid #2563eb; padding-bottom: 6px; }
  h2 { font-size: 13pt; color: #1e40af; margin-top: 1.4em; }
  h3 { font-size: 11.5pt; color: #1e40af; }
  table { border-collapse: collapse; margin: 10px 0; width: 100%; }
  th, td { border: 1px solid #cbd5e1; padding: 4px 8px; text-align: left; font-size: 9.5pt; }
  th { background: #eff6ff; }
  tr:last-child { font-weight: 600; background: #f8fafc; }
  code { background: #f1f5f9; padding: 1px 4px; border-radius: 3px; font-size: 9pt; }
  pre { background: #f1f5f9; padding: 8px; border-radius: 4px; font-size: 8.5pt; }
  ul { margin: 6px 0; padding-left: 22px; }
  li { margin: 3px 0; }
  p.ol { margin: 4px 0 4px 10px; }
`;
