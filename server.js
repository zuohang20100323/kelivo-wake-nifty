require("dotenv").config({ quiet: true });
const Fastify = require("fastify");
const fs = require("fs-extra");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const TARGET_API_URL = process.env.TARGET_API_URL;
const TIME_ZONE = process.env.TIME_ZONE || "Asia/Shanghai";
const IS_RAILWAY_RUNTIME = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const TIMELINE_FILE = path.join(DATA_DIR, "enhanced_messages.json");
const ENV_FILE = path.join(__dirname, ".env");

const app = Fastify({ logger: true });
app.register(require("@fastify/formbody"));

function readBooleanEnv(key, fallback = false) {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
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

function loadTimeline() {
  if (!fs.existsSync(TIMELINE_FILE)) return [];
  try { return fs.readJsonSync(TIMELINE_FILE); } catch { return []; }
}

function saveTimeline(messages) {
  const sp = messages.find(m => m.role === "system");
  const nonSP = messages.filter(m => m.role !== "system");
  const trimmed = nonSP.slice(-49);
  const final = sp ? [sp, ...trimmed] : trimmed;
  fs.writeJsonSync(TIMELINE_FILE, final, { spaces: 2 });
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

app.addHook("onRequest", (req, reply, done) => {
  const requestPath = req.url.split("?")[0];
  const ip = String(req.ip || req.connection.remoteAddress || "");
  
  if (requestPath.startsWith("/internal/")) {
    if (ip !== "127.0.0.1" && !ip.startsWith("::1")) {
      return reply.code(403).send({ error: "Forbidden" });
    }
  }
  
  done();
});

app.get("/healthz", async () => ({ status: "ok" }));

app.get("/v1/models", async (req, reply) => {
  reply.send({
    object: "list",
    data: [{ id: process.env.MODEL_NAME || "gateway-model", object: "model", created: 0, owned_by: "gateway" }]
  });
});

app.post("/v1/chat/completions", async (req, reply) => {
  try {
    const body = req.body;
    const kelivoMessages = body.messages || [];
    saveTimeline(kelivoMessages);
    
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
      return reply.code(response.status).header("Content-Type", upstreamContentType || "application/json").send(responseText);
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

function basicAuth(req, reply, done) {
  const auth = req.headers.authorization || "";
  const [scheme, encoded] = auth.split(" ");
  if (scheme !== "Basic" || !encoded) {
    return reply.code(401).header("WWW-Authenticate", 'Basic realm="Admin"').send("Unauthorized");
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
<head><meta charset="UTF-8"><title>Dylan Heartbeat - ntfy版</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f5f7; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 30px 20px; }
.container { max-width: 500px; width: 100%; background: white; border-radius: 16px; padding: 32px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
h2 { text-align: center; font-size: 28px; color: #333; margin-bottom: 4px; }
.subtitle { text-align: center; font-size: 12px; color: #888; margin-bottom: 24px; }
.status { background: #f8f8fa; border-radius: 12px; padding: 16px; margin-bottom: 20px; }
.status p { margin: 6px 0; font-size: 13px; color: #555; }
label { display: block; margin-top: 14px; font-weight: 500; font-size: 12px; color: #666; }
input { width: 100%; padding: 10px 12px; margin-top: 4px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; }
button { width: 100%; margin-top: 16px; padding: 12px; border: none; border-radius: 10px; font-size: 14px; font-weight: 500; cursor: pointer; }
button.save { background: #007aff; color: white; }
button.restart { background: #ff3b30; color: white; margin-top: 12px; }
</style>
</head>
<body>
<div class="container">
  <h2>HEARTBEAT</h2>
  <div class="subtitle">ntfy · AI Residency Runtime</div>
  <div class="status"><p>Gateway <strong>运行中</strong></p><p>推送渠道 <strong>${readEnvValue("PUSH_PROVIDER") || "ntfy"}</strong></p></div>
  <form id="configForm" onsubmit="saveConfig(event)">
    <label>API URL</label><input name="target_url" value="${currentUrl}">
    <label>Model Name</label><input name="model_name" value="${currentModel}">
    <label>ntfy Topic</label><input name="ntfy_topic" value="${ntfyTopic}">
    <button type="submit" class="save">保存配置</button>
  </form>
  <button onclick="restartServices()" class="restart">重启服务</button>
</div>
<script>
async function saveConfig(event) {
  event.preventDefault();
  const form = event.target;
  try {
    const resp = await fetch("/admin/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target_url: form.target_url.value.trim(), model_name: form.model_name.value.trim(), ntfy_topic: form.ntfy_topic.value.trim() }) });
    const result = await resp.json();
    if (result.success) alert("配置已保存，点击重启按钮生效");
  } catch (e) { alert("请求失败：" + e.message); }
}
async function restartServices() {
  if (!confirm("确定要重启服务吗？")) return;
  try {
    const resp = await fetch("/admin/restart", { method: "POST" });
    const result = await resp.json();
    if (result.success) alert("重启成功！页面稍后自动刷新。");
  } catch (e) { alert("重启失败：" + e.message); }
}
</script>
</body></html>`;
  reply.type("text/html").send(html);
});

app.post("/admin/save", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const { target_url, model_name, ntfy_topic } = req.body;
    if (!target_url || !model_name) return reply.code(400).send({ error: "必填项缺失" });
    
    const envLines = [
      `TARGET_API_URL=${target_url}`,
      `MODEL_NAME=${model_name}`,
      `PUSH_PROVIDER=ntfy`,
      `NTFY_TOPIC=${ntfy_topic || ""}`
    ];
    const existingKey = readEnvValue("TARGET_API_KEY");
    if (existingKey) envLines.push(`TARGET_API_KEY=${existingKey}`);
    
    fs.writeFileSync(ENV_FILE, envLines.join("\n") + "\n");
    console.log("配置已保存");
    reply.send({ success: true });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

app.post("/admin/restart", { preHandler: basicAuth }, async (req, reply) => {
  const { exec } = require("child_process");
  exec("pm2 restart all --update-env", (err) => {
    if (err) console.error("重启失败:", err);
    else console.log("服务已重启");
  });
  reply.send({ success: true });
});

app.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`✅ Gateway 运行在 ${address}`);
  console.log(`📱 推送渠道: ${readEnvValue("PUSH_PROVIDER") || "ntfy"}`);
  console.log(`🌐 管理页面: ${address}/admin`);
});

module.exports = app;