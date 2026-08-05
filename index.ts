import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import type {
  ImageGenerationProvider,
  ImageGenerationRequest,
  ImageGenerationResult,
  GeneratedImageAsset,
} from "openclaw/plugin-sdk/image-generation-core";
import type {
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationResult,
  GeneratedVideoAsset,
} from "openclaw/plugin-sdk/video-generation-core";

const AGNES_PROVIDERS = [
  { id: "agnes1", baseUrl: "https://apihub.agnes-ai.cn/v1" },
  { id: "agnes2", baseUrl: "https://apihub.agnes-ai.cn/v1" },
  { id: "agnes3", baseUrl: "https://apihub.agnes-ai.cn/v1" },
];

const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 120;

interface AgnesVideoCreateResponse {
  id?: string;
  task_id?: string;
  video_id?: string;
  status?: string;
  progress?: number;
  seconds?: string;
  size?: string;
  error?: { message?: string };
}

interface AgnesVideoPollResponse {
  id?: string;
  task_id?: string;
  video_id?: string;
  status?: string;
  progress?: number;
  url?: string;
  seconds?: string;
  size?: string;
  error?: { message?: string };
}

function buildAgnesImageProvider(
  providerId: string,
  defaultBaseUrl: string,
): ImageGenerationProvider {
  return {
    id: providerId,
    label: `Agnes ${providerId}`,
    defaultModel: "agnes-image-2.1-flash",
    models: ["agnes-image-2.0-flash", "agnes-image-2.1-flash"],
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      edit: {
        enabled: false,
        maxCount: 0,
        maxInputImages: 0,
        supportsSize: false,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
    },
    isConfigured: (ctx) => {
      const providerCfg = ctx.cfg?.models?.providers?.[providerId];
      return !!(providerCfg?.apiKey);
    },
    generateImage: async (req: ImageGenerationRequest): Promise<ImageGenerationResult> => {
      const providerCfg = req.cfg?.models?.providers?.[providerId];
      if (!providerCfg?.apiKey) {
        throw new Error(`API key missing. Set models.providers.${providerId}.apiKey`);
      }

      const baseUrl = providerCfg.baseUrl || defaultBaseUrl;
      const apiKey = providerCfg.apiKey;
      const rawModel = req.model || "agnes-image-2.1-flash";
      const model = rawModel.includes("/") ? rawModel.substring(rawModel.indexOf("/") + 1) : rawModel;
      const count = Math.min(req.count || 1, 4);

      const response = await fetch(`${baseUrl}/images/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          prompt: req.prompt,
          n: count,
          size: req.size || "1024x1024",
        }),
        signal: req.timeoutMs ? AbortSignal.timeout(req.timeoutMs) : undefined,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Agnes API error ${response.status}: ${text.slice(0, 500)}`);
      }

      const payload = await response.json() as Record<string, unknown>;
      const data = payload.data as Array<{ url?: string; b64_json?: string }> | undefined;

      if (!data?.length) {
        throw new Error("Agnes response missing image data");
      }

      const images: GeneratedImageAsset[] = [];

      for (let i = 0; i < data.length; i++) {
        const entry = data[i];
        let buffer: Buffer;
        let mimeType = "image/png";

        if (entry.b64_json) {
          buffer = Buffer.from(entry.b64_json, "base64");
        } else if (entry.url) {
          const imgResponse = await fetch(entry.url, {
            signal: req.timeoutMs ? AbortSignal.timeout(req.timeoutMs) : undefined,
          });
          if (!imgResponse.ok) {
            throw new Error(`Failed to download image ${i + 1}: ${imgResponse.status}`);
          }
          const arrayBuffer = await imgResponse.arrayBuffer();
          buffer = Buffer.from(arrayBuffer);
          const contentType = imgResponse.headers.get("content-type") || "image/png";
          mimeType = contentType.split(";")[0].trim() || "image/png";
        } else {
          throw new Error(`Agnes response entry ${i + 1} missing both url and b64_json`);
        }

        images.push({
          buffer,
          mimeType,
          fileName: `agnes-${i + 1}.png`,
        });
      }

      return {
        images,
        model,
        metadata: { provider: providerId },
      };
    },
  };
}

