/** Regenerate platform icons and the favicon from the shared, unmodified logo.
 * Run: node tools/gen-branding-icons.mjs
 * Uses the existing Playwright dependency and installed Chrome.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const assets = join(root, 'packages/ui/src/assets')
const source = readFileSync(join(assets, 'smackedoffice-logo.png'))
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const images = new Map()
const macImages = new Map()
try {
  const page = await browser.newPage()
  for (const size of sizes) {
    for (const mac of [false, true]) {
      const data = await page.evaluate(
        async ({ src, size, mac }) => {
          // Browser globals inside Playwright evaluation.
          // eslint-disable-next-line no-undef
          const img = new Image()
          img.src = src
          await img.decode()
          // eslint-disable-next-line no-undef
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = size
          const ctx = canvas.getContext('2d')
          ctx.imageSmoothingEnabled = true
          ctx.imageSmoothingQuality = 'high'
          const scale = (size * (mac ? 824 / 1024 : 1)) / Math.max(img.width, img.height)
          const width = img.width * scale
          const height = img.height * scale
          ctx.drawImage(img, (size - width) / 2, (size - height) / 2, width, height)
          return canvas.toDataURL('image/png').split(',')[1]
        },
        { src: `data:image/png;base64,${source.toString('base64')}`, size, mac },
      )
      ;(mac ? macImages : images).set(size, Buffer.from(data, 'base64'))
    }
  }
} finally {
  await browser.close()
}

// PNG-backed ICO entries preserve alpha and cover Windows scaling factors.
const winSizes = sizes.filter((size) => size <= 256)
const icoHeader = Buffer.alloc(6 + 16 * winSizes.length)
icoHeader.writeUInt16LE(1, 2)
icoHeader.writeUInt16LE(winSizes.length, 4)
let offset = icoHeader.length
for (const [i, size] of winSizes.entries()) {
  const png = images.get(size)
  const entry = 6 + i * 16
  icoHeader[entry] = icoHeader[entry + 1] = size === 256 ? 0 : size
  icoHeader.writeUInt16LE(1, entry + 4)
  icoHeader.writeUInt16LE(32, entry + 6)
  icoHeader.writeUInt32LE(png.length, entry + 8)
  icoHeader.writeUInt32LE(offset, entry + 12)
  offset += png.length
}
const ico = Buffer.concat([icoHeader, ...winSizes.map((size) => images.get(size))])

// Modern ICNS PNG chunks, including Retina representations; no macOS tool needed.
const icnsEntries = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
].map(([type, size]) => {
  const png = macImages.get(size)
  const header = Buffer.alloc(8)
  header.write(type)
  header.writeUInt32BE(8 + png.length, 4)
  return Buffer.concat([header, png])
})
const icnsHeader = Buffer.alloc(8)
icnsHeader.write('icns')
icnsHeader.writeUInt32BE(8 + icnsEntries.reduce((total, entry) => total + entry.length, 0), 4)
const icns = Buffer.concat([icnsHeader, ...icnsEntries])

writeFileSync(join(assets, 'favicon.png'), images.get(32))
for (const app of ['shell', 'docs', 'slides']) {
  const build = join(root, 'apps', app, 'build')
  mkdirSync(join(build, 'icons'), { recursive: true })
  writeFileSync(join(build, 'icon.png'), source)
  writeFileSync(join(build, 'icon-mac.png'), macImages.get(1024))
  writeFileSync(join(build, 'icon.ico'), ico)
  writeFileSync(join(build, 'icon.icns'), icns)
  for (const size of sizes.filter((size) => size !== 24)) {
    writeFileSync(join(build, 'icons', `${size}x${size}.png`), images.get(size))
  }
}
console.log('Generated favicon and shell, Docs, Slides platform icons from the shared logo.')
