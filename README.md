# dsh-openai-api

把当前 DeepSeek Harness 配置里**可用的模型**通过本机 HTTP 以 **OpenAI 兼容**协议开放出来。
插件本身不创建会话、不写入聊天记录，只复用 Host 的 `llm` 服务。

- 默认地址：`http://127.0.0.1:8787`
- 默认只监听回环地址，不对局域网暴露
- 纯 Host 插件，无第三方依赖，无需构建

## 安装

用 Plugin Manager 把本目录作为 bundle 安装：

```
plugin_manager action=install_bundle target="C:\Users\qian\Desktop\dsh-api-server"
```

安装后配置层（`cordis.patch.yml`）会新增一行：

```yaml
- insert:
    - id: dsh-openai-api
      name: '@local/dsh-openai-api'
      config:
        host: 127.0.0.1
        port: 8787
        apiKey: ''
```

## 配置项

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 监听地址。改成 `0.0.0.0` 会暴露到局域网，请配合 `apiKey` 使用 |
| `port` | `8787` | 监听端口；被占用时插件会以失败状态提示改端口 |
| `apiKey` | `""` | 非空时要求 `Authorization: Bearer <key>`（或 `x-api-key`） |
| `defaultModel` | `""` | 请求不带 `model` 时使用的路由，格式 `provider/model` |
| `defaultMaxTokens` | `0` | 客户端未给 `max_tokens` 时的输出上限；`0` 表示交给 provider 默认值 |
| `timeoutMs` | `600000` | 单次请求总超时 |
| `maxBodyBytes` | `25165824` | 请求体上限（约 24 MiB） |
| `cors` | `true` | 是否发送 CORS 头 |
| `exposeReasoning` | `true` | 是否在 `reasoning_content` 中返回推理内容 |

修改 `C:\Users\qian\.dsh\profiles\desktop\cordis.patch.yml` 里对应的 `config` 即可，无需改插件代码。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/models` | 模型列表，`id` 形如 `deepseek-account/deepseek-flash` |
| GET | `/v1/models/{id}` | 单个模型 |
| POST | `/v1/chat/completions` | 对话，支持 `stream`、`tools`、`tool_choice` |
| POST | `/v1/completions` | 旧版文本补全（单条字符串 prompt） |
| GET | `/`、`/health` | 服务信息与存活检查 |

模型寻址规则：

1. `/v1/models` 里列出的 `id` 原样发回，一定路由到发布它的那个 provider（provider 自身的 id 带 `/` 也不会错）；
2. 手写 `provider/model` 时，provider 已注册即可路由，模型不必出现在目录中（兼容不做 discovery 的 adapter）；
3. provider 未注册时返回 404 `provider_not_found`，不再把拼错的 provider 静默转发到上游；
4. 裸模型名（如 `deepseek-flash`）仅在目录中唯一匹配时使用；多个 provider 同名时返回 400 `model_ambiguous` 并列出全部候选；
5. 裸模型名在目录中不存在时返回 404（避免拼写错误静默发到上游）；
6. 目录因鉴权等原因完全取不到时，回退到唯一 provider 或 `defaultModel`。

`GET /v1/models/{id}` 与对话接口使用同一套匹配规则：裸名有歧义同样返回 400，非法百分号编码返回 400 `invalid_model_id`。

## 调用示例

```bash
curl http://127.0.0.1:8787/v1/models

curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-account/deepseek-flash",
    "messages": [{"role": "user", "content": "用一句话介绍你自己"}],
    "stream": true
  }'
```

Python（官方 `openai` SDK）：

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="not-needed")
resp = client.chat.completions.create(
    model="deepseek-account/deepseek-flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

函数调用：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-account/deepseek-flash",
    "messages": [{"role": "user", "content": "北京现在天气怎么样？"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "查询城市天气",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
      }
    }]
  }'
```

在 Cherry Studio / Chatbox / Open WebUI 等客户端里新建 “OpenAI 兼容” 服务商，Base URL 填
`http://127.0.0.1:8787/v1`，API Key 留空（或填配置里的 `apiKey`），即可从 `/v1/models` 拉取模型。

## 支持范围

- 文本对话、流式 SSE、`stream_options.include_usage`
- 工具调用（`tools` / `tool_choice`），含多轮 `tool` 结果回填
- `temperature`、`max_tokens` / `max_completion_tokens`、`stop`、`reasoning_effort`
- 推理内容以 `reasoning_content` 返回（DeepSeek 客户端兼容字段）
- 旧版 `/v1/completions`

暂不支持：

- 图片输入（`image_url` / `input_image` 会返回 400）
- `n > 1`、`logprobs`、`response_format`、`seed`、惩罚类参数（忽略或报错）
- 服务端会话记忆：每次请求独立，历史由客户端按 OpenAI 规范回传

## 安全说明

- 默认仅监听 `127.0.0.1`，等价于“本机已登录用户可调用”
- 绑定到 `0.0.0.0` 前务必设置 `apiKey`
- 请求直接使用 Host 已配置的 provider 凭据，不会额外保存任何密钥

## 排错

- 插件行显示失败且提示端口占用：改 `port` 或释放端口
- `/v1/models` 为空：说明当前 profile 没有已注册的 provider，或 provider 鉴权失败；查看 Host 日志
- 400 `unsupported_content`：请求里带了图片
- 502 `upstream_error`：上游模型报错，`error.message` 是 provider 原文
