import fs from "fs";
import { deidentify, STRIP_TAGS } from "../src/lib/deidentify";
import dcmjs from "dcmjs";

const FIX = "./tests/fixtures";
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  cond ? pass++ : fail++;
};

(async () => {
  for (const f of ["clean_od", "clean_os", "burned_in", "annotated"]) {
    const buf = fs.readFileSync(`${FIX}/${f}.dcm`);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    console.log(`\n=== ${f}.dcm ===`);
    const r = await deidentify(ab);

    console.log(`  caseId=${r.caseId} lat=${r.laterality} age=${r.ageYears} ` +
                `masked=${r.masked} burnedIn=${r.burnedInText.detected}(${r.burnedInText.source}) ` +
                `bands=[${r.burnedInText.bands}]`);
    console.log(`  stripped ${r.strippedTags.length}: ${r.strippedTags.slice(0,4).join(", ")}...`);
    if (r.warnings.length) r.warnings.forEach(w => console.log(`  ! ${w}`));

    check("all 11 brief tags stripped", r.strippedTags.length >= 11);
    check("laterality preserved", r.laterality === "OD" || r.laterality === "OS", r.laterality);
    check("age derived, DOB gone", typeof r.ageYears === "number");
    check("pixels decoded", !!r.pixels && r.pixels.width > 0);
    check("re-serialised to blob", !!r.blob);

    // --- the real test: re-parse the OUTPUT and hunt for identifiers ---
    if (r.blob) {
      const outBuf = Buffer.from(await r.blob.arrayBuffer());
      const out = dcmjs.data.DicomMessage.readFile(
        outBuf.buffer.slice(outBuf.byteOffset, outBuf.byteOffset + outBuf.byteLength));
      const nat: any = dcmjs.data.DicomMetaDictionary.naturalizeDataset(out.dict);
      const leaked = Object.entries(STRIP_TAGS).filter(([t]) => t !== "00100020")
        .filter(([t]) => out.dict[t] !== undefined);
      check("output has NO identifying tags (PatientID checked by value)", leaked.length === 0,
            leaked.length ? leaked.map(x => x[1]).join(",") : "");
      check("output keeps Laterality", !!nat.Laterality, String(nat.Laterality));
      check("output keeps PixelSpacing", !!nat.PixelSpacing);
      check("PatientID replaced with case ID", nat.PatientID === r.caseId, String(nat.PatientID));

      // raw byte scan: no name string anywhere in the file
      const names = ["RAMAN", "NGUYEN", "OKAFOR", "SMITH", "Westmead", "SPEC-77341", "9845"];
      const txt = outBuf.toString("latin1");
      const found = names.filter(n => txt.includes(n));
      check("no identifier strings in raw bytes", found.length === 0, found.join(","));
    }

    if (f === "burned_in")
      check("burned-in text caught WITHOUT the tag", r.burnedInText.source === "pixels" && r.masked);
    if (f === "annotated")
      check("burned-in text caught via tag", r.burnedInText.detected && r.masked);
    if (f.startsWith("clean"))
      check("no false positive on clean scan", !r.burnedInText.detected);
    check("result flagged ok", r.ok === true);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
