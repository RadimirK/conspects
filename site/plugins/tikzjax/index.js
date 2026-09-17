import fs from "fs"
import path from "path"
import crypto from "crypto"
import { visit } from "unist-util-visit"
import { h } from "preact"
import { joinSegments, pathToRoot } from "@quartz-community/utils"
import tikzModule from "node-tikzjax"

const tex2svg = tikzModule.default ?? tikzModule

const CACHE_DIR = path.join(process.cwd(), ".quartz-cache", "tikzjax")

// node-tikzjax keeps global WASM state, so only one compile may run at a time.
let queue = Promise.resolve()

/** Normalise the TeX source the same way the Obsidian TikZJax plugin does. */
function tidyTikzSource(source) {
  return source
    .replaceAll("&nbsp;", "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
}

/**
 * TikZ draws in plain black on white. Swap those for Quartz's theme tokens so
 * diagrams stay readable in dark mode; explicit colours (blue, red, ...) stay.
 */
function themeSvg(svg) {
  return svg
    .replaceAll('"#000"', '"currentColor"')
    .replaceAll('"#000000"', '"currentColor"')
    .replaceAll('"black"', '"currentColor"')
    .replaceAll('"#fff"', '"var(--light)"')
    .replaceAll('"#ffffff"', '"var(--light)"')
    .replaceAll('"white"', '"var(--light)"')
}

function cachePathFor(source) {
  const key = crypto.createHash("sha256").update(source).digest("hex").slice(0, 32)
  return path.join(CACHE_DIR, `${key}.svg`)
}

async function renderTikz(source, opts) {
  const cacheFile = cachePathFor(JSON.stringify(opts) + source)
  try {
    return fs.readFileSync(cacheFile, "utf8")
  } catch {
    // not cached yet
  }

  const render = queue.then(() => tex2svg(source, { ...opts, showConsole: false }))
  // keep the chain alive even if this render throws
  queue = render.catch(() => {})

  const svg = themeSvg(await render)
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  fs.writeFileSync(cacheFile, svg)
  return svg
}

function escapeHtml(str) {
  return str.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])
}

const DEFAULT_TEX_PACKAGES = { amsmath: "", amssymb: "", amsfonts: "" }

export default ((opts) => ({
  name: "TikZJax",
  markdownPlugins() {
    return [
      () => async (tree, file) => {
        const jobs = []
        visit(tree, "code", (node) => {
          if (node.lang !== "tikz") return
          jobs.push(node)
        })

        if (jobs.length === 0) return
        file.data.hasTikz = true

        const renderOpts = {
          texPackages: opts?.texPackages ?? DEFAULT_TEX_PACKAGES,
          tikzLibraries: opts?.tikzLibraries ?? "",
          addToPreamble: opts?.addToPreamble ?? "",
        }

        for (const node of jobs) {
          const source = tidyTikzSource(node.value)
          let html
          try {
            html = `<figure class="tikzjax">${await renderTikz(source, renderOpts)}</figure>`
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            console.warn(`[TikZJax] failed to render a diagram in ${file.path}: ${message}`)
            html =
              `<figure class="tikzjax tikzjax-error">` +
              `<p>Не удалось отрисовать TikZ-диаграмму.</p>` +
              `<pre><code>${escapeHtml(source)}</code></pre>` +
              `</figure>`
          }
          node.type = "html"
          node.value = html
          delete node.lang
          delete node.meta
        }
      },
    ]
  },
  externalResources() {
    return {
      css: [
        {
          inline: true,
          content: `
figure.tikzjax {
  margin: 1rem 0;
  padding: 0;
  overflow-x: auto;
  text-align: center;
}
figure.tikzjax svg {
  max-width: 100%;
  height: auto;
}
figure.tikzjax-error {
  border-left: 3px solid var(--secondary);
  padding-left: 0.8rem;
}
`,
        },
      ],
      additionalHead: [
        (pageData) => {
          if (!pageData?.hasTikz) return null
          const base = pathToRoot(pageData.slug)
          return h("link", {
            rel: "stylesheet",
            href: joinSegments(base, "static/tikzjax/fonts.css"),
          })
        },
      ],
    }
  },
}))
