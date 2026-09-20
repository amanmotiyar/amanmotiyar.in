// Reads and writes the signed-in user's tracker data to Netlify DB.
// Auth is handled entirely by Netlify Identity: this function only runs
// the body below when context.clientContext.user is present, which Netlify
// populates automatically from the "Authorization: Bearer <jwt>" header
// sent by the client -- there is no separate password/secret to manage here.

const { getDatabase } = require("@netlify/database");

exports.handler = async (event, context) => {
  const user = context.clientContext && context.clientContext.user;
  if (!user) {
    return { statusCode: 401, body: JSON.stringify({ error: "Not authenticated" }) };
  }
  const userId = user.sub;
  const db = getDatabase();

  if (event.httpMethod === "GET") {
    const rows = await db.sql`SELECT data, updated_at FROM user_data WHERE user_id = ${userId}`;
    if (!rows.length) {
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: null }) };
    }
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: rows[0].data, updatedAt: rows[0].updated_at })
    };
  }

  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
    }
    if (!body || typeof body.data !== "object" || body.data === null) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing data" }) };
    }

    const rows = await db.sql`
      INSERT INTO user_data (user_id, data, updated_at)
      VALUES (${userId}, ${JSON.stringify(body.data)}::jsonb, now())
      ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
      RETURNING updated_at
    `;
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, updatedAt: rows[0] && rows[0].updated_at })
    };
  }

  return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
};
