import http from 'node:http'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {runSmoke, SMOKE_ENVIRONMENTS} from './src/smoke/smoke.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HOST = process.env.SMOKE_HOST || '127.0.0.1'
const PORT = Number(process.env.SMOKE_PORT || 3100)

const STATIC_FILES = {
    '/': ['ui/index.html', 'text/html; charset=utf-8'],
    '/app.js': ['ui/app.js', 'text/javascript; charset=utf-8'],
    '/vue.js': ['node_modules/vue/dist/vue.esm-browser.prod.js', 'text/javascript; charset=utf-8'],
}

let running = false

function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'})
    res.end(JSON.stringify(data))
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let body = ''
        req.on('data', (chunk) => {
            body += chunk
            if (body.length > 10000) {
                reject(new Error('Слишком большой запрос'))
                req.destroy()
            }
        })
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {})
            } catch {
                reject(new Error('Некорректный JSON'))
            }
        })
        req.on('error', reject)
    })
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)

    try {
        if (req.method === 'GET' && url.pathname === '/api/options') {
            return sendJson(res, 200, {
                environments: Object.entries(SMOKE_ENVIRONMENTS).map(([value, env]) => ({
                    value,
                    label: env.label,
                    baseUrl: env.baseUrl,
                })),
            })
        }

        if (req.method === 'POST' && url.pathname === '/api/run') {
            if (running) return sendJson(res, 409, {error: 'Проверка уже выполняется'})

            const body = await readJson(req)
            running = true
            try {
                const result = await runSmoke({environment: body.environment})
                return sendJson(res, 200, result)
            } finally {
                running = false
            }
        }

        const file = STATIC_FILES[url.pathname]
        if (req.method === 'GET' && file) {
            const data = await readFile(path.join(__dirname, file[0]))
            res.writeHead(200, {'Content-Type': file[1], 'Cache-Control': 'no-store'})
            return res.end(data)
        }

        sendJson(res, 404, {error: 'Не найдено'})
    } catch (error) {
        sendJson(res, 400, {error: error.message})
    }
})

server.listen(PORT, HOST, () => {
    console.log(`Доступность страниц: http://${HOST}:${PORT}`)
})