function buildAgnesVideoProvider(
  providerId: string,
  defaultBaseUrl: string,
): VideoGenerationProvider {
  return {
    id: providerId,
    label: `Agnes Video ${providerId}`,
    defaultModel: "agnes-video-v2.0",
    models: ["agnes-video-v2.0"],
    defaultTimeoutMs: 300000,
    capabilities: {
      generate: {
        maxVideos: 1,
        maxDurationSeconds: 60,
        supportsSize: false,
        supportsAspectRatio: false,
        supportsResolution: false,
        supportsAudio: false,
        supportsWatermark: false,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 1,
        maxDurationSeconds: 60,
        supportsSize: false,
        supportsAspectRatio: false,
        supportsResolution: false,
        supportsAudio: false,
        supportsWatermark: false,
      },
    },
    isConfigured: (ctx) => {
      const providerCfg = ctx.cfg?.models?.providers?.[providerId];
      return !!(providerCfg?.apiKey);
    },
    generateVideo: async (req: VideoGenerationRequest): Promise<VideoGenerationResult> => {
      const providerCfg = req.cfg?.models?.providers?.[providerId];
      if (!providerCfg?.apiKey) {
        throw new Error(`Agnes Video API key missing. Set models.providers.${providerId}.apiKey`);
      }

      const baseUrl = providerCfg.baseUrl || defaultBaseUrl;
      const apiKey = providerCfg.apiKey;
      const rawModel = req.model || "agnes-video-v2.0";
      const model = rawModel.includes("/") ? rawModel.substring(rawModel.indexOf("/") + 1) : rawModel;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      };

      const body: Record<string, unknown> = {
        model,
        prompt: req.prompt,
      };

      if (req.size) {
        const m = req.size.match(/(\d+)x(\d+)/i);
        if (m) {
          body.width = parseInt(m[1], 10);
          body.height = parseInt(m[2], 10);
        }
      }
      if (req.aspectRatio) {
        if (req.aspectRatio.includes("16:9")) { body.width = 1152; body.height = 648; }
        else if (req.aspectRatio.includes("9:16")) { body.width = 648; body.height = 1152; }
        else if (req.aspectRatio.includes("1:1")) { body.width = 768; body.height = 768; }
        else if (req.aspectRatio.includes("4:3")) { body.width = 1024; body.height = 768; }
        else if (req.aspectRatio.includes("3:4")) { body.width = 768; body.height = 1024; }
      }

      body.num_frames = 121;
      body.frame_rate = 24;

      if (req.inputImages?.length) {
        const firstImage = req.inputImages[0];
        if (firstImage.url) {
          body.image = firstImage.url;
        } else if (firstImage.buffer) {
          body.image = `data:${firstImage.mimeType || "image/png"};base64,${firstImage.buffer.toString("base64")}`;
        }
      }

      if (req.providerOptions) {
        Object.assign(body, req.providerOptions);
      }

      const timeoutMs = req.timeoutMs || 300000;

      const createResponse = await fetch(`${baseUrl}/videos`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });

      if (!createResponse.ok) {
        const text = await createResponse.text().catch(() => "");
        throw new Error(`Agnes Video create task error ${createResponse.status}: ${text.slice(0, 500)}`);
      }

      const createPayload = await createResponse.json() as AgnesVideoCreateResponse;

      if (createPayload.error) {
        throw new Error(`Agnes Video create task failed: ${createPayload.error.message || "unknown error"}`);
      }

      const videoId = createPayload.video_id || createPayload.task_id || createPayload.id;

      if (!videoId) {
        throw new Error(`Agnes Video create task response missing video_id/task_id/id: ${JSON.stringify(createPayload).slice(0, 500)}`);
      }

      const startTime = Date.now();
      let lastStatus = "";

      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
        if (Date.now() - startTime > timeoutMs) {
          throw new Error(`Agnes Video generation timed out after ${Math.round(timeoutMs / 1000)}s (last status: ${lastStatus})`);
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

        let pollPayload: AgnesVideoPollResponse;
        try {
          const pollResponse = await fetch(`${baseUrl.replace(/\/v1$/, "")}/agnesapi?video_id=${videoId}`, {
            headers,
            signal: AbortSignal.timeout(10000),
          });

          if (!pollResponse.ok) {
            continue;
          }

          pollPayload = await pollResponse.json() as AgnesVideoPollResponse;
        } catch {
          continue;
        }

        if (pollPayload!.error) {
          throw new Error(`Agnes Video generation failed: ${pollPayload!.error!.message || "task failed"}`);
        }

        const status = pollPayload!.status || "";
        lastStatus = status;

        if (status === "completed" || status === "done" || status === "success") {
          const videoUrl = pollPayload!.url;
          if (!videoUrl) {
            throw new Error(`Agnes Video task completed but url is missing: ${JSON.stringify(pollPayload).slice(0, 500)}`);
          }

          const videos: GeneratedVideoAsset[] = [{
            url: videoUrl,
            mimeType: "video/mp4",
            fileName: `agnes-video-${videoId}.mp4`,
          }];

          return {
            videos,
            model,
            metadata: { provider: providerId, videoId },
          };
        }

        if (status === "failed" || status === "error") {
          throw new Error(`Agnes Video generation failed with status: ${status}`);
        }
      }

      throw new Error(`Agnes Video polling exhausted after ${MAX_POLL_ATTEMPTS} attempts (last status: ${lastStatus})`);
    },
  };
}

