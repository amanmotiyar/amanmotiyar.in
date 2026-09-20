// Reads and writes the signed-in user's tracker data.
// Originally used Netlify Database, but that project's database connection
// string isn't reaching Functions (confirmed via CLI: database is enabled,
// but no NETLIFY_DB_URL is exposed anywhere, in any context -- a Netlify-side
// wiring gap reported to their support). Netlify Blobs has no such issue and
// is already proven working (it's what stores the actual report files), so
// this uses it for the sync record too. The JSON shape returned is identical
// to before, so nothing on the client side needed to change.

const { getStore, connectLambda } = require("@netlify/blobs");

exports.handler = async (event, context) => {
  connectLambda(event);

  const user = context.clientContext && context.clientContext.user;
  if (!user) {
    return { statusCode: 401, body: JSON.stringify({ error: "Not authenticated" }) };
  }
  const userId = user.sub;
  // "strong" consistency needs extra edge configuration not available in
  // classic (Lambda-compat) functions -- default "eventual" consistency
  // works fine here and just means a write can take up to ~60s to be
  // visible to a read from a different request.
  const store = getStore({ name: "user-sync-data" });

  if (event.httpMethod === "GET") {
    const record = await store.get(userId, { type: "json" });
    if (!record) {
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: null, forceLogoutAt: null }) };
    }
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: record.data, updatedAt: record.updatedAt, forceLogoutAt: record.forceLogoutAt || null })
    };
  }

  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
    }

    if (body && body.action === "force_logout_all") {
      const existing = (await store.get(userId, { type: "json" })) || { data: {} };
      const forceLogoutAt = new Date().toISOString();
      existing.forceLogoutAt = forceLogoutAt;
      await store.setJSON(userId, existing);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true, forceLogoutAt })
      };
    }

    if (!body || typeof body.data !== "object" || body.data === null) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing data" }) };
    }

    const existing = (await store.get(userId, { type: "json" })) || {};
    const updatedAt = new Date().toISOString();
    await store.setJSON(userId, { data: body.data, updatedAt: updatedAt, forceLogoutAt: existing.forceLogoutAt || null });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, updatedAt: updatedAt })
    };
  }

  return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
};
