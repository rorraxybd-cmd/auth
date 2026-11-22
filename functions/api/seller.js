export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Cache-Control",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const db = env.retail || env.DB;
  if (!db) {
    return jsonResponse({ success: false, error: "Database binding not found" }, 500, corsHeaders);
  }

  try {
    const pathname = url.pathname;

    if (pathname.includes("/send-magic-link")) {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
      }

      const bodyData = await request.json().catch(() => ({}));
      const email = (bodyData.email || "").toLowerCase().trim();
      const mobile_number = (bodyData.mobile_number || "").trim();

      if (!email) {
        return jsonResponse({ error: "Email required" }, 400, corsHeaders);
      }

      const existingSeller = await db.prepare("SELECT * FROM sellers WHERE email = ?").bind(email).first();
      const emailPrefix = email.split("@")[0].replace(/[^a-z0-9]/g, "").substring(0, 6);
      const randomSuffix = Math.random().toString(36).substring(2, 8);
      const uniqueSellerId = existingSeller?.seller_id || `rorraxy-${emailPrefix}-${randomSuffix}`;

      const token = crypto.randomUUID();
      const expiresAt = Date.now() + 300 * 1000;
      const clientIp = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "Unknown";
      const ipCountry = request.headers.get("cf-ipcountry") || "BD";
      const userAgent = request.headers.get("user-agent") || "Unknown";

      const sqlMagic = `
        INSERT INTO sellers (
          seller_id, email, mobile_number, verification_token, token_expires_at,
          last_ip, ip_country, user_agent, is_verified, admin_approval_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending')
        ON CONFLICT(email) DO UPDATE SET
          verification_token = excluded.verification_token,
          token_expires_at = excluded.token_expires_at,
          mobile_number = COALESCE(NULLIF(excluded.mobile_number, ''), sellers.mobile_number),
          last_ip = excluded.last_ip,
          ip_country = excluded.ip_country,
          user_agent = excluded.user_agent
      `;

      await db.prepare(sqlMagic).bind(
        uniqueSellerId, email, mobile_number, token, expiresAt, clientIp, ipCountry, userAgent
      ).run();

      const magicLink = `https://${url.hostname}/api/seller/verify-magic?token=${token}`;
      const isProfileComplete = Boolean(existingSeller && existingSeller.brand_name && existingSeller.full_name);

      return jsonResponse({
        success: true,
        message: "Verification token generated successfully",
        magicLink,
        seller_id: uniqueSellerId,
        isProfileComplete,
      }, 200, corsHeaders);
    }

    if (pathname.includes("/verify-magic")) {
      const token = url.searchParams.get("token");
      if (!token) {
        return new Response("Invalid Verification Token", { status: 400 });
      }

      const record = await db.prepare("SELECT * FROM sellers WHERE verification_token = ?").bind(token).first();
      if (!record || Date.now() > record.token_expires_at) {
        return new Response("Verification link has expired or is invalid!", { status: 410 });
      }

      const now = new Date().toISOString();
      await db.prepare(
        "UPDATE sellers SET is_verified = 1, verified_at = ?, verification_token = NULL, token_expires_at = NULL WHERE verification_token = ?"
      ).bind(now, token).run();

      const isComplete = record.brand_name && record.full_name ? "true" : "false";
      const redirectUrl = `https://${url.hostname}/seller/index.html?verified=true&email=${encodeURIComponent(record.email)}&complete=${isComplete}`;
      return Response.redirect(redirectUrl, 302);
    }

    if (pathname.includes("/update-status")) {
      if (request.method !== "POST") {
        return jsonResponse({ success: false, error: "Method not allowed" }, 405, corsHeaders);
      }

      const bodyData = await request.json().catch(() => ({}));
      const email = (bodyData.email || "").toLowerCase().trim();
      const newStatus = (bodyData.status || bodyData.admin_approval_status || "").toLowerCase().trim();
      const allowedStatuses = ["pending", "approved", "rejected"];

      if (!email) {
        return jsonResponse({ success: false, error: "Email required" }, 400, corsHeaders);
      }

      if (!allowedStatuses.includes(newStatus)) {
        return jsonResponse({ success: false, error: "Invalid status value" }, 400, corsHeaders);
      }

      const updateResult = await db.prepare(
        "UPDATE sellers SET admin_approval_status = ? WHERE LOWER(TRIM(email)) = ?"
      ).bind(newStatus, email).run();

      const updatedSeller = await db.prepare(
        "SELECT email, seller_id, admin_approval_status FROM sellers WHERE LOWER(TRIM(email)) = ?"
      ).bind(email).first();

      if (!updatedSeller) {
        return jsonResponse({ success: false, error: "Seller not found" }, 404, corsHeaders);
      }

      return jsonResponse({
        success: true,
        message: `Seller status updated to ${newStatus}`,
        changes: updateResult?.meta?.changes ?? 1,
        data: updatedSeller,
      }, 200, corsHeaders);
    }

    if (request.method === "POST") {
      const data = await request.json().catch(() => ({}));
      const email = (data.email || "").toLowerCase().trim();
      const mobileNumber = (data.mobile_number || data.phone || "").trim();
      const clientIp = request.headers.get("cf-connecting-ip") || "Unknown";
      const country = request.headers.get("cf-ipcountry") || data.country || "Bangladesh";
      const userAgent = request.headers.get("user-agent") || "Unknown";
      const now = new Date().toISOString();

      if (!email) {
        return jsonResponse({ success: false, error: "Email required" }, 400, corsHeaders);
      }

      const emailPrefix = email.split("@")[0].replace(/[^a-z0-9]/g, "").substring(0, 6);
      const fallbackSellerId = `rorraxy-${emailPrefix}-${Math.random().toString(36).substring(2, 8)}`;
      const finalSellerId = data.seller_id && String(data.seller_id).startsWith("rorraxy-")
        ? String(data.seller_id)
        : fallbackSellerId;

      const sqlUpsert = `
        INSERT INTO sellers (
          seller_id, email, mobile_number, brand_name, full_name, business_desc,
          whatsapp, emergency_phone, country, full_address, doc_type, doc_number,
          trade_license, logo_url, is_verified, admin_approval_status, last_ip, ip_country, user_agent, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, COALESCE((SELECT admin_approval_status FROM sellers WHERE LOWER(TRIM(email)) = ?), 'pending'), ?, ?, ?, COALESCE((SELECT created_at FROM sellers WHERE LOWER(TRIM(email)) = ?), ?))
        ON CONFLICT(email) DO UPDATE SET
          seller_id = COALESCE(NULLIF(sellers.seller_id, ''), excluded.seller_id),
          mobile_number = COALESCE(NULLIF(excluded.mobile_number, ''), sellers.mobile_number),
          brand_name = excluded.brand_name,
          full_name = excluded.full_name,
          business_desc = excluded.business_desc,
          whatsapp = excluded.whatsapp,
          emergency_phone = excluded.emergency_phone,
          country = excluded.country,
          full_address = excluded.full_address,
          doc_type = excluded.doc_type,
          doc_number = excluded.doc_number,
          trade_license = excluded.trade_license,
          logo_url = excluded.logo_url,
          last_ip = excluded.last_ip,
          ip_country = excluded.ip_country,
          user_agent = excluded.user_agent
      `;

      await db.prepare(sqlUpsert).bind(
        finalSellerId,
        email,
        mobileNumber,
        data.brand_name || "",
        data.full_name || "",
        data.business_desc || "",
        data.whatsapp || "",
        data.emergency_phone || "",
        country,
        data.full_address || "",
        data.doc_type || "NID",
        data.doc_number || "",
        data.trade_license || "N/A",
        data.logo_url || "",
        email,
        clientIp,
        country,
        userAgent,
        email,
        now
      ).run();

      const sellerRecord = await db.prepare("SELECT id, seller_id, email, admin_approval_status FROM sellers WHERE LOWER(TRIM(email)) = ?").bind(email).first();

      return jsonResponse({
        success: true,
        message: "Seller data saved successfully",
        seller_id: sellerRecord ? sellerRecord.seller_id : finalSellerId,
        email,
        admin_approval_status: sellerRecord ? sellerRecord.admin_approval_status : "pending",
      }, 200, corsHeaders);
    }

    if (request.method === "GET") {
      const email = url.searchParams.get("email");
      if (email) {
        const seller = await db.prepare("SELECT * FROM sellers WHERE LOWER(TRIM(email)) = ?").bind(email.toLowerCase().trim()).all();
        return jsonResponse({ success: true, data: seller.results }, 200, corsHeaders);
      }

      const allSellers = await db.prepare("SELECT * FROM sellers ORDER BY created_at DESC").all();
      return jsonResponse({ success: true, data: allSellers.results }, 200, corsHeaders);
    }

    return jsonResponse({ message: "Seller API Active" }, 200, corsHeaders);
  } catch (err) {
    return jsonResponse({ success: false, error: err.message }, 500, corsHeaders);
  }
}

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...extraHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}
