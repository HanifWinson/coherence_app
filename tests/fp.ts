import fs from "fs"; import { deidentify } from "../src/lib/deidentify";
(async () => {
  const dir="./tests/fixtures/bulk";
  const files=fs.readdirSync(dir);
  let fp=0,cleanN=0,tp=0,burnN=0;
  for(const f of files){
    const b=fs.readFileSync(`${dir}/${f}`);
    const r=await deidentify(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
    if(f.startsWith("clean")){cleanN++; if(r.burnedInText.detected)fp++;}
    else {burnN++; if(r.burnedInText.detected)tp++;}
  }
  console.log(`clean scans      : ${cleanN}, false positives ${fp}  (${(100*fp/cleanN).toFixed(1)}%)`);
  console.log(`burned-in scans  : ${burnN}, detected ${tp}         (${(100*tp/burnN).toFixed(1)}% recall)`);
  console.log(fp===0&&tp===burnN ? "\nPERFECT separation" :
    (tp/burnN>=0.95 && fp/cleanN<=0.05 ? "\nacceptable" : "\nNEEDS WORK"));
})();
