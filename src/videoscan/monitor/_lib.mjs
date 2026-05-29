// Shared helpers for the Nationale Monitor CLI scripts.
// Kept tiny on purpose — slug + CSV read/write + Claude subprocess shared by
// run-monitor, classify-explainer, aggregate-monitor and find-support-urls.

import { spawn } from "node:child_process";

export function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Minimal RFC-4180-ish CSV parser. Handles quoted fields, doubled-quote escape,
// CRLF/LF line endings, and a leading UTF-8 BOM (Excel exports one). No
// streaming — monitor inputs are ~700 rows.
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\r") {
      // swallow — \n drives the row break
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function rowsToObjects(rows) {
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const obj = {};
    for (let i = 0; i < header.length; i++) {
      obj[header[i]] = (r[i] || "").trim();
    }
    return obj;
  });
}

export function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(cells) {
  return cells.map(csvCell).join(",");
}

// UTF-8 BOM + CRLF so Excel-on-Windows decodes UTF-8 and recognises rows.
export function writeCsvString(header, rows) {
  return "﻿" + [csvRow(header), ...rows.map(csvRow)].join("\r\n") + "\r\n";
}

// Run `claude --print` with the prompt piped via stdin. shell:true is required
// on Windows (claude is a .cmd shim). Resolves stdout; rejects with .fullStderr
// on non-zero exit.
export function callClaude(prompt) {
  return new Promise((resolveFn, reject) => {
    const proc = spawn(
      "claude",
      ["--print", "--dangerously-skip-permissions", "-"],
      { shell: true }
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== 0) {
        const err = new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`);
        err.fullStderr = stderr;
        reject(err);
      } else {
        resolveFn(stdout);
      }
    });
    if (proc.stdin) {
      // Swallow EPIPE if claude exits before we finish writing; the exit
      // handler reports the real cause.
      proc.stdin.on("error", () => {});
      proc.stdin.write(prompt);
      proc.stdin.end();
    }
  });
}

// callClaude with one retry. Appends attempt failures to errorLog (if given).
export async function callClaudeWithRetry(prompt, errorLog) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await callClaude(prompt);
    } catch (err) {
      if (errorLog) {
        errorLog.push(
          `--- attempt ${attempt} @ ${new Date().toISOString()} ---\n${err.fullStderr || err.message}\n`
        );
      }
      if (attempt === 2) throw err;
    }
  }
}

// Best-effort extraction of a JSON array from a model response that may be
// wrapped in prose or a ```json fence.
export function extractJsonArray(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {}
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\" && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0 && start !== -1) {
        return JSON.parse(trimmed.slice(start, i + 1));
      }
    }
  }
  throw new Error("No JSON array in model response");
}
