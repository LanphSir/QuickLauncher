#!/usr/bin/env node
/**
 * 冒烟用的最小 MCP server（v0.6.4）。
 *
 * 只实现工具场景需要的三个方法：initialize / tools/list / tools/call。
 * 传输是「一行一条 JSON-RPC」，与真实 server 一致——冒烟要验的正是这层分帧
 * 与握手，用真 server 反而会因为网络和依赖变得不可重复。
 *
 * 提供的工具：
 *   echo   —— 只读，原样返回输入（验「列出来 → 调通」）
 *   crash  —— 被调用时直接退出（验「server 崩了，对话还能继续」）
 */
import { createInterface } from 'node:readline'

const SERVER_INFO = { name: 'smoke-mcp', version: '0.0.0' }
const PROTOCOL_VERSION = '2024-11-05'

const TOOLS = [
  {
    name: 'echo',
    title: '回声',
    description: '把输入原样返回。用来验证 MCP 工具能被列出并调用。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要原样返回的文字' } },
      required: ['text']
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'crash',
    title: '让服务崩掉',
    description: '调用即退出进程，用来验证 MCP server 崩溃后对话仍可用。',
    inputSchema: { type: 'object', properties: {} },
    annotations: { destructiveHint: true }
  }
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return
  }
  const { id, method, params } = message ?? {}
  if (method === undefined) return // 我们不发请求，收到响应直接忽略

  // 通知没有 id，不需要回
  if (id === undefined || id === null) return

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO
    })
    return
  }

  if (method === 'tools/list') {
    reply(id, { tools: TOOLS })
    return
  }

  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments ?? {}
    if (name === 'echo') {
      reply(id, { content: [{ type: 'text', text: `回声：${String(args.text ?? '')}` }] })
      return
    }
    if (name === 'crash') {
      // 故意不回执直接退出：模拟真实 server 被 OOM/信号杀掉
      process.exit(7)
    }
    fail(id, -32602, `没有这个工具：${String(name)}`)
    return
  }

  fail(id, -32601, `不支持的方法：${String(method)}`)
})

rl.on('close', () => process.exit(0))
