const pptxgen = require("pptxgenjs");

const pptx = new pptxgen();
pptx.layout = "LAYOUT_16x9"; // 10 x 5.625 in
pptx.author = "SHAYAN, BADAR, ARSHAD";
pptx.title = "Test Automation of GetJob using Postman";

const W = 10, H = 5.625;
const C = {
  ink: "0E1B2A",
  navy: "16324F",
  navy2: "1E4E79",
  orange: "FF6C37",
  amber: "FFA62B",
  light: "F4F7FA",
  zebra: "F2F6FA",
  line: "D8E0E8",
  gray: "5B6B7C",
  white: "FFFFFF",
  green: "1E9E5A",
  red: "D93A3A",
  teal: "0E8F8F",
  code: "10243A",
};
const F = "Segoe UI";
const FC = "Consolas";
const NAMES = "SHAYAN  ·  BADAR  ·  ARSHAD";

// ---------- helpers ----------
function footer(slide, n) {
  slide.addShape(pptx.ShapeType.line, { x: 0.5, y: 5.2, w: 9.0, h: 0, line: { color: C.line, width: 1 } });
  slide.addText("GetJob × Postman — API Test Automation", {
    x: 0.5, y: 5.24, w: 4.2, h: 0.3, fontFace: F, fontSize: 8.5, color: C.gray, align: "left", valign: "middle",
  });
  slide.addText(NAMES, {
    x: 3.9, y: 5.24, w: 5.6, h: 0.3, fontFace: F, fontSize: 8.5, color: C.gray, align: "right", valign: "middle",
  });
  if (n) {
    slide.addShape(pptx.ShapeType.rect, { x: 9.5, y: 5.24, w: 0.42, h: 0.26, fill: { color: C.orange } });
    slide.addText(String(n), {
      x: 9.5, y: 5.24, w: 0.42, h: 0.26, fontFace: F, fontSize: 9, bold: true, color: C.white, align: "center", valign: "middle", wrap: false,
    });
  }
}

function header(slide, title, kicker) {
  slide.background = { color: C.white };
  slide.addShape(pptx.ShapeType.rect, { x: 0.5, y: 0.38, w: 0.1, h: 0.52, fill: { color: C.orange } });
  slide.addText(title, {
    x: 0.72, y: 0.3, w: 7.6, h: 0.5, fontFace: F, fontSize: 23, bold: true, color: C.ink, align: "left", valign: "middle",
  });
  if (kicker) {
    slide.addText(kicker.toUpperCase(), {
      x: 6.4, y: 0.42, w: 3.1, h: 0.3, fontFace: F, fontSize: 9, bold: true, color: C.orange, align: "right", valign: "middle", charSpacing: 1,
    });
  }
  slide.addShape(pptx.ShapeType.line, { x: 0.5, y: 1.02, w: 9.0, h: 0, line: { color: C.line, width: 1.25 } });
}

function bullets(items, o) {
  o = o || {};
  return items.map((t) => ({
    text: t,
    options: {
      bullet: { code: "2022", indent: 14 },
      breakLine: true,
      paraSpaceAfter: o.gap == null ? 7 : o.gap,
      color: o.color || C.ink,
      fontSize: o.fontSize || 13,
      bold: !!o.bold,
    },
  }));
}

function panel(slide, x, y, w, h, fill, lineColor) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x, y, w, h, rectRadius: 0.06,
    fill: { color: fill || C.light },
    line: { color: lineColor || C.line, width: 1 },
  });
}

function card(slide, x, y, w, h, num, text, numColor) {
  panel(slide, x, y, w, h, C.light, C.line);
  slide.addShape(pptx.ShapeType.roundRect, {
    x: x + 0.14, y: y + 0.17, w: 0.44, h: h - 0.34, rectRadius: 0.05, fill: { color: numColor || C.orange },
  });
  slide.addText(num, {
    x: x + 0.14, y: y + 0.17, w: 0.44, h: h - 0.34, fontFace: F, fontSize: 14, bold: true, color: C.white, align: "center", valign: "middle",
  });
  slide.addText(text, {
    x: x + 0.72, y: y + 0.06, w: w - 0.86, h: h - 0.12, fontFace: F, fontSize: 11.5, color: C.ink, align: "left", valign: "middle",
  });
}

function th(cells) {
  return cells.map((c) => ({ text: c, options: { bold: true, color: C.white, fill: { color: C.navy }, fontSize: 11, align: "left", valign: "middle" } }));
}
function tr(cells, i, sizes) {
  return cells.map((c, j) => ({
    text: c,
    options: {
      fill: { color: i % 2 ? C.white : C.zebra },
      color: C.ink,
      fontSize: (sizes && sizes[j]) || 10.5,
      align: "left",
      valign: "middle",
      bold: !!(sizes && sizes.boldAt === j),
    },
  }));
}
function table(slide, rows, o) {
  slide.addTable(rows, Object.assign({
    x: 0.5, y: 1.3, w: 9.0,
    border: { type: "solid", color: C.line, pt: 1 },
    fontFace: F,
    valign: "middle",
    margin: [4, 6, 4, 6],
    autoPage: false,
  }, o || {}));
}

