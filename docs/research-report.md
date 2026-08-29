# **Architecture and Product Requirements Specification for an Autonomous Web Search MCP Server**

## **System Context and Strategic Motivation**

Modern developer environments, integrated development environments (IDEs), and autonomous agent frameworks increasingly depend on external real-time knowledge retrieval to overcome model pretraining cutoffs and resolve environment-specific technical ambiguities1. While commercial platforms routinely lock native web browsing behind proprietary subscription tiers, the Model Context Protocol (MCP) provides an open, standardized RPC bridge that allows local and remote clients to dynamically discover and invoke server-managed tools1.  
Constructing a private, self-hosted Web Search MCP server achieves independence from paid vendor APIs, mitigates tracking, and avoids per-seat software licensing fees1. A resilient search server requires more than a blind proxy between the model and the internet; it must bridge transport-level stealth, multi-engine redundancy, DOM distillation, and strict JSON-RPC protocol compliance1. Ingesting uncurated web content introduces severe context-window bloat, token exhaustion, and layout-induced hallucinations9. The architecture detailed herein combines low-overhead transport spoofing with heuristic content distillation to deliver token-optimized Markdown directly to downstream agents3.

## **Architectural Taxonomy and Tool Surface Evaluation**

Determining how capabilities are exposed across the MCP interface dictates the cognitive load placed on the large language model, the overall token efficiency of the agentic loop, and the reliability of network execution1.

### **Arbitrary URL Proxying versus Intent-Specific Abstractions**

Exposing an unconstrained HTTP fetch tool—where the language model is responsible for constructing search URLs, following pagination links, and parsing arbitrary responses—introduces distinct operational failure modes:  
The first failure mode is context window exhaustion and economic waste. Modern web pages deliver between ![][image1] and ![][image2] of raw markup, translating to ![][image3] to ![][image4] tokens per retrieval cycle9. Raw HTML is saturated with inline SVG paths, CSS styles, JavaScript tracking bundles, navigation menus, footer link trees, and cookie consent banners9. Forcing an agent to ingest raw HTML consumes valuable context capacity and degrades reasoning performance over long multi-turn interactions10.  
The second failure mode is network-level bot blocking. Standard HTTP client libraries native to programming runtimes generate default Transport Layer Security (TLS) handshakes and HTTP header signatures that trigger immediate automated mitigation from Content Delivery Networks (CDNs) like Cloudflare, Akamai, and DataDome8. An agent generating naive GET requests will encounter HTTP 403 Forbidden responses, CAPTCHA challenges, or HTTP 202 soft rate-limit rejections8.  
The third failure mode is model hallucination during structural DOM parsing. Models struggle to accurately parse unstructured or malformed DOM trees, frequently confusing sidebar links or advertising copy with core technical documentation10.  
These systemic weaknesses demonstrate why an intent-specific, multi-stage retrieval architecture is necessary1. By decoupling search discovery from deep content ingestion, the model operates over high-signal metadata during initial triage and only requests full, distilled page content for select, relevant URLs1.

### **Unified Multi-Engine Abstraction versus Fragmented Tool Surfaces**

Exposing separate tools for distinct search providers (such as search\_duckduckgo, search\_google, and search\_bing) fragments the model's decision boundary, expands the initial system prompt schema footprint, and forces the model to handle provider-specific errors1.  
A unified tool surface centered around a consolidated web\_search endpoint offers significant operational advantages1. The server abstracts provider selection behind an automated failover engine: queries execute against zero-cost search backends (such as DuckDuckGo HTML or Lite interfaces) and automatically fail over to secondary backends (such as Bing HTML scrapers or private SearXNG instances) if rate limits or structural parsing errors occur1. The language model receives a clean, standardized array of ranked results containing titles, absolute target URLs, and concise snippets6.

### **Two-Stage Retrieval Lifecycle**

The operational pattern separates retrieval into two phases: discovery and ingestion1.  
During discovery, the agent calls web\_search with an analytical query string, optional geographic/language filters, and a target result count2. The MCP server queries the search engine pool, strips tracking redirects, deduplicates URLs, and returns a lightweight JSON array of candidates6.  
During ingestion, the agent evaluates the candidate snippets and invokes fetch\_page or batch\_scrape on the most relevant URLs1. The server fetches the raw HTML via a stealth transport layer, extracts the main article text using heuristic density algorithms, transforms the content into clean Markdown, enforces token ceilings, and returns the distilled text to the agent's context window1.

### **Model Context Protocol Tool Interface Specifications**

The server exposes four specialized tools conforming to the MCP JSON-RPC 2.0 specification, using strict JSON Schema for parameter validation4:

| Tool Identifier | Input Parameter Schema | Output Payload Structure | Primary Functional Scope |
| :---- | :---- | :---- | :---- |
| web\_search \[cite: 1, 3, 12\] | query (string, required) max\_results (integer, 1–20, default 10\) region (string, optional) timelimit (string: d, w, m, y, optional) | JSON array of objects: title (string) url (string) snippet (string) engine (string) | Executes multi-engine meta-search, balances query load, resolves redirects, and returns ranked result snippets. |
| fetch\_page \[cite: 1, 3\] | url (string, required) max\_words (integer, default 3000\) include\_links (boolean, default true) | JSON object: title (string) markdown (string) word\_count (integer) truncated (boolean) | Fetches a target URL via stealth transport, applies DOM distillation, and serializes clean, readable Markdown. |
| batch\_scrape \[cite: 1\] | urls (array of strings, max 5, required) max\_words\_per\_page (integer, default 2000\) | JSON array of extracted page objects mapped directly to source URLs | Concurrently retrieves and distills multiple web pages, optimizing multi-source agentic research turns. |
| site\_explore \[cite: 1, 9\] | base\_url (string, required) max\_depth (integer, 1–3, default 1\) path\_prefix (string, optional) | JSON object: discovered\_urls (array of strings) sitemap\_detected (boolean) | Discovers internal site architecture by parsing sitemap.xml and extracting same-domain links. |

## **Landscape Analysis: Existing MCP Implementations**

An evaluation of open-source MCP search servers reveals several common architectural designs, strengths, and failure modes1.

| Repository / Project | Search Backends | Extraction Engine | Anti-Blocking & Transport | Resource Overhead | Identified Failure Modes & Limitations |
| :---- | :---- | :---- | :---- | :---- | :---- |
| malong11-007/web-search-mcp \[cite: 1\] | DuckDuckGo, SearXNG fallback | Native Markdown converter, site mapping, batch scraper | User-Agent rotation, header sequencing, cookie jars | Minimal (\<30 MB RAM), compiled Go binary | Lacks deep TLS fingerprint spoofing; requires external SearXNG instance for high-throughput resilience1. |
| nickclyde/duckduckgo-mcp-server \[cite: 3\] | DuckDuckGo | Basic HTML text parser | Dual-mode HTTP: httpx with automatic curl\_cffi fallback | Low (\<60 MB RAM), Python FastMCP | Fixed client-side rate limits (30 req/min); single-engine dependency causes outages when DuckDuckGo throttles3. |
| pranavms13/web-search-mcp \[cite: 12\] | Google, DuckDuckGo, Bing | BeautifulSoup DOM parser | Headless Chrome via Selenium, pluggable Obscura backend | Heavy (\>500 MB RAM), requires OS-level browser binaries | High startup latency (![][image5] per query); memory leaks in long-running container deployments9. |
| brave/brave-search-mcp-server \[cite: 2\] | Official Brave REST API | Pre-computed snippets and AI summaries | Standard HTTPS API calls, supports stdio and SSE | Very low (\<40 MB RAM), TypeScript | Requires paid or tiered BRAVE\_API\_KEY; lacks arbitrary deep-page scraping for non-indexed technical content2. |
| aas-ee/open-webSearch \[cite: 6\] | Bing, Baidu, DuckDuckGo, Exa, Brave | Generic HTML/Markdown fetcher | Upstream HTTP/SOCKS5 proxy support, fake-IP routing | Moderate (\<80 MB RAM), Node.js daemon/CLI | Regular scraper breakage when search engine DOM structures change; no TLS fingerprint emulation6. |
| MattimaxForce/duckduckgo-mcp \[cite: 7\] | DuckDuckGo | Snippet extraction only | Standard Node fetch; strict stderr protocol logging | Minimal (\<35 MB RAM), single-file Node.js | No secondary full-page scraping; vulnerable to CDN challenges when reading external sites7. |

