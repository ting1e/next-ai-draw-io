# Next AI Draw.io 自部署版

基于上游 [DayuanJiang/next-ai-draw-io](https://github.com/DayuanJiang/next-ai-draw-io) 改造的自部署版本：保留原有的 AI 生成 / 编辑 draw.io 图表能力，并加入多用户账号与服务器端持久化，适合自己或小团队在内网、NAS 或服务器上长期使用。

- 本仓库：https://github.com/ting1e/next-ai-draw-io
- 上游仓库：https://github.com/DayuanJiang/next-ai-draw-io
- 许可证：[Apache-2.0](./LICENSE)

## 功能

- **用户登录**：邮箱 + 密码；首个用户通过 `/setup` 创建管理员
- **多用户数据隔离**：每个用户只能访问自己的图表与历史记录
- **图表保存到服务器**：SQLite 持久化，不再只存在浏览器 IndexedDB 中
- **文件列表与历史记录**：图库、版本历史、恢复 / 重命名 / 复制 / 下载
- **跨设备继续编辑**：换浏览器或设备登录后即可看到自己的图表
- **自部署 draw.io**：使用官方 `jgraph/drawio` 镜像，通过应用同源 `/drawio/*` 代理访问，不依赖 diagrams.net
- **原有 AI 能力**：自然语言生成 / 修改图表、图片复刻、PDF / 文本导入、多 AI 提供商（OpenAI、Anthropic、Google、DeepSeek 等）
- **数据自持有**：全部数据保存在 `./data` 目录，更新镜像不会丢失

## 一键部署（Docker Compose）

只需要 Docker 与 Docker Compose，然后创建一个 `docker-compose.yml`：

```yaml
services:
    app:
        # 也可以先执行：docker pull ghcr.io/ting1e/next-ai-draw-io:latest
        image: ghcr.io/ting1e/next-ai-draw-io:latest
        restart: unless-stopped
        environment:
            # ===== 必须修改 =====
            AUTH_SECRET: 请改成随机长字符串
            AUTH_BASE_URL: http://localhost:3000
            OPENAI_API_KEY: sk-你的Key
            # ===================
            AI_PROVIDER: openai
            AI_MODEL: gpt-5.1

            DATABASE_PATH: /app/data/app.sqlite
            ALLOW_REGISTRATION: "false"
            # 安全默认值：禁止访问内网地址、关闭网页导入
            ALLOW_PRIVATE_URLS: "false"
            ENABLE_URL_FETCH: "false"
        volumes:
            - ./data:/app/data
        ports:
            - "3000:3000"
        depends_on:
            - drawio

    drawio:
        # 服务名必须是 drawio：镜像内的 /drawio 代理指向 http://drawio:8080
        image: jgraph/drawio:31.4.5
        restart: unless-stopped
        # 不需要对外暴露端口，只有 app 通过内部网络访问
```

启动：

```bash
docker compose up -d
```

然后打开 `http://localhost:3000`。

更新：

```bash
docker compose pull
docker compose up -d
```

查看日志：

```bash
docker compose logs -f
```

## 首次使用

1. 打开 `http://localhost:3000`，会自动跳转到 `/setup`
2. 创建第一个管理员账号（创建完成后 `/setup` 返回 404）
3. 默认关闭开放注册（`ALLOW_REGISTRATION: "false"`）；需要新用户时再临时打开
4. 新建 / 编辑图表会自动保存到服务器和 `./data` 目录
5. 更新镜像不会删除数据库，数据库迁移在容器启动时自动执行

## 配置说明

必须修改：

| 变量 | 说明 |
| --- | --- |
| `AUTH_SECRET` | 会话加密密钥，随机长字符串：`openssl rand -hex 32` |
| `AUTH_BASE_URL` | 浏览器实际访问地址，如 `http://192.168.1.10:3000`；填错会无法登录 |
| `OPENAI_API_KEY` | AI 提供商的 Key（按你使用的提供商替换变量名） |

常用可选：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AI_PROVIDER` | `bedrock` | `openai` / `anthropic` / `google` / `deepseek` / `ollama` 等 |
| `AI_MODEL` | - | 模型 ID（必填），如 `gpt-5.1`、`claude-sonnet-4-5` |
| `OPENAI_BASE_URL` | - | 自定义 OpenAI 兼容端点 |
| `DATABASE_PATH` | `/app/data/app.sqlite` | SQLite 路径（容器内） |
| `ALLOW_REGISTRATION` | `false` | 是否允许注册新用户 |
| `AUTH_TRUSTED_ORIGINS` | - | 多个访问域名时用逗号分隔 |
| `ALLOW_PRIVATE_URLS` | `false` | 是否允许客户端配置内网 AI 地址（如 Ollama） |
| `ENABLE_URL_FETCH` | `false` | 是否启用网页导入（`/api/parse-url`） |

更多变量与完整说明见 [`env.example`](./env.example) 和 [自部署文档](./docs/en/self-hosting.md)。

> 为了方便直接部署，示例把配置写在 `docker-compose.yml` 的 `environment` 中。
> 如果仓库是公开的，不要把包含真实 API Key、密码或 `AUTH_SECRET` 的 Compose 文件提交到 GitHub。

## 备份

`./data` 目录包含用户、登录会话、图表与历史记录，应定期备份：

```bash
tar czf drawio-data-backup-$(date +%F).tgz data/
```

也可以在容器 / 源码目录中执行 WAL 安全备份脚本：

```bash
node scripts/db-backup.mjs
```

`data/` 已在 `.gitignore` 中，**绝对不要提交到 GitHub**。

## 与上游项目的关系

本项目 fork 自 [DayuanJiang/next-ai-draw-io](https://github.com/DayuanJiang/next-ai-draw-io)（Apache-2.0），在其基础上增加了账号系统、服务端 SQLite 存储、图库与版本历史、自部署 draw.io 代理以及相关安全加固；上游原有的 AI 图表生成能力和大部分文档保持不变。

- 上游仓库与英文文档：https://github.com/DayuanJiang/next-ai-draw-io
- 本仓库自部署细节：[docs/en/self-hosting.md](./docs/en/self-hosting.md)

## License

[Apache-2.0](./LICENSE)，与上游项目一致。
