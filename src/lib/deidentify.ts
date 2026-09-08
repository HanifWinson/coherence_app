/**
 * Coherence — client-side DICOM de-identification.
 *
 * Step 1 of the build brief: nothing else matters if this is wrong.
 *
 * Everything here runs in the browser. Identifiable data is removed before a
 * single byte is uploaded, so the practice keeps the patient mapping and we
 * never receive it. That is the whole privacy claim, and this file is what
 * makes it true rather than decorative.
 *
 * Two threats are handled separately:
 *   1. Identifiers in METADATA  -> delete the tags.
 *   2. Identifiers in PIXELS    -> some OCT exports render the patient's name
 *      into the image itself. The BurnedInAnnotation tag is meant to declare
 *      this, but it is frequently absent or wrong, so we also detect text
 *      regions in the top and bottom bands directly.
 */

import dcmjs from "dcmjs";

/* ─── tags removed, per the build brief ─────────────────────────────── */
export const STRIP_TAGS: Record<string, string> = {
  "00100010": "PatientName",
  "00100020": "PatientID",
  "00100030": "PatientBirthDate",
  "00100040": "PatientSex",
  "00080050": "AccessionNumber",
  "00080080": "InstitutionName",
  "00080090": "ReferringPhysicianName",
  "00081070": "OperatorsName",
  "00181000": "DeviceSerialNumber",
  "00101000": "OtherPatientIDs",
  "00102154": "PatientTelephoneNumbers",
};

/* Identifiers not in the brief's list that also must not survive. The brief
   says "keep only pixel data, laterality, pixel spacing, acquisition
   parameters", so anything identifying outside the keep-list goes. */
export const EXTRA_STRIP_TAGS: Record<string, string> = {
  "00101040": "PatientAddress",
  "00102180": "Occupation",
  "00081048": "PhysiciansOfRecord",
  "00081050": "PerformingPhysicianName",
  "00081090": "ManufacturerModelName_ifSerialised",
  "00080081": "InstitutionAddress",
  "00081040": "InstitutionalDepartmentName",
  "00200010": "StudyID",
  "00080090x": "unused",
};

/* Explicitly preserved — clinical content the model needs. */
export const KEEP_TAGS = [
  "00200060", // Laterality
  "00280030", // PixelSpacing
  "00180050", // SliceThickness
  "00080060", // Modality
  "00280010", // Rows
  "00280011", // Columns
  "00280100", // BitsAllocated
  "7FE00010", // PixelData
];

export interface DeidResult {
  ok: boolean;
  caseId: string;
  laterality: "OD" | "OS" | "unknown";
  ageYears: number | null;
  strippedTags: string[];
  burnedInText: { detected: boolean; source: "tag" | "pixels" | null; bands: string[] };
  masked: boolean;
  pixels: { width: number; height: number; data: Float32Array } | null;
  blob: Blob | null;
  warnings: string[];
}

/* ─── random case ID, generated here; the clinic keeps the mapping ──── */
export function newCaseId(): string {
  const A = "CFGHJKMPQRVWXY", N = "23456789";
  const pick = (s: string, n: number) => {
    const buf = new Uint32Array(n);
    // Web Crypto only. Present in every browser and in Node >= 19 as
    // globalThis.crypto, so no CommonJS require() ends up in the bundle.
    globalThis.crypto.getRandomValues(buf);
    return Array.from(buf, (v) => s[v % s.length]).join("");
  };
  return `${pick(A, 3)}-${pick(N, 4)}`;
}

/* ─── DOB -> age in years, as the brief specifies ──────────────────── */
export function dobToAge(dob?: string, studyDate?: string): number | null {
  if (!dob || dob.length < 8) return null;
  const y = +dob.slice(0, 4), m = +dob.slice(4, 6), d = +dob.slice(6, 8);
  const ref = studyDate && studyDate.length >= 8
    ? new Date(+studyDate.slice(0, 4), +studyDate.slice(4, 6) - 1, +studyDate.slice(6, 8))
    : new Date();
  let age = ref.getFullYear() - y;
  if (ref.getMonth() + 1 < m || (ref.getMonth() + 1 === m && ref.getDate() < d)) age--;
  return age >= 0 && age < 130 ? age : null;
}

