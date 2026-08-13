require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL || `http://localhost:${PORT}`;
const GATEWAY_URL = `${GATEWAY_BASE_URL}/internal/wake-event`;
const HEARTBEAT_URL = `${GATEWAY_BASE_URL}/internal/heartbeat`;
const TIME_ZONE = process.env.TIME_ZONE || "Asia/Shanghai";
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const TIMELINE_PATH = path.join(DATA_DIR, "enhanced_messages.json");
const DIARY_DIR_NAME = process.env.DIARY_DIR || "diary";
const DIARY_DIR_PATH = path.join(DATA_DIR, DIARY_DIR_NAME);
const PUSH_TIMEOUT_MS = Number(process.env.PUSH_TIMEOUT_MS) || 15000;
const WAKE_UPSTREAM_TIMEOUT_MS = Number(process.env.WAKE_UPSTREAM_TIMEOUT_MS) || 300000;

function readBooleanEnv(key, fallback = false) {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function readNumberEnv(key, fallback) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : fallback;
}

function getChinaTimeString() {
  return new Date().toLocaleString("zh-CN", { timeZone: TIME_ZONE });
}

function extractDiaryFromResponse(text) {
  const diaryBlocks = [];
  const remainingText = String(text || "").replace(/\[DIARY\]([\s\S]*?)\[\/DIARY\]/gi, (_, content) => {
    if (content.trim()) diaryBlocks.push(content.trim());
    return "";
  }).trim();
  return { diaryContent: diaryBlocks.join("\n\n"), remainingText };
}

