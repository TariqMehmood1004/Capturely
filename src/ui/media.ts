// Pictures and sounds a take refers to, as URLs the editor's page can show or play: the take's
// own files ("media:<name>"), the built-in wallpapers ("builtin:<id>") and pictures from the
// Wallpapers folder ("wallpaper:<name>"). Also turns an SVG (a shape) into PNG bytes.
import { platform } from "../platform";

const BUILTIN = import.meta.glob<string>("../assets/wallpapers/*.jpg", { eager: true, query: "?url", import: "default" });

export const builtinUrl = (id: string): string => BUILTIN[`../assets/wallpapers/${id}.jpg`] ?? "";

const sepOf = (p: string) => (p.includes("\\") ? "\\" : "/");
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** The file behind a reference, or "" when it cannot be shown. */
export function refPath(ref: string, take: string, wallpapers: string | null): string {
  const [kind, name] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
  const sep = sepOf(take);
  if (kind === "media") return `${take}${sep}media${sep}${name}`;
  if (kind === "wallpaper" && wallpapers) return `${wallpapers}${sepOf(wallpapers)}${name}`;
  return "";
}

export function refUrl(ref: string, take: string, wallpapers: string | null): string {
  if (ref.startsWith("builtin:")) return builtinUrl(ref.slice(8));
  const p = refPath(ref, take, wallpapers);
  return p ? platform.mediaUrl(p) : "";
}

/** A wallpaper file's reference. */
export const wallpaperRef = (path: string): string => `wallpaper:${fileName(path)}`;

/** Draw an SVG picture to PNG bytes at its own size. */
export async function svgToPng(svg: string, w: number, h: number): Promise<Uint8Array> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (!g) throw new Error("Could not draw the shape.");
  g.drawImage(img, 0, 0, w, h);
  const blob = await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not draw the shape."))), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}
