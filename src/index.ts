import {
  parseOpenAIChatUsage,
  parseOpenAIResponsesUsage,
  toModelList,
  type CredentialsWrite,
  type HttpExchange,
  type JsonGetRequest,
  type JsonPostRequest,
  type ModelList,
  type PluginContext,
  type ProviderConnection,
  type ViatePlugin,
} from "@viateai/sdk";

const PROVIDER_ID = "qwen-cloud-token-plan";
const REGIONS = {
  "china-beijing": "https://token-plan.cn-beijing.maas.aliyuncs.com",
  "global-sg": "https://token-plan.ap-southeast-1.maas.aliyuncs.com",
} as const;

type Region = keyof typeof REGIONS;

const INBOUND_HEADERS: Record<string, true> = {
  "anthropic-beta": true,
  "anthropic-version": true,
  "openai-beta": true,
};
const OUTBOUND_HEADERS: Record<string, true> = {
  "content-type": true,
  "cache-control": true,
};

export type QwenTokenPlanCredentials = {
  apiKey: string;
  region: Region;
  baseUrl?: string;
};

export const plugin: ViatePlugin = {
  id: PROVIDER_ID,
  register(ctx: PluginContext) {
    ctx.registerProvider({
      id: PROVIDER_ID,
      credentialsForm: [
        { key: "apiKey", label: "API key", kind: "secret", required: true },
        { key: "region", label: "Region (china-beijing or global-sg)", kind: "string" },
        { key: "baseUrl", label: "Base URL override", kind: "url" },
      ],
      parseCredentials,
      normalizeCredentials,
      chatCompletions,
      embeddings,
      responses,
      listModels,
      imageGenerations,
      imageEdits,
    });
  },
};

export default plugin;

export function parseCredentials(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("credentials are required");
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as unknown;
  return { apiKey: trimmed };
}

export function normalizeCredentials(input: unknown): CredentialsWrite {
  const record = asRecord(input);
  if (!record) throw new Error("credentials must be an object");
  const apiKey = stringValue(record.apiKey);
  if (!apiKey) throw new Error("apiKey is required");
  const region = normalizeRegion(record.region);
  const baseUrl = optionalBaseUrl(record.baseUrl);
  const credentials: QwenTokenPlanCredentials = {
    apiKey,
    region,
    ...(baseUrl ? { baseUrl } : {}),
  };
  const host = new URL(compatibleBase(credentials)).host;
  return { credentials, displayLabel: `${host} (${region})` };
}

export async function chatCompletions(request: JsonPostRequest, connection: ProviderConnection): Promise<HttpExchange> {
  return jsonRequest("POST", "chat/completions", request, connection, parseOpenAIChatUsage);
}

export async function embeddings(request: JsonPostRequest, connection: ProviderConnection): Promise<HttpExchange> {
  return jsonRequest("POST", "embeddings", request, connection, parseOpenAIChatUsage);
}

export async function responses(request: JsonPostRequest, connection: ProviderConnection): Promise<HttpExchange> {
  return jsonRequest("POST", "responses", request, connection, parseOpenAIResponsesUsage);
}

export async function listModels(request: JsonGetRequest, connection: ProviderConnection): Promise<ModelList> {
  const exchange = await jsonRequest("GET", "models", request, connection);
  if (exchange.status >= 400) {
    throw Object.assign(new Error(`upstream models request failed (${exchange.status})`), { statusCode: 502 });
  }
  if (!exchange.body) throw Object.assign(new Error("upstream models response was empty"), { statusCode: 502 });
  const listed = toModelList(JSON.parse(await new Response(exchange.body).text()) as unknown);
  for (const extra of QWEN_IMAGE_MODELS) {
    if (listed.data.some((model) => model.id === extra.id)) continue;
    listed.data.push({ id: extra.id, object: "model", owned_by: PROVIDER_ID, name: extra.name });
  }
  return listed;
}

const QWEN_IMAGE_MODELS = [
  { id: "wan2.7-image", name: "Wan 2.7 Image" },
  { id: "wan2.7-image-pro", name: "Wan 2.7 Image Pro" },
];
const QWEN_IMAGE_PARAMETERS = [
  "negative_prompt",
  "prompt_extend",
  "watermark",
  "seed",
  "enable_sequential",
  "thinking_mode",
  "color_palette",
] as const;

export async function imageGenerations(request: JsonPostRequest, connection: ProviderConnection): Promise<HttpExchange> {
  return generateImages(request, connection, false);
}

export async function imageEdits(request: JsonPostRequest, connection: ProviderConnection): Promise<HttpExchange> {
  return generateImages(request, connection, true);
}

