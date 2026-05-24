// Fire-and-forget reset of a link's session_status to 'idle'.
// Uses fetch keepalive so it survives pagehide / tab close on mobile.
export function beaconResetSession(linkId: string, reason: string) {
  try {
    const url = `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/links?id=eq.${encodeURIComponent(linkId)}`;
    const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    const body = JSON.stringify({
      session_status: "idle",
      session_user_agent: null,
      session_connected_at: null,
      session_updated_at: new Date().toISOString(),
    });
    console.log("[beaconReset] sending", { linkId, reason });
    void fetch(url, {
      method: "PATCH",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: "return=minimal",
      },
      body,
    }).catch((e) => console.warn("[beaconReset] fetch failed", { linkId, reason, e }));
  } catch (e) {
    console.warn("[beaconReset] threw", { linkId, reason, e });
  }
}
