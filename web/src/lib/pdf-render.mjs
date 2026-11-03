/**
 * pdf-render.mjs — render a tailored CV to PDF and mark the tracker (#2172).
 *
 * Plain .mjs (same pattern as pdf-paths.mjs / clean-chips.mjs) so this can be
 * unit-tested with `node --test`, no TypeScript build step. `spawnFn`,
 * `execPath`, and `coreRoot` (the code checkout — the scripts live there, not in the data root) are injected rather than importing node:child_process
 * or career-ops.ts directly, keeping this module free of TypeScript
 * dependencies and letting tests substitute a fake child process.
 *
 * Runs generate-pdf.mjs and mark-pdf-ready.mjs as plain Node child processes
 * — no agent CLI or its sandbox involved — so a browser launch never depends
 * on an interactive sandbox-escalation approval nobody is present to grant in
 * a headless/web-triggered run. The tracker is marked ✅ only after a
 * CONFIRMED successful render, never optimistically.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * @typedef {Object} PdfRunSignals
 * @property {object|undefined} envelope - parseCvEnvelope's result for this run.
 * @property {string|null} noOutputMessage - The route's verdict on "did the CLI
 *   produce any output at all", or null when it did. That question is about the
 *   transport, not this module, so the route owns the wording and passes it in
 *   rather than both places carrying the same two strings.
 * @property {boolean} sawError - An authoritative structured-stream error (the
 *   CLI's own JSONL `error` event) — never a stderr keyword match, which must
 *   not override a clean exit (#1974).
 * @property {boolean} cleanExit - Exit code 0 (not killed, not non-zero).
 * @property {boolean} hasPaths - The backend resolved its scratch/final paths.
 */

/**
 * Did this pdf run produce a CV worth rendering?
 *
 * Pure, and here rather than in the route, because it is the decision point for
 * the backend pdf pipeline this module implements: nothing is written, rendered or
 * marked unless this says yes, and the route is a transport layer the repo leaves
 * untested by design.
 *
 * The envelope's own error is preferred over the generic message: "never closed"
 * and "emitted no envelope" are different bugs and the user can act on the
 * difference.
 *
 * @param {PdfRunSignals} signals
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function pdfRunOutcome({ envelope, noOutputMessage, sawError, cleanExit, hasPaths }) {
  // A CLI that produced nothing at all is a different failure from one that ran
  // and fell short — usually "not installed" or "not authenticated".
  if (noOutputMessage) return { ok: false, message: noOutputMessage };
  if (envelope?.ok !== true || !cleanExit || sawError || !hasPaths) {
    const why = envelope && envelope.ok === false ? ` (${envelope.error})` : "";
    return {
      ok: false,
      message: `This run didn't produce a tailored CV to render, so no PDF was generated — re-run it to verify.${why}`,
    };
  }
  return { ok: true };
}

/**
 * Persist the CV the agent emitted through its <<cv-html>> envelope (#2185).
 *
 * The agent emits the tailored HTML inline and the backend saves it here. The
 * chosen page format is NOT written to disk: it is already in memory and goes
 * straight to renderAndMarkPdf. A sidecar written and re-read inside one request
 * bought only a fallback branch for a state that could not occur, plus an
 * undeclared ordering dependency between these two functions.
 *
 * The scratch directory is created by resolvePdfPaths earlier in the same
 * request, so this deliberately does not mkdir — a missing directory here means
 * something is wrong upstream and should surface, not be papered over.
 *
 * @param {{pdfPaths: {html: string}, html: string}} args
 * @returns {{ok: true} | {ok: false, error: string}} Never throws: the caller
 *   routes the failure through the same honesty gate as every other pdf failure.
 */
export function writeCvHtml({ pdfPaths, html }) {
  try {
    fs.writeFileSync(pdfPaths.html, html, "utf8");
    return { ok: true };
  } catch (err) {
    // err.path when the platform gives it: a non-fs throw (an oversized-content
    // RangeError, a bad argument type) carries none, and "could not save to
    // undefined" tells the user nothing.
    return { ok: false, error: `Could not save the tailored CV to ${err.path ?? pdfPaths.html}: ${err.message}` };
  }
}

/**
 * Where generate-pdf.mjs reports what a render produced (`--result=`): beside
 * the scratch HTML, under the same `cv-web-{report}.` prefix the scratch sweep
 * removes, with a name of its own per call. The file is this process's own
 * account of its render — written only once a render returned, with
 * `draftPath` set when the PDF went to an overflow draft instead of the output
 * path (#6377) — so a caller never has to read console output or guess from
 * the file system, where another run's PDF at the same path would be mistaken
 * for this one's. The per-call name closes the same hole one level up: two
 * renders of one report share the final path, and a result keyed per report
 * would let one run read the other's.
 * @param {{html: string}} pdfPaths
 * @returns {string}
 */
export function renderResultPath(pdfPaths) {
  return pdfPaths.html.replace(/\.html$/i, `.${randomUUID()}.result.json`);
}

