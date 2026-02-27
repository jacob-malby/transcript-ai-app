// lib/zip.ts
import JSZip from "jszip";

export async function makeZip(files: { name: string; data: Buffer }[]) {
  const zip = new JSZip();
  for (const f of files) zip.file(f.name, f.data);
  return zip.generateAsync({ type: "nodebuffer" });
}