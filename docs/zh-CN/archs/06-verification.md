# 本地开发

使用 Node.js 22.13 或更高版本，在仓库根目录依次运行：

```sh
npm ci
npm run check
npm run build
npm test
```

构建会共享运行时产物，请避免同时启动多个构建。修改执行器时，还应检查参数校验、取消、超时和结果处理。涉及麦克风、摄像头或外部服务的功能，需要使用自己的设备和凭据实际运行。

产品运行时仅使用 Node.js 与 TypeScript。Codex 只通过 app-server 接入；JSONL 仅用于解析测试夹具。

供应商验证使用可选的在线 smoke：`npm run test:live --workspace @nova-audio-agent/runtime`。它使用你配置的凭据，可能产生服务费用；普通测试通过不代表麦克风、扬声器或在线供应商已验收。
