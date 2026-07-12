// Packs assets/ico-{16,32,48,256}.png into assets/AppIcon.ico (PNG-compressed entries).
// Usage: deno run --allow-read --allow-write scripts/build-ico.ts

const sizes = [16, 32, 48, 256];
const dir = new URL("../assets/", import.meta.url);

const pngs = await Promise.all(
  sizes.map((s) => Deno.readFile(new URL(`ico-${s}.png`, dir))),
);

const HEADER = 6;
const ENTRY = 16;
let offset = HEADER + ENTRY * sizes.length;
const total = offset + pngs.reduce((a, p) => a + p.length, 0);
const out = new Uint8Array(total);
const view = new DataView(out.buffer);

view.setUint16(0, 0, true); // reserved
view.setUint16(2, 1, true); // type: icon
view.setUint16(4, sizes.length, true);

sizes.forEach((s, i) => {
  const e = HEADER + i * ENTRY;
  out[e] = s === 256 ? 0 : s; // width (0 = 256)
  out[e + 1] = s === 256 ? 0 : s; // height
  out[e + 2] = 0; // palette
  out[e + 3] = 0; // reserved
  view.setUint16(e + 4, 1, true); // planes
  view.setUint16(e + 6, 32, true); // bpp
  view.setUint32(e + 8, pngs[i].length, true);
  view.setUint32(e + 12, offset, true);
  out.set(pngs[i], offset);
  offset += pngs[i].length;
});

await Deno.writeFile(new URL("AppIcon.ico", dir), out);
console.log(`AppIcon.ico written (${total} bytes)`);
