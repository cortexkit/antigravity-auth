import type { ProviderModel } from "../types";

export type ModelThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface ModelThinkingConfig {
  thinkingBudget: number;
}

export interface ModelVariant {
  thinkingLevel?: ModelThinkingLevel;
  thinkingConfig?: ModelThinkingConfig;
}

export interface ModelLimit {
  context: number;
  output: number;
}

export type ModelModality = "text" | "image" | "pdf";

export interface ModelModalities {
  input: ModelModality[];
  output: ModelModality[];
}

export interface OpencodeModelDefinition extends ProviderModel {
  id: string;
  name: string;
  release_date: string;
  attachment: boolean;
  reasoning: boolean;
  temperature: boolean;
  tool_call: boolean;
  limit: ModelLimit;
  modalities: ModelModalities;
  variants?: Record<string, ModelVariant>;
}

export type OpencodeModelDefinitions = Record<string, OpencodeModelDefinition>;

interface OpencodeModelDefinitionInput {
  name: string;
  reasoning: boolean;
  limit: ModelLimit;
  modalities: ModelModalities;
  variants?: Record<string, ModelVariant>;
}

const DEFAULT_MODALITIES: ModelModalities = {
  input: ["text", "image", "pdf"],
  output: ["text"],
};

const MODEL_RELEASE_DATE = "";

function defineModel(
  id: string,
  model: OpencodeModelDefinitionInput
): OpencodeModelDefinition {
  return {
    id,
    release_date: MODEL_RELEASE_DATE,
    attachment: model.modalities.input.some((modality) => modality !== "text"),
    temperature: true,
    tool_call: true,
    ...model,
  };
}

export const OPENCODE_MODEL_DEFINITIONS: OpencodeModelDefinitions = {
  "antigravity-gemini-3.1-pro": defineModel("antigravity-gemini-3.1-pro", {
    name: "Gemini 3.1 Pro (Antigravity)",
    reasoning: true,
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: "low" },
      high: { thinkingLevel: "high" },
    },
  }),
  "antigravity-gemini-3.5-flash": defineModel("antigravity-gemini-3.5-flash", {
    name: "Gemini 3.5 Flash (Antigravity)",
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: "low" },
      high: { thinkingLevel: "high" },
    },
  }),  "antigravity-claude-sonnet-4-6-thinking": defineModel("antigravity-claude-sonnet-4-6-thinking", {
    name: "Claude Sonnet 4.6 Thinking (Antigravity)",
    reasoning: true,
    limit: { context: 200000, output: 64000 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingConfig: { thinkingBudget: 8192 } },
      max: { thinkingConfig: { thinkingBudget: 32768 } },
    },
  }),
  "antigravity-claude-opus-4-6-thinking": defineModel("antigravity-claude-opus-4-6-thinking", {
    name: "Claude Opus 4.6 Thinking (Antigravity)",
    reasoning: true,
    limit: { context: 200000, output: 64000 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingConfig: { thinkingBudget: 8192 } },
      max: { thinkingConfig: { thinkingBudget: 32768 } },
    },
  }),
  "antigravity-gemini-3.1-flash-image": defineModel("antigravity-gemini-3.1-flash-image", {
    name: "Gemini 3.1 Flash Image (Antigravity)",
    reasoning: false,
    limit: { context: 66000, output: 33000 },
    modalities: {
      input: ["text", "image"],
      output: ["text", "image"],
    },
  }),
  "antigravity-gpt-oss-120b": defineModel("antigravity-gpt-oss-120b", {
    name: "GPT-OSS 120B (Antigravity)",
    reasoning: false,
    limit: { context: 128000, output: 16384 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      medium: {},
    },
  }),
  "gemini-2.5-flash": defineModel("gemini-2.5-flash", {
    name: "Gemini 2.5 Flash (Gemini CLI)",
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  }),
  "gemini-2.5-pro": defineModel("gemini-2.5-pro", {
    name: "Gemini 2.5 Pro (Gemini CLI)",
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  }),
  "gemini-3-flash-preview": defineModel("gemini-3-flash-preview", {
    name: "Gemini 3 Flash Preview (Gemini CLI)",
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  }),
  "gemini-3-pro-preview": defineModel("gemini-3-pro-preview", {
    name: "Gemini 3 Pro Preview (Gemini CLI)",
    reasoning: true,
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
  }),
  "gemini-3.1-pro-preview": defineModel("gemini-3.1-pro-preview", {
    name: "Gemini 3.1 Pro Preview (Gemini CLI)",
    reasoning: true,
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
  }),
  "gemini-3.1-flash-image-preview": defineModel("gemini-3.1-flash-image-preview", {
    name: "Gemini 3.1 Flash Image Preview (Gemini CLI)",
    reasoning: false,
    limit: { context: 66000, output: 33000 },
    modalities: {
      input: ["text", "image"],
      output: ["text", "image"],
    },
  }),
  "gemini-3.1-pro-preview-customtools": defineModel("gemini-3.1-pro-preview-customtools", {
    name: "Gemini 3.1 Pro Preview Custom Tools (Gemini CLI)",
    reasoning: true,
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
  }),
};