async function generateImages(
  request: JsonPostRequest,
  connection: ProviderConnection,
  edit: boolean,
): Promise<HttpExchange> {
  const body = asRecord(request.body) ?? {};
  const model = stringValue(body.model);
  const prompt = stringValue(body.prompt);
  const references = referenceImages(body);
  if (!model || (!prompt && references.length === 0)) {
    return jsonError(400, "model and prompt or image are required");
  }
  if (edit && references.length === 0) return jsonError(400, "image is required");
  const credentials = readCredentials(connection.credentials);
  const size = imageSize(body.size);
  const count = typeof body.n === "number" && Number.isFinite(body.n) ? Math.trunc(body.n) : undefined;
  const parameters: Record<string, unknown> = {};
  if (size) parameters.size = size;
  if (count !== undefined) parameters.n = count;
  for (const key of QWEN_IMAGE_PARAMETERS) {
    if (body[key] !== undefined) parameters[key] = body[key];
  }
  const content = [
    ...references.map((image) => ({ image: `data:${image.mediaType};base64,${image.data}` })),
    ...(prompt ? [{ text: prompt }] : []),
  ];
  let upstream: Response;
  try {
    upstream = await fetch(imageUrl(credentials), {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.apiKey}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: model.split("/").pop(),
        input: { messages: [{ role: "user", content }] },
        ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
      }),
      signal: request.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(`upstream request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!upstream.ok) {
    return { status: upstream.status, headers: pickHeaders(upstream.headers), body: upstream.body };
  }
  const payload = asRecord(await upstream.json().catch(() => null));
  const images = imageUrls(payload);
  if (images.length === 0) return jsonError(502, "Qwen image generation returned no images");
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: new Response(JSON.stringify({ created: Math.floor(Date.now() / 1000), data: images })).body,
  };
}

function imageSize(value: unknown): string | undefined {
  const size = stringValue(value);
  if (!size) return undefined;
  return /^\d+x\d+$/i.test(size) ? size.replace(/x/i, "*") : size;
}

function referenceImages(body: Record<string, unknown>): Array<{ mediaType: string; data: string }> {
  if (!Array.isArray(body.images)) return [];
  const images: Array<{ mediaType: string; data: string }> = [];
  for (const entry of body.images) {
    const image = asRecord(entry);
    const data = stringValue(image?.b64_json);
    if (!data) continue;
    images.push({ mediaType: stringValue(image?.media_type) ?? "image/png", data });
  }
  return images;
}

async function jsonRequest(
  method: "GET" | "POST",
  path: string,
  request: JsonGetRequest | JsonPostRequest,
  connection: ProviderConnection,
  parseUsage?: HttpExchange["parseUsage"],
): Promise<HttpExchange> {
  const credentials = readCredentials(connection.credentials);
  const headers: Record<string, string> = {
    ...pickHeaders(request.headers, INBOUND_HEADERS),
    accept: "application/json, text/event-stream",
  };
  if (method === "POST") headers["content-type"] = "application/json";
  headers.authorization = `Bearer ${credentials.apiKey}`;
  let upstream: Response;
  try {
    upstream = await fetch(providerUrl(compatibleBase(credentials), path), {
      method,
      headers,
      ...(method === "POST" && "body" in request ? { body: JSON.stringify(request.body ?? {}) } : {}),
      signal: request.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(`upstream request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    status: upstream.status,
    headers: pickHeaders(upstream.headers, OUTBOUND_HEADERS),
    body: upstream.body,
    ...(parseUsage ? { parseUsage } : {}),
  };
}

function compatibleBase(credentials: QwenTokenPlanCredentials): string {
  if (credentials.baseUrl) return credentials.baseUrl.replace(/\/$/, "");
  return `${REGIONS[credentials.region]}/compatible-mode/v1`;
}

function imageUrl(credentials: QwenTokenPlanCredentials): string {
  const origin = credentials.baseUrl
    ? new URL(credentials.baseUrl).origin
    : REGIONS[credentials.region];
  return `${origin}/api/v1/services/aigc/multimodal-generation/generation`;
}

function providerUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith(`/${path}`)) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/${path}`;
  return `${trimmed}/${path}`;
}

function normalizeRegion(value: unknown): Region {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!text || text === "china-beijing" || text === "cn" || text === "beijing" || text === "cn-beijing") {
    return "china-beijing";
  }
  if (text === "global-sg" || text === "singapore" || text === "global" || text === "ap-southeast-1") {
    return "global-sg";
  }
  throw new Error("region must be china-beijing or global-sg");
}

function optionalBaseUrl(value: unknown): string | undefined {
  const text = stringValue(value);
  if (!text) return undefined;
  const url = new URL(text);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("baseUrl must use http or https");
  return url.toString().replace(/\/$/, "");
}

function imageUrls(payload: Record<string, unknown> | undefined): Array<{ url: string }> {
  const output = asRecord(payload?.output);
  const choices = Array.isArray(output?.choices) ? output.choices : [];
  const urls: Array<{ url: string }> = [];
  for (const choice of choices) {
    const message = asRecord(asRecord(choice)?.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const part of content) {
      const url = stringValue(asRecord(part)?.image);
      if (url) urls.push({ url });
    }
  }
  return urls;
}

function jsonError(status: number, message: string): HttpExchange {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } })).body,
  };
}

function readCredentials(input: unknown): QwenTokenPlanCredentials {
  return normalizeCredentials(input).credentials as QwenTokenPlanCredentials;
}

function pickHeaders(
  headers: Headers | Record<string, string>,
  allowed: Record<string, true> = OUTBOUND_HEADERS,
): Record<string, string> {
  const picked: Record<string, string> = {};
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);
  for (const [name, value] of entries) {
    if (allowed[name.toLowerCase()] && value) picked[name.toLowerCase()] = value;
  }
  return picked;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
