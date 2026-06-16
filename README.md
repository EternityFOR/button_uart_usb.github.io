# DeDge Cost Planner

Diractive Edge 内部成本计算工具。页面使用 `data/cost-vault.json` 提供加密产品数据，输入访问码后在浏览器内解锁。

## 目录

```text
index.html                 页面入口
cost-planner.html          备用入口，和 index.html 保持一致
data/cost-vault.json       加密成本包
tools/                     本地维护脚本
workers/                   Cloudflare Worker 同步接口源码
.private/products/         私有产品源
.private/access-codes.txt  访问码记录
```

## 维护流程

1. 每个产品一个私有源文件，放在 `.private/products/<product-id>.json`。
2. 更新或新增产品后，运行：

```bash
node tools/build-cost-vault.mjs
```

3. 提交生成的 `data/cost-vault.json`、页面和工具脚本。
4. 访问码记录：`.private/access-codes.txt`。

本地预览：

```bash
node tools/dev-server.mjs
```
