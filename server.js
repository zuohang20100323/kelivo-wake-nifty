const fs = require("fs");
const path = require("path");
const Fastify = require("fastify");
const { ensureDataDir, runtimeDirectory, runtimeFile, writeJsonAtomicSync } = require("./runtime_paths");
const { isSpecialEventContent } = require("./special_events");
const { decideRequestAccess } = require("./network_access");
const { formatDateTimeInTimeZone, resolveTimeZone } = require("./time_utils");
const { buildNtfyPayload } = require("./ntfy_priority");
const { parseChatCompletionResponse } = require("./upstream_response");

const DEFAULT_BODY_LIMIT_MB = 50;
const app = Fastify({ logger: true });

app.register(require("@fastify/formbody"));

const PORT = Number(process.env.PORT) || 3000;
const TARGET_API_URL = process.env.TARGET_API_URL;
const TIME_ZONE = resolveTimeZone();
const IS_RAILWAY_RUNTIME = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
const DATA_DIR = ensureDataDir();
const TIMELINE_FILE = runtimeFile("enhanced_messages.json");
const TIMESTAMP_DB_FILE = runtimeFile("message_timestamps.json");
const PRESETS_FILE = runtimeFile("presets.json");
const ENV_FILE = path.join(__dirname, ".env");
const DEFAULT_RESTART_COMMAND = "pm2 restart gateway wake-up --update-env";

// ========================
// 工具函数
// ========================
function readBooleanEnv(key, fallback = false) {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function configuredModelName() {
  return String(process.env.MODEL_NAME || "gateway-model").trim() || "gateway-model";
}

function readEnvValue(key) {
  if (IS_RAILWAY_RUNTIME && process.env[key]) return process.env[key];
  try {
    const envContent = fs.readFileSync(ENV_FILE, "utf-8");
    const lines = envContent.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith(key + "=")) return trimmed.substring(key.length + 1).trim();
    }
  } catch {}
  return process.env[key] || "";
}

function readNumberEnv(key, fallback) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : fallback;
}

// ========================
// 时间线操作
// ========================
function loadTimeline() {
  if (!fs.existsSync(TIMELINE_FILE)) return [];
  try { return fs.readJsonSync(TIMELINE_FILE); } catch { return []; }
}

function saveTimeline(messages) {
  const sp = messages.find(m => m.role === "system");
  const nonSP = messages.filter(m => m.role !== "system");
  const trimmed = nonSP.slice(-49);
  const final = sp ? [sp, ...trimmed] : trimmed;
  writeJsonAtomicSync(TIMELINE_FILE, final);
}

function appendSpecialEvent(content) {
  const timeline = loadTimeline();
  let maxPos = 0;
  for (const msg of timeline) {
    if (msg.position && msg.position > maxPos) maxPos = msg.position;
  }
  const newEvent = { role: "assistant", content, position: maxPos + 0.5 };
  timeline.push(newEvent);
  saveTimeline(timeline);
  console.log(`已记录特殊事件 (position ${newEvent.position})`);
}

// ========================
// 安全：管理页走 Basic Auth
// ========================
app.addHook("onRequest", (req, reply, done) => {
  const requestPath = req.url.split("?")[0];
  const ip = String(req.ip || req.connection.remoteAddress || "");
  const headerKey = String(req.headers["x-gateway-api-key"] || req.headers["x-api-key"] || "").trim();
  const access = decideRequestAccess({
    path: requestPath,
    ip,
    isRailway: IS_RAILWAY_RUNTIME,
    allowPublicApi: readBooleanEnv("ALLOW_PUBLIC_API", false),
    configuredKey: readEnvValue("GATEWAY_API_KEY"),
    authorization: req.headers.authorization,
    headerKey
  });
  if (access.allow) return done();
  if (access.authRejected) {
    console.warn(JSON.stringify({
      event: "gateway_auth_rejected",
      path: requestPath,
      auth_source: access.authSource || "missing"
    }));
  }
  reply.code(access.status || 403).send(access.status === 401 ? { error: access.error } : access.error);
});

app.get("/healthz", async () => ({ status: "ok" }));

// ========================
// Models
// ========================
app.get("/v1/models", async (req, reply) => {
  reply.send({
    object: "list",
    data: [{ id: configuredModelName(), object: "model", created: 0, owned_by: "gateway" }]
  });
});

