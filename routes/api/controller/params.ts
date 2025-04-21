import { Handlers } from "$fresh/server.ts";

// Open the KV store
const kv = await Deno.openKv();
const CONTROLLER_PARAMS_KEY = ["webrtc:controller:params"];

// Development mode flag - set to true to bypass authentication
const DEV_MODE = true;

// Middleware to ensure only authenticated users can access this endpoint
async function checkAuth(req: Request): Promise<string | null> {
  // In development mode, allow access with a dev user ID
  if (DEV_MODE) {
    // Check if this is a request from the development controller
    try {
      // Try to parse the request body to check for dev-user-id
      const body = await req.clone().json();
      if (body.controllerId === "dev-user-id") {
        return "dev-user-id";
      }
    } catch (e) {
      // Parsing failed, continue with normal auth
    }
  }

  // Get session cookie
  const cookies = req.headers.get("cookie") || "";
  const sessionId = getCookieValue(cookies, "session");

  if (!sessionId) {
    return null;
  }

  // Verify session
  const session = await kv.get(["webrtc:sessions", sessionId]);

  if (!session.value || session.value.expiresAt < Date.now()) {
    return null;
  }

  // Return the sessionId itself, as this is what we use as the controllerId
  return sessionId;
}

// Helper to get a cookie value
function getCookieValue(cookieStr: string, name: string): string | null {
  const match = cookieStr.match(new RegExp(`(^| )${name}=([^;]+)`));
  return match ? match[2] : null;
}

export const handler: Handlers = {
  // Get the latest global parameters
  async GET(req) {
    try {
      // Get the latest params
      const paramsRecord = await kv.get(CONTROLLER_PARAMS_KEY);

      if (!paramsRecord.value) {
        return new Response(
          JSON.stringify({
            success: true,
            params: null,
            message: "No global parameters found",
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          params: paramsRecord.value.params,
          version: paramsRecord.value.version,
          controllerId: paramsRecord.value.controllerId,
          timestamp: paramsRecord.value.timestamp,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    } catch (error) {
      console.error("[PARAMS API] Error fetching global parameters:", error);
      return new Response(
        JSON.stringify({ success: false, error: "Server error" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  },

  // Save global parameters
  async POST(req) {
    // Check auth
    const controllerId = await checkAuth(req);
    if (!controllerId) {
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized" }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    try {
      // Parse the request body
      const body = await req.json();

      if (!body.params) {
        return new Response(
          JSON.stringify({ success: false, error: "No parameters provided" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Ensure we have a version
      const version = body.version || Date.now();

      // Save the parameters with metadata
      await kv.set(CONTROLLER_PARAMS_KEY, {
        params: body.params,
        version,
        controllerId,
        timestamp: Date.now(),
      });

      console.log(
        `[PARAMS API] Controller ${controllerId} saved global parameters (version ${version})`,
      );

      return new Response(
        JSON.stringify({
          success: true,
          version,
          timestamp: Date.now(),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    } catch (error) {
      console.error("[PARAMS API] Error saving global parameters:", error);
      return new Response(
        JSON.stringify({ success: false, error: "Server error" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  },
};