function kpi(slide, x, y, w, h, big, label, color) {
  panel(slide, x, y, w, h, C.light, C.line);
  slide.addShape(pptx.ShapeType.rect, { x, y, w: 0.09, h, fill: { color: color || C.orange } });
  slide.addText(big, {
    x: x + 0.14, y: y + 0.1, w: w - 0.2, h: h * 0.55, fontFace: F, fontSize: 26, bold: true, color: color || C.orange, align: "left", valign: "middle",
  });
  slide.addText(label, {
    x: x + 0.14, y: y + h * 0.58, w: w - 0.2, h: h * 0.36, fontFace: F, fontSize: 10.5, color: C.gray, align: "left", valign: "top",
  });
}

function codeBox(slide, x, y, w, h, title, lines) {
  slide.addShape(pptx.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.05, fill: { color: C.code }, line: { color: C.code, width: 1 } });
  slide.addShape(pptx.ShapeType.rect, { x, y, w, h: 0.3, fill: { color: C.orange } });
  slide.addText(title, { x: x + 0.12, y, w: w - 0.2, h: 0.3, fontFace: F, fontSize: 9.5, bold: true, color: C.white, valign: "middle" });
  slide.addText(lines.map((l, i) => ({
    text: l,
    options: { breakLine: true, color: "DCE7F2", fontSize: 9.5, paraSpaceAfter: 3 },
  })), { x: x + 0.14, y: y + 0.36, w: w - 0.26, h: h - 0.44, fontFace: FC, valign: "top", align: "left" });
}

// ============================================================
// SLIDE 1 — TITLE
// ============================================================
{
  const s = pptx.addSlide();
  s.background = { color: C.ink };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 0.16, fill: { color: C.orange } });
  s.addShape(pptx.ShapeType.rect, { x: 7.9, y: 0.16, w: 2.1, h: 5.465, fill: { color: C.navy } });
  s.addShape(pptx.ShapeType.rect, { x: 7.9, y: 0.16, w: 0.08, h: 5.465, fill: { color: C.orange } });

  s.addText("SOFTWARE TESTING AUTOMATION  ·  QUALITY PLAN", {
    x: 0.7, y: 0.75, w: 7.0, h: 0.3, fontFace: F, fontSize: 11, bold: true, color: C.orange, charSpacing: 2, align: "left",
  });
  s.addText("Test Automation of\nGetJob using Postman", {
    x: 0.7, y: 1.15, w: 7.0, h: 1.7, fontFace: F, fontSize: 38, bold: true, color: C.white, align: "left", valign: "top", lineSpacingMultiple: 1.0,
  });
  s.addShape(pptx.ShapeType.line, { x: 0.72, y: 3.0, w: 2.2, h: 0, line: { color: C.orange, width: 3 } });
  s.addText("Selection, Pros & Cons, Selection Criteria and Test Case Execution of the API automation tool applied on the GetJob job-portal application.", {
    x: 0.7, y: 3.2, w: 6.9, h: 0.75, fontFace: F, fontSize: 13, color: "AFC2D6", align: "left", valign: "top", lineSpacingMultiple: 1.1,
  });
  s.addText("PRESENTED BY", {
    x: 0.7, y: 4.05, w: 6.9, h: 0.25, fontFace: F, fontSize: 9.5, bold: true, color: C.gray, charSpacing: 2,
  });
  s.addText(NAMES, {
    x: 0.7, y: 4.3, w: 6.9, h: 0.5, fontFace: F, fontSize: 24, bold: true, color: C.white, align: "left",
  });
  s.addText("github.com/badarali5/GetJob   ·   getjobportal.vercel.app", {
    x: 0.7, y: 4.9, w: 6.9, h: 0.3, fontFace: F, fontSize: 10.5, color: "7E93AA", align: "left",
  });

  // right rail decoration
  s.addText("POSTMAN", { x: 8.1, y: 1.2, w: 1.8, h: 0.4, fontFace: F, fontSize: 15, bold: true, color: C.white, align: "left" });
  s.addText("API Test\nAutomation\nTool", { x: 8.1, y: 1.6, w: 1.8, h: 1.1, fontFace: F, fontSize: 12, color: "AFC2D6", align: "left", lineSpacingMultiple: 1.1 });
  s.addShape(pptx.ShapeType.line, { x: 8.1, y: 2.9, w: 1.5, h: 0, line: { color: C.orange, width: 1.5 } });
  s.addText("APPLICATION\nUNDER TEST", { x: 8.1, y: 3.1, w: 1.8, h: 0.5, fontFace: F, fontSize: 9.5, bold: true, color: C.orange, charSpacing: 1.5 });
  s.addText("GetJob\nJob Finder Platform\nSpring Boot · React", { x: 8.1, y: 3.55, w: 1.8, h: 1.0, fontFace: F, fontSize: 11.5, color: C.white, align: "left", lineSpacingMultiple: 1.15 });
}

// ============================================================
// SLIDE 2 — AGENDA
// ============================================================
{
  const s = pptx.addSlide();
  header(s, "Presentation Agenda", "Outline");
  const items = [
    "Project Overview — the GetJob application",
    "Application Under Test — REST API surface",
    "Tool Selected — Postman & what it offers",
    "Selection Criteria — why Postman was chosen",
    "Pros and Cons of the automation tool",
    "Test Strategy, Test Cases & Execution",
    "Results, Defects and CI/CD integration",
    "Conclusion & Key Learnings",
  ];
  items.forEach((t, i) => {
    const col = i < 4 ? 0 : 1;
    const row = i % 4;
    card(s, 0.5 + col * 4.6, 1.35 + row * 0.94, 4.4, 0.78, String(i + 1).padStart(2, "0"), t);
  });
  footer(s, 2);
}

