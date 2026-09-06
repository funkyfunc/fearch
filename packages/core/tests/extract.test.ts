import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanMarkdownSource,
  detectShell,
  feedToMarkdown,
  htmlToMarkdown,
  splitFrontmatter,
} from "../src/fetch/extract.js";

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

describe("code blocks survive interactive chrome", () => {
  it("keeps identifiers wrapped in Twoslash hover <button>s and copy buttons inside <pre>", () => {
    // nodejs.org/en/about, 2026-09: Shiki + Twoslash wrap every identifier in <button class="twoslash-hover">
    const pre = `<pre class="shiki twoslash language-cjs"><code><span class="line"><span>const</span><span> {</span><span> </span><span><button data-state="closed" class="twoslash-hover">createServer</button></span><span> }</span><span> =</span><span> </span><span><button class="twoslash-hover">require</button></span><span>(</span><span>'node:http'</span><span>);</span></span>
<span class="line"><span><button class="twoslash-hover">server</button></span><span>.</span><span><button class="twoslash-hover">listen</button></span><span>(</span><span><button class="twoslash-hover">port</button></span><span>);</span></span></code><button class="copy" aria-hidden="true"><svg></svg></button></pre>`;
    const html = `<html><head><title>About</title></head><body><main><h1>About</h1><p>${"Prose about the runtime. ".repeat(12)}</p>${pre}<p>${"More prose. ".repeat(20)}</p></main></body></html>`;
    const md = htmlToMarkdown(html).markdown;
    expect(md).toContain("const { createServer } = require('node:http');");
    expect(md).toContain("server.listen(port);");
    expect(md).not.toContain("<button");
  });

  it("converts a header-first table with GFM and unwraps a row-header infobox instead of leaking its HTML", () => {
    // MediaWiki infobox: image row first, <th scope="row"> on later rows — not a table the GFM plugin converts.
    const infobox = `<table class="infobox"><caption>Sourdough bread</caption><tbody><tr><td colspan="2"><img src="/x.jpg" srcset="/x2.jpg 2x"></td></tr><tr><th scope="row">Type</th><td>Bread</td></tr><tr><th scope="row">Main ingredients</th><td>Flour, water, salt</td></tr></tbody></table>`;
    const data = `<table><tbody><tr><th>Name</th><th>Value</th></tr><tr><td>a</td><td>1</td></tr></tbody></table>`;
    const html = `<html><head><title>Sourdough</title></head><body><main>${infobox}<p>${"Sourdough is a leavening agent. ".repeat(15)}</p>${data}<p>${"More prose here. ".repeat(15)}</p></main></body></html>`;
    const md = htmlToMarkdown(html).markdown;
    expect(md).not.toContain("<table");
    expect(md).not.toContain("srcset");
    expect(md).toContain("Main ingredients");
    expect(md).toContain("Flour, water, salt");
    expect(md).toMatch(/\| Name \| Value \|/);
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

  it("recognises a mostly-script page with a few lines of text as a shell even when it says nothing familiar", () => {
    // app.diagrams.net: 347 chars of marketing + "Please ensure JavaScript is enabled", the rest is script.
    const blurb =
      "draw.io is free online diagram software. You can use it as a flowchart maker, network diagram software, to create UML online, as an ER diagram tool, to design database schema, to build BPMN online, as a circuit diagram maker, and more. draw.io can import .vsdx, Gliffy and Lucidchart files.";
    const script = `<script>${"var a = 1; ".repeat(400)}</script>`;
    expect(
      detectShell(
        `<html><body><p>${blurb}</p><h2>Loading...</h2><p>Please ensure JavaScript is enabled.</p>${script}</body></html>`,
      ),
    ).toBe(true);
    expect(detectShell(`<html><body><p>${blurb}</p>${script}</body></html>`)).toBe(true);
    // the same blurb with a real article behind it is content, scripts or not
    expect(
      detectShell(
        `<html><body><p>${blurb}</p><article>${"Real paragraph text. ".repeat(60)}</article>${script}</body></html>`,
      ),
    ).toBe(false);
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

  it("treats a huge, script-heavy page that yields only a footer as a shell (YouTube watch pages)", () => {
    const footer = "About Press Copyright Contact us Creators Advertise Developers Terms Privacy Policy & Safety";
    const filler = `<script>${"x".repeat(150_000)}</script><ytd-app>${"<div></div>".repeat(8000)}</ytd-app>`;
    const big = `<html><head><title>V</title></head><body>${filler}<footer>${footer}</footer></body></html>`;
    expect(big.length).toBeGreaterThan(200_000);
    expect(detectShell(big)).toBe(true);
    // The same footer on a small static page is just a small page.
    expect(detectShell(`<html><body><footer>${footer}</footer></body></html>`)).toBe(false);
  });

  it("drops MDX module code (multi-line component exports, imports) but never fenced code", () => {
    const mdx = [
      'import { Card } from "@/components";',
      "",
      "# Intro",
      "",
      "export const HeroCard = ({ title }) => {",
      '  return <a className="x">',
      "      {title}",
      "    </a>;",
      "};",
      "",
      "Prose stays.",
      "",
      "```ts",
      "export const keep = () => {",
      "  return 1;",
      "};",
      "```",
      "",
    ].join("\n");
    const out = cleanMarkdownSource(mdx);
    expect(out).not.toContain("HeroCard");
    expect(out).not.toContain("import {");
    expect(out).toContain("Prose stays.");
    expect(out).toContain("export const keep = () => {");
  });

  it("renders RSS and Atom feeds as one heading per entry", () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Front Page</title><description>News</description>
<item><title>First &amp; best</title><link>https://a.test/1</link><pubDate>Sat, 05 Sep 2026 22:15:52 +0000</pubDate>
<description><![CDATA[<p>Article URL: <a href="https://a.test/1">x</a></p><p>Points: 21</p>]]></description></item>
<item><title>Second</title><link>https://a.test/2</link></item></channel></rss>`;
    const md = feedToMarkdown(rss);
    expect(md.title).toBe("Front Page");
    expect(md.markdown).toContain("## First & best\nhttps://a.test/1 · 2026-09-05");
    expect(md.markdown).toContain("Points: 21");
    expect(md.markdown).not.toContain("CDATA");
    expect(md.markdown).toContain("## Second\nhttps://a.test/2");
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title><entry><title>Post</title>
<link rel="alternate" href="https://b.test/p"/><updated>2026-01-02T00:00:00Z</updated><summary>Short.</summary></entry></feed>`;
    const a = feedToMarkdown(atom);
    expect(a.markdown).toContain("# Blog");
    expect(a.markdown).toContain("## Post\nhttps://b.test/p · 2026-01-02\n\nShort.");
  });

  it("does not read a utility class with a variant prefix as a role (Tailwind's toc-visible:@md:…)", () => {
    const html = `<html><body><main><p>Intro paragraph long enough to be content for the extractor guard, with more words here so it counts.</p>
<div class="col-span-full toc-visible:@md:col-start-2 max-w-none"><ul class="mb-8 in-[:where(ul,ol)]:mt-2 list-disc"><li>Automatically or programmatically extract data or Output.</li><li>Represent that Output was human-generated when it was not.</li></ul></div>
<div class="toc"><a href="#a">A</a><a href="#b">B</a></div></main></body></html>`;
    const md = htmlToMarkdown(html).markdown;
    expect(md).toContain("programmatically extract data");
    expect(md).not.toMatch(/^-\s+A\s*$/m); // a real table-of-contents block still goes
  });

  it("renders formulas as TeX once, keeps meaningful image alt text, and shapes definition lists", () => {
    const html = `<html><body><main><p>Lead paragraph long enough to count as content for the guard, with enough words in it to pass the size rule.</p>
<p>Gating: <math alttext="G(x)=\\text{Softmax}(x)"><semantics><mrow><mi>G</mi></mrow><annotation encoding="application/x-tex">G(x)=\\text{Softmax}(x)</annotation></semantics></math> per token.</p>
<math display="block"><semantics><mrow><mi>y</mi></mrow><annotation encoding="text/plain">y equals x</annotation></semantics></math>
<img src="a.png" alt="Diagram of the Calvin cycle"><a href="/big.png"><img src="t.png" alt="Thumbnail of the same diagram"></a><img src="i.png" alt="icon">
<dl><dt><code>asyncio.run(coro)</code></dt><dd><p>Execute the coroutine and return the result.</p></dd></dl></main></body></html>`;
    const md = htmlToMarkdown(html).markdown;
    expect(md).toContain("$G(x)=\\text{Softmax}(x)$");
    expect(md).not.toContain("Softmax}(x)G"); // the annotation is not printed a second time
    expect(md).toContain("$$y$$"); // no TeX: the formula's own text, on its own line
    expect(md).not.toContain("y equals x");
    expect(md).toContain("[image: Diagram of the Calvin cycle]");
    expect(md).not.toContain("Thumbnail"); // a linked image is a thumbnail or a badge
    expect(md).not.toContain("[image: icon]");
    expect(md).toMatch(/\*\*`asyncio\.run\(coro\)`\*\*\n\s+Execute the coroutine/);
  });
});