### **Friction Points and Gaps in Existing MCP Solutions**

The primary friction points identified across current implementations stem from architectural trade-offs between operational weight, anti-bot resilience, and stream isolation3:  
Headless browser bloat remains a major operational liability9. Projects employing Selenium, Playwright, or Puppeteer require full browser binaries, consuming substantial memory and CPU resources while introducing installation hurdles across different host operating systems9.  
Rate-limiting vulnerabilities are prevalent in zero-configuration servers18. Unofficial scrapers targeting DuckDuckGo frequently encounter HTTP 202 accepted-but-empty responses or HTTP 429 Too Many Requests when agents execute iterative research loops18. Implementations lacking exponential backoff, request jitter, and token-bucket throttling fail during rapid multi-turn operations1.  
Protocol stream corruption frequently occurs in Python-based servers5. FastMCP servers communicating over stdio require absolute cleanliness on standard output5. Several implementations fail to suppress runtime warnings or third-party loggers, emitting non-JSON text to stdout, which invalidates framing and crashes client connections in Claude Code or Cursor7.  
Finally, shallow snippet extraction limits an agent's problem-solving effectiveness1. Servers that return only 150-character search engine snippets prevent the model from inspecting detailed technical documentation, API references, or code samples, forcing it to hallucinate implementation details1.

## **Analysis of the Broader Ecosystem: Extraction Libraries and Stealth Networking**

Web retrieval and content extraction have evolved significantly beyond the MCP ecosystem8. Integrating these advancements yields a robust, lightweight architecture8.

### **Content Distillation Engines**

Algorithmic extraction libraries remove boilerplate layout elements (such as headers, footers, sidebars, and ads) and convert the underlying article into structured text9. The performance of content extractors is benchmarked against the standard ScrapingHub/Zyte Article Extraction Dataset using the ![][image6] metric, defined as the harmonic mean of precision and recall9:  
![][image7]

| Extraction Engine | Benchmark F1​ Score | Execution Latency | Memory Footprint | Rendering Requirement | Core Architectural Fit |
| :---- | :---- | :---- | :---- | :---- | :---- |
| Trafilatura9 | 0.945 – 0.958 | 15 – 25 ms | \< 30 MB | Raw HTML (No JS engine required) | Optimal for local MCP servers: industry-leading ![][image6] accuracy, zero browser dependencies, native Markdown output9. |
| Mozilla Readability9 | 0.887 – 0.943 | 10 – 20 ms | \< 25 MB | DOM tree (Node or Python bridge) | High baseline fidelity for standard news/blog formats, but requires secondary conversion tools (Turndown) to generate Markdown10. |
| Crawl4AI9 | 0.920 – 0.940 | 800 – 2,500 ms | 400 – 900 MB | Playwright / Headless Chromium | High fidelity for complex JavaScript SPAs; includes BM25 content filtering, but incurs high memory and latency costs9. |
| IBM Docling9 | 0.935 | 1,200 – 4,000 ms | 1.5 – 2.5 GB | Deep layout models (PyTorch) | High-accuracy layout preservation for complex documents and PDFs, but resource-heavy for general web fetching9. |

Trafilatura combines heuristic scoring across text density and link-to-text ratios with an integrated fallback chain that incorporates readability-lxml and jusText9. It outputs structured Markdown directly while preserving technical code blocks and tabular structures, providing an ideal balance of speed, accuracy, and resource efficiency9.

### **Stealth Transport and TLS Fingerprint Spoofing**

Modern anti-bot systems deploy passive TLS fingerprinting to intercept automated clients during the cryptographic handshake8. Standard networking libraries in Python (urllib, requests, httpx, aiohttp) use standard OpenSSL bindings, producing identifiable Client Hello packet signatures that expose them as bots8.  
The library curl\_cffi resolves this issue by binding to curl-impersonate, a modified cURL distribution that matches the exact cryptographic signatures of commercial web browsers3. When configured with a modern browser profile (such as impersonate="chrome131"), curl\_cffi mimics the browser's cipher suite permutations, extension sequences, elliptic curves, and HTTP/2 settings frames3. This allows the server to bypass edge CDN checks without the overhead of a headless browser3.

### **Search Aggregation Patterns**

Scraping-based metasearch engines avoid vendor lock-in and API fees1. The ddgs package (formerly duckduckgo\_search) demonstrates how DuckDuckGo's JSON and Lite endpoints can be queried programmatically without API keys18. However, sustaining long-term reliability requires resilient query backends that incorporate automatic fallback routing, request throttling, and proxy support1.

## **Target System Architecture and Component Decomposition**

The system is designed as an asynchronous, modular service using FastMCP3. The architecture combines protocol isolation, resilient multi-engine search, stealth fetching, heuristic content distillation, and local caching1.

### **Protocol and Transport Layer**

The server runs on standard input/output (stdio) for integration with desktop clients and CLI tools (such as Claude Code, Claude Desktop, Cursor, and Windsurf)3. To prevent protocol corruption, standard logging output is redirected entirely to stderr7. The JSON-RPC dispatcher parses incoming tools/list and tools/call requests, routing parameters through Pydantic models for validation4.

### **Multi-Engine Meta-Search Orchestrator**

The search orchestrator executes queries across an automated failover chain1:

> 1. **Primary Backend**: DuckDuckGo HTML/Lite endpoints, queried via curl\_cffi with browser fingerprinting3.  
> 2. **Secondary Backend**: Public Bing HTML search scraper, matching search parameters and extracting results via CSS selectors6.  
> 3. **Tertiary Backend (Optional)**: User-configured local or remote SearXNG instance for high-volume, self-hosted environments1.

The orchestrator normalizes divergent search results into a unified schema, resolves tracking and redirect URLs, and generates structured output for downstream processing6.

### **Stealth Transport Engine**

The transport layer manages outbound HTTP/HTTPS requests through an asynchronous curl\_cffi session pool3. This layer configures TLS signatures, sets appropriate browser headers (Sec-Ch-Ua, Sec-Fetch-\*, Accept-Language), manages cookie persistence across domains, and supports upstream SOCKS5 and HTTP proxies1.

### **Content Distillation Pipeline**

When an agent requests a target URL, the HTML payload passes through an extraction pipeline1:

* Trafilatura processes the DOM to extract the primary content block while discarding navigation menus, sidebars, advertisements, and footers9.  
* The content is converted into structured Markdown, preserving headings, code snippets, blockquotes, and tables1.  
* If the extracted text exceeds configured word or token limits, the pipeline truncates the content at semantic section boundaries and appends a pagination indicator, preventing context window overflow1.

