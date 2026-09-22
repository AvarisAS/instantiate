import { createServer } from 'node:http';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { scan, applyDismissals, loadDismissals } from '../api.js';
import { renderHtmlReport } from './html.js';
import { bold, dim, cyan, green } from '../util/term.js';

/**
 * Live UI: the same report, rebuilt when the code changes.
 *
 * The file is what travels; this is what you keep open while working. Both
 * render from one scan, so there is no second implementation of the visuals to
 * drift out of step with the first.
 */
export async function serve(root: string, port: number): Promise<void> {
  let version = 0;
  let html = '';
  let building = false;

  const rebuild = (): void => {
    if (building) return;
    building = true;
    const start = Date.now();
    try {
      const result = scan({ root });
      const findings = applyDismissals(result.findings, loadDismissals(root));
      html = inject(renderHtmlReport(result, findings), version + 1);
      version++;
      console.log(
        `${green('✓')} rebuilt ${dim(`v${version} · ${result.stats.files} files · ${findings.length} findings · ${Date.now() - start}ms`)}`,
      );
    } catch (error) {
      console.error(`${dim('rebuild failed:')} ${error instanceof Error ? error.message : error}`);
    } finally {
      building = false;
    }
  };

  rebuild();

  const server = createServer((request, response) => {
    if (request.url === '/version') {
      response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      response.end(String(version));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html);
  });

  // Debounced, because a save from an editor fires several events and a
  // re-index is not free.
  let timer: NodeJS.Timeout | undefined;
  try {
    watch(join(root, 'src'), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(rebuild, 250);
    });
  } catch {
    // No src directory, or the platform lacks recursive watch: the server still
    // works, it simply will not refresh on its own.
    console.log(dim('  (file watching unavailable — refresh to rescan)'));
  }

  await new Promise<void>((resolve) => {
    server.listen(port, () => {
      console.log(`\n${bold('instantiate')} ${cyan(`http://localhost:${port}`)}`);
      console.log(dim('  rebuilds on save · ctrl-c to stop\n'));
    });
    process.on('SIGINT', () => {
      server.close();
      resolve();
      process.exit(0);
    });
  });
}

/** Reload when the scan version changes, so a save shows up without a refresh. */
function inject(html: string, version: number): string {
  const poller = `
<script>
(() => {
  let current = ${version};
  setInterval(async () => {
    try {
      const next = Number(await (await fetch('/version', { cache: 'no-store' })).text());
      if (next !== current) location.reload();
    } catch { /* server stopped; keep showing the last good render */ }
  }, 1000);
})();
</script>`;
  return html.replace('</body>', `${poller}\n</body>`);
}
