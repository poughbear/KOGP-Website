import { createClient } from "@supabase/supabase-js";

const STORAGE_BUCKET = "gallery";
const DATABASE_TABLE = "gallery_uploads";
const MAX_ITEMS = 100;
const SIGNED_URL_LIFETIME_SECONDS = 10 * 60;
const VALID_STATUSES = new Set(["pending", "approved", "rejected"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORAGE_PATH_PATTERN = /^uploads\/\d{4}\/\d{2}\/[0-9a-f-]+\.(?:jpe?g|png|webp|heic|heif)$/i;
const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, max-age=0",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  Vary: "Authorization"
};

export default async (request) => {
  if (request.method !== "GET" && request.method !== "PATCH") {
    return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "GET, PATCH" });
  }

  const config = getConfig();

  if (!config) {
    return jsonResponse({ error: "Gallery administration is not configured" }, 503);
  }

  const token = readBearerToken(request.headers.get("authorization"));

  if (!token) {
    return jsonResponse({ error: "Authentication required" }, 401);
  }

  const authorization = await authorizeAdministrator(token, config);

  if (!authorization.ok) {
    return jsonResponse({ error: authorization.status === 403 ? "Administrator access required" : "Authentication required" }, authorization.status);
  }

  const adminClient = createServerClient(config.supabaseUrl, config.supabaseSecretKey);

  try {
    if (request.method === "GET") {
      return await listSubmissions(request, adminClient, authorization.email);
    }

    return await updateSubmissions(request, adminClient);
  } catch (error) {
    console.error("Gallery administration request failed", { name: error?.name || "Error" });
    return jsonResponse({ error: "Gallery administration is temporarily unavailable" }, 503);
  }
};

function getConfig() {
  const supabaseUrl = normalizeSupabaseUrl(process.env.SUPABASE_URL);
  const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  const adminEmails = parseAdminEmails(process.env.GALLERY_ADMIN_EMAILS);

  if (!supabaseUrl || !supabasePublishableKey || !supabaseSecretKey || adminEmails.size === 0) {
    return null;
  }

  return { supabaseUrl, supabasePublishableKey, supabaseSecretKey, adminEmails };
}

async function authorizeAdministrator(token, config) {
  const authClient = createServerClient(config.supabaseUrl, config.supabasePublishableKey);
  const { data, error } = await authClient.auth.getUser(token);
  const email = normalizeEmail(data?.user?.email);

  if (error || !data?.user || !email || data.user.is_anonymous) {
    return { ok: false, status: 401 };
  }

  if (!config.adminEmails.has(email)) {
    return { ok: false, status: 403 };
  }

  return { ok: true, status: 200, email };
}