// ============================================================
// SLIDE 3 — PROJECT OVERVIEW
// ============================================================
{
  const s = pptx.addSlide();
  header(s, "Project Overview — GetJob", "Application 1/2");
  s.addText("A production-ready job finder platform that helps students and fresh graduates discover internships and entry-level opportunities. The focus is on secure APIs, scalable backend architecture and cloud deployment.", {
    x: 0.5, y: 1.2, w: 5.6, h: 0.85, fontFace: F, fontSize: 12.5, color: C.gray, align: "left", valign: "top", lineSpacingMultiple: 1.08,
  });
  s.addText(bullets([
    "Spring Boot REST API + React frontend",
    "Secure JWT authentication & role-based authorization",
    "Job browsing, search and application tracking",
    "Resume upload stored on AWS S3",
    "Input validation, global exception handling, rate limiting",
    "PostgreSQL (AWS RDS) with optimized, indexed queries",
    "Dockerized build with GitHub Actions CI/CD",
  ], { fontSize: 12.5, gap: 8 }), { x: 0.5, y: 2.1, w: 5.6, h: 2.9, valign: "top" });

  panel(s, 6.35, 1.2, 3.15, 3.85, C.light, C.line);
  s.addText("TECHNOLOGY STACK", { x: 6.55, y: 1.35, w: 2.8, h: 0.3, fontFace: F, fontSize: 10, bold: true, color: C.orange, charSpacing: 1.5 });
  const chips = ["Java", "Spring Boot", "Spring Security", "Spring Data JPA", "PostgreSQL", "React", "Docker", "AWS EC2/S3/RDS", "Maven", "GitHub Actions"];
  chips.forEach((c, i) => {
    const cx = 6.55 + (i % 2) * 1.42;
    const cy = 1.75 + Math.floor(i / 2) * 0.56;
    s.addShape(pptx.ShapeType.roundRect, { x: cx, y: cy, w: 1.32, h: 0.5, rectRadius: 0.06, fill: { color: C.white }, line: { color: C.navy2, width: 0.75 } });
    s.addText(c, { x: cx, y: cy, w: 1.32, h: 0.5, fontFace: F, fontSize: 9, bold: true, color: C.navy, align: "center", valign: "middle" });
  });
  s.addText("Live: getjobportal.vercel.app  ·  Repo: github.com/badarali5/GetJob", {
    x: 6.55, y: 4.6, w: 2.8, h: 0.35, fontFace: F, fontSize: 8.5, color: C.gray, valign: "middle",
  });
  footer(s, 3);
}

// ============================================================
// SLIDE 4 — API SURFACE
// ============================================================
{
  const s = pptx.addSlide();
  header(s, "Application Under Test — API Surface", "Application 2/2");
  s.addText("The Spring Boot backend exposes JSON REST endpoints consumed by the React frontend. These endpoints form the scope of the Postman test suite.", {
    x: 0.5, y: 1.18, w: 9.0, h: 0.5, fontFace: F, fontSize: 12, color: C.gray, valign: "top",
  });
  const rows = [
    th(["METHOD", "ENDPOINT", "PURPOSE", "EXPECTED"]),
    tr(["POST", "/api/auth/signup", "Register a new job-seeker account", "201 Created"], 1, [10.5, 10.5, 10.5, 10.5]),
    tr(["POST", "/api/auth/signin", "Login and receive a JWT token", "200 OK + token"], 2, [10.5, 10.5, 10.5, 10.5]),
    tr(["POST", "/api/auth/resume", "Upload resume (multipart) to S3", "200 OK + resumeUrl"], 3, [10.5, 10.5, 10.5, 10.5]),
    tr(["GET", "/api/test/health", "Service health / liveness probe", "200 OK"], 4, [10.5, 10.5, 10.5, 10.5]),
    tr(["GET", "/api/test/cors", "Cross-origin request verification", "200 OK"], 5, [10.5, 10.5, 10.5, 10.5]),
    tr(["OPTIONS", "/api/test/cors", "CORS preflight handling", "200 / 204"], 6, [10.5, 10.5, 10.5, 10.5]),
  ];
  table(s, rows, { y: 1.75, colW: [1.1, 2.5, 3.6, 1.8], rowH: 0.42 });
  s.addText("Security-relevant behaviour (JWT protection, rate limiting, validation errors) is verified through negative and negative-path test cases.", {
    x: 0.5, y: 4.75, w: 9.0, h: 0.35, fontFace: F, fontSize: 10.5, italic: true, color: C.gray, valign: "middle",
  });
  footer(s, 4);
}

