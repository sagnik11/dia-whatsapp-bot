import { describe, expect, it } from "vitest";
import { createAzureOpenAIClient } from "../src/azure-openai.js";

describe("createAzureOpenAIClient", () => {
  it("targets the direct Azure OpenAI v1 endpoint with the Azure key", () => {
    const client = createAzureOpenAIClient({
      apiKey: "azure-resource-key",
      baseUrl: "https://resource.openai.azure.com/openai/v1/",
    });

    expect(client.baseURL).toBe(
      "https://resource.openai.azure.com/openai/v1/",
    );
    expect(client.apiKey).toBe("azure-resource-key");
  });
});
