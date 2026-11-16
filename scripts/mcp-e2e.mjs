/**
 * اختبار e2e لخادم MCP عبر Streamable HTTP — يدعم الردود SSE و JSON.
 * الاستخدام:
 *   node scripts/mcp-e2e.mjs                       # اختبار بروتوكول كامل
 *   node scripts/mcp-e2e.mjs call <tool> '<json>'  # استدعاء أداة
 */
const BASE = process.env.MCP_URL || "http://localhost:3000/mcp";

async function post(body, { timeoutMs = 300000 } = {}) {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const ct = res.headers.get("content-type") || "";
  const raw = await res.text();
  if (ct.includes("text/event-stream") || raw.trim().startsWith("event:") || raw.trim().startsWith(":")) {
    // SSE: اجمع آخر رسالة data (الرد النهائي يأتي آخرًا)
    const dataLines = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return { httpStatus: res.status, json: null, raw };
    return { httpStatus: res.status, json: JSON.parse(dataLines[dataLines.length - 1]), raw };
  }
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* تجاهل */
  }
  return { httpStatus: res.status, json, raw };
}

const textOf = (json) => {
  try {
    return json.result.content.map((c) => c.text).join("\n");
  } catch {
    return JSON.stringify(json, null, 2);
  }
};

const protocol = async () => {
  let pass = 0;
  let fail = 0;
  const ok = (name, cond) => {
    if (cond) {
      pass++;
      console.log(`  PASS  ${name}`);
    } else {
      fail++;
      console.log(`  FAIL  ${name}`);
    }
  };

  console.log("== 1) initialize ==");
  const init = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e", version: "1.0" } },
  });
  const r = init.json?.result ?? {};
  ok("http 200", init.httpStatus === 200);
  ok("serverInfo name", r.serverInfo?.name === "media-generator-mcp");
  ok("serverInfo version", r.serverInfo?.version === "1.2.0");
  ok("protocolVersion", typeof r.protocolVersion === "string");
  ok("instructions contain failover", (r.instructions || "").includes("automatically switches API keys"));
  ok("instructions contain 24h note", (r.instructions || "").includes("~24 hours"));

  console.log("== 2) notifications/initialized -> 202 ==");
  const notif = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  ok("http 202", notif.httpStatus === 202);

  console.log("== 3) tools/list ==");
  const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = list.json?.result?.tools ?? [];
  ok("5 tools", tools.length === 5);
  const names = tools.map((t) => t.name).sort();
  ok(
    "names",
    JSON.stringify(names) ===
      JSON.stringify(["generate_image", "generate_video", "get_task", "list_media", "merge_videos"])
  );
  const gi = tools.find((t) => t.name === "generate_image");
  const gv = tools.find((t) => t.name === "generate_video");
  const mv = tools.find((t) => t.name === "merge_videos");
  ok("generate_image required=[prompt]", JSON.stringify(gi?.inputSchema?.required) === JSON.stringify(["prompt"]));
  ok("generate_video duration default 8", gv?.inputSchema?.properties?.duration?.default === 8);
  ok("merge has no resolution/fps", !mv?.inputSchema?.properties?.resolution && !mv?.inputSchema?.properties?.fps);
  ok("merge urls maxItems 10", mv?.inputSchema?.properties?.urls?.maxItems === 10);
  ok("merge description has 24h note", (mv?.description || "").includes("~24 hours"));
  ok("get_task required=[task_id]", JSON.stringify(tools.find((t) => t.name === "get_task")?.inputSchema?.required) === JSON.stringify(["task_id"]));

  console.log("== 4) unknown tool -> Arabic error ==");
  const unk = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bogus_tool", arguments: {} } });
  ok("error code -32602", unk.json?.error?.code === -32602);
  ok("Arabic unknown-tool message", (unk.json?.error?.message || "").includes("أداة غير معروفة"));

  console.log("== 5) list_media (may be empty) ==");
  const lm = await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_media", arguments: {} } });
  ok("list_media returns text", typeof textOf(lm.json) === "string" && textOf(lm.json).length > 0);
  console.log("  └─", textOf(lm.json).split("\n")[0]);

  console.log(`== النتيجة: ${pass} ناجح / ${fail} فاشل ==`);
  process.exit(fail > 0 ? 1 : 0);
};

const callTool = async (name, args) => {
  console.log(`== tools/call ${name} ==`);
  const res = await post({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } });
  console.log("http:", res.httpStatus, "| isError:", res.json?.result?.isError ?? false);
  console.log(textOf(res.json));
};

const [,, cmd, tool, argsJson] = process.argv;
if (cmd === "call") {
  await callTool(tool, argsJson ? JSON.parse(argsJson) : {});
} else {
  await protocol();
}
