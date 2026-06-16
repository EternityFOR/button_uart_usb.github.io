# button_uart_usb.github.io

GitHub Pages 公开托管成本表页面。成本明细不直接写在 HTML 里，公开仓库只提交 `data/cost-vault.json` 密文包；每个产品用单独 token 在浏览器里解锁。

## 目录

```text
index.html              GitHub Pages 入口
cost-planner.html       成本表备用入口，和 index.html 保持一致
data/cost-vault.json    公开提交的加密成本包
tools/                  本地维护脚本
workers/                Cloudflare Worker 同步接口源码
.private/products/      私有产品明文源，不提交
.private/tokens.txt     私有 token 记录，不提交
```

## 私有数据流程

1. 每个产品一个私有源文件，放在 `.private/products/<product-id>.json`，该目录已被 `.gitignore` 忽略。
2. 更新或新增产品后，运行：

```bash
node tools/build-cost-vault.mjs
```

3. 只提交生成的 `data/cost-vault.json`、页面和工具脚本，不提交 `.private/`。
4. token 私下发给需要查看对应产品成本的人。页面不会把 token 存入 GitHub，也不会写入浏览器持久存储。

本地预览：

```bash
node tools/dev-server.mjs
```