function buildVideoStatusTool(api: OpenClawPluginApi) {
  return {
    name: "agnes_video_status",
    label: "Agnes Video Status",
    description: "Check status and get result of an Agnes video generation task by video_id or task_id",
    parameters: {
      type: "object",
      properties: {
        video_id: { type: "string", description: "The video_id or task_id returned by video generation" },
        provider: { type: "string", description: "Provider id (agnes1/agnes2/agnes3), defaults to agnes1" },
      },
      required: ["video_id"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const { video_id, provider: providerId } = params as { video_id: string; provider?: string };
      const pid = providerId || "agnes1";
      const providerCfg = api.config?.models?.providers?.[pid];

      if (!providerCfg?.apiKey) {
        return { content: [{ type: "text" as const, text: `Error: provider ${pid} not configured or missing apiKey` }] };
      }

      const baseUrl = providerCfg.baseUrl || "https://apihub.agnes-ai.cn/v1";
      const pollUrl = `${baseUrl.replace(/\/v1$/, "")}/agnesapi?video_id=${video_id}`;

      const resp = await fetch(pollUrl, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${providerCfg.apiKey}`,
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { content: [{ type: "text" as const, text: `HTTP ${resp.status}: ${text.slice(0, 500)}` }] };
      }

      const data = await resp.json() as AgnesVideoPollResponse;

      const lines: string[] = [
        `status: ${data.status || "unknown"}`,
        `progress: ${data.progress ?? "N/A"}%`,
      ];
      if (data.seconds) lines.push(`duration: ${data.seconds}s`);
      if (data.size) lines.push(`size: ${data.size}`);
      if (data.url) lines.push(`url: ${data.url}`);
      if (data.error) lines.push(`error: ${JSON.stringify(data.error)}`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  };
}

export default {
  id: "agnes",
  name: "Agnes",
  description: "Agnes AI image + video generation",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    for (const p of AGNES_PROVIDERS) {
      api.registerImageGenerationProvider(buildAgnesImageProvider(p.id, p.baseUrl));
      api.registerVideoGenerationProvider(buildAgnesVideoProvider(p.id, p.baseUrl));
    }
    api.registerTool(buildVideoStatusTool(api) as any);
  },
};
