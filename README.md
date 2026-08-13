# Dylan Heartbeat - ntfy推送版

一个给 Kelivo AI伴侣使用的常驻插件，使用ntfy推送代替Bark。

## 特性

- 🧠 持续上下文记忆
- ⏰ 自动唤醒AI
- 📳 ntfy手机推送
- 🕰️ 长期时间感
- 📔 自动日记

## 快速开始

1. Fork本仓库
2. 配置 `.env` 文件
3. 安装依赖：`npm install`
4. 启动服务：
   ```bash
   node server.js      # 启动Gateway
   node wake_up.js     # 启动自动唤醒
   ```

## ntfy配置

在 `.env` 中设置：
```
PUSH_PROVIDER=ntfy
NTFY_SERVER_URL=https://ntfy.sh
NTFY_TOPIC=你的随机topic
```

## 许可证

MIT License