/**
 * Read the render result generate-pdf.mjs wrote, or null when there is none or
 * it does not have a result's shape (so a partial or foreign file reads as
 * "not delivered" rather than crashing the route).
 * @param {string} file
 * @returns {{outputPath: string, pageCount: number, size: number, draftPath?: string} | null}
 */
export function readRenderResult(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.outputPath !== "string" || !parsed.outputPath) return null;
    if (!Number.isInteger(parsed.pageCount) || parsed.pageCount < 1) return null;
    if (typeof parsed.size !== "number") return null;
    if (parsed.draftPath !== undefined && (typeof parsed.draftPath !== "string" || !parsed.draftPath)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Spawn generate-pdf.mjs as a plain child process and resolve once it exits.
 * @param {{spawnFn: Function, execPath: string, coreRoot: string, html: string, finalPdf: string, format: "letter"|"a4", reportNum: string, resultPath?: string}} args
 * @returns {Promise<{ok: boolean, stderr: string}>}
 */
export function spawnGeneratePdf({ spawnFn, execPath, coreRoot, html, finalPdf, format, reportNum, resultPath }) {
  return new Promise((resolve) => {
    const child = spawnFn(
      execPath,
      // --allow-reorder: a real cv.md's section order can legitimately diverge
      // from the template's fixed markup order, so this guard would otherwise
      // hard-fail every web-triggered render — same bypass a human already
      // applies manually via the CLI when this diverges.
      [
        path.join(coreRoot, "generate-pdf.mjs"), html, finalPdf, `--format=${format}`, `--report=${reportNum}`, "--allow-reorder",
        ...(resultPath ? [`--result=${resultPath}`] : []),
      ],
      // windowsHide: see api/doctor/route.ts — a stale inherited console
      // kills every child with 0xC0000142 on Windows; never inherit one.
      {
        cwd: coreRoot,
        windowsHide: true,
        env: { ...process.env, CAREER_OPS_PDF_SHARED: "1" },
      },
    );
    let stderr = "";
    // Decode on the stream, not per chunk: a chunk boundary inside a multibyte
    // character (the warnings open with ⚠️) would otherwise leave U+FFFD in the
    // text the error message is built from.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ ok: code === 0, stderr: stderr.trim() }));
    child.on("error", (e) => resolve({ ok: false, stderr: `PDF rendering failed to start: ${e.message}` }));
  });
}

/**
 * Spawn mark-pdf-ready.mjs (--json) and resolve once it exits, parsing its
 * JSON stdout when present (mark-pdf-ready.mjs prints a JSON payload even on
 * a failure exit when --json is passed) so a caller can surface the specific
 * reason (not-found / ambiguous / lock-timeout / ...) rather than raw stderr.
 * `code` is the exit code, or null when the child never started.
 * @param {{spawnFn: Function, execPath: string, coreRoot: string, reportNum: string}} args
 * @returns {Promise<{ok: boolean, code: number | null, data: {error?: string} | null, stderr: string}>}
 */
export function markTrackerReady({ spawnFn, execPath, coreRoot, reportNum }) {
  return new Promise((resolve) => {
    const child = spawnFn(execPath, [path.join(coreRoot, "mark-pdf-ready.mjs"), reportNum, "--json"], { cwd: coreRoot, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      let data = null;
      try { data = JSON.parse(stdout); } catch { /* not JSON, or exited before printing any */ }
      resolve({ ok: code === 0, code, data, stderr: stderr.trim() });
    });
    child.on("error", (e) => resolve({ ok: false, code: null, data: null, stderr: `mark-pdf-ready.mjs failed to start: ${e.message}` }));
  });
}

/**
 * Glob-clean every scratch file for this run rather than the one known filename.
 * The agent is not told these paths, and on Claude Code holds no write tool — but
 * the BACKEND writes here and generate-pdf.mjs may leave its own intermediates, so
 * matching the run's prefix stays the right sweep. Logs rather than silently
 * swallowing failures, so a systemic permissions problem doesn't grow
 * `.career-ops-web/pdf-tmp/` forever with no trace anywhere.
 * @param {string} scratchDir
 * @param {string} prefix
 * @returns {void}
 */
export function cleanupPdfScratch(scratchDir, prefix) {
  let entries;
  try {
    entries = fs.readdirSync(scratchDir);
  } catch (err) {
    console.error(`pdf scratch cleanup: could not list ${scratchDir}: ${err.message}`);
    return;
  }
  for (const f of entries) {
    if (!f.startsWith(prefix)) continue;
    try {
      fs.rmSync(path.join(scratchDir, f), { force: true });
    } catch (err) {
      console.error(`pdf scratch cleanup: could not remove ${f}: ${err.message}`);
    }
  }
}

/**
 * Keep the rendered HTML beside its PDF. The CV Studio edits that HTML, and
 * the scratch copy is deleted right after the render.
 * @param {{html: string, finalPdf: string}} pdfPaths
 * @param {string[]} warnings
 */
export function keepTailoredHtml(pdfPaths, warnings) {
  try {
    fs.copyFileSync(pdfPaths.html, pdfPaths.finalPdf.replace(/\.pdf$/i, ".html"));
  } catch (err) {
    warnings.push(`PDF rendered, but its HTML was not kept for the CV Studio: ${err.message}`);
  }
}

/**
 * @typedef {Object} RenderFailedResult
 * @property {"render-failed"} kind
 * @property {string} error
 */
/**
 * @typedef {Object} RenderedResult
 * @property {"rendered"} kind
 * @property {string[]} warnings - Non-fatal issues to surface to the user (e.g. a renderer advisory, or a tracker row that was not marked).
 */
/** @typedef {RenderFailedResult | RenderedResult} RenderResult */

/**
 * Render the tailored HTML to a PDF, then mark the tracker's PDF column
 * ready — only after the render is CONFIRMED successful, never
 * optimistically. Always cleans up scratch files, whether the render
 * succeeds or fails.
 *
 * Call after writeCvHtml for the same pdfPaths — this reads the HTML that
 * function wrote. `format` is passed in rather than read back off disk, so the two
 * no longer share a file and the only coupling left is the HTML itself.
 * @param {{spawnFn: Function, execPath: string, coreRoot: string, pdfPaths: {html: string, finalPdf: string}, format: "letter"|"a4", reportNum: string}} args
 * @returns {Promise<RenderResult>}
 */
export async function renderAndMarkPdf({ spawnFn, execPath, coreRoot, pdfPaths, format, reportNum }) {
  const warnings = [];

  // A render over a warn-only page budget exits 0 but writes nothing to the
  // final path: the PDF went to a sibling .overflow.pdf draft (#6377). There is
  // then no PDF to keep an HTML beside or to mark ready, and "done" would point
  // the user at a file that was never written, so it is reported the way a
  // strict overflow is. Whether a PDF was delivered comes from the result file
  // the render process writes about itself (see renderResultPath): not from
  // its console wording, which can change or arrive split, and not from the
  // final path's mtime, which another run for the same report could have
  // changed. The path is this call's own, so no earlier or concurrent run's
  // result can stand in for it; generate-pdf.mjs clears anything there anyway.
  const resultPath = renderResultPath(pdfPaths);
  const render = await spawnGeneratePdf({ spawnFn, execPath, coreRoot, html: pdfPaths.html, finalPdf: pdfPaths.finalPdf, format, reportNum, resultPath });
  const result = render.ok ? readRenderResult(resultPath) : null;
  const delivered = result !== null && !result.draftPath;
  if (delivered) keepTailoredHtml(pdfPaths, warnings);
  cleanupPdfScratch(path.dirname(pdfPaths.html), `cv-web-${reportNum}.`);

  if (!delivered) {
    if (!render.ok) {
      return { kind: "render-failed", error: render.stderr || "PDF rendering failed." };
    }
    if (result === null) {
      // Exit 0 but no account of a render: say exactly that rather than guess.
      return { kind: "render-failed", error: `PDF rendering reported success but left no usable result for ${path.basename(pdfPaths.finalPdf)}.` };
    }
    // The route shows the first 200 characters of this error. The full stderr
    // opens with the page-budget warning, which alone runs past that and reads
    // as advice to keep going; lead with the page counts and the outcome, and
    // name the draft this render wrote (the first free name, so a second
    // overflow is .overflow-2.pdf and the user must not open the older one).
    const budget = /CV is \d+ pages?; the allowed maximum is \d+ pages?\./.exec(render.stderr)?.[0]
      ?? `The CV is ${result.pageCount} pages, over its page budget.`;
    const named = `${budget} No PDF was written; the over-budget draft is ${path.basename(result.draftPath)}. Trim the CV and render again.`;
    const error = named.length <= 200
      ? named
      : `${budget} No PDF was written: the over-budget render was kept as an .overflow.pdf draft beside it. Trim the CV and render again.`;
    return { kind: "render-failed", error };
  }

  // A render that exits 0 can still have written advisories to stderr, and
  // they matter to whoever asked for this PDF: the CV fact check's advisory
  // phrases, the portal-length warnings. Reading render.stderr only in the
  // failure branch above collected them and dropped them, so on the web path
  // an unsupported claim the fact gate flagged reached nobody. One warning per
  // line, blank lines skipped, so a clean render still reports none.
  for (const line of render.stderr.split("\n")) {
    const text = line.trim();
    if (text) warnings.push(text);
  }

  // The PDF is the real deliverable and it already rendered successfully — a
  // tracker-sync miss (e.g. the row was edited away mid-flight) doesn't fail
  // the whole job, but it must still be visible to whoever is watching this
  // run, not just a server-side log nobody sees.
  const mark = await markTrackerReady({ spawnFn, execPath, coreRoot, reportNum });
  if (!mark.ok) {
    console.error(`mark-pdf-ready.mjs failed for report #${reportNum}: ${mark.data?.error ?? mark.stderr}`);
    warnings.push(
      mark.data?.error
        ? `PDF rendered, but the tracker wasn't updated: ${mark.data.error}`
        : `PDF rendered, but the tracker's PDF column wasn't updated automatically — run \`node mark-pdf-ready.mjs ${reportNum}\` manually.`,
    );
  }

  return { kind: "rendered", warnings };
}
