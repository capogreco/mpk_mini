import { Handlers } from "$fresh/server.ts";
import * as controllerManager from "./manager.ts";

// Open the KV store
const kv = await Deno.openKv();

// Legacy keys for backward compatibility (will be removed later)
const CONTROLLER_LOCK_KEY = ["webrtc:controller:lock"];
const OLD_ACTIVE_CONTROLLER_KEY = ["webrtc", "active", "controller"];
const OLD_ACTIVE_CONTROLLER_KEY2 = ["webrtc", "active_controller"];

export const handler: Handlers = {
  async GET(req) {
    // Check for admin mode query param as a simple security measure
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
      const activeController = await controllerManager.getActiveController();
      const lockResult = await kv.get(CONTROLLER_LOCK_KEY);
      const oldActiveResult1 = await kv.get(OLD_ACTIVE_CONTROLLER_KEY);
      const oldActiveResult2 = await kv.get(OLD_ACTIVE_CONTROLLER_KEY2);
      
      // Reset using the controller manager
      const reset = await controllerManager.forceResetControllerState();
      
      // For backward compatibility, also clear the legacy keys
      await kv.delete(CONTROLLER_LOCK_KEY);
      await kv.delete(OLD_ACTIVE_CONTROLLER_KEY);
      await kv.delete(OLD_ACTIVE_CONTROLLER_KEY2);
      
      // Return the previous state and confirmation
      return new Response(
        JSON.stringify({
          success: reset,
          message: "Controller status cleared",
          previousState: {
            activeController,
            lock: lockResult.value,
            oldActiveController1: oldActiveResult1.value,
            oldActiveController2: oldActiveResult2.value
          }
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    } catch (error) {
      console.error("[CLEAR API] Error clearing controller status:", error);
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