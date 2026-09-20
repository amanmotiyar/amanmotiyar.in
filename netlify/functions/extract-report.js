// Phase 2: extracts test results from a report using Claude. The actual
// model call runs in claude-extract.mjs, as a BACKGROUND function (a full
// extraction on a dense report measured at 44-48 seconds, too long for a
// normal synchronous function to wait on) -- this file starts that job and
// lets the client poll for its result, and keeps all identity/auth and
// per-user ownership checking, unchanged.
//
// Ownership: every operation first looks the report id (or job's stored
// userId) up in the user's own index / job record. A report or job that
// doesn't belong to *this* signed-in user is treated as not found.

const crypto = require("crypto");
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
  const jobsStore = getStore({ name: "medical-reports-extraction-jobs" });

  async function ownedRecord(id) {
    var list = (await indexStore.get(userId, { type: "json" })) || [];
    return list.find(function (r) { return r.id === id; }) || null;
  }

  if (event.httpMethod === "GET") {
    var params = event.queryStringParameters || {};

    if (params.jobId) {
      var job = await jobsStore.get(params.jobId, { type: "json" });
      if (!job || job.userId !== userId) {
        return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
      }
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: job.status, tests: job.tests || null, error: job.error || null })
      };
    }

    if (params.id) {
      var record = await ownedRecord(params.id);
      if (!record) {
        return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
      }
      var results = await resultsStore.get(params.id, { type: "json" });
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ results: results || null })
      };
    }

    return { statusCode: 400, body: JSON.stringify({ error: "Missing id or jobId" }) };
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

    // Default action: START an extraction job and return immediately.
    // The client polls GET ?jobId=... for the result -- see above.
    const bytes = await fileStore.get(record.blobKey, { type: "arrayBuffer" });
    if (!bytes) {
      return { statusCode: 404, body: JSON.stringify({ error: "File missing from storage" }) };
    }
    const base64 = Buffer.from(bytes).toString("base64");
    const jobId = crypto.randomUUID();

    await jobsStore.setJSON(jobId, { status: "pending", userId: userId, reportId: body.id, startedAt: new Date().toISOString() });

    try {
      // process.env.URL (Netlify's usual auto-injected site URL) isn't reliably
      // present in this project's classic functions -- same pattern seen
      // elsewhere tonight -- so this is hardcoded to the site's real, known
      // address instead of depending on it.
      const bridgeUrl = "https://amanmotiyar.in/.netlify/functions/claude-extract-background";
      await fetch(bridgeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": process.env.INTERNAL_BRIDGE_SECRET || "" },
        body: JSON.stringify({ jobId: jobId, userId: userId, base64: base64, mimeType: record.mimeType, prompt: EXTRACTION_PROMPT })
      });
    } catch (e) {
      console.error("could not start extraction job:", e && e.message);
      await jobsStore.setJSON(jobId, { status: "error", error: "Could not start extraction. Try again.", userId: userId, reportId: body.id });
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: jobId, status: "pending" })
    };
  }

  return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
};