/* ─── burned-in text detection ──────────────────────────────────────
 * Rendered text has a signature that retinal tissue does not: in a band that
 * should be near-empty vitreous or background, it produces a small number of
 * pixels at near-maximum intensity, arranged in short horizontal runs with
 * sharp edges. We look for exactly that, and only in the top and bottom
 * bands where OCT vendors place overlays.
 */
export function detectTextBand(
  pixels: Float32Array, width: number, height: number,
  bandFrac = 0.12,
): { top: boolean; bottom: boolean; scores: [number, number] } {
  const bandH = Math.max(8, Math.floor(height * bandFrac));

  const scoreBand = (y0: number, y1: number): number => {
    let hi = 0, total = 0, runs = 0, edges = 0;
    const THRESH = 0.78;                    // text is rendered at/near max
    for (let y = y0; y < y1; y++) {
      let inRun = false, runLen = 0;
      for (let x = 0; x < width; x++) {
        const v = pixels[y * width + x];
        total++;
        const bright = v > THRESH;
        if (bright) hi++;
        if (bright && !inRun) { inRun = true; runLen = 1; }
        else if (bright) runLen++;
        else if (inRun) {
          inRun = false;
          if (runLen >= 1 && runLen <= 14) runs++;   // glyph-width strokes
        }
        if (x > 0) {
          const prev = pixels[y * width + x - 1];
          if (Math.abs(v - prev) > 0.45) edges++;     // hard, aliased edges
        }
      }
    }
    const density = hi / total;
    // text: sparse but present, many short runs, many hard edges.
    // tissue: either near-empty (no runs) or dense and smooth (few edges).
    if (density < 0.0008 || density > 0.30) return 0;
    return (runs / (y1 - y0)) * (edges / total) * 1000;
  };

  const topScore = scoreBand(0, bandH);
  const botScore = scoreBand(height - bandH, height);
  const CUT = 0.55;
  return { top: topScore > CUT, bottom: botScore > CUT, scores: [topScore, botScore] };
}

/* ─── mask the offending bands rather than refusing the file ───────── */
export function maskBands(
  pixels: Float32Array, width: number, height: number,
  top: boolean, bottom: boolean, bandFrac = 0.12,
): Float32Array {
  const out = Float32Array.from(pixels);
  const bandH = Math.max(8, Math.floor(height * bandFrac));
  if (top) out.fill(0, 0, bandH * width);
  if (bottom) out.fill(0, (height - bandH) * width, height * width);
  return out;
}

