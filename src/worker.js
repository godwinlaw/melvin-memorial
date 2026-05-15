export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const { pathname } = url;

      if (pathname === "/api/rsvp" && request.method === "POST") {
        return jsonResponse({ error: "Not implemented" }, 501);
      }

      if (pathname === "/api/rsvps" && request.method === "GET") {
        return jsonResponse({ error: "Not implemented" }, 501);
      }

      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error("worker_unhandled", err?.message ?? String(err));
      return jsonResponse({ error: "Server error" }, 500);
    }
  },
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
