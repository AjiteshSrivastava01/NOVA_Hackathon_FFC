// Browser-side image helpers for the camera page and demo controls.

const MAX_SIDE = 1024;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = src;
  });
}

/** Downscale to max 1024px on the long side and re-encode as JPEG. Returns a data URL. */
export async function toJpegDataUrl(src: string, quality = 0.85): Promise<string> {
  const img = await loadImage(src);
  const w0 = img.naturalWidth || 1024;
  const h0 = img.naturalHeight || 768;
  const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const w = Math.round(w0 * scale);
  const h = Math.round(h0 * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff"; // JPEG has no alpha
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

export async function fileToJpegDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    return await toJpegDataUrl(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Strip the "data:image/jpeg;base64," prefix — the API takes raw base64. */
export function stripDataUrl(dataUrl: string): string {
  const i = dataUrl.indexOf(",");
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}