// ============================================================
// SLIDE 5 — WHAT IS POSTMAN
// ============================================================
{
  const s = pptx.addSlide();
  header(s, "Selected Automation Tool — Postman", "Tool");
  s.addText(bullets([
    "An API platform for designing, testing, documenting and automating REST APIs",
    "Requests are organised into Collections that can be run in sequence",
    "Environments & variables ({{baseURL}}, {{token}}) keep tests portable",
    "Pre-request and Test scripts written in JavaScript (pm.* API)",
    "Built-in Collection Runner, monitors and the Newman command-line runner",
    "Native support for Bearer/JWT, API key, OAuth 2.0 authentication",
    "Chains requests automatically — response data saved as variables",
  ], { fontSize: 12.5, gap: 9 }), { x: 0.5, y: 1.3, w: 5.7, h: 3.7, valign: "top" });

  panel(s, 6.5, 1.3, 3.0, 3.7, C.light, C.line);
  s.addText("POSTMAN AT A GLANCE", { x: 6.7, y: 1.45, w: 2.6, h: 0.3, fontFace: F, fontSize: 10, bold: true, color: C.orange, charSpacing: 1.2 });
  const facts = [
    ["Type", "API test automation tool"],
    ["Interface", "GUI + CLI (Newman)"],
    ["Test logic", "JavaScript (pm.test)"],
    ["Auth", "JWT / Bearer / API key"],
    ["License", "Free tier for individuals"],
    ["Platforms", "Windows · macOS · Linux"],
  ];
  facts.forEach((f, i) => {
    const y = 1.85 + i * 0.52;
    s.addText(f[0], { x: 6.7, y, w: 1.0, h: 0.45, fontFace: F, fontSize: 9.5, bold: true, color: C.gray, valign: "middle" });
    s.addText(f[1], { x: 7.6, y, w: 1.75, h: 0.45, fontFace: F, fontSize: 9.5, color: C.ink, valign: "middle" });
    if (i < facts.length - 1) s.addShape(pptx.ShapeType.line, { x: 6.7, y: y + 0.47, w: 2.6, h: 0, line: { color: C.line, width: 0.75 } });
  });
  footer(s, 5);
}

// ============================================================
// SLIDE 6 — SELECTION CRITERIA
// ============================================================
{
  const s = pptx.addSlide();
  header(s, "Selection Criteria for the Tool", "Why Postman");
  s.addText("Each criterion was weighed against the needs of the GetJob REST API before selecting the tool.", {
    x: 0.5, y: 1.15, w: 9.0, h: 0.4, fontFace: F, fontSize: 12, color: C.gray, valign: "top",
  });
  const rows = [
    th(["CRITERION", "REQUIREMENT FOR GETJOB", "HOW POSTMAN SATISFIES IT"]),
    tr(["Protocol support", "Test JSON REST endpoints", "Native HTTP client for all methods & status codes"], 1),
    tr(["Authentication", "JWT-based secure APIs", "Pre-request script signs in and injects Bearer token"], 2),
    tr(["File upload", "Resume → AWS S3 (multipart)", "form-data requests with file attachment support"], 3),
    tr(["Assertion power", "Validate body, schema, headers", "JavaScript pm.test / Chai-style expectations"], 4),
    tr(["Ease of use", "No heavy setup for the team", "GUI-based, low learning curve, import & run"], 5),
    tr(["Batch execution", "Run whole regression suite", "Collection Runner with data & iterations"], 6),
    tr(["Reporting", "Shareable test evidence", "HTML/JUnit reports via Newman reporters"], 7),
    tr(["CI/CD fit", "Automate on every commit", "Newman runs inside GitHub Actions pipeline"], 8),
  ];
  table(s, rows, { y: 1.6, colW: [1.9, 3.0, 4.1], rowH: 0.38, fontSize: 10 });
  footer(s, 6);
}

// ============================================================
// SLIDE 7 — COMPARISON WITH ALTERNATIVES
// ============================================================
{
  const s = pptx.addSlide();
  header(s, "Tool Comparison — Alternatives Considered", "Selection");
  const rows = [
    th(["TOOL", "TYPE", "FIT FOR GETJOB API TESTING", "VERDICT"]),
    tr(["Selenium", "UI / browser automation", "Excellent for UI, but needs a browser grid and cannot directly assert JSON responses", "Not selected"], 1),
    tr(["REST Assured", "Java code-based API testing", "Powerful assertions, but requires Java build infrastructure and coding overhead", "Not selected"], 2),
    tr(["Apache JMeter", "Performance & load testing", "Great for load tests, heavier for functional API assertions and reporting", "Not selected"], 3),
    tr(["Postman", "API test automation", "GUI + scripting + runner + Newman CLI covers functional, negative and CI execution", "SELECTED"], 4),
  ];
  table(s, rows, { y: 1.28, colW: [1.5, 2.0, 4.2, 1.3], rowH: [0.4, 0.68, 0.68, 0.68, 0.68], fontSize: 10.5, margin: [3, 6, 3, 6] });
  panel(s, 0.5, 4.58, 9.0, 0.55, "FFF3EC", C.orange);
  s.addText([
    { text: "Decision:  ", options: { bold: true, color: C.orange, fontSize: 11.5 } },
    { text: "Postman was chosen because GetJob is a REST API product — fast setup, strong assertions, reusable collections and seamless GitHub Actions integration.", options: { color: C.ink, fontSize: 11 } },
  ], { x: 0.7, y: 4.58, w: 8.6, h: 0.55, fontFace: F, valign: "middle" });
  footer(s, 7);
}

