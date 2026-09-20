// Modern-format Netlify Function, now run as a BACKGROUND function
// (see the `config` export below): a full extraction on a dense multi-page
// report genuinely took 44-48 seconds in testing, which is well past what a
// normal synchronous function can wait for. Background functions get up to
// 15 minutes and respond immediately, so extract-report.js starts a job here
// and polls for the result instead of waiting on one long request.
//
// No identity/auth checking of its own -- extract-report.js (a classic
// function) does all of that before ever calling this one, and this file is
// gated by a shared secret header so nothing else can trigger it and spend
// this account's AI Gateway credits.

import Anthropic from "@anthropic-ai/sdk";
import { getStore } from "@netlify/blobs";

export const config = { background: true };

function parseExtractionResponse(text) {
  var raw = String(text).trim();
  try { return validateTests(JSON.parse(raw)); } catch (e) {}
  var fenced = raw.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, "").trim();
  try { return validateTests(JSON.parse(fenced)); } catch (e) {}
  var first = raw.indexOf("{");
  var last = raw.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    try { return validateTests(JSON.parse(raw.slice(first, last + 1))); } catch (e) {}
  }
  throw new Error("Could not parse extraction response");
}
function validateTests(parsed) {
  if (!parsed || !Array.isArray(parsed.tests)) throw new Error("Unexpected shape");
  return parsed.tests;
}

export default async (req) => {
  const secret = req.headers.get("x-internal-secret");
  const expected = process.env.INTERNAL_BRIDGE_SECRET;
  const jobsStore = getStore({ name: "medical-reports-extraction-jobs" });

  if (!secret || !expected || secret !== expected) {
    console.error("claude-extract: secret mismatch, ignoring request");
    return;
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return;
  }
  if (!body || !body.jobId || !body.base64 || !body.mimeType || !body.prompt) {
    return;
  }

  const contentBlock = body.mimeType === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: body.base64 } }
    : { type: "image", source: { type: "base64", media_type: body.mimeType, data: body.base64 } };

  try {
    const anthropic = new Anthropic();
    const message = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 8192,
      messages: [{ role: "user", content: [contentBlock, { type: "text", text: body.prompt }] }]
    });
    const textBlock = (message.content || []).find(function (b) { return b.type === "text"; });
    if (!textBlock) {
      throw new Error("No text in model response");
    }
    const tests = parseExtractionResponse(textBlock.text);
    await jobsStore.setJSON(body.jobId, {
      status: "done", tests: tests, userId: body.userId,
      finishedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error("claude-extract background job failed:", e && e.message);
    await jobsStore.setJSON(body.jobId, {
      status: "error", error: "Extraction failed. Try again.", userId: body.userId,
      finishedAt: new Date().toISOString()
    });
  }
};
