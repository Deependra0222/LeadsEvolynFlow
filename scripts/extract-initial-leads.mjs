import { mkdir, readFile, writeFile } from "node:fs/promises";

const sourceUrl = new URL("../index.html", import.meta.url);
const outputUrl = new URL("../netlify/data/initial-leads.json", import.meta.url);
const html = await readFile(sourceUrl, "utf8");
const match = html.match(/const leads = (\[[\s\S]*?\]);\s*\n\s*const STATUS_OPTIONS/);

if (!match) throw new Error("Could not locate the embedded lead array.");
const leads = JSON.parse(match[1]);
if (leads.length !== 722) throw new Error(`Expected 722 leads, found ${leads.length}.`);
for (let index = 0; index < leads.length; index += 1) {
  if (leads[index].sno !== index + 1) {
    throw new Error(`Expected serial ${index + 1}, found ${leads[index].sno}.`);
  }
}

await mkdir(new URL("../netlify/data/", import.meta.url), { recursive: true });
await writeFile(outputUrl, `${JSON.stringify(leads, null, 2)}\n`, "utf8");
console.log(`Extracted ${leads.length} leads to ${outputUrl.pathname}`);
