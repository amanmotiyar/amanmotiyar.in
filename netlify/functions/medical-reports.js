// Private medical report library. Originally kept file bytes in Blobs and
// metadata in the database -- moved metadata onto Blobs too (a small per-user
// index) since the database connection isn't reaching Functions in this
// project (see sync-data.js for the full explanation). Every operation still
// checks the report belongs to the signed-in user's own index before ever
// touching it -- that check is what keeps one user's reports from being
// reachable by another, same as before.

const crypto = require("crypto");
const { getStore, connectLambda } = require("@netlify/blobs");

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const ALLOWED_MIME = ["application/pdf", "image/jpeg", "image/png"];

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
  const fileStore = getStore({ name: "medical-reports" });
  const indexStore = getStore({ name: "medical-reports-index" });

  async function getIndex() {
    const idx = await indexStore.get(userId, { type: "json" });
    return idx || [];
  }
  async function setIndex(list) {
    await indexStore.setJSON(userId, list);
  }
  function sortedForDisplay(list) {
    return list.slice().sort(function (a, b) {
      if (a.reportDate && b.reportDate) return b.reportDate.localeCompare(a.reportDate);
      if (a.reportDate && !b.reportDate) return -1;
      if (!a.reportDate && b.reportDate) return 1;
      return new Date(b.uploadedAt) - new Date(a.uploadedAt);
    });
  }

  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters || {};

    if (params.id && params.action === "file") {
      const list = await getIndex();
      const record = list.find(function (r) { return r.id === params.id; });
      if (!record) {
        return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
      }
      const bytes = await fileStore.get(record.blobKey, { type: "arrayBuffer" });
      if (!bytes) {
        return { statusCode: 404, body: JSON.stringify({ error: "File missing from storage" }) };
      }
      const safeName = String(record.filename).replace(/["\r\n]/g, "");
      return {
        statusCode: 200,
        headers: {
          "Content-Type": record.mimeType,
          "Content-Disposition": 'inline; filename="' + safeName + '"'
        },
        body: Buffer.from(bytes).toString("base64"),
        isBase64Encoded: true
      };
    }

    const list = sortedForDisplay(await getIndex());
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reports: list.map(function (r) {
          return {
            id: r.id, filename: r.filename, mime_type: r.mimeType,
            size_bytes: r.sizeBytes, report_date: r.reportDate, uploaded_at: r.uploadedAt
          };
        })
      })
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
    const blobKey = userId + "/" + id;
    await fileStore.set(blobKey, buffer, { metadata: { mimeType: body.mimeType, filename: body.filename } });

    const list = await getIndex();
    const uploadedAt = new Date().toISOString();
    list.push({
      id: id, filename: body.filename, mimeType: body.mimeType,
      sizeBytes: buffer.length, reportDate: body.reportDate || null,
      uploadedAt: uploadedAt, blobKey: blobKey
    });
    await setIndex(list);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: id, filename: body.filename, mimeType: body.mimeType,
        sizeBytes: buffer.length, reportDate: body.reportDate || null
      })
    };
  }

  if (event.httpMethod === "DELETE") {
    const params = event.queryStringParameters || {};
    if (!params.id) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing id" }) };
    }
    const list = await getIndex();
    const idx = list.findIndex(function (r) { return r.id === params.id; });
    if (idx === -1) {
      return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    }
    await fileStore.delete(list[idx].blobKey);
    list.splice(idx, 1);
    await setIndex(list);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
};
