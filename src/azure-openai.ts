import OpenAI from "openai";

export interface AzureOpenAIClientOptions {
  apiKey: string;
  baseUrl: string;
}

/** Create an OpenAI Responses client pointed directly at Azure's v1 route. */
export function createAzureOpenAIClient(
  options: AzureOpenAIClientOptions,
): OpenAI {
  return new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
  });
}
