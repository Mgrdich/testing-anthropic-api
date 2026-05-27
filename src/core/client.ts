import Anthropic from "@anthropic-ai/sdk";

export type InitOptions = {
  apiKey?: string;
};

export class AnthropicClient {
  private static instance: Anthropic | null = null;

  private constructor() {}

  static init(opts: InitOptions = {}): Anthropic {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Add it to .env or export it.",
      );
    }
    AnthropicClient.instance = new Anthropic({ apiKey });
    return AnthropicClient.instance;
  }

  static get(): Anthropic {
    return AnthropicClient.instance ?? AnthropicClient.init();
  }

  static reset(): void {
    AnthropicClient.instance = null;
  }
}