### **Token-Bucket Rate Limiter and Caching Engine**

To prevent rate-limit blocks during multi-step agent reasoning, requests are regulated by a client-side token-bucket algorithm3. The available token balance ![][image8] at time ![][image9] is calculated as:  
![][image10]  
where ![][image11] represents total burst capacity (such as 10 tokens) and ![][image12] denotes the replenishment rate per second (such as 0.5 tokens/second, enforcing a sustained rate of 30 requests per minute)3.  
An in-memory Least Recently Used (LRU) cache stores search queries and distilled page content with a 300-second Time-to-Live (TTL), preventing duplicate network requests for identical queries within the same conversation22.

### **MCP Error Handling Semantics**

The server strictly separates protocol errors from operational tool errors according to MCP specifications4:

* **Protocol Errors**: Structural anomalies (such as invalid JSON, unparseable parameters, or unregistered tool calls) return standard JSON-RPC error codes (such as \-32602 for invalid parameters)4.  
* **Tool Execution Errors**: Network timeouts, HTTP 404/403 responses, or anti-bot challenge blocks return valid JSON-RPC responses with isError: true and actionable error descriptions4. This allows the calling model to understand the retrieval failure and evaluate alternative URLs4.

## **Product Requirements Specification**

### **Functional Requirements**

* **FR-1: Unified Multi-Engine Meta-Search**: The system must provide a unified web\_search tool that executes text queries across DuckDuckGo and Bing, automatically falling back to secondary providers if the primary provider fails1.  
* **FR-2: Distilled Page Content Extraction**: The system must provide a fetch\_page tool that extracts the main content from target URLs as clean Markdown using Trafilatura, stripping boilerplate layout elements1.  
* **FR-3: Parallel Batch Scraping**: The system must provide a batch\_scrape tool that concurrently retrieves and distills up to 5 URLs in parallel via asynchronous I/O1.  
* **FR-4: Site Mapping and Breadth Exploration**: The system must provide a site\_explore tool that maps internal domain links and parses sitemap.xml files up to a depth of 3 levels1.  
* **FR-5: Cryptographic Transport Stealth**: All outbound HTTP network requests must use TLS fingerprint impersonation (curl\_cffi with a modern Chrome profile) and valid browser header ordering3.  
* **FR-6: Local Response Caching**: The server must cache search results and extracted page content in an in-memory LRU cache with a 300-second TTL22.  
* **FR-7: Rate Limiting and Backoff**: The system must enforce client-side token-bucket rate limiting (default 30 search requests/minute) with randomized exponential jitter1.  
* **FR-8: Token Truncation Controls**: Extracted Markdown must be bounded by a configurable word/token ceiling (default 3,000 words) with clear truncation indicators1.

### **Non-Functional Requirements**

* **NFR-1: Protocol Compliance**: The server must fully comply with the Model Context Protocol JSON-RPC specification over stdio transport4.  
* **NFR-2: Output Stream Purity**: All logging, diagnostics, and error stack traces must be directed exclusively to stderr to avoid corrupting the stdout JSON-RPC stream7.  
* **NFR-3: Memory and Resource Footprint**: Idle memory usage must remain below ![][image13], and peak active memory during batch scraping must not exceed ![][image14]. Headless browser automation frameworks are prohibited9.  
* **NFR-4: Latency Performance**: Standard search queries must return results in under ![][image15], and individual page extractions must complete within ![][image16] under standard broadband network conditions9.  
* **NFR-5: Zero External API Key Dependencies**: Core functionality must operate out-of-the-box without requiring paid API keys, user registration, or commercial platform subscriptions1.  
* **NFR-6: Cross-Platform Packaging**: The server must run across Linux, macOS, and Windows environments, distributed as an installable package compatible with uvx and pipx3.

### **Configuration and Environment Schema**

Server parameters are configured through standard environment variables1:

| Environment Variable | Default Value | Valid Options | Functional Description |
| :---- | :---- | :---- | :---- |
| WEB\_SEARCH\_BACKEND \[cite: 1, 6, 21\] | auto | auto, duckduckgo, bing, searxng | Sets the primary search routing backend. auto uses DuckDuckGo with automatic fallback. |
| SEARXNG\_URL \[cite: 1\] | None | Any valid HTTP/HTTPS URL | Optional base URL for a self-hosted SearXNG meta-search instance. |
| HTTP\_PROXY \[cite: 6, 21\] | None | Any valid URL (HTTP/HTTPS/SOCKS5) | Upstream proxy server URL for routing all outbound search and extraction traffic. |
| MAX\_WORDS\_PER\_PAGE \[cite: 1, 3\] | 3000 | Integer between 500 and 20000 | Maximum word count extracted from a target page before applying truncation. |
| SEARCH\_RATE\_LIMIT \[cite: 3, 22\] | 30 | Integer between 5 and 120 | Maximum search requests allowed per minute across the token bucket. |
| TLS\_IMPERSONATE \[cite: 3, 8\] | chrome131 | chrome131, edge101, safari17\_2\_ios | Browser TLS profile used by the curl\_cffi transport engine. |

### **Client Deployment Configuration**

To register the server with MCP-compatible clients (such as Claude Code, Claude Desktop, Cursor, or Windsurf), add the configuration block to the client configuration file1:

JSON  
{  
  "mcpServers": {  
    "web-search": {  
      "command": "uvx",  
      "args": \[  
        "--from",  
        "git+https://github.com/local-developer/custom-web-search-mcp",  
        "custom-web-search-mcp"  
      \],  
      "env": {  
        "WEB\_SEARCH\_BACKEND": "auto",  
        "MAX\_WORDS\_PER\_PAGE": "3000",  
        "SEARCH\_RATE\_LIMIT": "30"  
      }  
    }  
  }  
}

## **Implementation Roadmap and Strategic Synthesis**

Development is organized into four sequential delivery phases:

| Phase Identifier | Primary Focus Areas | Core Deliverables & Technical Milestones |
| :---- | :---- | :---- |
| Phase 1: Protocol Baseline & Transport | Server scaffolding and network stealth | Initialize FastMCP server with stdio communication and strict stderr logging3. Implement asynchronous curl\_cffi session manager with browser TLS impersonation3. Build DuckDuckGo HTML/Lite scraper18. |
| Phase 2: Content Extraction Pipeline | DOM parsing and Markdown generation | Integrate Trafilatura for heuristic HTML distillation9. Register fetch\_page and batch\_scrape tools1. Implement token-budgeting and semantic truncation controls1. |
| Phase 3: Resilience & Search Failover | Failover routing and rate control | Implement token-bucket rate limiter and in-memory LRU response cache3. Build Bing HTML search scraper and secondary failover engine6. Implement structured isError tool execution error handling4. |
| Phase 4: Exploration & Packaging | Site mapping and distribution | Build site\_explore tool with sitemap.xml parsing and internal link discovery1. Write unit and integration test suites. Package project for single-command uvx execution and Docker deployments3. |

This architecture combines TLS-impersonated transport via curl\_cffi with heuristic DOM extraction via Trafilatura, achieving fast retrieval, low memory usage (\<60 MB), and resilience against bot-detection mechanisms without requiring paid search APIs3. The separation between multi-engine discovery and distilled content ingestion delivers high-signal, token-efficient Markdown to local agents, preserving context capacity and improving output reliability during technical workflows1.

#### **Works cited**

