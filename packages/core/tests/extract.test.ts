import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanMarkdownSource, detectShell, htmlToMarkdown, splitFrontmatter } from "../src/fetch/extract.js";

const FIXTURES = join(import.meta.dirname, "../../../tests/fixtures/html");
// Documentation pages: the code-retention and size thresholds below are docs-shaped. The full fixture
// set (threads, articles, listings) is covered by the golden snapshots instead.
const countPre = (f: string) => (readFileSync(join(FIXTURES, f), "utf8").match(/<pre/g) ?? []).length;
const fixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".html") && countPre(f) >= 2)
  .sort();

const SYNTHETIC = `<html><head><title>Retries — Lib Docs</title></head><body>
<header><nav><a href=/a>A</a><a href=/b>B</a><a href=/c>C</a></nav></header>
<aside class="sidebar"><ul><li>Sidebar item</li></ul></aside>
<main>
<h1>Retries<a class="headerlink" href="#retries">¶</a></h1>
<p>Intro paragraph about the library. It is long enough to count as content for the extractor guard,
hopefully more than two hundred characters when combined with the rest of the page text here.</p>
<h2><a class="toc-backref" href="#id1">Configuration</a></h2>
<p>Set <code>retries</code> like so:</p>
<pre><code class="language-python">client = Client(retries=3)
print("hi")</code></pre>
<h2>Timeouts</h2><p>Timeouts are separate.</p>
<pre><code>curl -m 5 https://x</code></pre>
<table><tr><th>Option</th><th>Default</th></tr><tr><td>retries</td><td>0</td></tr></table>
<div class="cookie-banner">Accept cookies</div>
<div id="disqus_thread">Comment spam</div>
<img src="x.png" alt="diagram">
</main>
<footer>© 2026 Footer text</footer>
</body></html>`;

