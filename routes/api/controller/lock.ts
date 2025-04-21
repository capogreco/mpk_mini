import { Handlers } from "$fresh/server.ts";
import * as signalModule from "../signal.ts";

// Open the KV store
const kv = await Deno.openKv();
const CONTROLLER_LOCK_KEY = ["webrtc:controller:lock"];
const CONTROLLER_LOCK_TTL_MS = 1000 * 60 * 5; // 5 minutes TTL for controller lock

// Development mode flag - set to true to bypass authentication
const DEV_MODE = false;

// Define active controller storage key for consistency with signal.ts
const ACTIVE_CONTROLLER_KEY = ["webrtc", "active", "controller"];

// Helper to notify clients about controller changes through the signal module
async function notifyControllerChange(controllerId: string | null) {
  console.log(
    `[LOCK API] Notifying clients about controller change to ${
      controllerId || "none"
    }`,
  );

  try {
    // Access the setActiveController function from the signal module
    const setActiveController = (signalModule as any).setActiveController;

    if (typeof setActiveController === "function") {
      await setActiveController(controllerId);
      console.log(
        `[LOCK API] Successfully notified clients about controller change`,
      );
      return true;
    } else {
      console.error(
        `[LOCK API] setActiveController not found in signal module`,
      );
      return false;
    }
  } catch (error) {
    console.error(
      `[LOCK API] Error notifying clients about controller change:`,
      error,
    );
    return false;
  }
}