> 1. web-search-mcp | MCP Servers \- LobeHub, [https://lobehub.com/mcp/malong11-007-web-search-mcp](https://lobehub.com/mcp/malong11-007-web-search-mcp)  
> 2. Brave Search MCP Server \- GitHub, [https://github.com/brave/brave-search-mcp-server](https://github.com/brave/brave-search-mcp-server)  
> 3. nickclyde/duckduckgo-mcp-server: A Model Context ... \- GitHub, [https://github.com/nickclyde/duckduckgo-mcp-server](https://github.com/nickclyde/duckduckgo-mcp-server)  
> 4. Tools \- What is the Model Context Protocol (MCP)?, [https://modelcontextprotocol.io/specification/2025-11-25/server/tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)  
> 5. MCP Cheat Sheet \- Model Context Protocol Reference \- Webfuse, [https://www.webfuse.com/mcp-cheat-sheet](https://www.webfuse.com/mcp-cheat-sheet)  
> 6. GitHub \- Aas-ee/open-webSearch: Multi-engine MCP server, CLI, [https://github.com/aas-ee/open-websearch](https://github.com/aas-ee/open-websearch)  
> 7. GitHub \- MattimaxForce/duckduckgo-mcp: Free MCP server for web, [https://github.com/MattimaxForce/duckduckgo-mcp](https://github.com/MattimaxForce/duckduckgo-mcp)  
> 8. Using curl\_cffi for Web Scraping in Python \- Medium, [https://medium.com/@datajournal/curl-cffi-for-web-scraping-a34523f9fe89](https://medium.com/@datajournal/curl-cffi-for-web-scraping-a34523f9fe89)  
> 9. The 7 best (free) Firecrawl alternatives in 2026, [https://roundproxies.com/blog/best-firecrawl-alternatives/](https://roundproxies.com/blog/best-firecrawl-alternatives/)  
> 10. HTML to Markdown for AI — Comparing 8 Conversion Approaches, [https://www.contextractor.com/html-to-markdown/](https://www.contextractor.com/html-to-markdown/)  
> 11. Trafilatura Review: Pricing & Alternatives | serp.fast, [https://serp.fast/tools/trafilatura](https://serp.fast/tools/trafilatura)  
> 12. GitHub \- pranavms13/web-search-mcp: A Model Context Protocol, [https://github.com/pranavms13/web-search-mcp](https://github.com/pranavms13/web-search-mcp)  
> 13. Pre-processing web pages before passing to LLM : r/LocalLLaMA, [https://www.reddit.com/r/LocalLLaMA/comments/1nnou23/preprocessing\_web\_pages\_before\_passing\_to\_llm/](https://www.reddit.com/r/LocalLLaMA/comments/1nnou23/preprocessing_web_pages_before_passing_to_llm/)  
> 14. ScrapeGraphAI Alternatives: Schema-First Extraction | Inference.net, [https://inference.net/content/scrapegraphai-alternatives/](https://inference.net/content/scrapegraphai-alternatives/)  
> 15. How to Bypass Cloudflare When Web Scraping in 2026 \- Scrapfly, [https://scrapfly.io/blog/posts/how-to-bypass-cloudflare-anti-scraping](https://scrapfly.io/blog/posts/how-to-bypass-cloudflare-anti-scraping)  
> 16. Bypass Cloudflare & DataDome When Scraping in ... \- Serpent API, [https://apiserpent.com/blog/bypass-cloudflare-datadome-scraping](https://apiserpent.com/blog/bypass-cloudflare-datadome-scraping)  
> 17. How to use curl\_cffi for web scraping in Python \- ScrapingBee, [https://www.scrapingbee.com/blog/how-to-use-curl-cffi/](https://www.scrapingbee.com/blog/how-to-use-curl-cffi/)  
> 18. DuckDuckGo API: A Developer's Guide for 2026 \- IPRoyal.com, [https://iproyal.com/blog/duckduckgo-api/](https://iproyal.com/blog/duckduckgo-api/)  
> 19. duckduckgo\_search.exceptions.RatelimitException: 202 Ratelimit, [https://github.com/open-webui/open-webui/discussions/6624](https://github.com/open-webui/open-webui/discussions/6624)  
> 20. Build the Smartest AI Bot You've Ever Seen — A 7B Model \+ Web, [https://wearecommunity.io/communities/aicommunitymexico/articles/6649](https://wearecommunity.io/communities/aicommunitymexico/articles/6649)  
> 21. duckduckgo-search \- PyPI, [https://pypi.org/project/duckduckgo-search/](https://pypi.org/project/duckduckgo-search/)  
> 22. \[Bug\]: Rate Limit Exceeded in DDGAPIWrapper Search Function, [https://github.com/FoundationAgents/MetaGPT/issues/1567](https://github.com/FoundationAgents/MetaGPT/issues/1567)  
> 23. Tools \- What is the Model Context Protocol (MCP)?, [https://modelcontextprotocol.io/specification/2026-07-28/server/tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)  
> 24. DuckDuckGo \- Haystack, [https://haystack.deepset.ai/integrations/duckduckgo-api-websearch](https://haystack.deepset.ai/integrations/duckduckgo-api-websearch)  
> 25. Mozilla Readability Alternatives: 4 Tools Compared \- serp.fast, [https://serp.fast/alternatives/readability](https://serp.fast/alternatives/readability)  
> 26. Cheap Firecrawl alternative for hobby RAG | Web2MD Blog, [https://web2md.org/blog/cheap-firecrawl-alternative-hobby-rag](https://web2md.org/blog/cheap-firecrawl-alternative-hobby-rag)  
> 27. edwardtay/awesome-scrapers: A curated list of 150+ web scraping, [https://github.com/edwardtay/awesome-scrapers](https://github.com/edwardtay/awesome-scrapers)  
> 28. Dripper: Token-Efficient Main HTML Extraction with a Lightweight LM, [https://arxiv.org/html/2511.23119v2](https://arxiv.org/html/2511.23119v2)  
> 29. Web Scraping Tools Comparison 2026: requests vs curl\_cffi vs, [https://dev.to/vhub\_systems\_ed5641f65d59/web-scraping-tools-comparison-2026-requests-vs-curlcffi-vs-playwright-vs-scrapy-2fad](https://dev.to/vhub_systems_ed5641f65d59/web-scraping-tools-comparison-2026-requests-vs-curlcffi-vs-playwright-vs-scrapy-2fad)  
> 30. A complete guide to search tools in Neuro SAN \- Cognizant, [https://www.cognizant.com/us/en/ai-lab/blog/neuro-san-ai-agent-search-tools](https://www.cognizant.com/us/en/ai-lab/blog/neuro-san-ai-agent-search-tools)  
> 31. ddgs: Python Metasearch Library for Web, News & Images, [https://openapps.pro/packages/ddgs](https://openapps.pro/packages/ddgs)  
> 32. Web Search MCP Server | Awesome MCP Servers, [https://mcpservers.org/servers/sydasif/web-search-mcp](https://mcpservers.org/servers/sydasif/web-search-mcp)  
> 33. Practical Guide to MCP (Model Context Protocol) in Python, [https://dev.to/m\_sea\_bass/practical-guide-to-mcp-model-context-protocol-in-python-ijd](https://dev.to/m_sea_bass/practical-guide-to-mcp-model-context-protocol-in-python-ijd)  
> 34. Tools \- FastMCP, [https://gofastmcp.com/servers/tools](https://gofastmcp.com/servers/tools)

[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADgAAAAZCAYAAABkdu2NAAADB0lEQVR4Xu2WWahOURTHl+GBUHgwpMg8Zi5k6JIoyovIkG55U0SSBx6UQngRQimukMyhhPCEJMMDytg1ZggPhiTE/9/a67bu+s459z5S51e/vs5a+zvft87Ze+0tUlJS8i/QDS6FY2Fr2B3Ohgv8oEQPuBiuh9NDLouj8HHyEXySPtunfBP43MVr4Rw4LMXfOp+lcbzXfbgF9pZGMBH+Cb6Go/0g0XH8UT6MSfAyPFxvRDbN4VPR+44IObIIfoBr4aCQmyn6vZoQHwMfihbeN+QqqIKv4A14Gq6GnfwA0Ex0zAoX41v4AqtdLI97on+0Z4jzDdyCA0PcmCL6vR0xAeaJ5vg2C5kglU8oMkP0ZsND/Aq8GGJZWIGc4kY/0Yfax8UiVuD2mACDRXN8+5zquYyXhgvkfOfNuD49fOM/RKdhEbHAAfC6u87DCtwWE2ClaG5DTETGwVNwK7wkOmVYtOeg6M06hzibCOMdQzxiBfaCQ+B7eKbeiGyswN2wneiy4G8tg59E122rutE5cMFy8Mh0zUXLP8C1aJyX7ELYZBjvH+IRK3AuvApvp+v5flAGVuADuC+5H16DR0QfVoO0FN0qPHvhL9EnTs6J/lBsPlZg0ToiViBnRwfRbsmp/VEq7+kpmqJLRHObY6IxrBP98sJ0fSBdd6kboRxLcdvX8rACufYMzhDGTrpYpKhA8hL+hqNiwsNOeBM2dTHObd6YmzrZmK7jVLwAv0kDXUwqmwxhY7qT4mz5WRR1UXJcNL8pJgz+MW7qnOO+E+4S/SJPN6QqXU+1AQl+70SIZZG3D/LE8lO01cf1TYoK5At5J5rnVpcLq5/mrtvCF6KNxeBGf1d0uzC47r7DyS6WB08d/CPxpELYNJg7C1uEHI+DzO0M8TbwUMrV1E9VwkXO7aEGrhEthD/GZuDpKnoe3AOXi54L2RWL4DZSCz8n2Z15lrQ1uwp+FT0R2RiuNzuL8gGyCDa8NylGOY7deJbow28UPDZxLQyNCQenMbcV3jjuiSUlJSUlJf8TfwHoGsm60C7aygAAAABJRU5ErkJggg==>

[image2]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEMAAAAZCAYAAABq35PiAAADtUlEQVR4Xu2XWahNYRTHlzljpowZMyRDkgdzlwwh8mIsyfAgRIZIkiJCiVCm4hIiUsbMXSVTpvJgHkOGIlMo4f9vfd+1zrr7nHt51P7Vv3v2Wmvvc/b6vm+tdUVSUlJS/p4m0AyoO1QFagaNgMbaoEBzaBq0DBrsfJHS0BBoKTQTqp/pLsIc6H7QPegBdBcaaGL2QQ9DDP+uCfZ86CX0Kug59CjE8TknoPEhtkT0hn45vYC62CDRuKeiiesDnYX2ZkSIlIf2Q0ehXtBc0Wd1tUFZ2C763bO9A7SBfkCbRH9HGeNj8m+K3tvU2CtCy4N9tbHnJE80o1egQ9ACqJ4NEP1yxnAVIzWhT9A4Y5sMvYYqGRt3CFeqrLElsV70h0909srQKWiks1suiN5bxztEdxt9w70jCa5gvjc6hoo+sJOzn4dOm+vrogm19BW9t4eze2IyJhgbjy0TMczYkojJqO0d4ICob7p3JNFTik8GzygfyHpi4Yt/F1316qIx3O4WJpD2hc7u8cmoBp2BBhVGZCcmo5azV4DeQ1+gGs6XCFfsILRW9MuviSbIskv0y3wxZGGjvS7UMnzmuba0DfYNzu6JyZgkmtjLovWGSSmOmIwWoi/NHdIBugRdFG0OJYLF7R3UOVy3ht6I1o4Iq3J8aQsLKO0scHxO0kvTR7svtp6YjPnQOehwuN5ig7IQk7FHdGfugHaLdhZ2E9adEsGq28TZtolWb2aaHBf9Ml9YYzJaiXYfft6YEfEnGfxxuYjJeCv6LBZhFl7a+pu4JLIdk0bQDdHF5ud/gh2AD4/nd2e4blgYobCN0s7OwsQlrWS7YOcxzEVMxhRj43H9KdrSqxq7J1syCI8dfUe8Iwl2hKui/TqyWPQBHLDIinDNVbacFC1OpUQrP3eTPw7dRO+d5+weX0Aj64J9s7NbcnWT9qI+yrb8IvAlWKTuSOYcwK3Om2PhyQvXA2JAgPexdUUKRAuWZZTovSxoucg2ZzDJT0R9/TJdheRKxlRRH5tDsayUzPbFSv5MtGhGOHTdkj9jMGGd+Co6R0Q4GHGnNDA2FrMCc50NdiG7Gy1MEH08LklnnwMj/b7Ac6RnDfom2hiKhUWRWcuHFom+9DEpOs01Fl2hrdAs0dl/tA0ILIFui47trDVctVztkVMtC+UH6KPoXMBrvgjJCz5Ou/R/Fm3/JF904o3HgHGclB8HOxOxSjLH9BLBOWEM1NE7DDxKbKEcbf3MYWGC+c8eY8s5X0pKSkpKSsr/z28mqPK+U4dJAgAAAABJRU5ErkJggg==>

[image3]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAD0AAAAZCAYAAACCXybJAAADXUlEQVR4Xu2WWahNURjHP/M8pISIi5LhQYboGgqJDCHRJbMMGULyYHqQZHgwpEyF64Ei8iDz1CVEIZGZQuahRDKU4f+/31pnr73O3ftsGR5u+1e/zt7fWvvs9a29JpGUlJTSTh4c5wcNY+Aw2AxWg13hHNjYrZQQ/sdMuBwO8MostUXfuQpOhJXCxRk6w0VwMWznlUXSCq6EV+APeChcnOEM/Om5CVZ0KyWgJ3wMZ8Ne8DTcE6oh0gjegqthPtwMb8M6biUwD96EQ+FIeE+0M3PSSbQnO8CvEp10EbwAL4omOzhUmoxy8KloYy1M5KOER9hueNC5J+dhoXPfUrTjOzqxPqI5tHBiOYlLml8kzw/+JoNEG9rei5+DJ811XdF2zA2Ki1kGP0kwzNfAD0FxMRx1HK0c6omJS/qU/HnS60STburFD4i+uzwcIlpnQqiGdgLj3c39NdFp4sOOYFsTE5c0v8R0eAxehuthlVCN3OwSbXgDL77XxOvByeaac9RlhokXmPtn8G5QnOGN6PxPTFzSTHYbrCD6RdaK/nmeUycX/A+bnAsXMsa5qC4w1zY5yzQT5y9hW0tK7pUxMfyjw37QwMWhrHPfRLQRO5xYLo6KPlPfi9uk+Y755npEqEaQ9BRz/wXeCYozMOHnfjAOJn3EDxrKePf84mzEEy8ex07RZxp68X0mzpV8krkeFaqhWxHj3J4Id4H7QXGGt/C6H4wjKumB8D0c7sS4/XCl5EuSwoOGHcYux0VXZnZsPwkPY8tCE+dhhFyS7GHM56NyiIQPcAj6TIXf4VgnxsWIjTjhxEhr796lh+gzfb04h+l+c11VtANWBMXF8IDyWrSzyRLRTq9sK4hOG/7/LCcWC4frN3hWdKFy4bDjNsA6Fm4h7IhuTmy86Eu3ODEXNviG6NZl4Tz+DHs7sY3wqgRrCPffB6KJWpqLHmq4xVl4yHop2WtGFv1F5wYnP/c4ymHDI10tpx57r0j0xVvhO8med13gCyl5rll4Vn8Et4t2HJPxtycmyS2Scpjz8LIhVEPhVOD7looepR/CNqEafwEOJc5vvoxfPwp7uoqCIylfdI3gNImCR012iL8GuFQX/XBsUw2v7L/BlbnQD5Z2eLpq6wdLMzXhaD+YkpKS8q/4BQOdwO6aWXw5AAAAAElFTkSuQmCC>

[image4]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEcAAAAZCAYAAABjNDOYAAADbElEQVR4Xu2XWahOURTHl3nIlCIPZB5uUmTO0OVB4QUPxiRCiYg8mMqQOYQib/crL148kLEMJR4IyTw+kJk8GAqZ/n9r7++ss+/5uvveB5Tzq3/fd9be3zp7r+/stdYRycnJyfm7dIBmhEbDMGit05hgjLSHFkFDoCZQR2giNN1OiqSF6O+2QLOgBunhIgOhldAqqE8w5on1VYkyaDN0BfoBHU0PF9kG7YemQTuh79ApqKGZMwL6GegZNMjMiaEtdBvaDg2G9kF3oJZ2ElgK3YImQFOg+9CC1Ix4X5kMEI1mX+iLZAenHLoGNTO2XaKb32ps5dBT6BJ0WPQfbWPGYzkAHQlsF6AKc91D9P79jG2U6B66GVuMryhKBYePLBfCqHuGOxuDYW0Fc10TWomuY0lgXw99kuRI7IDeJ8O/qS/69HO9JNZXFKWC0x+6CI03ttaiwXlibMxJBXNdE8aJ+p0Z2LlB2nkPwif5cTJchAE77b7H+oqiVHCyGCt6g93GNhQ65GxcIPNYtRYA5oj6ZQ6xzHf2Se6auexeMlzkjWhOIbG+oqhOcHhu+S8xoXuY8N5Jkge6Q69Fc08syyV74fOcnZ+Ea/VBsLxyIrG+ouANj4XGDOZCH6CRgb2RaDm3VEDfoC6BvRTLRBc+ObD7DfHe5DN0NxkuwsA8d99jfUXB4BwPjQEs17w581AMG0QXwooYw2zR+WwZLCzRtLNsExaCB8lwkbfQdfc91lcUVQWnF3RDtIx62PR5zkOXodrGtk50IWH/UYrRkv3Ir3B2Nn2EBcIfH08tSe8h1lcUdHwiNDraQWfcp6ee6CIJF8YkyUe9bnGGln8uhF2zp5Okm0dLY9Eyuymw0w/zVx13vUa0bFs/7Kl4r4XuOtZXlXCjX6Fzkt4cYfvNTvSmaBU6KzqPCfGgmceG0L5W8Hcs9SeNja8U3FRWpfHsha5K8gSyf3koGhBPZ9G8x3Lt4dF9KenGM8ZXSbgZnl3mEVYfio8rW/Hmbo7PG1na6OYQLorBK0CrRY8gEzx7Ig+7bLbzH0U3mAU3wFcTikeCx3VPaobCY/NC9OjyFegR1DM1I97XH6MrNBXqHQ4Y+I/aNj8L5jb2KGXhgIEvuPyDGaimwZglxtc/AfNTqdz237NYKleQHAcDw6cnJycnJwf8AmTx55InzVZWAAAAAElFTkSuQmCC>

[image5]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACcAAAAWCAYAAABDhYU9AAACAElEQVR4Xu2VTShmYRTHD8ZXzWRKhI3UzLARiiJGLCxYWWgWGpGklI+lYiFkgbKQZGF4lbWi0CxmxkIWPlYsrH1sFCUfCx/D/3TufZ37eL3vvYjN+6vf273nOW/3Ps9znnOJwoR5PxJgCxyG7TDVOeyadNgBi+FHmAF/wDqd5IVvcB22wWa4A89htU5ySTm8MzyEhTrJCyuwXt0nwRt4YV17oQwekEx2AXbDFJ3ghUh4Bf/DNBX/SzLrJhVzQyn0mcGXMA4X4Qcjxi/XqGJu+E7Pf7ks2AorYYEx5mCDZGu9bmsJnIej8A/cInnhUPB/eklWnkvh0jn8QAXJqk2aAy4ogicw37rPhEckD3yKHHgMo1RsRl37+QR34RyMsWJ5JNsbzJ9WbjxJO9FMk+zCFyNuwyvLi8EHqIakrT06RFxzy/AXOWfBtcBtJZhV/uzHDFDo+h2jh9ZzTTIhB/xSg+o+m6RveWEVbpJ0AZs+kodysQeCF4LlleUPwRJJvh8uxk4dAF0ky+yWCJKGy2WhT/4EycP4qxEI/nr0G7FZ+4K/CmfwH0l/W4Fr8JRk9bwwRM4t/gz34G8VM2mA+zBRxab4hwuYi9Xeb+0tjLOzXcKFzC3EB3vgNsk2JasckwaScvDBEZKTGvC0vhZfYS3MNQcCwKsba13zJKLVWJgwb8Y9hgBmwOImNW0AAAAASUVORK5CYII=>

[image6]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABMAAAAXCAYAAADpwXTaAAABGElEQVR4XmNgGAWUAhcgvkUkloDqwQkYgZgLiHcC8X8gdgZiNiBmBWIOIJYH4llA/A/KJwq8BOKPQMyMLgEEQkD8HF0QF9BigLhqC5o4J5RmAeITyBL4QBYDxLASJDF9IJ4PZYMMzUeSwwtWMUAMM4HyQWG4CYiT4SpIAK8YIIbdg+LPUL4KsiJigDYDRON2IGZigMRkMBA/QVYEBdxAHAfEIugSMJDDADGsDElME4iXIPFBIBOIFzJA1KqiycHBGgaIAjMkMZALRJH4yACnYaAE+4YBd/rCBnAaZswAkdyBLoEHYBjmCMS3gfg9EH8D4q9AfJ+BOENBhqmhC5ILQIapowuSC6hiWAwQz2WABAsoDxegSg9rAAA/HTvdx/UAqgAAAABJRU5ErkJggg==>

[image7]: <data:image/png;base64,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>

[image8]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFEAAAAaCAYAAADPELCZAAAEkklEQVR4Xu2Yd4hdVRCHf/ZeY2+xY4LYsNc1oiKiEVuMEBOMsWBXREVFLKgoYg0Itih2YwMrBsVoEuwawfiHGhVRxIoFLFjmY86Y82bfzW4iLA+8H/zYPXPKO3funDnzntTS0jK0LGlaLRu7sG42DCWLmoaZFssdPQB7esa0c+7ownGmydk4FLxm+sv0t2nj1NcLXGe6KxsbWMT0uumc3DEYeEv7ZOMgIQqvUW868SDTT6a1c4f8iN9u2jvZ8cUfpi2SfUAuNJ2cjQvASepNJ75kOj8bC/vK97x/7jDuNj2QjQPxiv6bE49X7zlxa/memi6UK+URt3zuMPY0/SnP8wPCAizGh11i2sy0accIZ325o8aZNkp9MEmdTlxPfoTWNG0QgwormMbI52xT2ZcxbSePkF2KjXUOMK0agyrIX3vJX/6u8nFLVf0XmH6o2gH75zlfNb1n2ty0VscIaR358xye7F05Tx6FTHjf9JzpyaqfjV5qekP+4EeZ5srn1YQTNyntd0sbzY5B8of+wnSu6UjTV6arSx8OfEc+53HT9abbTBebfjFNKOMAp+KA8fJcfqv6Rx1z2XfNivJnfFk+fk5ps58anpvPvCHZGxkpX7DbcT5VvtjKla1PHuo4NQgnRhSTU+6TOyZYXR4ZXELBwfJ5O1W2D+Xrj61sDxV7cLrc0QEPzcutnfiCmvPafvLP5W8TvPyHs7GJJidy635veirZgbLm46odThwhv/Euq/oCLi/GcOyWK+LI47A6sonGz9VZc1K7MTdsF8nLKqJ1lPym5Tat5+DUbvuAK+T5kD008ajpxWxsIpx4SrITVdjvSXaYJu9bpbTDiTj3N/lRyhAVjGFzRGqtOureUv9jeJN87uKlzedOLzZEGXNm6Qt+NJ2VbMFM06xsTBAMpLpBEU48rbS3NQ2XXxLYHyn2mhnyvjVKO5x4hOns8v+BpS+4o9h3T/bMm/KkX0NuYu4SpU3kcVJ2lJcwHD36+0o/fGq6uWoHRN/vpqtyR4J0cG82NsExYANnlDZJlhuSTX4mj66apU2/qvOYnyBfg5KAeUTJl+rMUYeWMdSUNczZrWq/rf5OvFGdTiRK6i8HROhceYUR8DKerdpB5EPSCvSZJv7bOw+e/fJsbGJZ07fyjQJHMS6IQ+RHpX7IY+R5rL40ODZsjFIItiptHI3TgydMH2he/cWFQLQwHshp3JhEFi8juEW+3kqlPUVeRcQY1uHiqUsS0lB9GQUnyteifKLcIuK4tWvYMzn32GSfLyz8nfwhczKmjnpansvIVURZXd/RxtHkINbgeJHwfy62r01Hl7Hc8tSlH5kelP8wwEuBPeTRyxzE/6PkjuBWx/aNPHdPMU013Wm61nS/vFTCmcEE+eUReTSgSvhE/kyPmbbs6HUixZEuFgjyTFOFzubIkRsm+8JCRPFyFhaK+KDp5ysKZnLf9rlDHsHDs7GCLxXUui3yNPB8Ng4A33o4Kfws1iLPe9S6o3PHfODrIpdSncv/95BXuazq79VNkBr4EhEXZEvFYer/u2E3qHd3yMaWlpaWlsHxD+Bv+/hRhuhgAAAAAElFTkSuQmCC>

[image9]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAcAAAAcCAYAAACtQ6WLAAAAkklEQVR4XmNgGOTABYgXoQvCwFEgPo4uCAM4JXmA+DcQdyAL8gGxChDHAPF/IE4HYlUgZgVJZgHxTiB+xgDRCWKDsDRIEgZA9h1DFoABbiD+BcTt6BIg4MYAsc8dXQIE2hgg9oFcjAFAdp1E4s8DYhYY5wUQz4Gy04C4BCYBAhVA/B6IZwJxK7IEDIgy4LBzRAMAaC8Zom6t39QAAAAASUVORK5CYII=>

[image10]: <data:image/png;base64,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>

[image11]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAaCAYAAAC+aNwHAAABA0lEQVR4Xu2SIUtDURiGP8VZFIuiE8OYi2IxOGRtdXmGpVVhYBlikRXBLDaDQZtxRfwBsjFQu0tmg+AEm/ocv3vH5d2FLcseeODe973nOwfuMfv3zOM2VnA9kS9hNvE+wipe4Cf28BLbeI5r2MXd4dfCIX7gDa5Id4SDyDnp/mjgDx5oERGO/Y33WgT2zcsrLYRnPNZwAd/Md9+QTgm7FzVsmi9+1CKFTZzRsGM+oKXFpLybD9jRYhIy5ou/tEjhFHMaBl7NhyxqkaCADxrGnJkPCFc2jVm8xZIWMcvYxxcsSxcuzx3WJR8hb/6Pw0me8ASvzRfvJb4byxZWsRY9T5kyll/XiyxRZFBdwwAAAABJRU5ErkJggg==>

[image12]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAaCAYAAACO5M0mAAAAkUlEQVR4XmNgGAXUBCxA7ATEglC+ABB7AzE3XAUULAfieUD8CYhLgXgFELcC8U0gZoQpsgPiJiDWBuL/QLwPiDmA+DQQfwNiTpjCFCDWBOIEqEIzqHg4ELtC2SgAZPU7IGZCl0AHd4F4PbogOpBmgFibjy6BDiIZIAr10SXQQTsQ32BACgpcgBeIudAFRwH1AQBXXxRK+83PqwAAAABJRU5ErkJggg==>

[image13]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADsAAAAZCAYAAACPQVaOAAADQklEQVR4Xu2WWahOURTH/6YUZZ6VMmZ4wYN4MkcIZUrk3hR5EBnehCIyvEgZknkoIkIJyRAhHojIFNeYIREhIf7/1t7f3d+63733402dX/37zl5rnfOddfZea28gIyPjf6cntZgaT9VzPtGBmk2tpEY6XyG2Uq+o19RLamm+uwIHUB7/gppPzaKeB5sk/xPqYdA1ahHVAEVSlzpH7aQGU6uo42kAGUg9peZSg6izsJerjprUdaqMekPVyfOW05G6Sf2mdjmfWA/zlTr7NOoTdYmq73wF2U1tS8ZK/BfVOIxrwb70wlwE0IT6TJUktsq4QC2BvexY54ssh31IxWx0PqHVJN9E7yBbYL4N3uGZCQvslthGwZZzZDQspndiE/qaZ5ytEEpWJfCdOup8QrMve39Un6xKzDMH5jvsHZ4j1Mdw3ZBqlvgi62APa+/sx2AJ1HZ2j5JVTR2iflAt890YCpvVYpId5x3kBMw3zDs8Kv571ArYcr5BXaZaJDH7YA9rndjEwWD3L++JyaqpKT4tB7ED9pGLSbYEVl5NqXaw8nsW7FWihPSAn9SMYKsBWw63YctLnApxPik1KNnTEihETFa1r256J/FpNe0N18Ukex7WwDQxuu8+tYxqk4ushB6wB2gp6kUiaveyx+3lZBi3ykUYMdkuzu5RskpKrIbd0yeM1TPUI0QxyfplrC1yD2zCxjhfHs1hD3jg7FODPXY3fUGN2+YiDNWg7OrMVaFkG4XrrrB7NoWxekas+X9JVnSC+bSXx49aAS1T7VG3nH0K7ObNYRxnwy/X09QX2NKvCiUbtzFxhfpA9aLWJvZiki3UjcV7mH+Ed6Tsh+2hKXE7invagDD23U6Nrdp2D0s2nf34/LtU98T+r8nGcnyHalaZ/kAHiFhDQt33KspnTPWshqUtKKI6/UYNSWyFUKk8poYnNjWrr7D/SNHpTS+tQ4JnDcw3ydk7w3YQ+UrzXYVZAHshnWIuwrYe1VaK2nwZtR12Zn1ETU4DCqBtQWUi6bSlmoro3FwarjUz6htvYbHa93XunQdrllp5akBKSB9YzykLv4pXo+yLv0CddjpszVdWg2ok/agJqLjnZmRkZGRkZJTzBx512oYqBj8vAAAAAElFTkSuQmCC>

[image14]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEUAAAAZCAYAAABnweOlAAADpElEQVR4Xu2Xa+iOZxzHv2bmmLMyxNKQiJqSU0rzAtkM2yihRCTMJF4RLYcXYu0NYmsbW2yykTnk0N/KITm8IMT4a+a8zaHkMDbfb7/rep7rvp7nuW/7l3f3p7713L/f9dz3dX3v67p+1w3k5OTkvFreoibGQcd46kOqI9WQ6k/NptqHjchr1HvUEupT6s1kuoTJ1FXqJnWd2p1Ml6BnXqNuwNr/4OLnXUz3kX6nfqMuOn1HDXJtM+lKLadOUP9SvyTTBQ5S/0VaTb0RtNHvLbB7DKTmwQbQN2hTiZXUFdh9eyZTBWpR22FtLlG1k2m0cLlqWFtPO1ifnlGjg3hFelOTqF7UE1Q2pYo6TB2FmTEikTWmUbeoBkFMM0Zv6vUgVo7F1ELYoD6Pcp53YTNFbc5GOaGXUiknY/TSn1Jto1wqaaYcgC2vNE7C3mTIYFhHB0TxGJnyPmzG3kFyBnq+olqh8sC9KWfiBGzm/AXL94hyqaSZsh/ppjSFPfCbKP6Oiy+I4jHelBmw9qOSaTSG7Qsiy5TTcQK2IpQ7EieySDNlHzWd2kMdp76g6gf5TrCHrg1iopuLa8ml4U1pTj2mdiTTmALLiyxTlGsGu1dLahhsb5OpHQqtX5I0U2TGl1Qd2P6wijqH4uzRZlpu8NrIFd8cxWO8KUIVRZtiWLl+QnFfyjLlLmzGShuobbAXOQRWHf8XMmVnHHR0RvKGclwd+Npd93HXa3wDhzfl+ygeI1P85j0U9h9VL9GFWuF+iyxTyi0f7Wn3YYUirlqpyJRdcdARljihGaMO6Dwg3nbX6wotjO4uruWWhkz5wP1WpzXdNRPFMth9PDUxRWyE5efGiTQqmTKcukd9FMTUcZW4P911I9iUj5dJP1hH5kfxGJkyMriWEfqfDok/B3GRZUq56iNmwvLH4kQaMqXciXIq9ZyaEMS03vWAvUGsCqW7+1hYu6wyKFPCiqPl6gevDT6kpqb8CMtnVcICWg462PyK0oOWdnGVZLXxzIEZFZ4/xlAPqTZB7FuYWWnovluppUjuW4eoR7By71HfNLALQcyjQ6Nyftl5tPQ1U/+BfQ7UTaZLUbnSifM69cBJp1I9tEnQbhZscIuo9bCD0Lgg7/kM1qlPYGv4MOyMUQl9+/yN4rNvwzZtoZmpA5vnFPUHim0vU5tcToPVEpcpkg6A2u+qYdVIY9S3WFpfakQ92P6i6qDZU4nW1MewMh3OrpycnJycnJycl+EFjC7v9B0AAk8AAAAASUVORK5CYII=>

[image15]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGMAAAAZCAYAAAAlgpAyAAAEk0lEQVR4Xu2YdYhtVRTGP7G7C1EHW7ELweDZjQ0iimMhJv5jgChPVCwMRLF9tih2Y4EtgoJdqPPsxFZsv9+svd/dZ78749yZQWQ8P/jg7rVO7rX22utcqaWlpaVlgjO7NV9tHC/6rH1r4z+wnHWMdYbi3Nma7gnJztZP1l/WtZVvTKxsnW49b/1p3dt0D8vu1qNWvyIgX1tTrWWLYyYqi1o/aJyDsb61v7WO9YtGHox5rE8UwczsosiW5wrbROYjjXMwSnoJxkaKiX+jsFFDf0x2ytdE50P9R4LByqBEnVzZX1MEY5nKXrOSdbi1rbWepg/eGtYRivo8d+WDWaxtrKOs7a2Fm+5B1rSOVFxj/sq3mjXJ2iGN2Yi31PDP3WftaK1tzaDuwWDP3MM6QFE1OH5U9BKMbhCg362XakfFndZJ1ibW8YrNkP0HZlW84BPWTtYUa0DNckggX1ckA03DlYqJWSr5eY67rZsUk03APlYEHmaynlS875eKa3D80Yo977J0XGYO6wrrU+sU60TrVutbNYOxqfW4IviI53ul8PfEWINxqmJV7F07Csj4r6wZC9vV6gSDa/yqZsv4gnVf+k0pfNN6quPWZMV9J6UxE4Wf7M2coNhwy+bickXTcnFhO1SRUEsXtgsVzckCha1PMV9lMG5XBD7DKnu5GPcEF88v3SurWz8ruqrh2FgxcXcpAjCvtZi1oDWz4hqsijkLnZfsTO5e6fyD1AH7kun3Wgo/WV5CdmNnFWW4LjZWWoYSg23zNF5cETBWRs33agbjEUWiHadIOp5r1cLfEwTj/to4Anjgd60Da8cQXKB4YfSbohSR8UwKtnesayqxeqjH+dyt1B2eAX+3Z+FeLxbjcxTHzlXYdku2LdJ46zRmxdbUwSAR3lfn3fi9WeHvidEEg/r8rLVrYeN3ztQayhNiwz5EsRJ58MmKms/vh/PBXcgTuF/tSNCm42fzLyGQlJ9XC9vZimNJhExuz9nMy/Fp047oUAeD/Y5rEUA+gj+3vtEov9IJxgO1MUG3Unc8lJU71FnSmQethSpbZh9N34FdZz2mWNZk7mdN9yDbKTbeDRSTU5Yb4H4bWitaf1hnNt2DmyvnleXr3GQrg0EilcGgC2MPu3HaER0IxvXFmMaF5Mwsryhx3LsnmFhuSjfAS9e8p1jmfWnMxDGJdDF0DYgJ5YOPjBiKfusDxR6RYWIpP7CuIoMP67i1gpqTT7C5R04OnuUedUoC/ygMWIukMe92ieIjjb0jc6li4su2eM9ko5PLnKX4fipXO00KE/1QYRuwji3GfYoEp4yPCDLubUXr910SmfmWYnPN3KBo03J9JXNybaz1dDqmG/2KtvIqRclhL0DlhLDSuMYzivveouZS5xuDySWoZOZt1sGFHygVnI+f2s0GzF8YwPlTFZnN+7Lp0gVxnS+SDZFsQFllFVFySAqOYw8hQLwv7TFNCB/AvMtF1vnWzer9v75/FSaV2gpkLlk7FKyIMiFqOJdjuq1k4D6UrbxCxgqJyPdOLmurWEsU4xxsnofgtLS0tLS0tLS0tPzf+BtNVQ+bM8g2zwAAAABJRU5ErkJggg==>

[image16]: <data:image/png;base64,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>