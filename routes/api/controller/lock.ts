import { Handlers } from "$fresh/server.ts";
import * as controllerManager from "./manager.ts";

// Open the KV store
const kv = await Deno.openKv();

// Development mode flag - set to false for production
const DEV_MODE = false;

// For legacy support (will be removed later)
const CONTROLLER_LOCK_KEY = ["webrtc:controller:lock"];

// Helper to standardize user auth mechanism across endpoints
async function checkAuth(req: Request): Promise<string | null> {
  // In development mode, allow access with a dev user ID
  if (DEV_MODE) {
    try {
      // Try to parse the request body to check for dev-user-id
      const body = await req.clone().json();
      if (body.userId === "dev-user-id") {
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

  // Return the standardized controller ID (session ID)
  return sessionId;
}

// Helper to get a cookie value
function getCookieValue(cookieStr: string, name: string): string | null {
  const match = cookieStr.match(new RegExp(`(^| )${name}=([^;]+)`));
  return match ? match[2] : null;
}

export const handler: Handlers = {
  // Acquire controller lock
  async POST(req) {
    // Authenticate the user
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
      // Parse request body
      const body = await req.json();
      const isHeartbeat = !!body.heartbeat;

      // Use the controller manager to set active controller
      const changed = await controllerManager.setActiveController(
        controllerId, 
        isHeartbeat
      );

      // For backward compatibility, maintain the lock key as well
      await kv.set(CONTROLLER_LOCK_KEY, {
        userId: controllerId,
        timestamp: Date.now(),
      });

      // Get current controller state
      const activeController = await controllerManager.getActiveController();

      // Return response with current state
      return new Response(
        JSON.stringify({
          success: true,
          isActive: activeController?.id === controllerId,
          activeController: activeController?.id || null,
          changed,
          timestamp: Date.now(),
          timeoutMs: controllerManager.HEARTBEAT_TIMEOUT_MS,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    } catch (error) {
      console.error("[LOCK API] Error acquiring controller lock:", error);
      return new Response(
        JSON.stringify({ success: false, error: "Server error", details: error.message }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  },

  // Check lock status
  async GET(req) {
    // Check URL params
    const url = new URL(req.url);
    const health = url.searchParams.get("health");

    // If this is a health check request, we don't require auth
    if (health === "check") {
      try {
        // Get current controller status
        const activeController = await controllerManager.getActiveController();
        
        // For backward compatibility, also get the lock
        const lock = await kv.get(CONTROLLER_LOCK_KEY);
        
        // Check consistency
        const isConsistent = !lock.value || !activeController || 
                            (lock.value.userId === activeController.id);
        
        // Return health check data
        return new Response(
          JSON.stringify({
            consistent: isConsistent,
            activeController: activeController 
              ? {
                  id: activeController.id,
                  timestamp: activeController.timestamp,
                  instanceId: activeController.instanceId,
                  age: Date.now() - activeController.timestamp,
                }
              : null,
            timestamp: Date.now(),
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      } catch (error) {
        console.error("[LOCK API] Error in health check:", error);
        return new Response(
          JSON.stringify({
            success: false,
            error: "Server error during health check",
            timestamp: Date.now(),
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    // Normal lock status check - requires auth
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
      // Get current controller status
      const activeController = await controllerManager.getActiveController();
      
      // For backward compatibility
      const lock = await kv.get(CONTROLLER_LOCK_KEY);
      
      // If no active controller, return not locked
      if (!activeController) {
        return new Response(
          JSON.stringify({ locked: false, success: true }),
          { headers: { "Content-Type": "application/json" } },
        );
      }

      // Return controller status
      return new Response(
        JSON.stringify({
          locked: true,
          success: true,
          isOwner: activeController.id === controllerId,
          activeController: activeController.id,
          timestamp: activeController.timestamp,
          remainingTimeMs: Math.max(0, 
            controllerManager.HEARTBEAT_TIMEOUT_MS - 
            (Date.now() - activeController.timestamp)
          ),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    } catch (error) {
      console.error("[LOCK API] Error checking controller status:", error);
      return new Response(
        JSON.stringify({ success: false, error: "Server error" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  },

  // Release controller lock
  async DELETE(req) {
    // Authenticate the user
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
      // Use the controller manager to clear active controller
      const cleared = await controllerManager.clearActiveController(controllerId);
      
      // Also clear the legacy lock for backward compatibility
      await kv.delete(CONTROLLER_LOCK_KEY);

      return new Response(
        JSON.stringify({
          success: cleared,
          message: cleared
            ? "Controller deactivated"
            : "Not the active controller",
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    } catch (error) {
      console.error("[LOCK API] Error releasing controller lock:", error);
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