/* ─── the main entry point ─────────────────────────────────────────── */
export async function deidentify(
  file: File | ArrayBuffer,
  opts: { maskBurnedIn?: boolean } = {},
): Promise<DeidResult> {
  const maskBurnedIn = opts.maskBurnedIn ?? true;
  const warnings: string[] = [];
  const buf = file instanceof ArrayBuffer ? file : await file.arrayBuffer();

  const dicomDict = dcmjs.data.DicomMessage.readFile(buf);
  const dataset: any = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dicomDict.dict);

  /* --- age before we delete the DOB --- */
  const ageYears = dobToAge(dataset.PatientBirthDate, dataset.StudyDate);

  /* --- laterality before stripping; keep it, the brief says so --- */
  const rawLat = String(dataset.Laterality ?? dataset.ImageLaterality ?? "").toUpperCase();
  const laterality: DeidResult["laterality"] =
    rawLat.startsWith("L") || rawLat === "OS" ? "OS"
      : rawLat.startsWith("R") || rawLat === "OD" ? "OD"
        : "unknown";
  if (laterality === "unknown") warnings.push("Laterality absent from DICOM; ask the operator.");

  /* --- decode pixels --- */
  let pixels: DeidResult["pixels"] = null;
  const width = Number(dataset.Columns ?? 0), height = Number(dataset.Rows ?? 0);
  const pdEl = dicomDict.dict["7FE00010"];
  if (pdEl && width && height) {
    const raw = pdEl.Value[0] as ArrayBuffer;
    const bits = Number(dataset.BitsAllocated ?? 16);
    const src: any = bits === 8 ? new Uint8Array(raw) : new Uint16Array(raw);
    const norm = new Float32Array(width * height);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < norm.length; i++) {
      const v = src[i]; if (v < lo) lo = v; if (v > hi) hi = v;
    }
    const span = Math.max(hi - lo, 1);
    for (let i = 0; i < norm.length; i++) norm[i] = (src[i] - lo) / span;
    if (String(dataset.PhotometricInterpretation ?? "") === "MONOCHROME1") {
      for (let i = 0; i < norm.length; i++) norm[i] = 1 - norm[i];   // inverted scale
    }
    pixels = { width, height, data: norm };
  } else {
    warnings.push("No decodable pixel data found.");
  }

  /* --- burned-in text: tag first, then pixels, because the tag lies --- */
  const tagSays = String(dataset.BurnedInAnnotation ?? "").toUpperCase() === "YES";
  let detected = tagSays, source: "tag" | "pixels" | null = tagSays ? "tag" : null;
  const bands: string[] = [];
  let masked = false;

  if (pixels) {
    const t = detectTextBand(pixels.data, width, height);
    if (t.top) bands.push("top");
    if (t.bottom) bands.push("bottom");
    if (t.top || t.bottom) {
      if (!detected) source = "pixels";
      detected = true;
      if (!tagSays) {
        warnings.push(
          "Text found in the image but BurnedInAnnotation was absent or NO — " +
          "the tag cannot be trusted.");
      }
    }
    if (detected && maskBurnedIn) {
      pixels = {
        width, height,
        data: maskBands(pixels.data, width, height, t.top || tagSays, t.bottom || tagSays),
      };
      masked = true;
    }
  } else if (tagSays) {
    warnings.push("BurnedInAnnotation is YES but pixels could not be checked. Refusing.");
  }

  /* --- strip the tags --- */
  const strippedTags: string[] = [];
  for (const [tag, name] of Object.entries({ ...STRIP_TAGS, ...EXTRA_STRIP_TAGS })) {
    if (dicomDict.dict[tag] !== undefined) {
      delete dicomDict.dict[tag];
      strippedTags.push(name);
    }
  }
  // dates are quasi-identifiers; keep the year only
  for (const t of ["00080020", "00080030", "00080021", "00080031"]) {
    if (dicomDict.dict[t]) delete dicomDict.dict[t];
  }
  if (ageYears !== null) {
    dicomDict.dict["00101010"] = { vr: "AS", Value: [`${String(ageYears).padStart(3, "0")}Y`] };
  }

  const caseId = newCaseId();
  dicomDict.dict["00100020"] = { vr: "LO", Value: [caseId] };   // pseudonymous ID

  /* --- if we masked pixels, the written file must carry the masked pixels --- */
  if (masked && pixels && pdEl) {
    const bits = Number(dataset.BitsAllocated ?? 16);
    const max = bits === 8 ? 255 : 4095;
    const out: any = bits === 8
      ? new Uint8Array(width * height) : new Uint16Array(width * height);
    for (let i = 0; i < out.length; i++) out[i] = Math.round(pixels.data[i] * max);
    dicomDict.dict["7FE00010"].Value = [out.buffer];
  }

  let blob: Blob | null = null;
  try {
    blob = new Blob([dicomDict.write()], { type: "application/dicom" });
  } catch (e: any) {
    warnings.push(`Could not re-serialise DICOM: ${e.message}`);
  }

  /* --- verify: nothing identifying survived ---
   * PatientID is excluded from the residual scan because we deliberately
   * re-populate it with the pseudonymous case ID above; it is checked by
   * value instead. Every other identifier must be absent outright. */
  const residual = Object.keys(STRIP_TAGS)
    .filter((t) => t !== "00100020")
    .filter((t) => dicomDict.dict[t] !== undefined);
  const idIsPseudonym = dicomDict.dict["00100020"]?.Value?.[0] === caseId;
  const ok = residual.length === 0 && idIsPseudonym && (!detected || masked);
  if (residual.length) warnings.push(`FAILED to strip: ${residual.join(", ")}`);
  if (!idIsPseudonym) warnings.push("PatientID was not replaced with the case ID.");

  return { ok, caseId, laterality, ageYears, strippedTags,
           burnedInText: { detected, source, bands }, masked, pixels, blob, warnings };
}
