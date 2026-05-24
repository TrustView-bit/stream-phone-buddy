import { createClient } from "https://esm.sh/@supabase/supabase-js@2";


const API_HOST = "api.vmoscloud.com";
const API_BASE = "https://api.vmoscloud.com";
const TOKEN_PATH = "/vcpcloud/api/padApi/stsTokenByPadCode";
const SERVICE = "armcloud-paas";
const CONTENT_TYPE = "application/json;charset=UTF-8";
const SIGNED_HEADERS = "content-type;host;x-content-sha256;x-date";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const enc = new TextEncoder();
const toHex = (buf: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(buf as ArrayBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256Hex(s: string) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}
async function hmac(keyBytes: Uint8Array, msg: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
function utcDate() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
async function signPost(sk: string, ak: string, body: string) {
  const xDate = utcDate();
  const shortDate = xDate.substring(0, 8);
  const scope = `${shortDate}/${SERVICE}/request`;
  const xContentSha256 = await sha256Hex(body);
  const canonical =
    `host:${API_HOST}\n` +
    `x-date:${xDate}\n` +
    `content-type:${CONTENT_TYPE}\n` +
    `signedHeaders:${SIGNED_HEADERS}\n` +
    `x-content-sha256:${xContentSha256}`;
  const stringToSign =
    `HMAC-SHA256\n${xDate}\n${scope}\n${await sha256Hex(canonical)}`;
  const kDate = await hmac(enc.encode(sk), shortDate);
  const kService = await hmac(kDate, SERVICE);
  const signKey = await hmac(kService, "request");
  const signature = toHex((await hmac(signKey, stringToSign)).buffer);
  const authorization =
    `HMAC-SHA256 Credential=${ak}/${scope}, ` +
    `SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`;
  return {
    "x-date": xDate,
    "x-host": API_HOST,
    "content-type": CONTENT_TYPE,
    "authorization": authorization,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  try {
    const ak = Deno.env.get("VMOS_AK")!;
    const sk = Deno.env.get("VMOS_SK")!;
    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let payload: { padCode?: string; linkId?: string } = {};
    try {
      payload = await req.json();
    } catch (_) {
      payload = {};
    }

    // Resolve padCode: prefer linkId lookup, then explicit padCode, then validate.
    let padCode: string | null = null;

    if (payload.linkId) {
      const { data: link } = await supa
        .from("links")
        .select("pad_code")
        .eq("id", payload.linkId)
        .maybeSingle();
      if (!link) {
        return new Response(JSON.stringify({ error: "Invalid link" }), {
          status: 404,
          headers: { ...cors, "content-type": "application/json" },
        });
      }
      padCode = link.pad_code;
    } else if (payload.padCode) {
      // Validate the padCode exists in the links table — never mint for arbitrary phones.
      const { data: link } = await supa
        .from("links")
        .select("pad_code")
        .eq("pad_code", payload.padCode)
        .maybeSingle();
      if (!link) {
        return new Response(JSON.stringify({ error: "Pad code not registered" }), {
          status: 403,
          headers: { ...cors, "content-type": "application/json" },
        });
      }
      padCode = link.pad_code;
    } else {
      return new Response(JSON.stringify({ error: "Missing linkId or padCode" }), {
        status: 400,
        headers: { ...cors, "content-type": "application/json" },
      });
    }

    const body = JSON.stringify({ padCode });
    const headers = await signPost(sk, ak, body);
    const r = await fetch(`${API_BASE}${TOKEN_PATH}`, { method: "POST", headers, body });
    const data = await r.json();
    const token = data?.data?.token ?? data?.token ?? "";
    return new Response(JSON.stringify({ token, padCode, raw: data }), {
      headers: { ...cors, "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...cors, "content-type": "application/json" },
    });
  }
});
