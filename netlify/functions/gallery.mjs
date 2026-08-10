import { createClient } from "@supabase/supabase-js";

const MAX_PHOTOS = 60;
const SIGNED_URL_LIFETIME_SECONDS = 60 * 60;
const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=60",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff"
};

export default async (request) => {
  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "GET" });
  }

  const supabaseUrl = normalizeSupabaseUrl(process.env.SUPABASE_URL);
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY?.trim();

  if (!supabaseUrl || !supabaseSecretKey) {
    return jsonResponse({ error: "Gallery service is not configured" }, 503);
  }

  const supabase = createClient(supabaseUrl, supabaseSecretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });

  try {
    const { data: rows, error: rowsError } = await supabase
      .from("gallery_uploads")
      .select("id, storage_path, caption, approved_at, created_at")
      .eq("status", "approved")
      .order("approved_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(MAX_PHOTOS);

    if (rowsError) {
      console.error("Approved gallery query failed", { code: rowsError.code });
      return jsonResponse({ error: "Gallery is temporarily unavailable" }, 503);
    }

    const validRows = (rows || []).filter(isValidGalleryRow);

    if (validRows.length === 0) {
      return jsonResponse({ photos: [] }, 200);
    }

    const paths = validRows.map((row) => row.storage_path);
    const { data: signedObjects, error: signingError } = await supabase.storage
      .from("gallery")
      .createSignedUrls(paths, SIGNED_URL_LIFETIME_SECONDS);

    if (signingError) {
      console.error("Gallery URL signing failed", { name: signingError.name });
      return jsonResponse({ error: "Gallery is temporarily unavailable" }, 503);
    }

    const signedUrlsByPath = new Map(
      (signedObjects || [])
        .filter((item) => item?.path && item?.signedUrl && !item.error)
        .map((item) => [item.path, item.signedUrl])
    );

    const photos = validRows.flatMap((row) => {
      const imageUrl = signedUrlsByPath.get(row.storage_path);
      if (!imageUrl) return [];

      return [{
        id: row.id,
        imageUrl,
        caption: normalizeCaption(row.caption),
        approvedAt: row.approved_at || row.created_at
      }];
    });

    return jsonResponse({ photos }, 200);
  } catch (error) {
    console.error("Gallery function failed", { name: error?.name || "Error" });
    return jsonResponse({ error: "Gallery is temporarily unavailable" }, 503);
  }
};

function normalizeSupabaseUrl(value) {
  try {
    const url = new URL(value?.trim());
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function isValidGalleryRow(row) {
  return Boolean(
    row &&
    typeof row.id === "string" &&
    typeof row.storage_path === "string" &&
    /^uploads\/\d{4}\/\d{2}\/[0-9a-f-]+\.(?:jpe?g|png|webp|heic|heif)$/i.test(row.storage_path) &&
    typeof row.created_at === "string"
  );
}

function normalizeCaption(value) {
  if (typeof value !== "string") return null;
  const caption = value.trim().replace(/\s+/g, " ").slice(0, 300);
  return caption || null;
}

function jsonResponse(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}
