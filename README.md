# @viateai/plugin-qwen-token-plan

Viate provider for Alibaba Cloud Model Studio Token Plan. Package name: `@viateai/plugin-qwen-token-plan`. Provider id: `qwen-cloud-token-plan`. `viate plugin remove` takes the package name.

It relays OpenAI-shaped chat, embeddings, responses, and model lists to the region's `compatible-mode/v1` API. Chat and responses usage is parsed. Image generation and image edits go to DashScope multimodal generation and come back as OpenAI image results (`data[].url`).

`listModels` returns the upstream model list, then adds `wan2.7-image` and `wan2.7-image-pro` when the upstream list omitted them.

## Connection

| Field | Required | Notes |
| --- | --- | --- |
| `apiKey` | yes | Sent as `Authorization: Bearer`. A raw credential string is this key. |
| `region` | no | `china-beijing` (default) or `global-sg`. |
| `baseUrl` | no | Overrides the compatible-mode base. Must be `http` or `https`. |

Region aliases: `cn`, `beijing`, and `cn-beijing` select Beijing. `singapore`, `global`, and `ap-southeast-1` select Singapore.

Default origins:

- Beijing: `https://token-plan.cn-beijing.maas.aliyuncs.com`
- Singapore: `https://token-plan.ap-southeast-1.maas.aliyuncs.com`

Text, embeddings, and model calls use `<origin>/compatible-mode/v1`. Image calls use `<origin>/api/v1/services/aigc/multimodal-generation/generation`. With a `baseUrl` override, text uses that base and images use its origin.

`anthropic-beta`, `anthropic-version`, and `openai-beta` are forwarded on the compatible-mode calls. Response `content-type` and `cache-control` are returned. Streams are passed through.

## Install

From npm, after a release is published:

```bash
viate plugin add @viateai/plugin-qwen-token-plan
```

From a tarball:

```bash
npm pack
viate plugin add ./<tarball>.tgz
```

`viate.entry` is `dist/index.js`. The published tarball contains the built `dist`. `@viateai/sdk` is a peer of `1.0.1`; the gateway removes it at install and loads its own copy.

Plugins run in-process. Install only packages you trust. See [Viate](https://github.com/ViateAI/viate).

## Development

Node.js >= 24. pnpm 12.16.1, pinned by `packageManager`.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Release Please on `main` owns the version and changelog. Do not edit either by hand.

MIT. See [LICENSE](LICENSE).