async function listSubmissions(request, adminClient, reviewerEmail) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "pending";

  if (!VALID_STATUSES.has(status)) {
    return jsonResponse({ error: "Invalid status filter" }, 400);
  }

  const [rowsResult, ...countResults] = await Promise.all([
    adminClient
      .from(DATABASE_TABLE)
      .select("id, storage_path, uploader_name, uploader_email, caption, status, created_at, approved_at")
      .eq("status", status)
      .order("created_at", { ascending: false })
      .limit(MAX_ITEMS),
    ...Array.from(VALID_STATUSES, (value) => (
      adminClient
        .from(DATABASE_TABLE)
        .select("id", { count: "exact", head: true })
        .eq("status", value)
    ))
  ]);

  if (rowsResult.error || countResults.some((result) => result.error)) {
    console.error("Gallery administration query failed", {
      rowsCode: rowsResult.error?.code || null,
      countsFailed: countResults.filter((result) => result.error).length
    });
    return jsonResponse({ error: "Submissions could not be loaded" }, 503);
  }

  const validRows = (rowsResult.data || []).filter(isValidSubmissionRow);
  const paths = validRows.map((row) => row.storage_path);
  let signedUrlsByPath = new Map();

  if (paths.length > 0) {
    const { data: signedObjects, error: signingError } = await adminClient.storage
      .from(STORAGE_BUCKET)
      .createSignedUrls(paths, SIGNED_URL_LIFETIME_SECONDS);

    if (signingError) {
      console.error("Gallery administration URL signing failed", { name: signingError.name });
      return jsonResponse({ error: "Photo previews could not be loaded" }, 503);
    }

    signedUrlsByPath = new Map(
      (signedObjects || [])
        .filter((item) => item?.path && item?.signedUrl && !item.error)
        .map((item) => [item.path, item.signedUrl])
    );
  }

  const items = validRows.map((row) => ({
    id: row.id,
    imageUrl: signedUrlsByPath.get(row.storage_path) || null,
    uploaderName: normalizeOptionalText(row.uploader_name, 120),
    uploaderEmail: normalizeEmail(row.uploader_email),
    caption: normalizeOptionalText(row.caption, 300),
    status: row.status,
    createdAt: row.created_at,
    approvedAt: typeof row.approved_at === "string" ? row.approved_at : null,
    fileType: row.storage_path.split(".").pop().toLowerCase()
  }));

  const statusOrder = Array.from(VALID_STATUSES);
  const counts = Object.fromEntries(statusOrder.map((value, index) => [value, countResults[index].count || 0]));

  return jsonResponse({
    reviewer: { email: reviewerEmail },
    status,
    counts,
    items,
    truncated: counts[status] > MAX_ITEMS
  }, 200);
}

async function updateSubmissions(request, adminClient) {
  const contentType = request.headers.get("content-type") || "";

  if (!contentType.toLowerCase().startsWith("application/json")) {
    return jsonResponse({ error: "JSON content is required" }, 415);
  }

  const requestBody = await request.text();

  if (requestBody.length > 20000) {
    return jsonResponse({ error: "Request is too large" }, 413);
  }

  let payload;

  try {
    payload = JSON.parse(requestBody);
  } catch {
    return jsonResponse({ error: "Request body is invalid" }, 400);
  }

  const status = payload?.status;
  const ids = Array.isArray(payload?.ids) ? Array.from(new Set(payload.ids)) : [];

  if (!VALID_STATUSES.has(status)) {
    return jsonResponse({ error: "Invalid review status" }, 400);
  }

  if (ids.length === 0 || ids.length > MAX_ITEMS || ids.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))) {
    return jsonResponse({ error: "One to 100 valid submission IDs are required" }, 400);
  }

  const changes = {
    status,
    approved_at: status === "approved" ? new Date().toISOString() : null
  };

  const { data, error } = await adminClient
    .from(DATABASE_TABLE)
    .update(changes)
    .in("id", ids)
    .select("id, status, approved_at");

  if (error) {
    console.error("Gallery administration update failed", { code: error.code });
    return jsonResponse({ error: "Submissions could not be updated" }, 503);
  }

  return jsonResponse({ updated: data || [] }, 200);
}

function createServerClient(supabaseUrl, key) {
  return createClient(supabaseUrl, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
}

function parseAdminEmails(value) {
  return new Set(
    (value || "")
      .split(/[\s,;]+/)
      .map(normalizeEmail)
      .filter(Boolean)
  );
}

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function normalizeOptionalText(value, maxLength) {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ").slice(0, maxLength);
  return text || null;
}

function normalizeSupabaseUrl(value) {
  try {
    const url = new URL(value?.trim());
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function readBearerToken(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] && match[1].length <= 8192 ? match[1] : null;
}

function isValidSubmissionRow(row) {
  return Boolean(
    row &&
    typeof row.id === "string" &&
    UUID_PATTERN.test(row.id) &&
    typeof row.storage_path === "string" &&
    STORAGE_PATH_PATTERN.test(row.storage_path) &&
    VALID_STATUSES.has(row.status) &&
    typeof row.created_at === "string"
  );
}

function jsonResponse(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}
