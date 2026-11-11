import { createHash } from "node:crypto";
import sharp from "sharp";

export interface EncodedImage { data: string; mime: string }

/** Per-plugin, byte-bounded cache. Originals are never written to disk. */
export class ImageOptimizer {
  private cache = new Map<string, EncodedImage>();
  private bytes = 0;

  clear() { this.cache.clear(); this.bytes = 0; }

  async optimize(image: EncodedImage, emergency = false, edge?: number): Promise<EncodedImage> {
    const key = createHash("sha256").update(image.mime).update(image.data).update(`${emergency}:${edge ?? "default"}`).digest("hex");
    const cached = this.cache.get(key);
    if (cached) return cached;
    let result = image;
    try {
      const input = Buffer.from(image.data, "base64");
      const metadata = await sharp(input, { limitInputPixels: 40_000_000 }).metadata();
      // Don't silently flatten animated images or change unsupported formats.
      if (!metadata.width || !metadata.height || (metadata.pages ?? 1) > 1 ||
          !["jpeg", "png", "webp"].includes(metadata.format ?? "")) return image;
      const pixels = metadata.width * metadata.height;
      const maxEdge = edge ?? (emergency ? 1280 : 2560);
      const resize = Math.max(metadata.width, metadata.height) > maxEdge;
      if (!emergency && !resize && input.length * 8 / pixels <= 2) return image;
      const pipeline = () => {
        const value = sharp(input, { limitInputPixels: 40_000_000 }).rotate();
        return resize ? value.resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true }) : value;
      };
      // PNG often wins for flat UI screenshots; JPEG is only an alternative for
      // opaque images. 4:4:4 avoids chroma subsampling damage to colored text.
      const candidates: Array<{ buffer: Buffer; mime: string }> = [];
      if (metadata.format === "png" || metadata.hasAlpha) {
        candidates.push({ buffer: await pipeline().png({ compressionLevel: 9 }).toBuffer(), mime: "image/png" });
      }
      if (!metadata.hasAlpha) {
        candidates.push({ buffer: await pipeline().jpeg({ quality: emergency ? 75 : 88, chromaSubsampling: "4:4:4" }).toBuffer(), mime: "image/jpeg" });
      }
      if (metadata.format === "webp") {
        candidates.push({ buffer: await pipeline().webp({ quality: emergency ? 75 : 88 }).toBuffer(), mime: "image/webp" });
      }
      const best = candidates.sort((a, b) => a.buffer.length - b.buffer.length)[0];
      if (best && best.buffer.length <= input.length * 0.85) {
        result = { data: best.buffer.toString("base64"), mime: best.mime };
      }
    } catch {
      // A malformed/unsupported image should not break an otherwise valid turn.
    }
    const size = result.data.length;
    if (size <= 16_000_000) {
      while (this.bytes + size > 32_000_000 && this.cache.size) {
        const first = this.cache.keys().next().value!;
        this.bytes -= this.cache.get(first)!.data.length;
        this.cache.delete(first);
      }
      this.cache.set(key, result);
      this.bytes += size;
    }
    return result;
  }
}
