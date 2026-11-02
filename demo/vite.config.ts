/**
 * Builds the v0 browser demo into dist/demo/index.html: ONE self-contained file (script and styles
 * inlined), so it opens straight from disk (file://, where browsers refuse external module scripts)
 * and can be hosted as-is on GitHub Pages or any static host.  Run: npm run demo:build
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

function git(args: string): string {
  return execSync(`git ${args}`, { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }).trim();
}

function commitId(): string {
  try {
    return git('rev-parse --short HEAD') + (git('status --porcelain') ? '-dirty' : '');
  } catch {
    return 'unknown';
  }
}

/** Inline the entry chunk and the stylesheet into index.html and drop the separate files. */
function inlineIntoHtml(): Plugin {
  return {
    name: 'hui-inline-into-html',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const page = Object.values(bundle).find((f) => f.type === 'asset' && f.fileName.endsWith('.html'));
      if (!page || page.type !== 'asset') throw new Error('index.html not found in the bundle');
      let html = String(page.source);
      for (const [fileName, file] of Object.entries(bundle)) {
        const ref = new RegExp(`<(script|link)[^>]*(src|href)="[^"]*${fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>(</script>)?`);
        if (file.type === 'chunk') {
          if (!ref.test(html)) throw new Error(`no <script> for ${fileName}`);
          // function replacements: the code contains "$&"-like sequences that string replacements would expand
          const code = file.code.replace(/<\/script/gi, '<\\/script');
          html = html.replace(ref, () => `<script type="module">${code}</script>`);
          delete bundle[fileName];
        } else if (fileName.endsWith('.css')) {
          if (!ref.test(html)) throw new Error(`no <link> for ${fileName}`);
          html = html.replace(ref, () => `<style>${String(file.source)}</style>`);
          delete bundle[fileName];
        }
      }
      page.source = html;
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  define: {
    __HUI_COMMIT__: JSON.stringify(commitId()),
    __HUI_BUILT__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  plugins: [inlineIntoHtml()],
  build: {
    outDir: fileURLToPath(new URL('../dist/demo', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: { polyfill: false },
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    chunkSizeWarningLimit: 4096,
    reportCompressedSize: false,
  },
  logLevel: 'warn',
});
