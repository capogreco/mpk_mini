// Centralized controller manager to provide a single source of truth
// for controller state and notifications across the application

// Open the KV store
const kv = await Deno.openKv();

// Single key for active controller (consistent across all modules)
export const ACTIVE_CONTROLLER_KEY = ["webrtc", "controller", "active"];

// Key for controller change notifications
export const CONTROLLER_NOTIFICATION_KEY = ["webrtc", "controller", "notification"];

// Heartbeat timeout (30 seconds)
export const HEARTBEAT_TIMEOUT_MS = 30000;

// Controller record interface for type safety
export interface ControllerRecord {
  id: string;           // Controller ID (uses session ID directly, no prefixes)
  timestamp: number;    // Last updated timestamp
  instanceId: string;   // Deployment instance ID
  metadata?: {          // Optional metadata about the controller
    clientType: string;
    [key: string]: any;
  };
}

// Get active controller or null if none/expired
export async function getActiveController(): Promise<ControllerRecord | null> {
  try {
    const result = await kv.get<ControllerRecord>(ACTIVE_CONTROLLER_KEY);
    if (!result.value) return null;

    // Check if controller heartbeat has expired
    const now = Date.now();
    if (now - result.value.timestamp > HEARTBEAT_TIMEOUT_MS) {
      console.log(
        `[CONTROLLER] Active controller ${result.value.id} has expired (${now - result.value.timestamp}ms)`,
      );
      // Clear expired controller
      await clearActiveController(result.value.id);
      return null;
    }

    return result.value;
  } catch (error) {
    console.error("[CONTROLLER] Error getting active controller:", error);
    return null;
  }
}

// Set active controller and notify all clients about the change
export async function setActiveController(
  controllerId: string,
  isHeartbeat = false,
): Promise<boolean> {
  try {
    const current = await getActiveController();
    const instanceId = Deno.env.get("DENO_DEPLOYMENT_ID") || "local";
    const now = Date.now();

    // If there's no change in controller, just update timestamp
    if (current && current.id === controllerId) {
      if (!isHeartbeat) {
        // If not just a heartbeat, log the request
        console.log(
          `[CONTROLLER] Controller ${controllerId} is already active, updating timestamp`,
        );
      }

      // Update timestamp to keep controller active
      await kv.set(ACTIVE_CONTROLLER_KEY, {
        ...current,
        timestamp: now,
      });
      
      // No need to create change notification, just a timestamp update
      return false; // No controller change
    }

    // If this is a heartbeat but not from active controller, reject it
    if (isHeartbeat && current && current.id !== controllerId) {
      console.log(
        `[CONTROLLER] Rejected heartbeat from non-active controller ${controllerId}`,
      );
      return false;
    }

    // Log the controller change
    const previousId = current ? current.id : null;
    console.log(
      `[CONTROLLER] Changing active controller: ${previousId || "none"} -> ${controllerId}`,
    );

    // Set new controller
    await kv.set<ControllerRecord>(ACTIVE_CONTROLLER_KEY, {
      id: controllerId,
      timestamp: now,
      instanceId,
      metadata: {
        clientType: "controller",
      },
    });

    // Create notification for this controller change
    await createControllerChangeNotification(controllerId);

    return true; // Controller changed
  } catch (error) {
    console.error("[CONTROLLER] Error setting active controller:", error);
    return false;
  }
}

// Clear active controller if it matches the provided ID
export async function clearActiveController(controllerId: string): Promise<boolean> {
  try {
    const current = await getActiveController();

    // Only allow clearing if this is the active controller
    if (!current || current.id !== controllerId) {
      console.log(
        `[CONTROLLER] Rejected clearing from non-active controller ${controllerId}`,
      );
      return false;
    }

    // Delete the active controller record
    await kv.delete(ACTIVE_CONTROLLER_KEY);
    console.log(`[CONTROLLER] Cleared active controller ${controllerId}`);

    // Send notification that there's no active controller
    await createControllerChangeNotification(null);

    return true;
  } catch (error) {
    console.error("[CONTROLLER] Error clearing active controller:", error);
    return false;
  }
}

// Force clear active controller (admin function)
export async function forceResetControllerState(): Promise<boolean> {
  try {
    // Get current controller before clearing
    const current = await getActiveController();
    
    // Delete the active controller record
    await kv.delete(ACTIVE_CONTROLLER_KEY);
    
    if (current) {
      console.log(`[CONTROLLER] Force cleared active controller ${current.id}`);
    } else {
      console.log(`[CONTROLLER] No active controller to clear`);
    }

    // Send notification that there's no active controller
    await createControllerChangeNotification(null);

    return true;
  } catch (error) {
    console.error("[CONTROLLER] Error force clearing controller:", error);
    return false;
  }
}

// Create a notification for controller changes
export async function createControllerChangeNotification(
  controllerId: string | null,
): Promise<boolean> {
  try {
    const notificationId = crypto.randomUUID();
    const now = Date.now();

    // Store notification with a unique ID
    await kv.set(CONTROLLER_NOTIFICATION_KEY, {
      controllerId,  // Important: can be null to indicate no active controller
      timestamp: now,
      notificationId,
    });

    console.log(
      `[CONTROLLER] Created change notification: controllerId=${controllerId || "none"}, id=${notificationId}`,
    );
    return true;
  } catch (error) {
    console.error("[CONTROLLER] Error creating change notification:", error);
    return false;
  }
}

// Send a controller heartbeat to maintain active status
export async function sendControllerHeartbeat(
  controllerId: string,
): Promise<boolean> {
  return await setActiveController(controllerId, true);
}

// Check if a client ID is a controller (for backward compatibility)
export function isController(id: string): boolean {
  return id.startsWith("controller-") || id.includes("controller");
}

// Convert legacy controller ID to standard format if needed
export function standardizeControllerId(id: string): string {
  // Remove "controller-" prefix if present (for backward compatibility)
  if (id.startsWith("controller-")) {
    return id.substring("controller-".length);
  }
  return id;
}