import { Handlers } from "$fresh/server.ts";

// Open the KV store
const kv = await Deno.openKv();

// Simple key for active controller
const ACTIVE_CONTROLLER_KEY = ["webrtc", "active_controller"];

// Key for controller change notifications - polled by signal.ts
const CONTROLLER_CHANGE_NOTIFICATION_KEY = [
  "webrtc",
  "controller_change_notification",
];

// 30 seconds timeout for controller heartbeat
const HEARTBEAT_TIMEOUT_MS = 30000;

// Development mode flag
const DEV_MODE = false;

// Get active controller or null if expired/none
async function getActiveController() {
  const result = await kv.get(ACTIVE_CONTROLLER_KEY);
  if (!result.value) return null;

  // Check if controller heartbeat has expired
  const now = Date.now();
  if (now - result.value.timestamp > HEARTBEAT_TIMEOUT_MS) {
    console.log(
      `[CONTROLLER] Active controller ${result.value.id} has expired`,
    );
    // Expired - delete it
    await kv.delete(ACTIVE_CONTROLLER_KEY);

    // Create a notification for this expiration (setting to null)
    await createControllerChangeNotification(null);

    return null;
  }

  return result.value;
}

// Create a notification event in KV for controller changes
// This will be picked up by all signal.ts instances
async function createControllerChangeNotification(controllerId) {
  try {
    // Generate a unique notification ID
    const notificationId = crypto.randomUUID();

    // Store the notification with the notification ID
    await kv.set(CONTROLLER_CHANGE_NOTIFICATION_KEY, {
      controllerId,
      timestamp: Date.now(),
      notificationId,
    });

    console.log(
      `[CONTROLLER] Created change notification: ${controllerId}, id=${notificationId}`,
    );
    return true;
  } catch (error) {
    console.error(`[CONTROLLER] Error creating change notification:`, error);
    return false;
  }
}

// Set active controller and return if change occurred
async function setActiveController(controllerId, isHeartbeat = false) {
  const current = await getActiveController();

  // If there's no change in controller, just update timestamp
  if (current && current.id === controllerId) {
    await kv.set(ACTIVE_CONTROLLER_KEY, {
      id: controllerId,
      timestamp: Date.now(),
    });
    console.log(
      `[CONTROLLER] Updated heartbeat for active controller ${controllerId}`,
    );
    return false; // No controller change
  }

  // If this is a heartbeat but not from active controller, reject it
  if (isHeartbeat && current && current.id !== controllerId) {
    console.log(
      `[CONTROLLER] Rejected heartbeat from non-active controller ${controllerId}`,
    );
    return false;
  }

  // Change controller
  const previousId = current ? current.id : null;
  await kv.set(ACTIVE_CONTROLLER_KEY, {
    id: controllerId,
    timestamp: Date.now(),
  });

  console.log(
    `[CONTROLLER] Changed active controller: ${previousId} -> ${controllerId}`,
  );

  // Create a notification for this controller change
  await createControllerChangeNotification(controllerId);

  return true; // Controller changed
}

// Clear active controller
async function clearActiveController(controllerId) {
  const current = await getActiveController();

  // Only allow clearing if this is the active controller
  if (!current || current.id !== controllerId) {
    console.log(
      `[CONTROLLER] Rejected clearing from non-active controller ${controllerId}`,
    );
    return false;
  }

  await kv.delete(ACTIVE_CONTROLLER_KEY);
  console.log(`[CONTROLLER] Cleared active controller ${controllerId}`);
  return true;
}

// Simple auth for development
async function checkAuth(req) {
  if (DEV_MODE) {
    try {
      const body = await req.clone().json();
      if (body.controllerId) {
        return body.controllerId;
      }
    } catch (e) {
      // Parsing failed, continue with normal auth
    }
    return "dev-controller";
  }

  // For production: check session cookie
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

  return sessionId;
}

// Helper to get a cookie value
function getCookieValue(cookieStr, name) {
  const match = cookieStr.match(new RegExp(`(^| )${name}=([^;]+)`));
  return match ? match[2] : null;
}

export const handler: Handlers = {
  // Activate or heartbeat controller
  async POST(req) {
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
      const data = await req.json();
      const isHeartbeat = !!data.heartbeat;

      const changed = await setActiveController(controllerId, isHeartbeat);

      // Return the current status
      const activeController = await getActiveController();

      return new Response(
        JSON.stringify({
          success: true,
          isActive: activeController?.id === controllerId,
          activeController: activeController?.id || null,
          changed,
          timestamp: Date.now(),
          timeoutMs: HEARTBEAT_TIMEOUT_MS,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    } catch (error) {
      console.error("Error managing controller:", error);
      return new Response(
        JSON.stringify({ success: false, error: "Server error" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  },

  // Get current active controller
  async GET(req) {
    // No auth for GET - synth clients need this
    try {
      const activeController = await getActiveController();

      return new Response(
        JSON.stringify({
          activeController: activeController?.id || null,
          timestamp: Date.now(),
          timeoutMs: HEARTBEAT_TIMEOUT_MS,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    } catch (error) {
      console.error("Error getting controller status:", error);
      return new Response(
        JSON.stringify({ success: false, error: "Server error" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  },

  // Deactivate controller
  async DELETE(req) {
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
      const cleared = await clearActiveController(controllerId);

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
      console.error("Error deactivating controller:", error);
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
