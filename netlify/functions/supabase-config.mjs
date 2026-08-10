const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
};

export default async (request) => {
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...JSON_HEADERS, Allow: "GET" }
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();

  if (!supabaseUrl || !supabasePublishableKey) {
    return new Response(JSON.stringify({ error: "Upload service is not configured" }), {
      status: 503,
      headers: JSON_HEADERS
    });
  }

  let normalizedUrl;

  try {
    const parsedUrl = new URL(supabaseUrl);
    if (parsedUrl.protocol !== "https:") {
      throw new Error("Supabase URL must use HTTPS");
    }
    normalizedUrl = parsedUrl.origin;
  } catch {
    return new Response(JSON.stringify({ error: "Upload service is not configured" }), {
      status: 503,
      headers: JSON_HEADERS
    });
  }

  return new Response(JSON.stringify({
    supabaseUrl: normalizedUrl,
    supabasePublishableKey
  }), {
    status: 200,
    headers: JSON_HEADERS
  });
};
