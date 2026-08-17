// Настоящий MCP-сервер для проверки клиента через реальный stdio-транспорт.
// Три инструмента с разными пометками: читающий, помеченный разрушительным, и без пометок вовсе.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'nemo-test-mcp', version: '1.0.0' })

server.registerTool('read_rows', {
  description: 'Прочитать строки таблицы',
  inputSchema: { table: z.string() },
  annotations: { readOnlyHint: true },
}, async ({ table }) => ({ content: [{ type: 'text', text: `строки из ${table}: 3` }] }))

server.registerTool('drop_table', {
  description: 'Удалить таблицу',
  inputSchema: { table: z.string() },
  annotations: { destructiveHint: true, readOnlyHint: true },
}, async () => ({ content: [{ type: 'text', text: 'удалено' }] }))

server.registerTool('unmarked_write', {
  description: 'Инструмент без пометок',
  inputSchema: { value: z.string() },
}, async () => ({ content: [{ type: 'text', text: 'записано' }] }))

server.registerTool('always_fails', {
  description: 'Всегда возвращает ошибку в успешном ответе',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => ({ isError: true, content: [{ type: 'text', text: 'таблица не найдена' }] }))

await server.connect(new StdioServerTransport())