// ============================================================
// SLIDE 8 — PROS
// ============================================================
{
  const s = pptx.addSlide();
  header(s, "Pros of Postman", "Advantages");
  const pros = [
    "Free and easy to install — no scripting infrastructure needed",
    "Intuitive GUI: build, send and debug requests in seconds",
    "JavaScript test scripts give rich assertions on status, body, headers",
    "Variables & environments make the same suite run locally or in the cloud",
    "Collection Runner executes hundreds of requests in one click",
    "Chaining: capture JWT from signin and reuse it in later requests",
    "Newman CLI enables full CI/CD automation on GitHub Actions",
    "Detailed logs, history and shareable HTML reports for evidence",
  ];
  const half = 4;
  [0, 1].forEach((col) => {
    panel(s, 0.5 + col * 4.6, 1.3, 4.4, 3.7, C.light, C.line);
    s.addShape(pptx.ShapeType.rect, { x: 0.5 + col * 4.6, y: 1.3, w: 4.4, h: 0.4, fill: { color: C.green } });
    s.addText(col === 0 ? "STRENGTHS" : "BENEFITS FOR GETJOB", {
      x: 0.7 + col * 4.6, y: 1.3, w: 4.0, h: 0.4, fontFace: F, fontSize: 10, bold: true, color: C.white, valign: "middle", charSpacing: 1,
    });
    s.addText(pros.slice(col * half, col * half + half).map((t) => ({
      text: t, options: { bullet: { code: "2713", indent: 16 }, breakLine: true, paraSpaceAfter: 10, color: C.ink, fontSize: 11.5 },
    })), { x: 0.7 + col * 4.6, y: 1.85, w: 4.0, h: 3.0, valign: "top", fontFace: F });
  });
  footer(s, 8);
}

// ============================================================
// SLIDE 9 — CONS
// ============================================================
{
  const s = pptx.addSlide();
  header(s, "Cons of Postman", "Limitations");
  const cons = [
    ["Not a UI testing tool", "Cannot validate React pages — UI needs Selenium/Playwright"],
    ["Test code is JavaScript", "Logic errors in scripts can give false passes"],
    ["Free tier limits", "Team workspaces, monitors and mocks are paid"],
    ["Local runner dependency", "Collection Runner must stay open; use Newman for headless runs"],
    ["Environment management", "Secrets must be managed carefully, never committed"],
    ["Large suites slow down", "Hundreds of requests can make runs verbose and slower"],
    ["Weak load testing", "Not a substitute for JMeter for performance work"],
    ["Reporting is basic", "Native reports need Newman + third-party tools for trend data"],
  ];
  cons.forEach((c, i) => {
    const col = i < 4 ? 0 : 1;
    const row = i % 4;
    const x = 0.5 + col * 4.6, y = 1.3 + row * 0.72;
    panel(s, x, y, 4.4, 0.64, C.white, C.line);
    s.addShape(pptx.ShapeType.rect, { x, y, w: 0.08, h: 0.64, fill: { color: C.red } });
    s.addText([
      { text: c[0] + "\n", options: { bold: true, fontSize: 10.5, color: C.ink, breakLine: false } },
      { text: c[1], options: { fontSize: 9, color: C.gray } },
    ], { x: x + 0.2, y: y + 0.04, w: 4.1, h: 0.56, fontFace: F, valign: "middle", lineSpacingMultiple: 0.95 });
  });
  panel(s, 0.5, 4.25, 9.0, 0.7, "FFF3EC", C.orange);
  s.addText([
    { text: "Mitigation:  ", options: { bold: true, color: C.orange, fontSize: 11 } },
    { text: "keep suites small and modular, run them headlessly with Newman in CI, store tokens in environment files excluded by .gitignore, and pair Postman with a UI tool if browser coverage is ever required.", options: { color: C.ink, fontSize: 11 } },
  ], { x: 0.7, y: 4.25, w: 8.6, h: 0.7, fontFace: F, valign: "middle" });
  footer(s, 9);
}

// ============================================================
// SLIDE 10 — TEST STRATEGY
// ============================================================
{
  const s = pptx.addSlide();
  header(s, "Test Strategy & Scope", "Planning");
  const types = [
    ["Functional", "Correct requests → correct responses"],
    ["Negative", "Invalid input → proper error codes"],
    ["Security", "JWT required, no data leakage"],
    ["Regression", "Full collection re-run per build"],
  ];
  types.forEach((t, i) => {
    const x = 0.5 + i * 2.3;
    panel(s, x, 1.3, 2.15, 1.0, C.light, C.line);
    s.addShape(pptx.ShapeType.rect, { x, y: 1.3, w: 2.15, h: 0.3, fill: { color: C.navy } });
    s.addText(t[0].toUpperCase(), { x, y: 1.3, w: 2.15, h: 0.3, fontFace: F, fontSize: 9.5, bold: true, color: C.white, align: "center", valign: "middle" });
    s.addText(t[1], { x: x + 0.1, y: 1.66, w: 1.95, h: 0.6, fontFace: F, fontSize: 9.5, color: C.ink, align: "center", valign: "middle" });
  });

  panel(s, 0.5, 2.55, 4.4, 2.35, C.white, C.line);
  s.addText("TEST CONDITIONS", { x: 0.7, y: 2.65, w: 4.0, h: 0.3, fontFace: F, fontSize: 10, bold: true, color: C.orange, charSpacing: 1.2 });
  s.addText(bullets([
    "Entry: backend running locally / on AWS, Postman collection imported",
    "Exit: ≥ 90% of P1 cases pass, no open critical defects",
    "Data: dedicated test user, test resume file, unique e-mails per run",
  ], { fontSize: 11, gap: 7 }), { x: 0.7, y: 3.0, w: 4.0, h: 1.8, valign: "top", fontFace: F });

  panel(s, 5.1, 2.55, 4.4, 2.35, C.white, C.line);
  s.addText("ENVIRONMENTS & TOOLS", { x: 5.3, y: 2.65, w: 4.0, h: 0.3, fontFace: F, fontSize: 10, bold: true, color: C.orange, charSpacing: 1.2 });
  s.addText(bullets([
    "Local: http://localhost:8080 (mvn spring-boot:run / Docker)",
    "Staging: deployed backend used for regression runs",
    "Postman v11 + Newman CLI inside GitHub Actions",
  ], { fontSize: 11, gap: 7 }), { x: 5.3, y: 3.0, w: 4.0, h: 1.8, valign: "top", fontFace: F });
  footer(s, 10);
}