// Middleware to ensure only authenticated users can access this endpoint
async function checkAuth(req: Request): Promise<string | null> {
  // In development mode, allow access with a dev user ID
  if (DEV_MODE) {
    // Check if this is a request from the development controller
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

  // Return the sessionId itself, as this is what we use as the userId
  return sessionId;
}

// Helper to get a cookie value
function getCookieValue(cookieStr: string, name: string): string | null {
  const match = cookieStr.match(new RegExp(`(^| )${name}=([^;]+)`));
  return match ? match[2] : null;
}

// Compare controller from lock and active controller records
async function validateControllerConsistency() {
  try {
    // Get the current lock
    const lock = await kv.get(CONTROLLER_LOCK_KEY);

    // Get the active controller
    const activeController = await kv.get(ACTIVE_CONTROLLER_KEY);

    if (!lock.value && activeController.value) {
      // There's an active controller but no lock - this is inconsistent
      console.warn(
        `[LOCK API] Inconsistency detected: Active controller ${activeController.value.id} exists but no lock found`,
      );
      return false;
    }

    if (lock.value && !activeController.value) {
      // There's a lock but no active controller - this is inconsistent
      console.warn(
        `[LOCK API] Inconsistency detected: Lock held by ${lock.value.userId} but no active controller record`,
      );
      return false;
    }

    if (
      lock.value && activeController.value &&
      lock.value.userId !== activeController.value.id
    ) {
      // The lock holder and active controller are different - this is inconsistent
      console.warn(
        `[LOCK API] Inconsistency detected: Lock held by ${lock.value.userId} but active controller is ${activeController.value.id}`,
      );
      return false;
    }

    // Everything is consistent
    return true;
  } catch (error) {
    console.error(`[LOCK API] Error validating controller consistency:`, error);
    return false;
  }
}

export const handler: Handlers = {
  // Acquire controller lock
  async POST(req) {
    // Check auth
    const userId = await checkAuth(req);
    if (!userId) {
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized" }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    try {
      // Check if the controller records are consistent
      const isConsistent = await validateControllerConsistency();
      if (!isConsistent) {
        console.log(
          `[LOCK API] Controller records inconsistent - attempting to fix before proceeding`,
        );
        // Get the active controller record and compare with lock
        const activeController = await kv.get(ACTIVE_CONTROLLER_KEY);
        const existingLock = await kv.get(CONTROLLER_LOCK_KEY);

        if (
          activeController.value &&
          (!existingLock.value ||
            existingLock.value.userId !== activeController.value.id)
        ) {
          // There's an active controller with no matching lock - notify clients about the change
          console.log(
            `[LOCK API] Fixing inconsistency - active controller ${activeController.value.id} doesn't match lock`,
          );
          await notifyControllerChange(null); // Clear the active controller status
          await kv.delete(ACTIVE_CONTROLLER_KEY); // Delete the active controller record
        }
      }

      // Try to get the current lock
      const existingLock = await kv.get(CONTROLLER_LOCK_KEY);

      // Check if someone else has the lock
      if (existingLock.value && existingLock.value.userId !== userId) {
        // Check if the lock has expired
        const lockAgeMs = Date.now() - existingLock.value.timestamp;

        if (lockAgeMs < CONTROLLER_LOCK_TTL_MS) {
          // Lock is active and held by someone else
          return new Response(
            JSON.stringify({
              success: false,
              error: "Controller is already locked by another user",
              lockHolder: existingLock.value.userId,
              remainingTimeMs: CONTROLLER_LOCK_TTL_MS - lockAgeMs,
            }),
            {
              status: 409, // Conflict
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        // Lock has expired, we can take it - but first notify that the previous controller is gone
        console.log(
          `[LOCK API] Expired lock found for ${existingLock.value.userId} - notifying about controller change`,
        );
        await notifyControllerChange(null); // Notify that the old controller is gone before setting a new one
      }

      // Set lock with expiration
      await kv.set(CONTROLLER_LOCK_KEY, {
        userId,
        timestamp: Date.now(),
      }, { expireIn: CONTROLLER_LOCK_TTL_MS });

      // Also update the active controller record to ensure consistency
      // This mirrors what's done in signal.ts setActiveController
      console.log(
        `[LOCK API] Controller ${userId} has acquired the lock - updating active controller record`,
      );
      await kv.set(ACTIVE_CONTROLLER_KEY, {
        id: userId,
        timestamp: Date.now(),
        instanceId: Deno.env.get("DENO_DEPLOYMENT_ID") || "local",
        lockedAt: Date.now(), // Additional timestamp for lock acquisition
      });

      // Notify all connected clients about the controller change
      await notifyControllerChange(userId);

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { "Content-Type": "application/json" } },
      );
    } catch (error) {
      console.error("Error acquiring controller lock:", error);
      return new Response(
        JSON.stringify({ success: false, error: "Server error" }),
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
        // Validate consistency between lock and active controller
        const isConsistent = await validateControllerConsistency();

        // Get both lock and active controller records
        const lock = await kv.get(CONTROLLER_LOCK_KEY);
        const activeController = await kv.get(ACTIVE_CONTROLLER_KEY);

        // If inconsistent, try to fix the issue
        if (!isConsistent) {
          console.log(
            "[LOCK API] Inconsistency detected in health check - attempting to fix",
          );

          if (lock.value && !activeController.value) {
            // We have a lock but no active controller - set the active controller
            console.log(
              `[LOCK API] Setting active controller to match lock holder: ${lock.value.userId}`,
            );
            await kv.set(ACTIVE_CONTROLLER_KEY, {
              id: lock.value.userId,
              timestamp: Date.now(),
              instanceId: Deno.env.get("DENO_DEPLOYMENT_ID") || "local",
              lockedAt: lock.value.timestamp || Date.now(),
            });

            // Notify about the controller change
            await notifyControllerChange(lock.value.userId);
          } else if (!lock.value && activeController.value) {
            // We have an active controller but no lock - clear the active controller
            console.log(
              `[LOCK API] Clearing active controller ${activeController.value.id} as no lock exists`,
            );
            await kv.delete(ACTIVE_CONTROLLER_KEY);

            // Notify that there's no active controller
            await notifyControllerChange(null);
          } else if (
            lock.value && activeController.value &&
            lock.value.userId !== activeController.value.id
          ) {
            // Lock and active controller are different - update active controller to match lock
            console.log(
              `[LOCK API] Fixing mismatch: lock=${lock.value.userId}, active=${activeController.value.id}`,
            );
            await kv.set(ACTIVE_CONTROLLER_KEY, {
              id: lock.value.userId,
              timestamp: Date.now(),
              instanceId: Deno.env.get("DENO_DEPLOYMENT_ID") || "local",
              lockedAt: lock.value.timestamp || Date.now(),
            });

            // Notify about the controller change
            await notifyControllerChange(lock.value.userId);
          }
        }

        // Return health information to client
        const lockStatus = lock.value
          ? {
            userId: lock.value.userId,
            timestamp: lock.value.timestamp,
            age: Date.now() - lock.value.timestamp,
            expired:
              (Date.now() - lock.value.timestamp) >= CONTROLLER_LOCK_TTL_MS,
          }
          : null;

        const controllerStatus = activeController.value
          ? {
            id: activeController.value.id,
            timestamp: activeController.value.timestamp,
            instanceId: activeController.value.instanceId,
            age: Date.now() - activeController.value.timestamp,
          }
          : null;

        return new Response(
          JSON.stringify({
            consistent: isConsistent,
            lock: lockStatus,
            activeController: controllerStatus,
            lockTtlMs: CONTROLLER_LOCK_TTL_MS,
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
    const userId = await checkAuth(req);
    if (!userId) {
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized" }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    try {
      const lock = await kv.get(CONTROLLER_LOCK_KEY);

      if (!lock.value) {
        return new Response(
          JSON.stringify({ locked: false }),
          { headers: { "Content-Type": "application/json" } },
        );
      }

      const lockAgeMs = Date.now() - lock.value.timestamp;
      const isExpired = lockAgeMs >= CONTROLLER_LOCK_TTL_MS;

      // Also get active controller for consistency check
      const activeController = await kv.get(ACTIVE_CONTROLLER_KEY);
      const isConsistent = lock.value && activeController.value &&
        lock.value.userId === activeController.value.id;

      return new Response(
        JSON.stringify({
          locked: !isExpired,
          isOwner: lock.value.userId === userId,
          userId: lock.value.userId,
          timestamp: lock.value.timestamp,
          remainingTimeMs: isExpired ? 0 : CONTROLLER_LOCK_TTL_MS - lockAgeMs,
          activeController: activeController.value
            ? activeController.value.id
            : null,
          consistent: isConsistent,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    } catch (error) {
      console.error("Error checking controller lock:", error);
      return new Response(
        JSON.stringify({ success: false, error: "Server error" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  },

  // Release lock
  async DELETE(req) {
    // Check auth
    const userId = await checkAuth(req);
    if (!userId) {
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized" }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    try {
      // Get current lock
      const lock = await kv.get(CONTROLLER_LOCK_KEY);

      // Only the lock owner can release it
      if (lock.value && lock.value.userId !== userId) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "You don't own the controller lock",
          }),
          {
            status: 403,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Delete the lock
      await kv.delete(CONTROLLER_LOCK_KEY);

      // Also remove the active controller record if this was the active controller
      const activeController = await kv.get(ACTIVE_CONTROLLER_KEY);
      if (activeController.value && activeController.value.id === userId) {
        console.log(
          `[LOCK API] Controller ${userId} is releasing the lock and was the active controller - removing active controller status`,
        );
        await kv.delete(ACTIVE_CONTROLLER_KEY);

        // Notify all connected clients that there's no active controller
        await notifyControllerChange(null);
      } else {
        console.log(
          `[LOCK API] Controller ${userId} is releasing the lock but is not the active controller (active: ${
            activeController.value?.id || "none"
          })`,
        );
      }

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { "Content-Type": "application/json" } },
      );
    } catch (error) {
      console.error("Error releasing controller lock:", error);
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
