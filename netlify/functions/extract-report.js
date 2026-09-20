// Phase 2: extracts test results from a report using Claude. The actual
// model call is delegated to claude-extract.mjs (a modern-format function --
// see that file for why) over an internal, secret-gated request; this file
// keeps all identity/auth and per-user ownership checking, unchanged.
//
// Ownership: every operation first looks the report id up in the user's own
// index (never a global list), exactly like medical-reports.js. A report
// that isn't in *this* signed-in user's index is treated as not found.

const { getStore, connectLambda } = require("@netlify/blobs");

const MODEL = "claude-sonnet-5";

const EXTRACTION_PROMPT =
  "You are extracting structured data from a medical lab report. Follow these rules strictly:\n\n" +
  "1. Extract every individual test result you can find: its name, its value exactly as printed, its unit, and the reference range exactly as printed on this report.\n" +
  "2. If the report explicitly prints an abnormal or critical marker directly next to or clearly associated with a value (for example \"H\", \"L\", \"Critical\", \"Panic\", \"Abnormal\"), record it in labFlag exactly as printed. If no such marker is printed, labFlag must be null.\n" +
  "3. Never guess, infer, or fill in a value, unit, or reference range that is missing, cut off, or illegible. If you cannot confidently read a field, set it to null rather than guessing.\n" +
  "4. Do not calculate, diagnose, suggest treatment, or state whether any result is good, bad, healthy, or concerning. Only extract what is printed on the page.\n" +
  "5. Group results under the section heading printed in the report if there is one (e.g. \"LIVER & KIDNEY FUNCTION TEST\"); otherwise use null for section.\n\n" +
  "Respond with ONLY a JSON object in this exact shape, and nothing else -- no markdown fences, no commentary, no extra keys:\n" +
  "{\"tests\":[{\"section\":string|null,\"name\":string,\"value\":string|null,\"unit\":string|null,\"referenceRange\":string|null,\"labFlag\":string|null}]}";

function parseExtractionResponse(text) {
  var raw = String(text).trim();
  raw = raw.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  var parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.tests)) {
    throw new Error("Unexpected shape");
  }
  return parsed.tests;
}

exports.handler = async (event, context) => {
  connectLambda(event);

  const user = context.clientContext && context.clientContext.user;
  if (!user) {
    return { statusCode: 401, body: JSON.stringify({ error: "Not authenticated" }) };
  }
  const userId = user.sub;

  const indexStore = getStore({ name: "medical-reports-index" });
  const fileStore = getStore({ name: "medical-reports" });
  const resultsStore = getStore({ name: "medical-reports-results" });

  async function ownedRecord(id) {
    var list = (await indexStore.get(userId, { type: "json" })) || [];
    return list.find(function (r) { return r.id === id; }) || null;
  }

  if (event.httpMethod === "GET") {
    var id = event.queryStringParameters && event.queryStringParameters.id;
    if (!id) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing id" }) };
    }
    var record = await ownedRecord(id);
    if (!record) {
      return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    }
    var results = await resultsStore.get(id, { type: "json" });
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ results: results || null })
    };
  }

  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
    }
    if (!body || !body.id) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing report id" }) };
    }
    const record = await ownedRecord(body.id);
    if (!record) {
      return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    }

    if (body.action === "save") {
      if (!Array.isArray(body.tests)) {
        return { statusCode: 400, body: JSON.stringify({ error: "Missing tests" }) };
      }
      const confirmedAt = new Date().toISOString();
      await resultsStore.setJSON(body.id, { tests: body.tests, confirmedAt: confirmedAt, model: MODEL });
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true, confirmedAt: confirmedAt })
      };
    }

    // Default action: run extraction and return a PREVIEW. Nothing is saved
    // here -- the client shows this to the user for review, and only a
    // subsequent "save" call (above) persists anything.
    const bytes = await fileStore.get(record.blobKey, { type: "arrayBuffer" });
    if (!bytes) {
      return { statusCode: 404, body: JSON.stringify({ error: "File missing from storage" }) };
    }
    const base64 = Buffer.from(bytes).toString("base64");
    const contentBlock = record.mimeType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
      : { type: "image", source: { type: "base64", media_type: record.mimeType, data: base64 } };

    let message;
    try {
      // process.env.URL (Netlify's usual auto-injected site URL) isn't reliably
      // present in this project's classic functions either -- same pattern as
      // everything else tonight -- so this is hardcoded to the site's real,
      // known address instead of depending on it.
      const bridgeUrl = "https://amanmotiyar.in/.netlify/functions/claude-extract";
      const bridgeRes = await fetch(bridgeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": process.env.INTERNAL_BRIDGE_SECRET || "" },
        body: JSON.stringify({ base64: base64, mimeType: record.mimeType, prompt: EXTRACTION_PROMPT })
      });
      const bridgeBody = await bridgeRes.json();
      if (!bridgeRes.ok || bridgeBody.error) {
        console.error("extraction bridge call failed:", bridgeRes.status, bridgeBody && bridgeBody.error);
        return { statusCode: 502, body: JSON.stringify({ error: "Could not reach the extraction service. Try again." }) };
      }
      message = { content: bridgeBody.content };
    } catch (e) {
      console.error("extraction call failed:", e && e.message);
      return { statusCode: 502, body: JSON.stringify({ error: "Could not reach the extraction service. Try again." }) };
    }

    const textBlock = (message.content || []).find(function (b) { return b.type === "text"; });
    if (!textBlock) {
      return { statusCode: 502, body: JSON.stringify({ error: "No extraction result returned" }) };
    }

    let tests;
    try {
      tests = parseExtractionResponse(textBlock.text);
    } catch (e) {
      return { statusCode: 502, body: JSON.stringify({ error: "Could not understand the extraction result. Try again." }) };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tests: tests, model: MODEL })
    };
  }

  return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
};
