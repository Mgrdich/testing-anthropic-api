import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { l2Normalize } from "@/rag/math.ts";

const EMBED_DIM = 384;

export class Embedder {
  private static instance: Embedder | null = null;
  private pipeline: FeatureExtractionPipeline | null = null;
  private readonly modelId = "Xenova/all-MiniLM-L6-v2";
  readonly dim = EMBED_DIM;

  private constructor() {}

  static get(): Embedder {
    if (!Embedder.instance) Embedder.instance = new Embedder();
    return Embedder.instance;
  }

  async ensureReady(): Promise<void> {
    if (this.pipeline) return;
    process.stderr.write(
      `[embedder] loading ${this.modelId} (cached to ~/.cache/huggingface; ~25MB on first run)\n`,
    );
    const { pipeline } = await import("@huggingface/transformers");
    this.pipeline = await pipeline("feature-extraction", this.modelId);
  }

  async embed(text: string): Promise<Float32Array> {
    await this.ensureReady();
    if (!this.pipeline) throw new Error("embedder pipeline not initialized");
    const out = await this.pipeline(text, { pooling: "mean", normalize: true });
    const data = out.data as Float32Array;
    return l2Normalize(new Float32Array(data));
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.ensureReady();
    if (!this.pipeline) throw new Error("embedder pipeline not initialized");
    const out = await this.pipeline(texts, { pooling: "mean", normalize: true });
    const flat = out.data as Float32Array;
    const n = texts.length;
    const dim = flat.length / n;
    if (!Number.isInteger(dim) || dim !== EMBED_DIM) {
      throw new Error(
        `embedder returned unexpected shape: data.length=${flat.length} for ${n} inputs`,
      );
    }
    const result: Float32Array[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const slice = flat.subarray(i * dim, (i + 1) * dim);
      result[i] = l2Normalize(new Float32Array(slice));
    }
    return result;
  }
}