// ========================
// Chat Completions
// ========================
app.post("/v1/chat/completions", async (req, reply) => {
  try {
    const body = req.body;
    const kelivoMessages = body.messages || [];
    const oldTimeline = loadTimeline();
    
    // 构建最终时间线
    const finalTimeline = [...kelivoMessages];
    saveTimeline(finalTimeline);
    
    // 注入特殊事件
    const oldEvents = oldTimeline.filter(isSpecialEventContent);
    console.log("本次注入的特殊事件数量:", oldEvents.length);
    
    // 转发请求到上游API
    if (!TARGET_API_URL || !process.env.TARGET_API_KEY) {
      return reply.code(500).send({ error: "TARGET_API_URL / TARGET_API_KEY 未配置" });
    }

    const requestedStream = body?.stream === true;
    const response = await fetch(TARGET_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.TARGET_API_KEY}`
      },
      body: JSON.stringify({ ...body, messages: kelivoMessages })
    });

    const upstreamContentType = response.headers.get("content-type") || "";
    const shouldStreamResponse = requestedStream || upstreamContentType.includes("text/event-stream");

    if (!shouldStreamResponse) {
      const responseText = await response.text();
      return reply
        .code(response.status)
        .header("Content-Type", upstreamContentType || "application/json")
        .send(responseText);
    }

    if (!response.body) {
      return reply.code(response.status).send({ error: "上游 API 没有返回可读取的响应体" });
    }

    reply.raw.writeHead(response.status, {
      "Content-Type": upstreamContentType || "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      reply.raw.write(value);
    }
    reply.raw.end();
  } catch (err) {
    console.error(err);
    reply.code(500).send({ error: err.message });
  }
});

// ========================
// 内部接口
// ========================
app.post("/internal/wake-event", async (req, reply) => {
  try {
    const { content } = req.body;
    if (!content) return reply.code(400).send({ error: "content is required" });
    appendSpecialEvent(content);
    reply.send({ success: true });
  } catch (err) {
    console.error(err);
    reply.code(500).send({ error: err.message });
  }
});

// ========================
// 管理页面
// ========================
function basicAuth(req, reply, done) {
  const auth = req.headers.authorization || "";
  const [scheme, encoded] = auth.split(" ");
  if (scheme !== "Basic" || !encoded) {
    reply.code(401).header("WWW-Authenticate", 'Basic realm="Admin"').send("Unauthorized");
    return;
  }
  const decoded = Buffer.from(encoded, "base64").toString();
  const colonIndex = decoded.indexOf(":");
  const user = decoded.substring(0, colonIndex);
  const password = decoded.substring(colonIndex + 1);
  if (user === process.env.ADMIN_USER && password === process.env.ADMIN_PASSWORD) {
    done();
  } else {
    reply.code(401).header("WWW-Authenticate", 'Basic realm="Admin"').send("Unauthorized");
  }
}

app.get("/admin", { preHandler: basicAuth }, async (req, reply) => {
  const currentUrl = readEnvValue("TARGET_API_URL");
  const currentModel = readEnvValue("MODEL_NAME");
  const ntfyTopic = readEnvValue("NTFY_TOPIC");
  
  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <title>Dylan Heartbeat - ntfy版</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f5f7; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 30px 20px; }
    .container { max-width: 500px; width: 100%; background: white; border-radius: 16px; padding: 32px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    h2 { text-align: center; font-size: 28px; color: #333; margin-bottom: 4px; }
    .subtitle { text-align: center; font-size: 12px; color: #888; margin-bottom: 24px; }
    .status { background: #f8f8fa; border-radius: 12px; padding: 16px; margin-bottom: 20px; }
    .status p { margin: 6px 0; font-size: 13px; color: #555; }
    .status strong { color: #333; }
    label { display: block; margin-top: 14px; font-weight: 500; font-size: 12px; color: #666; }
    input { width: 100%; padding: 10px 12px; margin-top: 4px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; }
    input:focus { outline: none; border-color: #007aff; }
    button { width: 100%; margin-top: 16px; padding: 12px; border: none; border-radius: 10px; font-size: 14px; font-weight: 500; cursor: pointer; }
    button.save { background: #007aff; color: white; }
    button.save:hover { background: #0056cc; }
    button.restart { background: #ff3b30; color: white; margin-top: 12px; }
    .hint { margin-top: 8px; font-size: 11px; color: #888; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <h2>HEARTBEAT</h2>
    <div class="subtitle">ntfy · AI Residency Runtime</div>
    
    <div class="status">
      <p>Gateway <strong>运行中</strong></p>
      <p>推送渠道 <strong>${readEnvValue("PUSH_PROVIDER") || "ntfy"}</strong></p>
    </div>
    
    <form id="configForm" onsubmit="saveConfig(event)">
      <label>API URL</label>
      <input name="target_url" value="${currentUrl}">
      
      <label>API Key</label>
      <input name="target_key" placeholder="留空不修改">
      
      <label>Model Name</label>
      <input name="model_name" value="${currentModel}">
      
      <label>ntfy Topic</label>
      <input name="ntfy_topic" value="${ntfyTopic}">
      
      <div class="grid-2" style="margin-top: 12px;">
        <div>
          <label>白天唤醒间隔(分钟)</label>
          <input type="number" name="day_wake" value="${readEnvValue("DAY_WAKE_AFTER_MINUTES") || "60"}">
        </div>
        <div>
          <label>夜间唤醒间隔(分钟)</label>
          <input type="number" name="night_wake" value="${readEnvValue("NIGHT_WAKE_AFTER_MINUTES") || "120"}">
        </div>
      </div>
      
      <button type="submit" class="save">保存配置</button>
    </form>
    
    <button onclick="restartServices()" class="restart">重启服务</button>
    <div class="hint">修改配置后先保存，再点重启按钮生效</div>
  </div>
  
  <script>
    async function saveConfig(event) {
      event.preventDefault();
      const form = event.target;
      const payload = {
        target_url: form.target_url.value.trim(),
        model_name: form.model_name.value.trim(),
        ntfy_topic: form.ntfy_topic.value.trim(),
        day_wake: form.day_wake.value.trim(),
        night_wake: form.night_wake.value.trim()
      };
      
      if (!payload.target_url || !payload.model_name) {
        alert("请填写 API 地址和模型名称");
        return;
      }
      
      try {
        const resp = await fetch("/admin/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const result = await resp.json();
        if (result.success) {
          alert("配置已保存，点击重启按钮生效");
        } else {
          alert("保存失败：" + (result.error || "未知错误"));
        }
      } catch (e) {
        alert("请求失败：" + e.message);
      }
    }
    
    async function restartServices() {
      if (!confirm("确定要重启服务吗？")) return;
      try {
        const resp = await fetch("/admin/restart", { method: "POST" });
        const result = await resp.json();
        if (result.success) {
          alert("重启成功！页面稍后自动刷新。");
          setTimeout(() => location.reload(), 3000);
        }
      } catch (e) {
        alert("重启失败：" + e.message);
      }
    }
  </script>
</body>
</html>`;

  reply.type("text/html").send(html);
});

// 保存配置
app.post("/admin/save", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const { target_url, model_name, ntfy_topic, day_wake, night_wake } = req.body;
    if (!target_url || !model_name) {
      return reply.code(400).send({ error: "必填项缺失" });
    }
    
    const envLines = [
      `TARGET_API_URL=${target_url}`,
      `MODEL_NAME=${model_name}`,
      `PUSH_PROVIDER=ntfy`,
      `NTFY_TOPIC=${ntfy_topic || ""}`,
      `DAY_WAKE_AFTER_MINUTES=${day_wake || "60"}`,
      `NIGHT_WAKE_AFTER_MINUTES=${night_wake || "120"}`
    ];
    
    // 保留现有配置
    const existingKey = readEnvValue("TARGET_API_KEY");
    if (existingKey) envLines.push(`TARGET_API_KEY=${existingKey}`);
    
    fs.writeFileSync(ENV_FILE, envLines.join("\n") + "\n");
    console.log("配置已保存");
    reply.send({ success: true });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 重启服务
app.post("/admin/restart", { preHandler: basicAuth }, async (req, reply) => {
  const restartCommand = readEnvValue("RESTART_COMMAND") || DEFAULT_RESTART_COMMAND;
  const { exec } = require("child_process");
  exec(restartCommand, (err) => {
    if (err) console.error("重启失败:", err);
    else console.log("服务已重启");
  });
  reply.send({ success: true });
});

// 启动服务
app.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`✅ Gateway 运行在 ${address}`);
  console.log(`📱 推送渠道: ${readEnvValue("PUSH_PROVIDER") || "ntfy"}`);
  console.log(`🌐 管理页面: ${address}/admin`);
});

module.exports = app;
