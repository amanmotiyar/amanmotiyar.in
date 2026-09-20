const crypto = require("crypto");
const { getDatabase } = require("@netlify/database");
const { getStore, connectLambda } = require("@netlify/blobs");

// Kept deliberately small: classic Netlify Functions cap request/response
// payloads around 6MB, and base64 inflates size by ~33%, so this leaves
// headroom. Revisit if larger scanned reports are needed later.
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const ALLOWED_MIME = ["application/pdf", "image/jpeg", "image/png"];

exports.handler = async (event, context) => {
  connectLambda(event);

  const user = context.clientContext && context.clientContext.user;
  if (!user) {
    return { statusCode: 401, body: JSON.stringify({ error: "Not authenticated" }) };
  }
  const userId = user.sub;

  const db = getDatabase();
  // "strong" consistency: a report you just uploaded must show up in your
  // very next list/view call, not eventually.
  const store = getStore({ name: "medical-reports", consistency: "strong" });

  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters || {};

    if (params.id && params.action === "file") {
      const rows = await db.sql`
        SELECT * FROM medical_reports WHERE id = ${params.id} AND user_id = ${userId}
      `;
      if (!rows.length) {
        return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
      }
      const record = rows[0];
      const bytes = await store.get(record.blob_key, { type: "arrayBuffer" });
      if (!bytes) {
        return { statusCode: 404, body: JSON.stringify({ error: "File missing from storage" }) };
      }
      const safeName = String(record.filename).replace(/["\r\n]/g, "");
      return {
        statusCode: 200,
        headers: {
          "Content-Type": record.mime_type,
          "Content-Disposition": 'inline; filename="' + safeName + '"'
        },
        body: Buffer.from(bytes).toString("base64"),
        isBase64Encoded: true
      };
    }

    const rows = await db.sql`
      SELECT id, filename, mime_type, size_bytes, report_date, uploaded_at
      FROM medical_reports
      WHERE user_id = ${userId}
      ORDER BY report_date DESC NULLS LAST, uploaded_at DESC
    `;
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reports: rows })
    };
  }

  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
    }
    if (!body || !body.fileBase64 || !body.filename || !body.mimeType) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing file data" }) };
    }
    if (ALLOWED_MIME.indexOf(body.mimeType) === -1) {
      return { statusCode: 400, body: JSON.stringify({ error: "Only PDF, JPG, and PNG files are allowed" }) };
    }

    let buffer;
    try {
      buffer = Buffer.from(body.fileBase64, "base64");
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: "Could not read file data" }) };
    }
    if (!buffer.length) {
      return { statusCode: 400, body: JSON.stringify({ error: "File is empty" }) };
    }
    if (buffer.length > MAX_FILE_BYTES) {
      return { statusCode: 413, body: JSON.stringify({ error: "File is too large \u2014 please keep reports under 4MB for now." }) };
    }

    const id = crypto.randomUUID();
    // Every stored key is prefixed with the owner's user id. Nothing else in
    // this function ever reads or writes a blob key without first checking
    // that the matching database row belongs to this same user_id -- that
    // check, not the store itself, is what keeps one user's reports from
    // being reachable by another.
    const blobKey = userId + "/" + id;

    await store.set(blobKey, buffer, {
      metadata: { mimeType: body.mimeType, filename: body.filename }
    });

    await db.sql`
      INSERT INTO medical_reports (id, user_id, filename, mime_type, size_bytes, report_date, uploaded_at, blob_key)
      VALUES (${id}, ${userId}, ${body.filename}, ${body.mimeType}, ${buffer.length}, ${body.reportDate || null}, now(), ${blobKey})
    `;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id, filename: body.filename, mimeType: body.mimeType,
        sizeBytes: buffer.length, reportDate: body.reportDate || null
      })
    };
  }

  if (event.httpMethod === "DELETE") {
    const params = event.queryStringParameters || {};
    if (!params.id) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing id" }) };
    }
    const rows = await db.sql`
      SELECT blob_key FROM medical_reports WHERE id = ${params.id} AND user_id = ${userId}
    `;
    if (!rows.length) {
      return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    }
    await store.delete(rows[0].blob_key);
    await db.sql`DELETE FROM medical_reports WHERE id = ${params.id} AND user_id = ${userId}`;
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
};