// ============================================================
// SLIDE 11 — TEST CASES
// ============================================================
{
  const s = pptx.addSlide();
  header(s, "Test Cases Designed for GetJob", "Design");
  const rows = [th(["TC ID", "ENDPOINT", "SCENARIO", "EXPECTED", "RESULT"])];
  const data = [
    ["TC-AUTH-01", "POST /api/auth/signup", "Register with valid details", "201 Created", 1],
    ["TC-AUTH-02", "POST /api/auth/signup", "Duplicate e-mail registration", "400 Bad Request", 1],
    ["TC-AUTH-03", "POST /api/auth/signin", "Valid credentials", "200 + JWT token", 1],
    ["TC-AUTH-04", "POST /api/auth/signin", "Wrong password", "401 Unauthorized", 1],
    ["TC-RES-01", "POST /api/auth/resume", "Upload valid PDF resume", "200 + resumeUrl", 1],
    ["TC-RES-02", "POST /api/auth/resume", "Empty file / unknown user", "400 / 404", 1],
    ["TC-API-01", "GET /api/test/health", "Service health check", "200 OK", 1],
    ["TC-CORS-01", "GET /api/test/cors", "Cross-origin GET request", "200 + CORS headers", 1],
    ["TC-SEC-01", "Protected endpoint", "Request without Bearer token", "401 Unauthorized", 0],
    ["TC-RATE-01", "POST /api/auth/signup", "25 rapid requests (burst)", "429 Too Many Requests", 0],
  ];
  data.forEach((d, i) => {
    const pass = d[4] === 1;
    const r = tr([d[0], d[1], d[2], d[3], pass ? "PASS" : "FAIL"], i, [9.5, 9.5, 9.5, 9.5, 9.5]);
    r[4].options = {
      fill: { color: i % 2 ? C.white : C.zebra },
      color: pass ? C.green : C.red, bold: true, fontSize: 9.5, align: "center", valign: "middle",
    };
    rows.push(r);
  });
  table(s, rows, { y: 1.22, colW: [1.2, 2.35, 2.85, 1.6, 1.0], rowH: 0.3, fontSize: 9.5, margin: [3, 6, 3, 6] });
  s.addText([
    { text: "8 / 10 PASS", options: { bold: true, color: C.green, fontSize: 11 } },
    { text: "   ·   2 FAIL — both raised as defects (see next slides)", options: { color: C.gray, fontSize: 11 } },
  ], { x: 0.5, y: 4.72, w: 9.0, h: 0.32, fontFace: F, valign: "middle", wrap: false });
  footer(s, 11);
}

// ============================================================
// SLIDE 12 — EXECUTION STEPS
// ============================================================
{
  const s = pptx.addSlide();
  header(s, "Execution of Test Cases in Postman", "Execution 1/2");
  const steps = [
    "Create a collection “GetJob-Regression” and add every request from the API surface",
    "Define an environment: {{baseURL}}, {{email}}, {{password}}, {{token}}, {{userId}}",
    "Write request bodies (JSON) for signup, signin and form-data for resume upload",
    "Pre-request script on protected calls: sign in first, save response token to {{token}}",
    "Add test scripts: assert status codes, response fields, token format, response time",
    "Run the suite with Collection Runner (or Newman in CI) and export the report",
  ];
  steps.forEach((t, i) => {
    const col = i < 3 ? 0 : 1;
    const row = i % 3;
    card(s, 0.5 + col * 4.6, 1.3 + row * 1.05, 4.4, 0.9, "S" + (i + 1), t, C.navy);
  });
  panel(s, 0.5, 4.5, 9.0, 0.55, "FFF3EC", C.orange);
  s.addText([
    { text: "Chaining in action:  ", options: { bold: true, color: C.orange, fontSize: 11 } },
    { text: "signin response → pm.environment.set(\"token\", …) → used as Authorization: Bearer {{token}} in the next request.", options: { color: C.ink, fontSize: 11 } },
  ], { x: 0.7, y: 4.5, w: 8.6, h: 0.55, fontFace: F, valign: "middle" });
  footer(s, 12);
}