function appendDiaryEntry(content) {
  if (!readBooleanEnv("DIARY_ENABLED", true) || !content.trim()) return false;
  fs.mkdirSync(DIARY_DIR_PATH, { recursive: true });
  const now = new Date();
  const dateStr = now.toLocaleDateString("zh-CN", { timeZone: TIME_ZONE }).replace(/\//g, "-");
  const timeStr = now.toLocaleTimeString("zh-CN", { timeZone: TIME_ZONE, hour12: false }).slice(0, 5);
  const diaryFile = path.join(DIARY_DIR_PATH, `${dateStr}.md`);
  const entry = `\n\n## ${timeStr}\n\n${content}\n`;
  fs.appendFileSync(diaryFile, entry, "utf-8");
  console.log(`已保存日记：${diaryFile}`);
  return true;
}

async function sendPushNotification({ title, body }) {
  const topic = String(process.env.NTFY_TOPIC || "").trim();
  if (!topic) return { ok: false, reason: "NTFY_TOPIC 未配置" };
  
  const server = (process.env.NTFY_SERVER_URL || "https://ntfy.sh").replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json" };
  if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
  
  const payload = { topic: topic, title: title || "来自AI", message: body };
  
  try {
    const response = await fetch(server, {
      method: "POST",
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      headers,
      body: JSON.stringify(payload)
    });
    if (response.ok) return { ok: true, providerLabel: "ntfy" };
    return { ok: false, reason: `HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function loadTimeline() {
  if (!fs.existsSync(TIMELINE_PATH)) {
    console.log("未找到 enhanced_messages.json，需要先有对话记录");
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(TIMELINE_PATH, "utf-8"));
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    console.error("读取时间线失败:", err.message);
    return null;
  }
}

function getLastUserTime(messages) {
  const reversed = [...messages].reverse();
  for (const msg of reversed) {
    if (msg.role === "user" && msg.content) {
      const content = typeof msg.content === "string" ? msg.content : "";
      const match = content.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}[\sT]\d{1,2}:\d{2}/);
      if (match) {
        try { return new Date(match[0].replace("T", " ")); } catch {}
      }
    }
  }
  return null;
}

function isDayTime(date = new Date()) {
  const hour = date.getHours();
  const start = readNumberEnv("WAKE_DAY_START_HOUR", 10);
  const end = readNumberEnv("WAKE_DAY_END_HOUR", 24);
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function getWakeAfterMinutes(date = new Date()) {
  return isDayTime(date) ? readNumberEnv("DAY_WAKE_AFTER_MINUTES", 60) : readNumberEnv("NIGHT_WAKE_AFTER_MINUTES", 120);
}

function getCheckIntervalMinutes(date = new Date()) {
  return isDayTime(date) ? readNumberEnv("DAY_CHECK_INTERVAL_MINUTES", 10) : readNumberEnv("NIGHT_CHECK_INTERVAL_MINUTES", 120);
}

function shouldWake(lastUserTime) {
  const now = new Date();
  const diffMinutes = Math.floor((now - lastUserTime) / 1000 / 60);
  return diffMinutes >= getWakeAfterMinutes(now);
}

function buildWakePrompt(diffMinutes) {
  return `
## 最高优先级规则
1. 这是后台自动唤醒，不是用户发起的对话。你没有收到任何新消息。
2. 你的唯一任务是决定是否主动联系用户。
3. 输出格式必须严格遵守以下二选一。

## 唤醒信息
- 当前时间：${getChinaTimeString()}
- 距离用户最后一条消息：${diffMinutes} 分钟

## 输出格式
- 如果想联系用户，直接写你想说的话。第一行作为标题，第二行作为正文。
- 如果不想联系，只输出：[NO_ACTION]，可附带简短原因。
- 如果想写日记，可以额外输出 [DIARY]...[/DIARY]。
`;
}

async function runWakeUp() {
  console.log("\n==========================");
  console.log("开始自动唤醒检查");
  console.log("==========================\n");

  const messages = loadTimeline();
  if (!messages) return;

  const lastUserTime = getLastUserTime(messages);
  if (!lastUserTime) {
    console.log("未找到用户时间戳");
    return;
  }

  const now = new Date();
  const diffMinutes = Math.floor((now - lastUserTime) / 1000 / 60);

  if (!shouldWake(lastUserTime)) {
    console.log(`\n暂不需要唤醒（还需等待 ${getWakeAfterMinutes(now) - diffMinutes} 分钟）\n`);
    return;
  }

  const wakePrompt = buildWakePrompt(diffMinutes);
  
  // 构建消息历史
  const historyText = messages
    .filter(msg => msg.role !== "system" && msg.content)
    .map(msg => {
      const role = msg.role === "user" ? "用户" : "AI";
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      return `[${role}] ${content}`;
    })
    .slice(-20)
    .join("\n\n");

  const wakeMessages = [
    { role: "system", content: [wakePrompt, messages.find(m => m.role === "system")?.content || ""].filter(Boolean).join("\n\n") },
    { role: "user", content: `以下是最近的聊天记录：\n\n${historyText}` }
  ];

  if (!process.env.TARGET_API_URL || !process.env.TARGET_API_KEY || !process.env.MODEL_NAME) {
    console.log("缺少必要配置，跳过本次唤醒");
    return;
  }

  try {
    const response = await fetch(process.env.TARGET_API_URL, {
      method: "POST",
      signal: AbortSignal.timeout(WAKE_UPSTREAM_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.TARGET_API_KEY}`
      },
      body: JSON.stringify({ model: process.env.MODEL_NAME, messages: wakeMessages, temperature: 0.8, top_p: 0.95, stream: false })
    });

    const responseText = await response.text();
    let data;
    try { data = JSON.parse(responseText); } catch (error) { console.error("响应解析失败:", error.message); return; }
    
    if (!response.ok) {
      console.error(`模型请求失败（HTTP ${response.status}）`);
      return;
    }

    const rawAiText = (data.choices?.[0]?.message?.content || "").trim();
    console.log("AI回复:", rawAiText.substring(0, 100) + (rawAiText.length > 100 ? "..." : ""));

    // 提取日记
    const diaryResult = extractDiaryFromResponse(rawAiText);
    appendDiaryEntry(diaryResult.diaryContent);
    const aiText = diaryResult.remainingText;

    let eventContent;
    if (!aiText) {
      eventContent = `（${getChinaTimeString()} 自动唤醒：本次未发送推送｜原因：模型空回复）`;
    } else if (aiText.match(/^\[NO_ACTION\]/)) {
      const reason = aiText.replace(/^\[NO_ACTION\]\s*/, "").trim();
      eventContent = reason ? `（${getChinaTimeString()} 自动唤醒：本次未发送推送｜原因：${reason}）` : `（${getChinaTimeString()} 自动唤醒：本次未发送推送）`;
    } else {
      const lines = aiText.split("\n").filter(l => l.trim());
      const title = lines[0]?.trim() || "来自AI";
      const body = lines.slice(1).join(" ").trim() || lines[0];
      
      const pushResult = await sendPushNotification({ title, body });
      if (pushResult.ok) {
        eventContent = `（${getChinaTimeString()} 刚刚给用户发了ntfy推送：${title}｜${body.substring(0, 50)}${body.length > 50 ? "..." : ""}）`;
      } else {
        console.log(`ntfy推送失败：${pushResult.reason}`);
        eventContent = `（${getChinaTimeString()} 自动唤醒：本次未发送推送｜原因：ntfy推送失败：${pushResult.reason}）`;
      }
    }

    try {
      await fetch(GATEWAY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: eventContent })
      });
      console.log("已记录唤醒事件到Gateway");
    } catch (err) {
      console.error("记录事件失败:", err.message);
    }

  } catch (err) {
    console.error("唤醒检查出错:", err.message);
  }
}

function scheduleNextCheck() {
  const intervalMs = getCheckIntervalMinutes(new Date()) * 60 * 1000;
  setTimeout(() => {
    runWakeUp().then(scheduleNextCheck);
  }, intervalMs);
}

console.log("\n==================================");
console.log("Dylan Heartbeat Runtime (ntfy版) 已启动");
console.log("推送渠道: ntfy");
console.log("时间线:", TIMELINE_PATH);
console.log("检查间隔: 白天" + getCheckIntervalMinutes(new Date()) + "分钟/夜间" + getCheckIntervalMinutes(new Date()) + "分钟");
console.log("==================================\n");

setTimeout(scheduleNextCheck, 10_000);
