import { useState, useEffect, useRef, useCallback, useMemo } from "react";


/* ════════════════════════════════════════════════════════════════
   COHERENCE — confidence-first OCT triage
   Engine layer: UI only ever touches TriageEngine.
   ════════════════════════════════════════════════════════════════ */

const ENGINE_ENV = "mock"; // "mock" | "real"  — env var in production

/* ---------- seeded RNG so every case is stable ---------- */
function hashStr(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- synthetic OCT B-scan ---------- */
function genScan(seed) {
  const rnd = mulberry32(seed);
  const w = 640, h = 360;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "#04070b"; g.fillRect(0, 0, w, h);
  const foveaX = w * (0.38 + rnd() * 0.24);
  const dip = 26 + rnd() * 18;
  const base = 132 + rnd() * 30;
  const layers = [
    { t: 0, s: 200 }, { t: 14, s: 90 }, { t: 30, s: 150 }, { t: 52, s: 70 },
    { t: 70, s: 120 }, { t: 92, s: 60 }, { t: 104, s: 235 }, { t: 116, s: 250 },
    { t: 126, s: 40 },
  ];
  const wob = Array.from({ length: 8 }, () => ({ f: 0.004 + rnd() * 0.01, p: rnd() * 6.28, a: 2 + rnd() * 5 }));
  for (let x = 0; x < w; x++) {
    const d = (x - foveaX) / (w * 0.16);
    const pit = dip * Math.exp(-d * d);
    let wave = 0;
    for (const o of wob) wave += Math.sin(x * o.f + o.p) * o.a * 0.3;
    const top = base + wave + pit * 0.9;
    for (let i = 0; i < layers.length - 1; i++) {
      const y0 = top + layers[i].t - (i < 4 ? pit * (0.8 - i * 0.18) : 0);
      const y1 = top + layers[i + 1].t - (i + 1 < 4 ? pit * (0.8 - (i + 1) * 0.18) : 0);
      const s = layers[i].s * (0.75 + rnd() * 0.5);
      g.fillStyle = `rgb(${s},${s * 0.98},${s * 0.92})`;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
    // speckle above/below
    if (rnd() < 0.5) { const yy = rnd() * (top - 10); const v = 10 + rnd() * 22; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(x, yy, 1, 1); }
  }
  // speckle noise pass
  const img = g.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 34;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  return { url: c.toDataURL("image/png"), foveaX, base };
}

/* ---------- uncertainty map: the shape IS the product ---------- */
function genHeatmap(seed, shape, foveaX, base) {
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  const w = 640, h = 360;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  const blob = (x, y, r, a) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(214,86,0,${a})`);
    gr.addColorStop(0.45, `rgba(240,170,20,${a * 0.6})`);
    gr.addColorStop(1, "rgba(26,95,200,0)");
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.28); g.fill();
  };
  if (shape === "focal") {
    const fx = foveaX + (rnd() - 0.5) * 160;
    const fy = base + 40 + rnd() * 50;
    blob(fx, fy, 60 + rnd() * 30, 0.95);
    blob(fx + (rnd() - 0.5) * 50, fy + (rnd() - 0.5) * 30, 34, 0.7);
    // faint boundary trace elsewhere
    for (let i = 0; i < 10; i++) blob(rnd() * w, base + rnd() * 120, 12, 0.08);
  } else if (shape === "diffuse") {
    for (let i = 0; i < 90; i++) blob(rnd() * w, rnd() * h, 18 + rnd() * 30, 0.10 + rnd() * 0.12);
  } else {
    // low: whisper-thin uncertainty riding the layer boundaries only
    for (const off of [0, 52, 116]) {
      for (let x = 0; x < w; x += 6) {
        const d = (x - foveaX) / (w * 0.16);
        const pit = 24 * Math.exp(-d * d);
        blob(x, base + off + Math.sin(x * 0.01) * 3 + (off < 60 ? pit * 0.6 : 0), 5, 0.16);
      }
    }
  }
  return c.toDataURL("image/png");
}

/* ---------- MockEngine — canned results, no network ---------- */
const REASONS = {
  cleared: "The model agrees with itself across all passes.",
  rescan: "Uncertainty is diffuse — this is a capture problem, not a clinical one. Likely small pupil or poor fixation.",
  review: "The capture is fine; the anatomy is genuinely ambiguous. A rescan won't help.",
};
const MockEngine = {
  name: "mock",
  analyze(meta) {
    return new Promise((res) => {
      const seed = hashStr(meta.name + meta.id);
      const rnd = mulberry32(seed);
      const p = rnd();
      let decision, shape, confidence, mu;
      if (p < 0.55) { decision = "cleared"; shape = "low"; confidence = 88 + rnd() * 10; mu = 4 + rnd() * 5; }
      else if (p < 0.72) { decision = "rescan"; shape = "diffuse"; confidence = 40 + rnd() * 24; mu = 18 + rnd() * 12; }
      else { decision = "review"; shape = "focal"; confidence = 46 + rnd() * 28; mu = 8 + rnd() * 9; }
      const scan = genScan(seed);
      const heatmapUrl = genHeatmap(seed, shape, scan.foveaX, scan.base);
      const thickness = 205 + rnd() * 110;
      const hasPrior = rnd() < 0.45 && decision !== "rescan";
      const priorDelta = hasPrior ? (rnd() - 0.4) * 26 : null;
      setTimeout(() => res({
        caseId: meta.caseId,
        confidence: Math.round(confidence),
        uncertaintyShape: shape,
        decision,
        reason: REASONS[decision],
        heatmapUrl,
        scanUrl: scan.url,
        layerThicknessUm: Math.round(thickness),
        measurementUncertaintyUm: Math.round(mu),
        prior: hasPrior ? { thickness: Math.round(thickness - priorDelta), monthsAgo: 6 + Math.floor(rnd() * 12) } : null,
      }), 600 + rnd() * 900);
    });
  },
};
const RealEngine = {
  name: "real",
  async analyze() { throw new Error("RealEngine: POST /api/analyze not wired yet."); },
};
const getEngine = () => (ENGINE_ENV === "mock" ? MockEngine : RealEngine);

/* ---------- de-identification manifest ---------- */
const STRIPPED_TAGS = [
  "PatientName (0010,0010)", "PatientID (0010,0020)", "PatientBirthDate (0010,0030)",
  "PatientSex (0010,0040)", "AccessionNumber (0008,0050)", "InstitutionName (0008,0080)",
  "ReferringPhysician (0008,0090)", "OperatorsName (0008,1070)", "DeviceSerialNumber (0018,1000)",
  "OtherPatientIDs (0010,1000)", "PatientTelephoneNumbers (0010,2154)",
];

function newCaseId() {
  const a = "CFGHJKMPQRVWXY", n = "23456789";
  let s = "";
  for (let i = 0; i < 3; i++) s += a[Math.floor(Math.random() * a.length)];
  s += "-";
  for (let i = 0; i < 4; i++) s += n[Math.floor(Math.random() * n.length)];
  return s;
}

/* ════════════════ small presentational atoms ════════════════ */
const Icon = ({ d, size = 15 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const ICONS = {
  check: <><circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.5 2.5 4.5-5.5" /></>,
  camera: <><path d="M3 8h3l2-3h8l2 3h3v11H3z" /><circle cx="12" cy="13" r="3.5" /></>,
  eye: <><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  shield: <><path d="M12 3 5 6v5c0 5 3 8.5 7 10 4-1.5 7-5 7-10V6z" /><path d="m9 12 2 2 4-4.5" /></>,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  upload: <><path d="M12 16V4m0 0 -4 4m4-4 4 4" /><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></>,
  back: <path d="m14 6-6 6 6 6" />,
  warn: <><path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v4m0 3v.5" /></>,
};

/* uncertainty-shape glyph — the product's signature mark */
const ShapeGlyph = ({ shape }) => (
  <svg width="42" height="16" viewBox="0 0 42 16" aria-hidden="true" style={{ flexShrink: 0 }}>
    {shape === "low" && <path d="M2 12 H40" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" opacity="0.75" />}
    {shape === "focal" && <path d="M2 13 H14 C17 13 18 3 21 3 C24 3 25 13 28 13 H40" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />}
    {shape === "diffuse" && <g fill="currentColor" opacity="0.8">
      {[4, 9, 14, 19, 24, 29, 34, 39].map((x, i) => <circle key={x} cx={x} cy={5 + ((i * 7) % 8)} r="1.5" />)}
    </g>}
  </svg>
);

const DECISION_META = {
  cleared: { label: "Cleared", cls: "chip-cleared", icon: ICONS.check, next: "No review · recall in 12 months" },
  rescan: { label: "Rescan", cls: "chip-rescan", icon: ICONS.camera, next: "Retake and re-upload" },
  review: { label: "Review", cls: "chip-review", icon: ICONS.eye, next: "Open case — heatmap marks where to look" },
};
const Chip = ({ decision }) => {
  const m = DECISION_META[decision];
  return <span className={`chip ${m.cls}`}><Icon d={m.icon} size={13} /> {m.label}</span>;
};

/* ════════════════════════ APP ════════════════════════ */
export default function Coherence() {
  const engine = useMemo(getEngine, []);
  const [stage, setStage] = useState("upload"); // upload | triage | report | review
  const [files, setFiles] = useState([]);       // {id, caseId, name, laterality, deid, burnedIn, masked, progress}
  const [results, setResults] = useState({});   // caseId -> TriageResult+
  const [current, setCurrent] = useState(null); // caseId under review
  const [triageNow, setTriageNow] = useState(null); // filename being analysed
  const [role, setRole] = useState("reviewer");
  const [audit, setAudit] = useState([]);
  const [showAudit, setShowAudit] = useState(false);
  const [locked, setLocked] = useState(false);
  const [disagreeFor, setDisagreeFor] = useState(null);

  const log = useCallback((action, caseId = "—") => {
    setAudit((a) => [{ t: new Date(), role, caseId, action }, ...a]);
  }, [role]);

  /* ----- auto-lock after 5 min idle (shared front-desk machines) ----- */
  const idleRef = useRef(null);
  useEffect(() => {
    const reset = () => {
      clearTimeout(idleRef.current);
      idleRef.current = setTimeout(() => setLocked(true), 5 * 60 * 1000);
    };
    ["pointerdown", "keydown", "pointermove"].forEach((e) => window.addEventListener(e, reset));
    reset();
    return () => { clearTimeout(idleRef.current); ["pointerdown", "keydown", "pointermove"].forEach((e) => window.removeEventListener(e, reset)); };
  }, []);

  /* ----- intake: REAL de-identification, in the browser, before upload ----- */
  const intake = useCallback(async (fileList) => {
    const metas = fileList.map((file, i) => ({
      id: `${Date.now()}-${i}`,
      file,
      name: file.name,
      caseId: null, laterality: null,
      deid: 0, ok: false, masked: false,
      strippedCount: 0, ageYears: null, warnings: [],
      synthetic: false,
    }));
    setFiles(metas);
    log(`Batch received · ${metas.length} scan${metas.length > 1 ? "s" : ""} · de-identifying in browser`);

    // dcmjs is ~700 kB; load it only when a file is actually dropped,
    // so the dropzone paints instantly on a slow clinic connection.
    const { deidentify } = await import("./lib/deidentify");

    for (const m of metas) {
      try {
        const r = await deidentify(m.file);
        setFiles((fs) => fs.map((f) => f.id === m.id ? { ...f,
          deid: 1, ok: r.ok, caseId: r.caseId, laterality: r.laterality,
          ageYears: r.ageYears, masked: r.masked,
          strippedCount: r.strippedTags.length,
          burnedIn: r.burnedInText.detected,
          burnedInSource: r.burnedInText.source,
          warnings: r.warnings, pixels: r.pixels, blob: r.blob,
        } : f));
        if (!r.ok) log(`De-identification FAILED · ${m.name}`, r.caseId ?? "—");
      } catch (err) {
        setFiles((fs) => fs.map((f) => f.id === m.id ? { ...f,
          deid: 1, ok: false,
          warnings: [`Not readable as DICOM: ${err.message}`],
        } : f));
      }
    }
  }, [log]);

  const onDrop = (e) => {
    e.preventDefault();
    const fs = Array.from(e.dataTransfer?.files || []);
    if (fs.length) intake(fs);
  };
  const onPick = (e) => {
    const fs = Array.from(e.target.files || []);
    if (fs.length) intake(fs);
    e.target.value = "";
  };

  /* Demo path: no real DICOM, so nothing to de-identify. Flagged as synthetic
     everywhere so it can never be mistaken for a real de-identified batch. */
  const loadSamples = () => {
    const eyes = ["OD", "OS"];
    const metas = Array.from({ length: 12 }, (_, i) => {
      const name = `SAMPLE_MAC-CUBE_${eyes[i % 2]}_${String(1200 + i * 37)}.dcm`;
      return {
        id: `${Date.now()}-${i}`, file: null, name,
        caseId: newCaseId(), laterality: eyes[i % 2],
        deid: 1, ok: true, masked: false, synthetic: true,
        strippedCount: 0, ageYears: null, warnings: [],
      };
    });
    setFiles(metas);
    log(`Sample batch loaded · ${metas.length} synthetic scans · NOT de-identified (no real files)`);
  };

  /* A file that failed de-identification must block the batch, not sail through. */
  const deidDone = files.length > 0 && files.every((f) => f.deid >= 1 && f.ok);
  const deidFailed = files.filter((f) => f.deid >= 1 && !f.ok);

  /* ----- triage run ----- */
  const runTriage = async () => {
    setStage("triage");
    log(`Triage started · engine=${engine.name} · 20 passes per scan`);
    const out = {};
    for (const f of files) {
      setTriageNow(f.name);
      const r = await engine.analyze(f);
      out[f.caseId] = { ...r, name: f.name, laterality: f.laterality, masked: f.masked, clinician: null };
      setResults({ ...out });
    }
    setTriageNow(null);
    setStage("report");
    log(`Triage complete · ${files.length} scans · pixel data deleted, derived numbers retained`);
  };

  /* ----- clinician actions ----- */
  const record = (caseId, action, extra) => {
    setResults((rs) => ({ ...rs, [caseId]: { ...rs[caseId], clinician: { action, ...extra, t: new Date() } } }));
    log(`Sign-off: ${action}`, caseId);
  };

  const list = Object.values(results).sort((a, b) => a.confidence - b.confidence);
  const counts = {
    received: files.length,
    cleared: list.filter((r) => r.decision === "cleared").length,
    rescan: list.filter((r) => r.decision === "rescan").length,
    review: list.filter((r) => r.decision === "review").length,
  };
  const decided = list.filter((r) => r.clinician && ["agree", "disagree"].includes(r.clinician.action));
  const agreePct = decided.length ? Math.round(100 * decided.filter((r) => r.clinician.action === "agree").length / decided.length) : null;

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <StyleBlock />
      {engine.name === "mock" && (
        <div className="mockbar" role="status">MOCK ENGINE — canned results, no network. Not clinical data.</div>
      )}
      <header className="hdr">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><ShapeGlyph shape="focal" /></span>
          <span className="brand-name">Coherence</span>
          <span className="brand-tag">AI that knows what it doesn't know</span>
        </div>
        <div className="hdr-right">
          <label className="rolewrap">
            <span className="rolelabel">Signed in as</span>
            <select value={role} onChange={(e) => { setRole(e.target.value); }} aria-label="Role (demo switcher — Clerk/Supabase Auth in production)">
              <option value="uploader">Uploader · practice invite</option>
              <option value="reviewer">Reviewer · AHPRA OPT0012345</option>
              <option value="admin">Admin · practice account</option>
            </select>
          </label>
          {role === "admin" && (
            <button className="ghostbtn" onClick={() => setShowAudit((s) => !s)}>Audit log ({audit.length})</button>
          )}
        </div>
      </header>

      <main className="main">
        {stage === "upload" && (
          <UploadScreen files={files} deidDone={deidDone} deidFailed={deidFailed}
            onPick={onPick} onSamples={loadSamples} onRun={runTriage} />
        )}
        {stage === "triage" && <TriageScreen now={triageNow} done={Object.keys(results).length} total={files.length} />}
        {stage === "report" && (
          <ReportScreen counts={counts} list={list} agreePct={agreePct}
            onOpen={(id) => { setCurrent(id); setStage("review"); log("Case opened", id); }} />
        )}
        {stage === "review" && current && (
          <ReviewScreen r={results[current]} role={role}
            onBack={() => setStage("report")}
            onAction={(a) => a === "disagree" ? setDisagreeFor(current) : record(current, a, {})} />
        )}
      </main>

      {showAudit && <AuditPanel audit={audit} onClose={() => setShowAudit(false)} />}
      {disagreeFor && (
        <DisagreeModal r={results[disagreeFor]}
          onSave={(said, why) => { record(disagreeFor, "disagree", { said, why }); setDisagreeFor(null); }}
          onCancel={() => setDisagreeFor(null)} />
      )}
      {locked && (
        <div className="lock" role="dialog" aria-modal="true" aria-label="Session locked">
          <div className="lockcard">
            <Icon d={ICONS.lock} size={26} />
            <h2>Session locked</h2>
            <p>Locked after 5 minutes of inactivity. Shared machines stay safe.</p>
            <button className="primary" onClick={() => { setLocked(false); log("Session unlocked"); }}>Unlock</button>
          </div>
        </div>
      )}

      <footer className="disclaimer" role="note">
        <Icon d={ICONS.shield} size={14} />
        <strong>Triage aid. Not a diagnosis.</strong>&nbsp;All clinical decisions remain with the practitioner. &nbsp;·&nbsp; We do not use your uploads to train our models. &nbsp;·&nbsp; Reports go to the practitioner, never the patient.
      </footer>
    </div>
  );
}

/* ════════════════ Screen 1 — Upload + in-browser de-id ════════════════ */
function UploadScreen({ files, deidDone, deidFailed = [], onPick, onSamples, onRun }) {
  const inputRef = useRef(null);
  const folderRef = useRef(null);
  return (
    <section className="screen">
      {files.length === 0 ? (
        <>
          <div className="hero">
            <p className="eyebrow">Upload · OCT retinal scans</p>
            <h1>Which scans does a human<br />actually need to open?</h1>
            <p className="lede">Drop a folder of scans. Each one is de-identified <em>in your browser</em> —
              names, IDs and dates of birth never leave this machine — then triaged into three outcomes:
              cleared, rescan, or review.</p>
          </div>
          <div className="dropzone" role="button" tabIndex={0} aria-label="Upload scans — DICOM, TIFF, PNG or JPEG"
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}>
            <Icon d={ICONS.upload} size={26} />
            <p><strong>Drag a folder or files here</strong>, or choose below</p>
            <p className="dim">DICOM · TIFF · PNG · JPEG — per-file progress, resumable</p>
            <div className="dz-actions">
              <button className="primary" onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}>Choose files</button>
              <button className="ghostbtn" onClick={(e) => { e.stopPropagation(); folderRef.current?.click(); }}>Choose folder</button>
              <button className="ghostbtn" onClick={(e) => { e.stopPropagation(); onSamples(); }}>Load 12 sample scans</button>
            </div>
            <input ref={inputRef} type="file" multiple hidden onChange={onPick} accept=".dcm,.dicom,.tif,.tiff,.png,.jpg,.jpeg" />
            <input ref={folderRef} type="file" webkitdirectory="" hidden onChange={onPick} />
          </div>
          <div className="privacycard">
            <h3><Icon d={ICONS.shield} /> De-identified before upload — non-negotiable</h3>
            <p>Eleven identifying DICOM tags are stripped client-side, dates of birth become age in years,
              and image bands are checked for burned-in patient names. Only pixel data, laterality and
              acquisition parameters are sent. Case IDs are random and generated here — your practice keeps
              the mapping; we never receive it.</p>
          </div>
        </>
      ) : (
        <>
          <div className="hero small">
            <p className="eyebrow">De-identifying in browser · {files.length} scan{files.length > 1 ? "s" : ""}</p>
            <h1>Stripping identity, keeping anatomy</h1>
            <p className="lede">Removing {STRIPPED_TAGS.length} tags per file: {STRIPPED_TAGS.slice(0, 4).map(t => t.split(" ")[0]).join(", ")},
              and {STRIPPED_TAGS.length - 4} more. Checking BurnedInAnnotation (0028,0301) plus top and bottom image bands for rendered text.</p>
          </div>
          <ul className="filelist" aria-label="Per-file de-identification progress">
            {files.map((f) => (
              <li key={f.id} className="filerow">
                <div className="filemeta">
                  <span className="mono fname">{f.name}</span>
                  {f.laterality && f.laterality !== "unknown" &&
                    <span className="latbadge" title="Laterality read from DICOM tag (0020,0060)">{f.laterality}</span>}
                  {f.caseId && <span className="mono caseid">{f.caseId}</span>}
                  {f.ageYears != null && <span className="mono caseid" title="DOB converted to age, then deleted">age {f.ageYears}</span>}
                  {f.synthetic && <span className="latbadge" style={{ background: "#8A6410" }}>SYNTHETIC</span>}
                </div>
                <div className="fprog" role="progressbar" aria-valuenow={Math.round(f.deid * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`De-identifying ${f.name}`}>
                  <div className="fprog-fill" style={{ width: `${f.deid * 100}%` }} />
                </div>
                <div className="fstate">
                  {f.deid < 1
                    ? <span className="dim">reading DICOM · stripping tags…</span>
                    : f.synthetic
                      ? <span className="dim">demo placeholder — no file to de-identify</span>
                      : !f.ok
                        ? <span className="warn"><Icon d={ICONS.warn} size={13} /> {f.warnings[0] || "De-identification failed — not uploaded"}</span>
                        : f.masked
                          ? <span className="warn"><Icon d={ICONS.warn} size={13} /> Burned-in text found ({f.burnedInSource === "pixels" ? "in pixels; tag was absent" : "declared by tag"}) — masked before upload</span>
                          : <span className="ok"><Icon d={ICONS.check} size={13} /> Clean · {f.strippedCount} tags stripped</span>}
                  {f.ok && f.warnings.length > 0 &&
                    <span className="dim" style={{ display: "block", fontSize: 12.5, marginTop: 4 }}>{f.warnings[0]}</span>}
                </div>
              </li>
            ))}
          </ul>
          <div className="runbar">
            <p className="dim">
              {deidFailed.length > 0
                ? `${deidFailed.length} file${deidFailed.length > 1 ? "s" : ""} could not be de-identified. Remove ${deidFailed.length > 1 ? "them" : "it"} before continuing — nothing is uploaded until every file is clean.`
                : deidDone
                  ? "All files de-identified. Nothing identifiable leaves this browser."
                  : "De-identification must finish before upload."}
            </p>
            <button className="primary big" disabled={!deidDone} onClick={onRun}>
              Run triage · {files.length} scan{files.length > 1 ? "s" : ""}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/* ════════════════ Screen 2 — Triage ════════════════ */
function TriageScreen({ now, done, total }) {
  return (
    <section className="screen center">
      <div className="triagecard" aria-live="polite">
        <p className="eyebrow">Triage in progress</p>
        <h1 className="mono bignum">{done} <span className="of">of {total}</span></h1>
        <p className="passline">20 passes · measuring disagreement</p>
        <div className="fprog big"><div className="fprog-fill" style={{ width: `${(done / total) * 100}%` }} /></div>
        {now && <p className="mono dim nowfile">{now}</p>}
        <p className="dim smallnote">Where the twenty passes agree, we clear. Where they disagree everywhere,
          the capture is bad. Where they disagree in one place, a human should look — exactly there.</p>
      </div>
    </section>
  );
}

/* ════════════════ Screen 3 — Report ════════════════ */
function ReportScreen({ counts, list, agreePct, onOpen }) {
  const notOpened = counts.cleared;
  return (
    <section className="screen">
      <div className="hero small">
        <p className="eyebrow">Report · read in five seconds</p>
        <h1><span className="heronum mono">{notOpened}</span> scan{notOpened !== 1 ? "s" : ""} you did not have to open</h1>
        <p className="lede">Cleared with high confidence — uncertainty confined to layer boundaries.
          {agreePct !== null && <> &nbsp;·&nbsp; You've agreed with <strong>{agreePct}%</strong> of triage decisions this session.</>}</p>
      </div>
      <div className="counters" role="group" aria-label="Batch summary">
        {[
          ["Received", counts.received, null],
          ["Cleared", counts.cleared, "cleared"],
          ["Rescan", counts.rescan, "rescan"],
          ["Review", counts.review, "review"],
        ].map(([label, n, d]) => (
          <div key={label} className={`counter ${d ? "c-" + d : ""}`}>
            <span className="mono cnum">{n}</span>
            <span className="clabel">{d ? <Chip decision={d} /> : label}</span>
          </div>
        ))}
      </div>
      <div className="worklist">
        <div className="wl-head">
          <span>Case</span><span>Eye</span><span>Confidence</span><span>Uncertainty shape</span><span>Decision</span><span>Next step</span>
        </div>
        <ul aria-label="Worklist, sorted worst confidence first">
          {list.map((r) => (
            <li key={r.caseId}>
              <button className={`wl-row ${r.clinician ? "signed" : ""}`} onClick={() => onOpen(r.caseId)}
                aria-label={`Open case ${r.caseId}, ${r.decision}, confidence ${r.confidence}`}>
                <span className="mono">{r.caseId}</span>
                <span className="latbadge">{r.laterality}</span>
                <span className="confcell"><span className="mono">{r.confidence}</span><ConfBar v={r.confidence} /></span>
                <span className={`shapecell s-${r.uncertaintyShape}`}><ShapeGlyph shape={r.uncertaintyShape} />
                  <span className="shapename">{r.uncertaintyShape}</span></span>
                <span><Chip decision={r.decision} /></span>
                <span className="dim nextcell">{r.clinician
                  ? <span className="signedtag"><Icon d={ICONS.check} size={12} /> {r.clinician.action}</span>
                  : DECISION_META[r.decision].next}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="dim wl-note">Sorted by confidence ascending — worst first. Pixel data was deleted when this
          report was generated; only derived numbers are retained.</p>
      </div>
    </section>
  );
}
const ConfBar = ({ v }) => (
  <span className="confbar" aria-hidden="true"><span style={{ width: `${v}%` }} /></span>
);

/* ════════════════ Screen 4 — Review ════════════════ */
function ReviewScreen({ r, role, onBack, onAction }) {
  const [opacity, setOpacity] = useState(0.7);
  const [overlay, setOverlay] = useState(true);
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const dragRef = useRef(null);
  const canSign = role === "reviewer";

  const onWheel = (e) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    setView((v) => {
      const s2 = Math.min(8, Math.max(1, v.s * Math.exp(-e.deltaY * 0.0015)));
      const k = s2 / v.s;
      let x = px - k * (px - v.x), y = py - k * (py - v.y);
      if (s2 === 1) { x = 0; y = 0; }
      return { s: s2, x, y };
    });
  };
  const onDown = (e) => { dragRef.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId); };
  const onMove = (e) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.x, dy = e.clientY - dragRef.current.y;
    dragRef.current = { x: e.clientX, y: e.clientY };
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const onUp = () => { dragRef.current = null; };
  const zoomBy = (k) => setView((v) => {
    const s2 = Math.min(8, Math.max(1, v.s * k));
    return s2 === 1 ? { s: 1, x: 0, y: 0 } : { ...v, s: s2 };
  });
  const t = { transform: `translate(${view.x}px,${view.y}px) scale(${view.s})`, transformOrigin: "0 0" };
  const panelHandlers = { onWheel, onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp };
  const panelStyle = { touchAction: "none", cursor: "grab" };

  const delta = r.prior ? r.layerThicknessUm - r.prior.thickness : null;
  const withinU = delta !== null && Math.abs(delta) <= r.measurementUncertaintyUm;

  return (
    <section className="screen">
      <div className="revtop">
        <button className="ghostbtn" onClick={onBack}><Icon d={ICONS.back} size={14} /> Worklist</button>
        <div className="revid">
          <span className="mono caseid big">{r.caseId}</span>
          <span className="latbadge">{r.laterality}</span>
          <Chip decision={r.decision} />
          {r.masked && <span className="warn"><Icon d={ICONS.warn} size={13} /> burned-in text was masked at upload</span>}
        </div>
      </div>

      <div className="reasonbar">
        <ShapeGlyph shape={r.uncertaintyShape} />
        <p>“{r.reason}”</p>
        <span className="mono confpill">confidence {r.confidence}</span>
      </div>

      <div className="viewer">
        <figure className="panel">
          <div className="panelimg" {...panelHandlers} style={panelStyle} role="img"
            aria-label={overlay ? "B-scan with uncertainty overlay" : "B-scan"}>
            <div className="panelinner" style={t}>
              <img src={r.scanUrl} alt="" draggable={false} />
              {overlay && <img src={r.heatmapUrl} alt="" draggable={false} style={{ opacity }} />}
            </div>
          </div>
          <figcaption>{overlay ? "B-scan · uncertainty overlay" : "B-scan"}</figcaption>
        </figure>
        <figure className="panel">
          <div className="panelimg" {...panelHandlers} style={panelStyle} role="img"
            aria-label="Confidence map — orange marks where the passes disagree">
            <div className="panelinner" style={t}>
              <img src={r.scanUrl} alt="" draggable={false} style={{ filter: "brightness(0.35)" }} />
              <img src={r.heatmapUrl} alt="" draggable={false} style={{ opacity: Math.max(0.55, opacity) }} />
            </div>
          </div>
          <figcaption>Confidence map — orange is where the passes disagree</figcaption>
        </figure>
      </div>

      <div className="viewctl" role="group" aria-label="View controls — these never alter the input or the model">
        <label className="ctl">
          <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} />
          Overlay on scan
        </label>
        <label className="ctl slider">
          Heatmap opacity
          <input type="range" min="0" max="1" step="0.05" value={opacity}
            onChange={(e) => setOpacity(+e.target.value)} aria-label="Heatmap opacity" />
          <span className="mono">{Math.round(opacity * 100)}%</span>
        </label>
        <span className="ctl" role="group" aria-label="Zoom">
          <button className="ghostbtn" onClick={() => zoomBy(1 / 1.4)} aria-label="Zoom out">−</button>
          <span className="mono">{view.s.toFixed(1)}×</span>
          <button className="ghostbtn" onClick={() => zoomBy(1.4)} aria-label="Zoom in">+</button>
        </span>
        <span className="dim">Scroll to zoom · drag to pan · panels stay in sync</span>
        <button className="ghostbtn" onClick={() => setView({ s: 1, x: 0, y: 0 })}>Reset view</button>
      </div>

      <div className="datarow">
        <div className="datum">
          <span className="dlabel">Central thickness</span>
          <span className="mono dval">{r.layerThicknessUm} µm <span className="pm">± {r.measurementUncertaintyUm}</span></span>
        </div>
        <div className="datum">
          <span className="dlabel">Uncertainty shape</span>
          <span className={`dval shapecell s-${r.uncertaintyShape}`}><ShapeGlyph shape={r.uncertaintyShape} /> {r.uncertaintyShape}</span>
        </div>
        <div className="datum wide">
          <span className="dlabel">Prior visit</span>
          {r.prior ? (
            <span className="dval">
              <span className="mono">{r.prior.thickness} µm</span> · {r.prior.monthsAgo} mo ago →
              change <span className="mono">{delta > 0 ? "+" : ""}{delta} µm</span> —{" "}
              {withinU
                ? <strong>within measurement uncertainty, not progression.</strong>
                : <strong className="warn-ink">exceeds measurement uncertainty (±{r.measurementUncertaintyUm} µm) — treat as real change.</strong>}
            </span>
          ) : <span className="dval dim">No history on file for this case ID.</span>}
        </div>
      </div>

      <div className="actions">
        {!canSign && <p className="gatenote"><Icon d={ICONS.lock} size={13} /> Sign-off requires a verified AHPRA registration (OPT…/MED…). Uploaders can view but not record clinical decisions.</p>}
        <div className="actionbtns">
          <button className="primary" disabled={!canSign} onClick={() => onAction("agree")}>Agree</button>
          <button className="outline" disabled={!canSign} onClick={() => onAction("disagree")}>Disagree</button>
          <button className="outline" disabled={!canSign} onClick={() => onAction("request rescan")}>Request rescan</button>
          <button className="outline" disabled={!canSign} onClick={() => onAction("refer")}>Refer</button>
        </div>
        {r.clinician && (
          <p className="ok signednote"><Icon d={ICONS.check} size={13} /> Recorded: <strong>{r.clinician.action}</strong>
            {r.clinician.said && <> — your call: {r.clinician.said}</>} · {r.clinician.t.toLocaleTimeString()} · written to audit log</p>
        )}
      </div>
    </section>
  );
}

/* ════════════════ Disagree flow — the calibration dataset ════════════════ */
function DisagreeModal({ r, onSave, onCancel }) {
  const [said, setSaid] = useState("review");
  const [why, setWhy] = useState("");
  return (
    <div className="modalwrap" role="dialog" aria-modal="true" aria-label="Record disagreement">
      <div className="modal">
        <h2>Record disagreement · <span className="mono">{r.caseId}</span></h2>
        <p className="dim">This becomes part of the calibration dataset. The aggregate comes back to you monthly.</p>
        <div className="modalgrid">
          <div>
            <span className="dlabel">The model said</span>
            <div className="modelbox"><Chip decision={r.decision} /><p className="dim">“{r.reason}”</p></div>
          </div>
          <div>
            <label className="dlabel" htmlFor="yousaid">Your assessment</label>
            <select id="yousaid" value={said} onChange={(e) => setSaid(e.target.value)}>
              <option value="cleared">Cleared — no pathology of concern</option>
              <option value="review">Needs review — genuine finding</option>
              <option value="rescan">Capture problem — rescan</option>
              <option value="refer">Refer to ophthalmology</option>
            </select>
            <label className="dlabel" htmlFor="why">Why (optional)</label>
            <textarea id="why" rows={3} value={why} onChange={(e) => setWhy(e.target.value)}
              placeholder="e.g. drusen at the flagged region look benign; uncertainty overstated" />
          </div>
        </div>
        <div className="modalbtns">
          <button className="ghostbtn" onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={() => onSave(said, why)}>Save disagreement</button>
        </div>
      </div>
    </div>
  );
}

/* ════════════════ Audit log (admin) ════════════════ */
function AuditPanel({ audit, onClose }) {
  return (
    <aside className="auditpanel" aria-label="Immutable audit log">
      <div className="audithead">
        <h2>Audit log</h2>
        <button className="ghostbtn" onClick={onClose}>Close</button>
      </div>
      <p className="dim">Append-only: who, what case, what action, when.</p>
      <ul>
        {audit.length === 0 && <li className="dim">No events yet — actions appear here as they happen.</li>}
        {audit.map((e, i) => (
          <li key={i} className="auditrow mono">
            <span>{e.t.toLocaleTimeString()}</span>
            <span className="arole">{e.role}</span>
            <span>{e.caseId}</span>
            <span className="aaction">{e.action}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

/* ════════════════ styles ════════════════ */
function StyleBlock() {
  return (
    <style>{`
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
:root{
  --paper:#EDF1F4; --surface:#FFFFFF; --ink:#13222E; --dim:#5A6B77; --line:#D3DCE2;
  --blue:#1A5FC8; --blue-ink:#0F3E86; --blue-soft:#E3ECFA;
  --orange:#C25200; --orange-ink:#8F3D00; --orange-soft:#FBEADB;
  --amber:#8F6400; --amber-soft:#F7EFD8;
  --dark:#0A0F14; --ok:#1A6B3C; --warn:#A14400;
  --radius:10px;
}
*{box-sizing:border-box}
.app{min-height:100vh;background:var(--paper);color:var(--ink);
  font:16px/1.55 'IBM Plex Sans',system-ui,sans-serif;display:flex;flex-direction:column;padding-bottom:64px}
.mono{font-family:'IBM Plex Mono',monospace}
button{font:inherit;cursor:pointer}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,[tabindex]:focus-visible{
  outline:3px solid var(--blue);outline-offset:2px;border-radius:4px}
.dim{color:var(--dim)} .ok{color:var(--ok);display:inline-flex;gap:5px;align-items:center}
.warn{color:var(--warn);display:inline-flex;gap:5px;align-items:center;font-weight:600}
.warn-ink{color:var(--warn)}

.mockbar{background:repeating-linear-gradient(-45deg,#2B3A46,#2B3A46 14px,#37474F 14px,#37474F 28px);
  color:#F4D06F;text-align:center;font:600 13px/1 'IBM Plex Mono',monospace;letter-spacing:.08em;padding:8px 12px;text-transform:uppercase}

.hdr{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;
  padding:14px 28px;background:var(--surface);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:baseline;gap:12px;color:var(--ink)}
.brand-mark{color:var(--orange);position:relative;top:2px}
.brand-name{font:800 22px 'Archivo',sans-serif;letter-spacing:-0.02em}
.brand-tag{font-size:13px;color:var(--dim);font-style:italic}
.hdr-right{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.rolewrap{display:flex;align-items:center;gap:8px;font-size:13px}
.rolelabel{color:var(--dim)}
select,textarea{border:1.5px solid var(--line);border-radius:8px;padding:8px 10px;background:var(--surface);font:inherit;font-size:14px;color:var(--ink)}

.main{flex:1;width:100%;max-width:1060px;margin:0 auto;padding:28px 24px}
.screen.center{display:flex;justify-content:center;align-items:center;min-height:60vh}

.eyebrow{font:600 12px 'IBM Plex Mono',monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--blue-ink);margin:0 0 10px}
.hero h1{font:700 clamp(26px,4vw,40px)/1.12 'Archivo',sans-serif;letter-spacing:-0.02em;margin:0 0 12px}
.hero.small h1{font-size:clamp(22px,3vw,30px)}
.lede{max-width:64ch;color:var(--dim);margin:0 0 8px}
.heronum{color:var(--blue);font-size:1.25em}

.dropzone{margin-top:22px;background:var(--surface);border:2px dashed var(--line);border-radius:14px;
  padding:38px 24px;text-align:center;color:var(--ink)}
.dropzone p{margin:10px 0 4px}
.dz-actions{display:flex;gap:10px;justify-content:center;margin-top:18px;flex-wrap:wrap}
.primary{background:var(--blue);color:#fff;border:none;border-radius:9px;padding:10px 18px;font-weight:600}
.primary:hover{background:var(--blue-ink)}
.primary:disabled{background:#9FB2C4;cursor:not-allowed}
.primary.big{padding:13px 26px;font-size:17px}
.ghostbtn{background:transparent;border:1.5px solid var(--line);border-radius:9px;padding:9px 14px;color:var(--ink);display:inline-flex;gap:6px;align-items:center}
.ghostbtn:hover{border-color:var(--ink)}
.outline{background:var(--surface);border:1.8px solid var(--ink);border-radius:9px;padding:10px 18px;font-weight:600;color:var(--ink)}
.outline:hover{background:var(--ink);color:#fff}
.outline:disabled,.primary:disabled{opacity:.55;cursor:not-allowed}
.outline:disabled:hover{background:var(--surface);color:var(--ink)}

.privacycard{margin-top:20px;background:var(--surface);border:1px solid var(--line);border-left:5px solid var(--blue);
  border-radius:var(--radius);padding:16px 20px}
.privacycard h3{margin:0 0 6px;display:flex;gap:8px;align-items:center;font:600 16px 'Archivo',sans-serif}
.privacycard p{margin:0;color:var(--dim);font-size:15px}

.filelist{list-style:none;margin:20px 0 0;padding:0;display:flex;flex-direction:column;gap:10px}
.filerow{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:12px 16px;
  display:grid;grid-template-columns:1fr;gap:8px}
.filemeta{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.fname{font-size:13.5px;font-weight:500}
.caseid{font-size:12.5px;color:var(--dim);border:1px solid var(--line);border-radius:6px;padding:1px 7px}
.caseid.big{font-size:17px;font-weight:600;color:var(--ink)}
.latbadge{font:600 11.5px 'IBM Plex Mono',monospace;background:var(--ink);color:#fff;border-radius:5px;padding:2px 7px}
.fprog{height:7px;background:var(--paper);border-radius:99px;overflow:hidden}
.fprog.big{height:10px;max-width:420px;margin:18px auto}
.fprog-fill{height:100%;background:linear-gradient(90deg,var(--blue),#4E8BE0);border-radius:99px;transition:width .12s}
.fstate{font-size:13.5px}

.runbar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-top:22px;flex-wrap:wrap}

.triagecard{text-align:center;max-width:480px}
.bignum{font-size:64px;font-weight:600;margin:6px 0 0}
.of{font-size:22px;color:var(--dim)}
.passline{font:500 15px 'IBM Plex Mono',monospace;color:var(--orange-ink);margin:4px 0 0}
.nowfile{font-size:13px;margin-top:12px;word-break:break-all}
.smallnote{font-size:14px;margin-top:18px}

.counters{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:22px 0}
.counter{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px;
  display:flex;flex-direction:column;gap:6px}
.cnum{font-size:34px;font-weight:600;line-height:1}
.clabel{font-size:13px;color:var(--dim)}
.c-cleared{border-top:4px solid var(--blue)} .c-rescan{border-top:4px solid var(--amber)} .c-review{border-top:4px solid var(--orange)}

.chip{display:inline-flex;align-items:center;gap:5px;font:600 12.5px 'IBM Plex Sans',sans-serif;
  border-radius:99px;padding:3px 10px;white-space:nowrap}
.chip-cleared{background:var(--blue-soft);color:var(--blue-ink);border:1.5px solid var(--blue)}
.chip-rescan{background:var(--amber-soft);color:var(--amber);border:1.5px dashed var(--amber)}
.chip-review{background:var(--orange);color:#fff;border:1.5px solid var(--orange-ink)}

.worklist{background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.wl-head,.wl-row{display:grid;grid-template-columns:110px 52px 150px 130px 110px 1fr;gap:12px;align-items:center;padding:10px 18px}
.wl-head{font:600 11.5px 'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);border-bottom:1px solid var(--line)}
.worklist ul{list-style:none;margin:0;padding:0}
.wl-row{width:100%;text-align:left;background:none;border:none;border-bottom:1px solid var(--line);font-size:14px;color:var(--ink)}
.wl-row:hover{background:var(--blue-soft)}
.wl-row.signed{background:#F2F6F3}
.confcell{display:flex;gap:8px;align-items:center}
.confbar{flex:1;height:6px;background:var(--paper);border-radius:99px;overflow:hidden;min-width:56px;display:inline-block}
.confbar span{display:block;height:100%;background:var(--ink);border-radius:99px}
.shapecell{display:inline-flex;gap:6px;align-items:center;font-size:13px}
.s-low{color:var(--blue-ink)} .s-focal{color:var(--orange)} .s-diffuse{color:var(--amber)}
.shapename{font-family:'IBM Plex Mono',monospace;font-size:12px}
.nextcell{font-size:13px}
.signedtag{color:var(--ok);display:inline-flex;gap:4px;align-items:center;font-weight:600}
.wl-note{padding:10px 18px;margin:0;font-size:13px}

.revtop{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.revid{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.reasonbar{display:flex;gap:14px;align-items:center;background:var(--surface);border:1px solid var(--line);
  border-left:5px solid var(--orange);border-radius:var(--radius);padding:12px 18px;margin-bottom:16px;flex-wrap:wrap;color:var(--ink)}
.reasonbar p{margin:0;font-size:16.5px;font-weight:500;flex:1;min-width:220px}
.confpill{background:var(--ink);color:#fff;border-radius:99px;padding:4px 12px;font-size:13px}

.viewer{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:860px){.viewer{grid-template-columns:1fr}
  .wl-head{display:none}.wl-row{grid-template-columns:1fr 1fr;gap:6px}}
.panel{margin:0;background:var(--dark);border-radius:12px;overflow:hidden;border:1px solid #22303B}
.panelimg{position:relative;aspect-ratio:16/9;overflow:hidden}
.panelinner{position:absolute;inset:0}
.panelinner img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;user-select:none}
.panel figcaption{color:#B9C6D0;font:500 12.5px 'IBM Plex Mono',monospace;padding:8px 14px;border-top:1px solid #22303B}

.viewctl{display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin:14px 0 20px;font-size:14px}
.ctl{display:inline-flex;gap:8px;align-items:center}
.ctl.slider input[type=range]{width:150px;accent-color:var(--orange)}
.ctl input[type=checkbox]{width:17px;height:17px;accent-color:var(--blue)}

.datarow{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:20px}
.datum{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:13px 16px}
.datum.wide{grid-column:span 2}
@media(max-width:700px){.datum.wide{grid-column:span 1}}
.dlabel{display:block;font:600 11.5px 'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin-bottom:5px}
.dval{font-size:16.5px}
.pm{color:var(--orange-ink);font-weight:600}

.actions{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px 20px}
.gatenote{margin:0 0 12px;color:var(--dim);font-size:14px;display:flex;gap:7px;align-items:center}
.actionbtns{display:flex;gap:10px;flex-wrap:wrap}
.signednote{margin:12px 0 0;font-size:14px}

.modalwrap,.lock{position:fixed;inset:0;background:rgba(10,15,20,.55);display:flex;justify-content:center;align-items:center;padding:20px;z-index:50}
.modal{background:var(--surface);border-radius:14px;max-width:640px;width:100%;padding:24px 26px}
.modal h2{margin:0 0 4px;font:700 20px 'Archivo',sans-serif}
.modalgrid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:16px 0}
@media(max-width:640px){.modalgrid{grid-template-columns:1fr}}
.modelbox{background:var(--paper);border-radius:9px;padding:12px}
.modelbox p{margin:8px 0 0;font-size:14px}
.modal select,.modal textarea{width:100%;margin-bottom:12px}
.modalbtns{display:flex;justify-content:flex-end;gap:10px}

.lock{backdrop-filter:blur(7px)}
.lockcard{background:var(--surface);border-radius:14px;padding:34px 40px;text-align:center;max-width:380px}
.lockcard h2{font:700 22px 'Archivo',sans-serif;margin:12px 0 6px}
.lockcard p{color:var(--dim);margin:0 0 18px}

.auditpanel{position:fixed;top:0;right:0;bottom:56px;width:min(430px,92vw);background:var(--surface);
  border-left:1px solid var(--line);padding:20px;overflow-y:auto;z-index:40;box-shadow:-8px 0 30px rgba(10,20,30,.12)}
.audithead{display:flex;justify-content:space-between;align-items:center}
.audithead h2{font:700 19px 'Archivo',sans-serif;margin:0}
.auditpanel ul{list-style:none;padding:0;margin:14px 0 0}
.auditrow{display:grid;grid-template-columns:74px 70px 84px 1fr;gap:8px;font-size:12px;padding:7px 0;border-bottom:1px solid var(--line)}
.arole{color:var(--blue-ink)} .aaction{color:var(--ink)}

.disclaimer{position:fixed;left:0;right:0;bottom:0;background:var(--ink);color:#E8EEF2;
  display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap;
  padding:10px 16px;font-size:13px;z-index:45;text-align:center}
.disclaimer strong{color:#fff}

@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`}</style>
  );
}