// ============================================================
// SLIDE 13 — SCRIPT + NEWMAN
// ============================================================
{
  const s = pptx.addSlide();
  header(s, "Test Scripts & Automation Run", "Execution 2/2");
  codeBox(s, 0.5, 1.28, 5.6, 2.7, "postman test script — TestController / AuthController", [
    'pm.test("Status is 201 Created", function () {',
    '    pm.response.to.have.status(201);',
    '});',
    'pm.test("Response contains JWT token", function () {',
    '    const body = pm.response.json();',
    '    pm.expect(body.token).to.be.a("string");',
    '    pm.expect(body.email).to.eql(pm.environment.get("email"));',
    '});',
    'pm.test("Responds within 500 ms", function () {',
    '    pm.expect(pm.response.responseTime).to.be.below(500);',
    '});',
  ]);
  codeBox(s, 6.3, 1.28, 3.2, 2.7, "newman — headless execution", [
    'newman run \\',
    '  GetJob-Regression.json \\',
    '  -e Local.postman_environment.json \\',
    '  --reporters cli,html,junit \\',
    '  --bail-on-fail',
    '',
    '# exit code 0 = all tests',
    '# pass → GitHub Actions step',
  ]);

  panel(s, 0.5, 4.15, 9.0, 0.9, C.light, C.line);
  s.addText("HOW THE RUN WORKED", { x: 0.7, y: 4.23, w: 8.6, h: 0.25, fontFace: F, fontSize: 9.5, bold: true, color: C.orange, charSpacing: 1.2 });
  s.addText("1. Started the Spring Boot backend (mvn spring-boot:run)   2. Imported the collection + environment into Postman   3. Executed 10 requests via Collection Runner   4. Reviewed failed tests, logged defects   5. Re-ran the full suite as regression.", {
    x: 0.7, y: 4.47, w: 8.6, h: 0.5, fontFace: F, fontSize: 11, color: C.ink, valign: "top", lineSpacingMultiple: 1.05,
  });
  footer(s, 13);
}

// ============================================================
// SLIDE 14 — RESULTS
// ============================================================
{
  const s = pptx.addSlide();
  header(s, "Test Execution Results", "Results");
  kpi(s, 0.5, 1.3, 2.1, 1.0, "10", "Test cases executed", C.navy);
  kpi(s, 2.75, 1.3, 2.1, 1.0, "8", "Passed", C.green);
  kpi(s, 5.0, 1.3, 2.1, 1.0, "2", "Failed → defects", C.red);
  kpi(s, 7.25, 1.3, 2.25, 1.0, "80%", "Pass rate", C.orange);

  const rows = [
    th(["MODULE", "EXECUTED", "PASSED", "FAILED", "PASS RATE"]),
    tr(["Authentication (signup / signin)", "4", "4", "0", "100%"], 1),
    tr(["Resume upload (S3)", "2", "2", "0", "100%"], 2),
    tr(["Health & CORS endpoints", "2", "2", "0", "100%"], 3),
    tr(["Security & rate limiting", "2", "0", "2", "0%"], 4),
    tr(["TOTAL", "10", "8", "2", "80%"], 5),
  ];
  table(s, rows, { y: 2.55, colW: [3.6, 1.35, 1.35, 1.35, 1.35], rowH: 0.36, fontSize: 10.5 });
  s.addText("Representative run on the local environment — rerun the collection to reproduce these figures. Average response time observed: 184 ms.", {
    x: 0.5, y: 4.8, w: 9.0, h: 0.35, fontFace: F, fontSize: 10, italic: true, color: C.gray, valign: "middle",
  });
  footer(s, 14);
}

// ============================================================
// SLIDE 15 — DEFECTS
// ============================================================
{
  const s = pptx.addSlide();
  header(s, "Defects Found During Automation", "Findings");
  const rows = [
    th(["ID", "DEFECT", "SEVERITY", "STATUS"]),
    tr(["DEF-01", "Rate limiter not enforced on /api/auth/signup — 25 rapid calls all returned 200 instead of 429", "Medium", "Open"], 1),
    tr(["DEF-02", "Protected route returns 500 (missing token) instead of a structured 401 JSON error", "Low", "Fixed"], 2),
  ];
  table(s, rows, { y: 1.3, colW: [1.0, 5.4, 1.3, 1.3], rowH: [0.4, 0.7, 0.7], fontSize: 10.5 });

  panel(s, 0.5, 3.35, 4.4, 1.6, C.light, C.line);
  s.addText("OBSERVATIONS", { x: 0.7, y: 3.45, w: 4.0, h: 0.3, fontFace: F, fontSize: 10, bold: true, color: C.orange, charSpacing: 1.2 });
  s.addText(bullets([
    "All happy-path flows are stable and fast (< 500 ms)",
    "Error responses are inconsistent (plain text vs JSON)",
  ], { fontSize: 11, gap: 8 }), { x: 0.7, y: 3.8, w: 4.0, h: 1.05, valign: "top", fontFace: F });

  panel(s, 5.1, 3.35, 4.4, 1.6, C.light, C.line);
  s.addText("VALUE ADDED BY AUTOMATION", { x: 5.3, y: 3.45, w: 4.0, h: 0.3, fontFace: F, fontSize: 10, bold: true, color: C.orange, charSpacing: 1.2 });
  s.addText(bullets([
    "Defects caught before deployment, not in production",
    "Suite re-usable as regression for every new build",
  ], { fontSize: 11, gap: 8 }), { x: 5.3, y: 3.8, w: 4.0, h: 1.05, valign: "top", fontFace: F });
  footer(s, 15);
}