function fenceCount(md: string): number {
  return Math.floor((md.match(/^\s*(`{3,}|~{3,})/gm) ?? []).length / 2);
}

describe("extract", () => {
  it("extracts the main container and keeps code/tables, drops chrome", () => {
    const ex = htmlToMarkdown(SYNTHETIC);
    const md = ex.markdown;
    expect(ex.method).toBe("main");
    expect(ex.title).toBe("Retries — Lib Docs");
    expect(md).toContain("# Retries");
    expect(md).not.toContain("¶");
    expect(md).toContain("## Configuration");
    expect(md).toContain("```python\nclient = Client(retries=3)");
    expect(md).toContain("```\ncurl -m 5 https://x\n```");
    expect(md).toMatch(/\| Option \| Default \|/);
    for (const noise of ["Sidebar item", "Accept cookies", "Comment spam", "Footer text", "x.png"])
      expect(md).not.toContain(noise);
  });

  it("unwraps layout tables and keeps discussion threads", () => {
    const html = `<html><head><title>Thread</title></head><body>
<table id="hnmain"><tbody><tr><td>
<table class="fatitem"><tr><td class="title"><a href="/x">Show HN: A thing</a></td></tr></table>
<table class="comment-tree"><tr class="athing comtr"><td><div class="comment"><span class="commtext">First comment with plenty of text to keep the guard happy and then some more words to be safe here.</span></div></td></tr>
<tr class="athing comtr"><td><div class="comment"><span class="commtext">Second comment, also long enough to matter for the extraction length threshold of two hundred chars.</span></div>
<table><thead><tr><th>Col</th><th>Val</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr></tbody></table></td></tr></table>
</td></tr></tbody></table>
</body></html>`;
    const md = htmlToMarkdown(html).markdown;
    expect(md).not.toContain("<table");
    expect(md).toContain("First comment");
    expect(md).toContain("Second comment");
    expect(md).toMatch(/\| Col \| Val \|/); // real data table still converted by GFM
  });

  it("detects shells", () => {
    expect(detectShell("<html><body><div id='root'></div><script>app()</script></body></html>")).toBe(true);
    expect(detectShell("<html><body><p>You need to enable JavaScript to run this app.</p></body></html>")).toBe(true);
    expect(detectShell(SYNTHETIC)).toBe(false);
  });

  it("cleans markdown sources without eating code lines", () => {
    const src =
      '```python theme={"a":1}\nx = 1\n```\n\n<VersionBadge version="2" />\n## Heading {/*anchor*/}\n\nIf text\n';
    const out = cleanMarkdownSource(src);
    expect(out.startsWith("```python\nx = 1\n```")).toBe(true);
    expect(out).not.toContain("VersionBadge");
    expect(out).toContain("## Heading\n");
    const src2 = "Example:\n\n```\nasync with timeout(10):\n    pass\n```\n\nIf the manager";
    const out2 = cleanMarkdownSource(src2);
    expect(out2).toContain("```\nasync with timeout(10):");
    expect(out2).toContain("```\n\nIf the manager");
  });

  it("splits frontmatter", () => {
    const { meta, body } = splitFrontmatter('---\ntitle: "Workers"\nkind: doc\n---\n# Body\n');
    expect(meta.title).toBe("Workers");
    expect(body).toBe("# Body\n");
    expect(splitFrontmatter("# no fm\n")).toEqual({ meta: {}, body: "# no fm\n" });
  });

  it.each(fixtures)("%s keeps ≥80%% of code blocks and drops chrome", (name) => {
    const html = readFileSync(join(FIXTURES, name), "utf8");
    const ex = htmlToMarkdown(html);
    const md = ex.markdown;
    const preTotal = (html.match(/<pre/g) ?? []).length;
    expect(md.length).toBeGreaterThan(1500);
    expect(ex.title).toBeTruthy();
    expect(fenceCount(md)).toBeGreaterThanOrEqual(Math.ceil(0.8 * preTotal));
    expect(md).not.toContain("Skip to content");
    expect(md).not.toMatch(/^#{1,6} .*[¶#]\s*$/m);
    const headings = (md.match(/^#{1,6} .*$/gm) ?? []).join("\n");
    expect(headings).not.toContain("](#");
  });
});

describe("detectShell", () => {
  it("does not mistake a short static page for a JS shell, but still catches empty mount points", () => {
    const tiny = `<html><head><title>Example Domain</title></head><body><div><h1>Example Domain</h1><p>This domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.</p><p><a href="https://www.iana.org/domains/example">More information...</a></p></div></body></html>`;
    expect(detectShell(tiny)).toBe(false);
    expect(detectShell(`<html><body><div id="root"></div><script src="/app.js"></script></body></html>`)).toBe(true);
    expect(detectShell(`<html><body><div id="app"></div><script>render()</script></body></html>`)).toBe(true);
    expect(detectShell(`<html><body><p>Loading...</p><script src="/bundle.js"></script></body></html>`)).toBe(true);
    expect(detectShell(`<html><body><p>ok</p></body></html>`)).toBe(false);
  });
});

describe("content selection guards", () => {
  const prose = (n: number) => `<p>${"Plain prose sentence that says something. ".repeat(n)}</p>`;
  it("prunes link farms (navigation rails inside <main>) but keeps prose with links in it", () => {
    const farm = `<ul>${Array.from({ length: 12 }, (_, i) => `<li><a href="/${i}">Related article number ${i}</a></li>`).join("")}</ul>`;
    const html = `<html><body><main><h1>Title</h1>${prose(8)}<p>See <a href="/x">this page</a> and <a href="/y">that one</a> for more.</p>${farm}</main></body></html>`;
    const md = htmlToMarkdown(html).markdown;
    expect(md).not.toContain("Related article number");
    expect(md).toContain("this page");
    expect(md).toContain("that one");
  });
  it("does not accept a container that holds less than half of the page's text", () => {
    // <main> is a short summary box; the article lives outside it.
    const html = `<html><body><main><h2>Summary</h2>${prose(3)}</main><div class="story"><h1>The article</h1>${prose(40)}</div></body></html>`;
    const ex = htmlToMarkdown(html);
    expect(ex.method).not.toBe("main");
    expect(ex.markdown).toContain("The article");
  });
});
