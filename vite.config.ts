import { defineConfig, type Plugin } from 'vite'

interface ProxyRequest {
  socket?: { remoteAddress?: string, localAddress?: string }
  url?: string
}

interface ProxyResponse {
  writeHead(statusCode: number, headers?: Record<string, string>): ProxyResponse
  end(data?: string | Uint8Array): void
}

const maximumImageBytes = 25 * 1024 * 1024

function isLoopback(request: ProxyRequest): boolean {
  return Boolean(request.socket?.remoteAddress && request.socket.remoteAddress === request.socket.localAddress)
}

async function proxyOnlineImage(request: ProxyRequest, response: ProxyResponse): Promise<void> {
  if (!isLoopback(request)) {
    response.writeHead(403).end('Online image proxy is only available locally.')
    return
  }
  const requestUrl = new URL(request.url ?? '/', 'http://localhost')
  const targetValue = requestUrl.searchParams.get('url')
  if (!targetValue) {
    response.writeHead(400).end('Missing image URL.')
    return
  }
  let target: URL
  try { target = new URL(targetValue) }
  catch { response.writeHead(400).end('Invalid image URL.'); return }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    response.writeHead(400).end('Only HTTP and HTTPS images are supported.')
    return
  }
  try {
    const upstream = await fetch(target, { signal: AbortSignal.timeout(15_000) })
    if (!upstream.ok) {
      response.writeHead(upstream.status).end(`Online image returned HTTP ${upstream.status}.`)
      return
    }
    const declaredLength = Number(upstream.headers.get('content-length') ?? 0)
    if (declaredLength > maximumImageBytes) {
      response.writeHead(413).end('Online image exceeds 25 MB.')
      return
    }
    const bytes = await upstream.arrayBuffer()
    if (bytes.byteLength > maximumImageBytes) {
      response.writeHead(413).end('Online image exceeds 25 MB.')
      return
    }
    response.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, max-age=300',
    })
    response.end(new Uint8Array(bytes))
  } catch (error) {
    response.writeHead(502).end(error instanceof Error ? error.message : 'Online image download failed.')
  }
}

function onlineImageProxy(): Plugin {
  return {
    name: 'wall-display-online-image-proxy',
    configureServer(server) {
      server.middlewares.use('/__online_image', (request, response) => { void proxyOnlineImage(request as unknown as ProxyRequest, response) })
    },
    configurePreviewServer(server) {
      server.middlewares.use('/__online_image', (request, response) => { void proxyOnlineImage(request as unknown as ProxyRequest, response) })
    },
  }
}

export default defineConfig({ plugins: [onlineImageProxy()] })
