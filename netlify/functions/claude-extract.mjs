// Modern-format Netlify Function (note the `export default` + Request/Response
// shape below, instead of exports.handler) -- this is the format that
// actually gets AI Gateway credentials auto-injected in this project;
// classic exports.handler functions here do not (confirmed via diagnostic
// logging: ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, NETLIFY_AI_GATEWAY_KEY and
// NETLIFY_AI_GATEWAY_BASE_URL were all absent there).
//
// This function does NO identity/auth checking of its own -- extract-report.js
// (a classic function) does all of that first, then calls this one internally
// as a plain proxy to Claude. Because every Netlify Function is a public URL,
// this file checks a shared secret header so only that internal call can ever
// reach it -- without this check, anyone could call this endpoint directly
// and spend this account's AI Gateway credits.

import Anthropic from "@anthropic-ai/sdk";

export default async (req) => {
  const secret = req.headers.get("x-internal-secret");
  const expected = process.env.INTERNAL_BRIDGE_SECRET;
  if (!secret || !expected || secret !== expected) {
    console.error("claude-extract: secret mismatch -- has env var:", Boolean(expected), "env var length:", expected ? expected.length : 0, "received header:", Boolean(secret), "header length:", secret ? secret.length : 0);
    return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } });
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  if (!body || !body.base64 || !body.mimeType || !body.prompt) {
    return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400, headers: { "Content-Type": "application/json" } });
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
    return new Response(JSON.stringify({ content: message.content }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("claude-extract bridge call failed:", e && e.message);
    return new Response(JSON.stringify({ error: "Model call failed" }), { status: 502, headers: { "Content-Type": "application/json" } });
  }
};
