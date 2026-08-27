import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
// 用于读取本地首尾帧图片文件
import { readFile } from "node:fs/promises";
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
  { id: "agnes5", baseUrl: "https://apihub.agnes-ai.cn/v1" },
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
  metadata?: { url?: string };
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
    defaultModel: "agnes-video-2.5-flash",
    models: ["agnes-video-2.5-flash", "agnes-video-v2.0"],
    defaultTimeoutMs: 300000,
    capabilities: {
      generate: {
        maxVideos: 1,
        maxDurationSeconds: 12,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: false,
        supportsAudio: false,
        supportsWatermark: false,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 5,
        maxDurationSeconds: 12,
        supportsSize: true,
        supportsAspectRatio: true,
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
      const rawModel = req.model || "agnes-video-2.5-flash";
      const model = rawModel.includes("/") ? rawModel.substring(rawModel.indexOf("/") + 1) : rawModel;
      const isFlash = model === "agnes-video-2.5-flash";

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      };

      const body: Record<string, unknown> = {
        model,
        prompt: req.prompt,
      };

      // Flash mode parameters
      if (isFlash) {
        // size must be "720P" for Flash
        body.size = "720P";
        
        // duration as string "4"-"12"
        if (req.durationSeconds) {
          const dur = Math.min(Math.max(Math.round(req.durationSeconds), 4), 12);
          body.seconds = String(dur);
        } else {
          body.seconds = "5";
        }
        
        // aspect_ratio as string
        if (req.aspectRatio) {
          body.aspect_ratio = req.aspectRatio;
        }
      } else {
        // Legacy v2.0 mode
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
      }

      // Handle input images based on mode
      if (req.inputImages?.length) {
        if (isFlash) {
          // Flash: keyframe mode requires top-level first_frame/last_frame (per 2.5-flash docs,
          // at least one of them, publicly accessible URLs); otherwise fall back to reference/images.
          const roleOf = (i: number) => req.imageRoles?.[i];
          const firstIdx = req.inputImages.findIndex((_, i) => roleOf(i) === "first_frame");
          const lastIdx = req.inputImages.findIndex((_, i) => roleOf(i) === "last_frame");
          const publicUrl = (idx: number) => {
            const u = idx >= 0 ? req.inputImages[idx]?.url : undefined;
            return u && !u.startsWith("data:") ? u : undefined;
          };
          const firstFrameUrl = publicUrl(firstIdx);
          const lastFrameUrl = publicUrl(lastIdx);
          if (firstFrameUrl) body.first_frame = firstFrameUrl;
          if (lastFrameUrl) body.last_frame = lastFrameUrl;
          const urls = req.inputImages
            .map((img) => img.url)
            .filter((u): u is string => !!u && !u.startsWith("data:"));
          if (body.first_frame || body.last_frame) {
            body.mode = "keyframe";
          } else if (urls.length > 0) {
            body.mode = "reference";
            body.images = urls.slice(0, 5);
          }
          if (!body.mode) {
            // mode is required for flash; nothing media-related resolved -> pure text mode
            body.mode = "text";
          }
        } else {
          // Legacy v2.0: first image as "image" field
          const firstImage = req.inputImages[0];
          if (firstImage.url) {
            body.image = firstImage.url;
          } else if (firstImage.buffer) {
            body.image = `data:${firstImage.mimeType || "image/png"};base64,${firstImage.buffer.toString("base64")}`;
          }
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

      // v20 文档说明 id/task_id/video_id 可能相等，也可能不等（video_ 前缀 vs task_ 前缀）。
      // 2.5-flash 文档明确要求 video_id 与 id/task_id 不同。因此两种模型都只能使用响应中的 video_id 查询。
      if (!createPayload.video_id) {
        throw new Error(`Agnes Video create task response missing video_id: ${JSON.stringify(createPayload).slice(0, 500)}`);
      }
      const videoId = createPayload.video_id;

      const startTime = Date.now();
      let lastStatus = "";
      let lastPollFailure = "";

      // Poll URL: flash queries require video_id + model_name (per 2.5-flash docs);
      // v2.0 keeps the legacy plain video_id query.
      const pollBaseUrl = baseUrl.replace(/\/v1$/, "");
      const pollQueryParam = isFlash
        ? `?video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(model)}`
        : `?video_id=${encodeURIComponent(videoId)}`;

      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
        if (Date.now() - startTime > timeoutMs) {
          throw new Error(`Agnes Video generation timed out after ${Math.round(timeoutMs / 1000)}s (last status: ${lastStatus}). Resume with agnes_video_status: video_id=${videoId}${isFlash ? ` model_name=${model}` : ""}`);
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

        let pollPayload: AgnesVideoPollResponse;
        try {
          const pollResponse = await fetch(`${pollBaseUrl}/agnesapi${pollQueryParam}`, {
            headers,
            signal: AbortSignal.timeout(10000),
          });

          if (!pollResponse.ok) {
            const errText = await pollResponse.text().catch(() => "");
            lastPollFailure = `HTTP ${pollResponse.status}: ${errText.slice(0, 200)}`;
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
          const videoUrl = pollPayload!.metadata?.url || pollPayload!.url;
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

      throw new Error(`Agnes Video polling exhausted after ${MAX_POLL_ATTEMPTS} attempts (last status: ${lastStatus}${lastPollFailure ? `; last poll failure: ${lastPollFailure}` : ""}). Resume with agnes_video_status: video_id=${videoId}${isFlash ? ` model_name=${model}` : ""}`);
    },
  };
}

function buildVideoStatusTool(api: OpenClawPluginApi) {
  return {
    name: "agnes_video_status",
    label: "Agnes Video Status",
    description: "Check status and get result of an Agnes video generation task. Query with the video_id saved from task creation (recommended; id/task_id alone may 404). Pass model_name for agnes-video-2.5-flash tasks.",
    parameters: {
      type: "object",
      properties: {
        video_id: { type: "string", description: "The video_id from task creation response (preferred over id/task_id)" },
        provider: { type: "string", description: "Provider id (agnes1/agnes2/agnes3), defaults to agnes1" },
        model_name: { type: "string", description: "Model name for polling (e.g. agnes-video-2.5-flash). Required for flash keyframe/reference tasks; auto-retried on 404 if omitted." },
      },
      required: ["video_id"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const { video_id, provider: providerId, model_name } = params as { video_id: string; provider?: string; model_name?: string };
      const pid = providerId || "agnes1";
      const providerCfg = api.config?.models?.providers?.[pid];

      if (!providerCfg?.apiKey) {
        return { content: [{ type: "text" as const, text: `Error: provider ${pid} not configured or missing apiKey` }] };
      }

      const baseUrl = providerCfg.baseUrl || "https://apihub.agnes-ai.cn/v1";
      const pollBase = `${baseUrl.replace(/\/v1$/, "")}/agnesapi`;

      const queryOnce = async (modelName?: string) => {
        const queryParam = modelName
          ? `?video_id=${encodeURIComponent(video_id)}&model_name=${encodeURIComponent(modelName)}`
          : `?video_id=${encodeURIComponent(video_id)}`;
        return fetch(`${pollBase}${queryParam}`, {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${providerCfg.apiKey}`,
          },
          signal: AbortSignal.timeout(15000),
        });
      };

      let resp = await queryOnce(model_name);
      // 2.5-flash lookups need model_name (except pure text mode); if omitted and plain lookup 404s, retry with flash.
      if (!model_name && resp.status === 404) {
        resp = await queryOnce("agnes-video-2.5-flash");
      }

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { content: [{ type: "text" as const, text: `HTTP ${resp.status}: ${text.slice(0, 500)}` }] };
      }

      const data = await resp.json() as AgnesVideoPollResponse;

      const lines: string[] = [
        `video_id: ${video_id}`,
        `status: ${data.status || "unknown"}`,
        `progress: ${data.progress ?? "N/A"}%`,
      ];
      if (data.seconds) lines.push(`duration: ${data.seconds}s`);
      if (data.size) lines.push(`size: ${data.size}`);
      if (data.metadata?.url || data.url) lines.push(`url: ${data.metadata?.url || data.url}`);
      if (data.error) lines.push(`error: ${JSON.stringify(data.error)}`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  };
}

// 将首尾帧图片输入统一解析为可提交给 Agnes API 的字符串：
// - http(s) 远程地址与 data:URI 直接透传；
// - 本地文件路径（含 file:// 前缀）读取后转为 base64 data URI。
// 注意：Agnes 2.5-flash 文档建议使用公网可访问的图片 URL，若 API 拒绝 data URI 请改用公网地址。
async function resolveFrameImageInput(input: string): Promise<string> {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("data:")) {
    return trimmed;
  }
  // 去除可能的 file:// 前缀后按本地路径读取
  const filePath = trimmed.replace(/^file:\/\//i, "");
  const buffer = await readFile(filePath);
  // 根据扩展名推断 MIME 类型，未知扩展名时默认按 PNG 处理
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
  };
  const mimeType = mimeMap[ext] || "image/png";
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

// 构建转场特效视频生成工具：以起始帧与结束帧为关键帧，生成一段过渡视频
function buildVideoTransitionTool(_api: OpenClawPluginApi) {
  return {
    name: "agnes_video_transition",
    label: "Agnes Video Transition",
    description: "Generate a transition-effect video from a first frame and a last frame image (Agnes 2.5-flash keyframe mode). Provide prompt, first_frame and last_frame (path or URL), optionally aspect_ratio and seconds. Returns video_id immediately; poll with agnes_video_status.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "视频描述提示词，描述起始帧到结束帧的过渡效果" },
        first_frame: { type: "string", description: "起始帧图片路径或URL" },
        last_frame: { type: "string", description: "结束帧图片路径或URL" },
        aspect_ratio: { type: "string", description: "宽高比，例如 16:9 / 9:16 / 1:1（可选）" },
        seconds: { type: "number", description: "视频时长（秒），范围 4-12，默认 5（可选）" },
        provider: { type: "string", description: "Provider id (agnes1/agnes2/agnes3)，默认 agnes1（可选）" },
        model_name: { type: "string", description: "模型名，默认 agnes-video-2.5-flash（可选）" },
        timeout_ms: { type: "number", description: "等待生成的最长毫秒数，默认 300000，最大 600000（可选）" },
      },
      required: ["prompt", "first_frame", "last_frame"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const {
        prompt,
        first_frame,
        last_frame,
        aspect_ratio: aspectRatio,
        seconds,
        provider: providerId,
        model_name: modelName,
        timeout_ms: timeoutMsParam,
      } = params as {
        prompt: string;
        first_frame: string;
        last_frame: string;
        aspect_ratio?: string;
        seconds?: number;
        provider?: string;
        model_name?: string;
        timeout_ms?: number;
      };

      const pid = providerId || "agnes1";
      const providerCfg = _api.config?.models?.providers?.[pid];
      if (!providerCfg?.apiKey) {
        return { content: [{ type: "text" as const, text: `Error: provider ${pid} not configured or missing apiKey` }] };
      }

      // 转场特效依赖首尾帧关键点模式，仅 2.5 系列模型支持
      const model = modelName || "agnes-video-2.5-flash";
      if (!/^agnes-video-2\.5/.test(model)) {
        return { content: [{ type: "text" as const, text: `Error: transition (keyframe) mode requires a 2.5-series model, got "${model}". Use agnes-video-2.5-flash.` }] };
      }

      const baseUrl = providerCfg.baseUrl || "https://apihub.agnes-ai.cn/v1";
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${providerCfg.apiKey}`,
      };

      // 解析首尾帧输入（支持 URL / 本地路径 / data URI）
      let firstFrameInput: string;
      let lastFrameInput: string;
      try {
        [firstFrameInput, lastFrameInput] = await Promise.all([
          resolveFrameImageInput(first_frame),
          resolveFrameImageInput(last_frame),
        ]);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: failed to read frame image: ${reason}` }] };
      }

      // 时长限制在 4-12 秒之间（2.5-flash 要求）
      const durationSeconds = Math.min(Math.max(Math.round(seconds ?? 5), 4), 12);
      const body: Record<string, unknown> = {
        model,
        prompt,
        mode: "keyframe",
        size: "720P",
        seconds: String(durationSeconds),
        first_frame: firstFrameInput,
        last_frame: lastFrameInput,
      };
      if (aspectRatio) {
        body.aspect_ratio = aspectRatio;
      }

      // 创建生成任务
      let createPayload: AgnesVideoCreateResponse;
      try {
        const createResponse = await fetch(`${baseUrl}/videos`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        });
        if (!createResponse.ok) {
          const text = await createResponse.text().catch(() => "");
          return { content: [{ type: "text" as const, text: `Agnes Video create task error ${createResponse.status}: ${text.slice(0, 500)}` }] };
        }
        createPayload = await createResponse.json() as AgnesVideoCreateResponse;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: failed to create transition task: ${reason}` }] };
      }

      if (createPayload.error) {
        return { content: [{ type: "text" as const, text: `Agnes Video create task failed: ${createPayload.error.message || "unknown error"}` }] };
      }
      // 与现有供应商逻辑一致：查询必须使用响应中的 video_id
      if (!createPayload.video_id) {
        return { content: [{ type: "text" as const, text: `Agnes Video create task response missing video_id: ${JSON.stringify(createPayload).slice(0, 500)}` }] };
      }
      const videoId = createPayload.video_id;

      // 轮询任务状态直到完成、失败或超时；超时时返回 video_id 以便用 agnes_video_status 续查
      const timeoutMs = Math.min(Math.max(timeoutMsParam ?? 300000, 10000), 600000);
      const startTime = Date.now();
      const pollBase = `${baseUrl.replace(/\/v1$/, "")}/agnesapi`;
      const pollUrl = `${pollBase}?video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(model)}`;
      let lastStatus = "";

      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
        if (Date.now() - startTime > timeoutMs) {
          return { content: [{ type: "text" as const, text: `Task submitted but still pending after ${Math.round(timeoutMs / 1000)}s (status: ${lastStatus || "unknown"}). Resume with agnes_video_status: video_id=${videoId} model_name=${model}` }] };
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

        let pollPayload: AgnesVideoPollResponse;
        try {
          const pollResponse = await fetch(pollUrl, {
            headers,
            signal: AbortSignal.timeout(15000),
          });
          if (!pollResponse.ok) {
            continue;
          }
          pollPayload = await pollResponse.json() as AgnesVideoPollResponse;
        } catch {
          continue;
        }

        if (pollPayload!.error) {
          return { content: [{ type: "text" as const, text: `Agnes Video generation failed: ${pollPayload!.error!.message || "task failed"} (video_id=${videoId})` }] };
        }

        const status = pollPayload!.status || "";
        lastStatus = status;

        if (status === "completed" || status === "done" || status === "success") {
          const videoUrl = pollPayload!.metadata?.url || pollPayload!.url;
          if (!videoUrl) {
            return { content: [{ type: "text" as const, text: `Task completed but url is missing (video_id=${videoId}). Resume with agnes_video_status.` }] };
          }
          const lines = [
            `video_id: ${videoId}`,
            `status: ${status}`,
            `url: ${videoUrl}`,
            `duration: ${durationSeconds}s`,
          ];
          if (aspectRatio) lines.push(`aspect_ratio: ${aspectRatio}`);
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        }

        if (status === "failed" || status === "error") {
          return { content: [{ type: "text" as const, text: `Agnes Video generation failed with status: ${status} (video_id=${videoId})` }] };
        }
      }

      return { content: [{ type: "text" as const, text: `Polling exhausted after ${MAX_POLL_ATTEMPTS} attempts (status: ${lastStatus || "unknown"}). Resume with agnes_video_status: video_id=${videoId} model_name=${model}` }] };
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
    // 注册转场特效视频生成工具
    api.registerTool(buildVideoTransitionTool(api) as any);
  },
};
