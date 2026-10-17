/// SSRF gate for main-process fetches whose target is influenced by untrusted
/// input — most importantly AI tool calls, where a poisoned web-search result
/// can steer the model into requesting an internal address. Every hop of a
/// redirect chain has to pass, because validating only the initial URL lets a
/// public host bounce the request to loopback or a cloud metadata endpoint.

import { lookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { Readable } from 'node:stream'

/**
 * Non-public address ranges. BlockList does the range math and maps
 * ::ffff:0:0/96 addresses back onto the IPv4 rules, which hand-rolled string
 * checks get wrong for normalized forms such as [::ffff:127.0.0.1], whose
 * hostname becomes ::ffff:7f00:1.
 */
const blockedAddresses = (() => {
  const list = new BlockList()
  list.addSubnet('0.0.0.0', 8) // "this network"
  list.addSubnet('10.0.0.0', 8) // private
  list.addSubnet('100.64.0.0', 10) // carrier NAT
  list.addSubnet('127.0.0.0', 8) // loopback
  list.addSubnet('169.254.0.0', 16) // link-local (cloud metadata)
  list.addSubnet('172.16.0.0', 12) // private
  list.addSubnet('192.0.0.0', 24) // IETF protocol assignments
  list.addSubnet('192.0.2.0', 24) // documentation
  list.addSubnet('192.88.99.0', 24) // deprecated 6to4 relay
  list.addSubnet('192.168.0.0', 16) // private
  list.addSubnet('198.18.0.0', 15) // benchmarking
  list.addSubnet('198.51.100.0', 24) // documentation
  list.addSubnet('203.0.113.0', 24) // documentation
  list.addSubnet('224.0.0.0', 4) // multicast
  list.addSubnet('240.0.0.0', 4) // reserved + broadcast
  list.addAddress('::', 'ipv6') // unspecified
  list.addAddress('::1', 'ipv6') // loopback
  list.addSubnet('::', 96, 'ipv6') // deprecated IPv4-compatible (::127.0.0.1)
  list.addSubnet('64:ff9b::', 96, 'ipv6') // NAT64
  list.addSubnet('100::', 64, 'ipv6') // discard-only
  list.addSubnet('2001:db8::', 32, 'ipv6') // documentation
  list.addSubnet('fc00::', 7, 'ipv6') // unique local
  list.addSubnet('fe80::', 10, 'ipv6') // link-local
  list.addSubnet('ff00::', 8, 'ipv6') // multicast
  return list
})()

/** Hostname suffixes that never denote a public host. */
const BLOCKED_HOST_SUFFIXES: readonly string[] = ['.localhost', '.local', '.internal']

/** True when `ip` is a literal address outside the public ranges (non-addresses count as unsafe). */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 0) return true
  return blockedAddresses.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}

interface PinnedAddress {
  address: string
  family: 4 | 6
}

interface SafeTarget {
  url: URL
  addresses: PinnedAddress[]
}

async function resolveSafeTarget(raw: unknown): Promise<SafeTarget | null> {
  if (typeof raw !== 'string') return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.+$/, '')
  if (!host) return null
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return null
  }
  try {
    const literal = isIP(host)
    const found = literal
      ? [{ address: host, family: literal }]
      : await lookup(host, { all: true, verbatim: true })
    if (found.length === 0 || found.some((entry) => isBlockedAddress(entry.address))) return null
    return {
      url,
      addresses: found.map((entry) => ({
        address: entry.address,
        family: entry.family === 6 ? 6 : 4,
      })),
    }
  } catch {
    return null
  }
}

/**
 * True when the URL is http(s) and its host is public. Literal addresses are
 * checked directly; hostnames are resolved and every returned address must pass,
 * so a name pointing at an internal address is rejected.
 *
 * This is a best-effort control, not a guarantee: DNS can change between this
 * check and the request (rebinding). Pair it with per-hop revalidation via
 * `fetchWithSsrfGuard` rather than relying on a single up-front check.
 */
export async function isSafeRemoteUrl(raw: unknown): Promise<boolean> {
  return (await resolveSafeTarget(raw)) !== null
}

export interface FetchWithSsrfGuardOptions {
  /** Redirect hops to follow. Each hop is revalidated. Defaults to 5. */
  maxRedirects?: number
  headers?: Record<string, string>
  signal?: AbortSignal
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

type LookupCallback = (error: null, address: string | PinnedAddress[], family?: number) => void

function pinnedLookup(addresses: PinnedAddress[]) {
  return (_host: string, options: { all?: boolean }, callback: LookupCallback): void => {
    if (options.all) callback(null, addresses)
    else callback(null, addresses[0]!.address, addresses[0]!.family)
  }
}

function responseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item)
    else if (value !== undefined) headers.set(name, value)
  }
  return headers
}

/** Connect to the exact public addresses that were checked, closing the DNS-rebinding gap. */
function pinnedFetch(
  target: SafeTarget,
  headers: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = target.url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = request(
      target.url,
      {
        method: 'GET',
        ...(headers ? { headers } : {}),
        ...(signal ? { signal } : {}),
        lookup: pinnedLookup(target.addresses) as never,
      },
      (response) => {
        const status = response.statusCode ?? 500
        const noBody = status === 204 || status === 205 || status === 304
        const body = noBody
          ? null
          : (Readable.toWeb(response) as ReadableStream<Uint8Array<ArrayBuffer>>)
        resolve(
          new Response(body, {
            status,
            statusText: response.statusMessage,
            headers: responseHeaders(response),
          }),
        )
      },
    )
    req.once('error', reject)
    req.end()
  })
}

/**
 * fetch() that validates the target before every hop, following redirects
 * manually. Returns null when any hop fails validation, a redirect lacks a
 * usable Location, or the hop budget is exhausted.
 */
export async function fetchWithSsrfGuard(
  rawUrl: string,
  options: FetchWithSsrfGuardOptions = {},
): Promise<Response | null> {
  const { maxRedirects = 5, headers, signal, fetchImpl } = options
  // maxRedirects arrives from callers (CLI flags, IPC-adjacent config): an
  // Infinity value would follow redirects forever, so normalize to 0..10.
  const hopBudget = Number.isFinite(maxRedirects)
    ? Math.min(Math.max(0, Math.floor(maxRedirects)), 10)
    : 5
  let current = rawUrl
  for (let hop = 0; hop <= hopBudget; hop++) {
    const target = await resolveSafeTarget(current)
    if (!target) return null
    // Custom fetch is a test seam. Production sockets are pinned to the DNS
    // answers validated above so a second lookup cannot rebind to an internal IP.
    const resp = fetchImpl
      ? await fetchImpl(current, {
          ...(headers ? { headers } : {}),
          ...(signal ? { signal } : {}),
          redirect: 'manual',
        })
      : await pinnedFetch(target, headers, signal)
    if (resp.status < 300 || resp.status >= 400) return resp
    const location = resp.headers.get('location')
    await resp.body?.cancel().catch(() => undefined)
    if (!location) return null
    try {
      current = new URL(location, current).toString()
    } catch {
      return null
    }
  }
  return null
}