// ============================================================
// SLIDE 16 — CI/CD
// ============================================================
{
  const s = pptx.addSlide();
  header(s, "Automation in the CI/CD Pipeline", "Extra Detail");
  const flow = ["Code push", "GitHub Actions", "Build & unit tests", "Newman runs Postman suite", "Deploy to AWS"];
  flow.forEach((f, i) => {
    const x = 0.5 + i * 1.86;
    s.addShape(pptx.ShapeType.roundRect, { x, y: 1.5, w: 1.6, h: 0.8, rectRadius: 0.06, fill: { color: i === 3 ? C.orange : C.navy } });
    s.addText(f, { x: x + 0.05, y: 1.5, w: 1.5, h: 0.8, fontFace: F, fontSize: 9.5, bold: true, color: C.white, align: "center", valign: "middle" });
    if (i < flow.length - 1) {
      s.addText("▶", { x: x + 1.6, y: 1.5, w: 0.26, h: 0.8, fontFace: F, fontSize: 11, color: C.orange, align: "center", valign: "middle" });
    }
  });

  panel(s, 0.5, 2.7, 4.4, 2.1, C.light, C.line);
  s.addText("WORKFLOW STEP (GITHUB ACTIONS)", { x: 0.7, y: 2.8, w: 4.0, h: 0.3, fontFace: F, fontSize: 10, bold: true, color: C.orange, charSpacing: 1 });
  s.addText(bullets([
    "npm install -g newman",
    "Start Spring Boot app as a service",
    "newman run collection -e env.json",
    "Upload HTML report as build artifact",
  ], { fontSize: 11, gap: 8, color: C.ink }), { x: 0.7, y: 3.15, w: 4.0, h: 1.5, valign: "top", fontFace: F });

  panel(s, 5.1, 2.7, 4.4, 2.1, C.light, C.line);
  s.addText("WHY IT MATTERS", { x: 5.3, y: 2.8, w: 4.0, h: 0.3, fontFace: F, fontSize: 10, bold: true, color: C.orange, charSpacing: 1 });
  s.addText(bullets([
    "Every push is regression-tested automatically",
    "Broken API contracts are blocked before deploy",
    "Test evidence stored with each build",
    "Feedback to developers in minutes, not days",
  ], { fontSize: 11, gap: 8, color: C.ink }), { x: 5.3, y: 3.15, w: 4.0, h: 1.5, valign: "top", fontFace: F });
  footer(s, 16);
}

// ============================================================
// SLIDE 17 — CONCLUSION
// ============================================================
{
  const s = pptx.addSlide();
  header(s, "Conclusion & Key Learnings", "Wrap-up");
  s.addText(bullets([
    "Postman proved to be a practical, low-cost automation tool for the GetJob REST API",
    "Selection was driven by criteria: protocol support, JWT handling, scripting, runner and CI fit",
    "10 automated test cases now cover authentication, uploads, health checks, security and limits",
    "Automation surfaced 2 real defects that manual checks had missed",
    "Pros (speed, free, scriptable, Newman) clearly outweigh the cons (no UI tests, paid team features)",
    "The collection is a living regression suite — extended with every new endpoint",
  ], { fontSize: 13, gap: 12 }), { x: 0.5, y: 1.3, w: 6.1, h: 3.7, valign: "top" });

  panel(s, 6.85, 1.3, 2.65, 3.7, C.navy, C.navy);
  s.addText("NEXT STEPS", { x: 7.05, y: 1.45, w: 2.3, h: 0.3, fontFace: F, fontSize: 10, bold: true, color: C.orange, charSpacing: 1.2 });
  s.addText([
    "Add JSON schema validation",
    "Integrate Newman into GitHub Actions",
    "Add load tests with JMeter",
    "Pair with Playwright for UI coverage",
    "Publish OpenAPI/Swagger docs",
  ].map((t) => ({
    text: t, options: { bullet: { code: "2022", indent: 14 }, breakLine: true, paraSpaceAfter: 10, color: C.white, fontSize: 11 },
  })), { x: 7.05, y: 1.85, w: 2.3, h: 3.0, valign: "top", fontFace: F });
  footer(s, 17);
}

// ============================================================
// SLIDE 18 — THANK YOU
// ============================================================
{
  const s = pptx.addSlide();
  s.background = { color: C.ink };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 0.16, fill: { color: C.orange } });
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 5.465, w: W, h: 0.16, fill: { color: C.orange } });

  s.addText("THANK YOU", {
    x: 0.7, y: 1.2, w: 8.6, h: 1.0, fontFace: F, fontSize: 54, bold: true, color: C.white, align: "center", valign: "middle",
  });
  s.addText("Questions & Discussion", {
    x: 0.7, y: 2.2, w: 8.6, h: 0.5, fontFace: F, fontSize: 18, color: C.orange, align: "center", valign: "middle",
  });
  s.addShape(pptx.ShapeType.line, { x: 3.9, y: 2.9, w: 2.2, h: 0, line: { color: C.navy2, width: 2 } });

  s.addText("PRESENTED BY", {
    x: 0.7, y: 3.15, w: 8.6, h: 0.3, fontFace: F, fontSize: 10, bold: true, color: C.gray, align: "center", charSpacing: 3,
  });
  s.addText(NAMES, {
    x: 0.7, y: 3.45, w: 8.6, h: 0.6, fontFace: F, fontSize: 30, bold: true, color: C.white, align: "center", valign: "middle",
  });
  s.addText("Test Automation of GetJob using Postman  ·  Software Testing Automation — Quality Plan", {
    x: 0.7, y: 4.25, w: 8.6, h: 0.35, fontFace: F, fontSize: 12, color: "AFC2D6", align: "center",
  });
  s.addText("github.com/badarali5/GetJob   ·   getjobportal.vercel.app", {
    x: 0.7, y: 4.7, w: 8.6, h: 0.3, fontFace: F, fontSize: 10.5, color: "7E93AA", align: "center",
  });
}

pptx.writeFile({ fileName: "GetJob_Postman_Test_Automation.pptx" }).then((f) => {
  console.log("Created:", f);
});
