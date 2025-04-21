import { Handlers } from "$fresh/server.ts";

// Open the KV store
const kv = await Deno.openKv();

// Keys for controller records
const CONTROLLER_LOCK_KEY = ["webrtc", "controller", "lock"];
const ACTIVE_CONTROLLER_KEY = ["webrtc", "active", "controller"];
const CONTROLLER_CHANGE_NOTIFICATION_KEY = ["webrtc", "controller_change_notification"];

// Create a notification for controller changes
async function createControllerChangeNotification(controllerId: string | null) {
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

export const handler: Handlers = {
  async GET(req) {
    // Check for dev or admin mode query param as a simple security measure
    const url = new URL(req.url);
    const adminMode = url.searchParams.get("admin_mode");
    
    if (adminMode !== "true") {
      return new Response(
        JSON.stringify({ error: "Unauthorized", success: false }),
        { 
          status: 401,
          headers: { "Content-Type": "application/json" }
        }
      );
    }
    
    try {
      // Get current state before clearing
      const lockResult = await kv.get(CONTROLLER_LOCK_KEY);
      const activeResult = await kv.get(ACTIVE_CONTROLLER_KEY);
      
      // Clear the controller lock
      await kv.delete(CONTROLLER_LOCK_KEY);
      
      // Clear the active controller
      await kv.delete(ACTIVE_CONTROLLER_KEY);
      
      // Notify all clients that there's no active controller
      await createControllerChangeNotification(null);
      
      // Return the previous state and confirmation
      return new Response(
        JSON.stringify({
          success: true,
          message: "Controller status cleared",
          previousState: {
            lock: lockResult.value,
            activeController: activeResult.value
          }
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    } catch (error) {
      console.error("Error clearing controller status:", error);
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: "Server error",
          message: error.message
        }),
        { 
          status: 500,
          headers: { "Content-Type": "application/json" }
        }
      );
    }
  }
};