require("dotenv").config({ quiet: true });

const { exec } = require("child_process");

console.log("开始一体化启动 Gateway + wake-up...");

const gatewayProcess = exec("node server.js");
gatewayProcess.stdout.on("data", (data) => console.log(`Gateway: ${data}`));
gatewayProcess.stderr.on("data", (data) => console.error(`Gateway Error: ${data}`));
console.log("Gateway 进程已启动");

const wakeUpProcess = exec("node wake_up.js");
wakeUpProcess.stdout.on("data", (data) => console.log(`WakeUp: ${data}`));
wakeUpProcess.stderr.on("data", (data) => console.error(`WakeUp Error: ${data}`));
console.log("WakeUp 进程已启动");

process.on("SIGINT", () => {
  console.log("收到中断信号，关闭进程...");
  gatewayProcess.kill();
  wakeUpProcess.kill();
  process.exit(0);
});