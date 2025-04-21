import { Handlers } from "$fresh/server.ts";
import { ulid } from "https://deno.land/x/ulid@v0.3.0/mod.ts";

// Open the KV store
const kv = await Deno.openKv();

// Helper method to make WebSocket readyState human-readable
WebSocket.readyStateToString = (state: number): string => {
  switch (state) {
    case WebSocket.CONNECTING:
      return "CONNECTING (0)";
    case WebSocket.OPEN:
      return "OPEN (1)";
    case WebSocket.CLOSING:
      return "CLOSING (2)";
    case WebSocket.CLOSED:
      return "CLOSED (3)";
    default:
      return `UNKNOWN (${state})`;
  }
};

// Connection tracking with Deno KV
// Using prefixes for string debugging, but we'll use arrays for actual keys
const CONNECTIONS_PREFIX = "webrtc:connections:";
const MESSAGES_PREFIX = "webrtc:messages:";
const QUEUE_TTL_MS = 1000 * 60 * 5; // 5 minutes TTL for message queues
const CLIENT_TTL_MS = 1000 * 60 * 10; // 10 minutes TTL for client records
const CLIENT_GRACE_PERIOD_MS = 15000; // 15 seconds grace period for new clients

// Key prefixes for Deno KV (as arrays)
const CONNECTION_KEY_PREFIX = ["webrtc", "connections"];
const MESSAGE_KEY_PREFIX = ["webrtc", "messages"];

// Active WebSocket connections (in-memory per instance)
const activeConnections = new Map<string, WebSocket>();

// Keep track of message polling intervals
const pollingIntervals = new Map<string, number>();

// Track active controllers
const activeControllers = new Set<string>();

// Track clients with active WebRTC connections (controlled by controller)
// Map of controller ID -> Set of client IDs with active connections
const activeWebRTCConnections = new Map<string, Set<string>>();

// Key for controller change notifications from controller/status.ts
const CONTROLLER_CHANGE_NOTIFICATION_KEY = [
  "webrtc",
  "controller_change_notification",
];

// Track last processed notification to avoid duplicates
let lastProcessedNotificationId: string | null = null;

// Poll interval ID for notification checking
let notificationPollIntervalId: number | null = null;

// Helper to get the connection key - ensure all parts are proper key types
const getConnectionKey = (id: string) => CONNECTION_KEY_PREFIX.concat([id]);

// Helper to get the message queue key - ensure all parts are proper key types
const getMessagesKey = (id: string) => MESSAGE_KEY_PREFIX.concat([id]);

// Store a message in the recipient's queue
async function queueMessage(targetId: string, message: any) {
  const messageId = ulid();
  const messagesKey = getMessagesKey(targetId);

  // Store the message in the queue with TTL
  // messageId needs to be added to the key
  await kv.set([...messagesKey, messageId], message, {
    expireIn: QUEUE_TTL_MS,
  });

  console.log(`Message queued for ${targetId}`);
}

// Retrieve and process pending messages for a client
async function processMessages(clientId: string, socket: WebSocket) {
  try {
    // Get the message key prefix for this client
    const messageKeyPrefix = getMessagesKey(clientId);

    // Get all pending messages for this client
    const messages = kv.list({ prefix: messageKeyPrefix });

    let messageCount = 0;
    for await (const entry of messages) {
      const message = entry.value;
      messageCount++;

      // Send the message to the client
      socket.send(JSON.stringify(message));
      console.log(`Delivered message to ${clientId}`);

      // Delete the message from the queue
      await kv.delete(entry.key);
    }

    if (messageCount > 0) {
      console.log(`Processed ${messageCount} messages for client ${clientId}`);
    }
  } catch (error) {
    console.error("Error processing messages:", error);
  }
}

// Controller-related constants and state
const ACTIVE_CONTROLLER_KEY = ["webrtc", "active", "controller"];
const CONTROLLER_PREFIX = "controller-";

// Check if a client ID is a controller
function isController(id: string): boolean {
  return id.startsWith(CONTROLLER_PREFIX);
}

// Import the controller manager
import * as controllerManager from "./controller/manager.ts";

// Check for controller change notifications in KV store
async function checkForControllerChangeNotifications() {
  try {
    // Get the latest notification using the controller manager's key
    const notification = await kv.get(controllerManager.CONTROLLER_NOTIFICATION_KEY);

    // Skip if no notification or we've already processed this one
    if (
      !notification.value ||
      (lastProcessedNotificationId &&
        lastProcessedNotificationId === notification.value.notificationId)
    ) {
      return;
    }

    // Get the controller ID from the notification
    const { controllerId, notificationId, timestamp } = notification.value;

    // Check if the notification is recent (less than 30 seconds old)
    // This prevents processing very old notifications after server restart
    const age = Date.now() - timestamp;
    if (age > 30000) {
      console.log(
        `[SIGNAL] Skipping old notification (${age}ms old): ${notificationId}`,
      );
      lastProcessedNotificationId = notificationId;
      return;
    }

    console.log(
      `[SIGNAL] Processing controller change notification: ${
        controllerId || "none"
      }, id=${notificationId}`,
    );

    // Ensure controller ID is standardized
    const standardizedId = controllerId 
      ? controllerManager.standardizeControllerId(controllerId) 
      : null;

    // Broadcast to all clients connected to this instance
    await broadcastControllerChange(standardizedId);

    // Remember that we've processed this notification
    lastProcessedNotificationId = notificationId;
  } catch (error) {
    console.error(`[SIGNAL] Error checking for controller changes:`, error);
  }
}

// Start polling for controller change notifications
function startNotificationPolling() {
  // Don't start multiple polling intervals
  if (notificationPollIntervalId !== null) {
    return;
  }

  console.log(`[SIGNAL] Starting controller change notification polling`);

  // Check every second for new notifications
  notificationPollIntervalId = setInterval(
    checkForControllerChangeNotifications,
    1000,
  ) as unknown as number;
}

// Stop polling for controller change notifications
function stopNotificationPolling() {
  if (notificationPollIntervalId !== null) {
    clearInterval(notificationPollIntervalId);
    notificationPollIntervalId = null;
    console.log(`[SIGNAL] Stopped controller change notification polling`);
  }
}

// Simple function to broadcast controller changes to all connected clients
async function broadcastControllerChange(controllerId: string | null) {
  console.log(
    `[SIGNAL] Broadcasting controller change: ${controllerId || "none"}`,
  );

  // Simple counter for logging
  let notifiedCount = 0;
  let errorCount = 0;

  // Send to all non-controller active connections
  for (const [clientId, socket] of activeConnections.entries()) {
    // Only send to non-controllers that have open connections
    if (!isController(clientId) && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({
          type: "active-controller",
          controllerId: controllerId,
          timestamp: Date.now(),
        }));
        notifiedCount++;

        // Don't log every notification to reduce noise
        if (notifiedCount < 5 || notifiedCount % 10 === 0) {
          console.log(
            `[SIGNAL] Notified client ${clientId} about controller change`,
          );
        }
      } catch (error) {
        errorCount++;
        console.error(`[SIGNAL] Error notifying client ${clientId}:`, error);

        // Queue the message as fallback
        try {
          await queueMessage(clientId, {
            type: "active-controller",
            controllerId: controllerId,
            timestamp: Date.now(),
          });
        } catch (queueError) {
          console.error(
            `[SIGNAL] Failed to queue message for ${clientId}:`,
            queueError,
          );
        }
      }
    }
  }

  console.log(
    `[SIGNAL] Broadcasting complete: ${notifiedCount} clients notified, ${errorCount} errors`,
  );
  return notifiedCount;
}

// Set the active controller and notify all clients
// Now delegates to the controller manager
async function setActiveController(controllerId: string | null) {
  console.log(
    `[SIGNAL] setActiveController called with: ${controllerId || "none"}`,
  );

  if (controllerId) {
    // Standardize the controller ID if needed
    const standardId = controllerManager.standardizeControllerId(controllerId);
    
    // Use the controller manager to set the active controller
    await controllerManager.setActiveController(standardId);
  } else {
    // If controllerId is null, force reset the controller state
    await controllerManager.forceResetControllerState();
  }

  // Broadcast to all connected clients
  return await broadcastControllerChange(controllerId);
}

// Get the active controller - now using the controller manager
async function getActiveController(): Promise<string | null> {
  // Use the controller manager to get the active controller
  const controller = await controllerManager.getActiveController();
  return controller ? controller.id : null;
}

// Function to check if a client has any active WebRTC connections with any controller
function hasActiveWebRTCConnection(clientId: string): boolean {
  // Check all controllers for this client
  for (const [_, connectedClients] of activeWebRTCConnections.entries()) {
    if (connectedClients.has(clientId)) {
      return true;
    }
  }
  return false;
}

// Function to clean up based on WebRTC connections
async function cleanupBasedOnWebRTCConnections() {
  console.log("===== CLEANING UP CLIENTS WITHOUT WEBRTC CONNECTIONS =====");

  // First gather all clients with active WebRTC connections from all controllers
  const clientsWithActiveConnections = new Set<string>();
  for (const [controllerId, connections] of activeWebRTCConnections.entries()) {
    console.log(
      `Controller ${controllerId} has connections to:`,
      Array.from(connections),
    );
    connections.forEach((clientId) =>
      clientsWithActiveConnections.add(clientId)
    );
  }

  console.log(
    "Clients with active WebRTC connections:",
    Array.from(clientsWithActiveConnections),
  );

  const clientsToRemove = []; // Track clients for cleanup
  let totalClients = 0;

  try {
    // Use the CONNECTION_KEY_PREFIX array for proper KV listing
    const connectionEntries = kv.list({ prefix: CONNECTION_KEY_PREFIX });

    // Find all non-controller clients
    for await (const entry of connectionEntries) {
      totalClients++;

      // The last element of the key array is the client ID
      const id = entry.key[entry.key.length - 1];

      // Skip controllers (making sure id is a string)
      const clientId = id.toString();
      if (isController(clientId)) {
        console.log(`Found controller ${clientId} - skipping cleanup`);
        continue;
      }

      console.log(`Checking synth client: ${clientId}`);

      // Check if the client is within its connection grace period
      const now = Date.now();
      const connectionTimestamp = entry.value.connectionTimestamp || 0;
      const timeSinceConnection = now - connectionTimestamp;
      const isInGracePeriod = timeSinceConnection < CLIENT_GRACE_PERIOD_MS;

      if (isInGracePeriod) {
        console.log(
          `Synth client ${clientId} is in grace period (${timeSinceConnection}ms) - keeping`,
        );
        continue;
      }

      // IMPORTANT: Only keep clients with active WebRTC connections to controllers
      if (!clientsWithActiveConnections.has(clientId)) {
        console.log(
          `Synth client ${clientId} has NO WebRTC connections - WILL REMOVE`,
        );
        clientsToRemove.push({
          key: entry.key,
          id: clientId,
        });
      } else {
        console.log(
          `Synth client ${clientId} has active WebRTC connection - keeping`,
        );
      }
    }

    console.log(
      `Found total of ${totalClients} clients, ${clientsToRemove.length} to remove`,
    );

    // Clean up all inactive synth clients
    if (clientsToRemove.length > 0) {
      console.log(
        `Cleaning up ${clientsToRemove.length} clients without WebRTC connections`,
      );

      for (const client of clientsToRemove) {
        try {
          console.log(`Removing client: ${client.id}`);
          // Perform the actual deletion from KV store
          await kv.delete(client.key);

          // Notify controllers about this client disconnection
          notifyControllers("client-disconnected", {
            clientId: client.id,
          });
        } catch (error) {
          console.error(`Error removing client ${client.id}:`, error);
        }
      }

      console.log(
        `Cleanup completed - removed ${clientsToRemove.length} clients`,
      );
      return clientsToRemove.length;
    }

    console.log("No clients without WebRTC connections to clean up");
    return 0;
  } catch (error) {
    console.error("Error during client cleanup:", error);
    return 0;
  }
}

// Legacy function - now we use cleanupBasedOnWebRTCConnections instead
async function cleanupInactiveClients() {
  return cleanupBasedOnWebRTCConnections();
}

// Get a list of all connected clients (for controllers)
async function getConnectedClients() {
  const clients = [];
  const now = Date.now();
  const staleClientKeys = []; // Track stale clients for cleanup

  // Use the CONNECTION_KEY_PREFIX array for proper KV listing
  const connectionEntries = kv.list({ prefix: CONNECTION_KEY_PREFIX });

  // Gather entries
  for await (const entry of connectionEntries) {
    // The last element of the key array is the client ID
    const id = entry.key[entry.key.length - 1];

    // Skip controllers (making sure id is a string)
    const clientId = id.toString();
    if (isController(clientId)) {
      continue;
    }

    // Check if this client is stale (not seen in a while)
    const lastSeen = entry.value.lastSeen || 0;
    const timeSinceLastSeen = now - lastSeen;

    // We'll accept all clients here, no automatic cleanup during regular client listing
    console.log(
      `Found client: ${clientId}, last seen ${timeSinceLastSeen}ms ago`,
    );

    // Get connection timestamp info
    const connectionTimestamp = entry.value.connectionTimestamp || lastSeen;
    const timeSinceConnection = now - connectionTimestamp;
    const isInGracePeriod = timeSinceConnection < CLIENT_GRACE_PERIOD_MS;

    // Add to client list with more info
    clients.push({
      id: clientId,
      connected: false, // Will be set correctly by the controller's own tracking
      lastSeen: lastSeen,
      connectionTimestamp: connectionTimestamp,
      reconnectionCount: entry.value.reconnectionCount || 0,
      lastReconnectTime: entry.value.lastReconnectTime || null,
      isInGracePeriod: isInGracePeriod,
      hasWebsocket: activeConnections.has(clientId),
      webRTCConnected: hasActiveWebRTCConnection(clientId),
    });
  }

  console.log(
    `Returning ${clients.length} clients: ${
      clients.map((c) => c.id).join(", ")
    }`,
  );
  return clients;
}

// Register a new connection
async function registerConnection(
  id: string,
  socket: WebSocket,
  isReconnect: boolean = false,
  timestamp: number = Date.now(),
) {
  const connectionKey = getConnectionKey(id);
  const isControllerClient = isController(id);

  // Check if this client is already registered elsewhere (handle duplicate IDs)
  let existingClient = null;
  try {
    existingClient = await kv.get(connectionKey);
  } catch (error) {
    console.error(`Error checking for existing client ${id}:`, error);
  }

  // Check for existing WebSocket connection
  const existingConnection = activeConnections.get(id);

  // If there's an existing active connection with this ID
  if (existingConnection && existingConnection !== socket) {
    console.log(
      `Duplicate connection detected for ${id} - forcibly closing previous connection`,
    );

    try {
      // Close existing connection
      existingConnection.close(1000, "Replaced by new connection");

      // This will trigger the onclose handler and help clean up resources
      console.log(`Closed previous connection for ${id}`);
    } catch (closeError) {
      console.error(`Error closing existing connection for ${id}:`, closeError);
    }

    // Small delay to allow cleanup to complete
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // If the existing record is from another server instance, we may need
  // to clean it up or notify that instance, but for now we'll just overwrite it
  const now = Date.now();
  const instanceId = Deno.env.get("DENO_DEPLOYMENT_ID") || "local";

  // Prepare client data, preserving original connection timestamp on reconnect
  let connectionTimestamp = now;
  let reconnectionCount = 0;

  if (isReconnect && existingClient?.value) {
    // If this is a reconnection, preserve the original connection timestamp
    console.log(`Client ${id} is reconnecting (reconnect flag received)`);
    connectionTimestamp = existingClient.value.connectionTimestamp ||
      timestamp || now;
    reconnectionCount = (existingClient.value.reconnectionCount || 0) + 1;
  } else if (existingClient?.value) {
    // If an existing client was found but reconnect flag wasn't set, it might be a client
    // that lost connection and doesn't know it's reconnecting
    console.log(
      `Client ${id} appears to be reconnecting (existing record found)`,
    );
    connectionTimestamp = existingClient.value.connectionTimestamp || now;
    reconnectionCount = (existingClient.value.reconnectionCount || 0) + 1;
  }

  // Store the client data
  await kv.set(connectionKey, {
    instanceId,
    lastSeen: now,
    connectionTimestamp: connectionTimestamp, // Preserve original connection time for reconnects
    reconnectionCount: reconnectionCount,
    lastReconnectTime: isReconnect
      ? now
      : (existingClient?.value?.lastReconnectTime || null),
    isController: isControllerClient,
  }, { expireIn: CLIENT_TTL_MS });

  console.log(
    `${
      isReconnect ? "Reconnected" : "Registered"
    } client ${id}, connections: ${reconnectionCount}, original connection: ${
      new Date(connectionTimestamp).toISOString()
    }`,
  );

  // Store in local memory
  activeConnections.set(id, socket);

  // If it's a controller, add to our controller set and store in KV
  if (isControllerClient) {
    // Add to local set
    activeControllers.add(id);

    // Also store in KV so other instances know about this controller
    const controllerKey = ["webrtc", "controllers", id];
    await kv.set(controllerKey, {
      instanceId,
      lastSeen: now,
      connectionTimestamp: connectionTimestamp,
      reconnectionCount: reconnectionCount,
    }, { expireIn: CLIENT_TTL_MS });

    console.log(
      `Registered controller ${id} in KV for cross-instance visibility`,
    );
  } else {
    // Notify all controllers about the new client or reconnection
    await notifyControllers(
      isReconnect ? "client-reconnected" : "client-connected",
      {
        client: {
          id,
          connected: false,
          lastSeen: now,
          connectionTimestamp: connectionTimestamp,
          reconnectionCount: reconnectionCount,
          isReconnect: isReconnect,
        },
      },
    );
  }

  // Clean up any existing polling interval to avoid duplicates
  if (pollingIntervals.has(id)) {
    console.log(`Cleaning up existing polling interval for ${id}`);
    clearInterval(pollingIntervals.get(id));
    pollingIntervals.delete(id);
  }

  // Set up polling for messages
  const intervalId = setInterval(() => {
    processMessages(id, socket);
  }, 500); // Poll every 500ms

  pollingIntervals.set(id, intervalId);
}

// Unregister a connection
async function unregisterConnection(id: string) {
  if (!id) return;

  console.log(`Unregistering connection for ${id}`);

  const connectionKey = getConnectionKey(id);
  const isControllerClient = isController(id);

  try {
    // Remove from KV
    await kv.delete(connectionKey);

    // Remove from local memory
    activeConnections.delete(id);

    // If it's a controller, remove from our controller set and KV
    if (isControllerClient) {
      // Remove from local set
      activeControllers.delete(id);

      // Also remove from KV
      const controllerKey = ["webrtc", "controllers", id];
      await kv.delete(controllerKey);

      console.log(`Removed controller ${id} from local set and KV`);
    } else {
      // Notify all controllers about the client disconnection
      console.log(`Broadcasting client disconnection: ${id}`);
      await notifyControllers("client-disconnected", {
        clientId: id,
      });
    }

    // Clear polling interval
    const intervalId = pollingIntervals.get(id);
    if (intervalId) {
      clearInterval(intervalId);
      pollingIntervals.delete(id);
    }

    console.log(`Successfully unregistered: ${id}`);
  } catch (error) {
    console.error(`Error unregistering connection ${id}:`, error);
  }
}

// Send a notification to all active controllers
async function notifyControllers(type: string, data: any) {
  // Create the message
  const message = {
    type,
    ...data,
  };

  try {
    // Get all active controllers from KV to ensure we notify controllers on all instances
    const controllerKey = ["webrtc", "controllers"];
    const controllersData = kv.list({ prefix: controllerKey });

    // Local tracking of notified controllers to avoid duplicates
    const notifiedControllers = new Set<string>();

    // First notify controllers connected to this instance directly
    for (const controllerId of activeControllers) {
      const socket = activeConnections.get(controllerId);

      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
        console.log(`Notified controller ${controllerId} directly`);
      } else {
        await queueMessage(controllerId, message);
        console.log(`Queued notification for controller ${controllerId}`);
      }

      notifiedControllers.add(controllerId);
    }

    // Then check KV for controllers on other instances
    for await (const entry of controllersData) {
      const controllerId = entry.key[entry.key.length - 1].toString();

      // Skip if we've already notified this controller
      if (notifiedControllers.has(controllerId)) {
        continue;
      }

      // Queue message for controllers on other instances
      await queueMessage(controllerId, message);
      console.log(
        `Queued notification for controller ${controllerId} (other instance)`,
      );
    }
  } catch (error) {
    console.error("Error notifying controllers:", error);
  }
}

// Flag to track if the module has been initialized
let moduleInitialized = false;

// Initialize the notification polling - called on first request
function initializeModule() {
  if (moduleInitialized) return; // Only initialize once
  
  // Start polling for controller change notifications
  startNotificationPolling();

  // Set up a shutdown handler to clean up
  self.addEventListener("unload", () => {
    stopNotificationPolling();
  });

  moduleInitialized = true;
  console.log("[SIGNAL] Module initialized, notification polling started");
}

export const handler: Handlers = {
  GET: async (req) => {
    // Initialize the module on first request
    initializeModule();
    
    const url = new URL(req.url);
    const upgrade = req.headers.get("upgrade") || "";

    if (upgrade.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }

    const { socket, response } = Deno.upgradeWebSocket(req);

    let clientId: string | null = null;

    // Store request for later use
    const requestUrl = req.url;

    socket.onopen = () => {
      console.log("WebSocket connection opened");
    };

    socket.onmessage = async (event) => {
      // Make request URL available in onmessage handler
      try {
        const message = JSON.parse(event.data);

        // Update the lastSeen timestamp for this client whenever we receive a message
        if (clientId) {
          const connectionKey = getConnectionKey(clientId);
          const existingData = await kv.get(connectionKey);

          if (existingData.value) {
            // Preserve the original connection timestamp
            const connectionTimestamp =
              existingData.value.connectionTimestamp || Date.now();
            // Update the lastSeen timestamp
            await kv.set(connectionKey, {
              ...existingData.value,
              lastSeen: Date.now(),
              connectionTimestamp, // Keep the original connection time
            }, { expireIn: CLIENT_TTL_MS });
          }
        }

        switch (message.type) {
          case "register":
            clientId = message.id;

            // Check for reconnection flag and timestamp
            const isReconnect = message.isReconnect === true;
            const connectionTimestamp = message.timestamp || Date.now();

            console.log(
              `Registration request from ${clientId}${
                isReconnect ? " (reconnection)" : ""
              } with timestamp ${connectionTimestamp}`,
            );

            await registerConnection(
              clientId,
              socket,
              isReconnect,
              connectionTimestamp,
            );
            console.log(
              `Client ${
                isReconnect ? "reconnected" : "registered"
              } with ID: ${clientId}`,
            );

            // Process any pending messages right away
            await processMessages(clientId, socket);

            // Send confirmation of registration with new client data
            const connectionKey = getConnectionKey(clientId);
            const clientData = await kv.get(connectionKey);
            const reconnectionCount = clientData.value?.reconnectionCount || 0;

            socket.send(JSON.stringify({
              type: "registration-confirmed",
              id: clientId,
              reconnectionCount: reconnectionCount,
              timestamp: Date.now(),
              isReconnection: isReconnect,
            }));

            // Handle different client types
            if (isController(clientId)) {
              // If this is a controller, send the list of clients right away
              const clients = await getConnectedClients();
              socket.send(JSON.stringify({
                type: "client-list",
                clients,
              }));
            } else {
              // Regular client - check if there's an active controller
              const activeControllerId = await getActiveController();
              if (activeControllerId) {
                // Send the active controller ID to the client
                socket.send(JSON.stringify({
                  type: "active-controller",
                  controllerId: activeControllerId,
                }));
              }
            }
            break;

          case "controller-heartbeat":
            // Controller is requesting updates - send client list
            if (clientId && isController(clientId)) {
              // First cleanup inactive clients to provide a clean list
              console.log("Controller heartbeat - refreshing client list");
              await cleanupInactiveClients();

              // Send the clean list
              const clients = await getConnectedClients();
              socket.send(JSON.stringify({
                type: "client-list",
                clients,
              }));
              console.log(
                `Sent refreshed client list to controller: ${clients.length} clients`,
              );
            }
            break;

          case "controller-activate":
            // Controller is activating
            if (clientId && isController(clientId)) {
              console.log("=== CONTROLLER ACTIVATION ===");
              console.log(
                `Controller ${clientId} activating - broadcasting to connected clients`,
              );

              // For legacy support, we'll broadcast via WebSockets
              await broadcastControllerChange(clientId);

              // First, immediately send the client list without cleanup
              socket.send(JSON.stringify({
                type: "client-list",
                clients: await getConnectedClients(),
              }));

              // Clean up inactive clients when a controller becomes active, but with a delay
              setTimeout(async () => {
                console.log("Executing delayed cleanup of inactive clients");
                const removedCount = await cleanupInactiveClients();

                // Force the controller to request an updated client list after cleanup
                if (socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({
                    type: "client-list",
                    clients: await getConnectedClients(),
                  }));
                }
              }, CLIENT_GRACE_PERIOD_MS);
            }
            break;

          case "controller-deactivate":
            // Controller is deactivating
            if (clientId && isController(clientId)) {
              // Check if this is the current active controller
              const activeController = await getActiveController();
              if (activeController === clientId) {
                // Just broadcast that there is no active controller
                console.log(
                  `Controller ${clientId} deactivating - broadcasting to connected clients`,
                );
                await broadcastControllerChange(null);
              }
            }
            break;

          case "controller-connections":
            // Controller is reporting its active WebRTC connections
            if (clientId && isController(clientId)) {
              const connections = message.connections || [];
              console.log(
                `Controller ${clientId} reported ${connections.length} active WebRTC connections:`,
                connections,
              );

              // Store the controller's active connections
              activeWebRTCConnections.set(clientId, new Set(connections));

              // Only run cleanup if it's been at least half the grace period since controller activated
              // This provides a balance between keeping the connection list clean and giving clients time to connect
              const activeController = await getActiveController();
              if (activeController === clientId) {
                const controllerKey = ["webrtc", "active", "controller"];
                const controllerData = await kv.get(controllerKey);

                if (controllerData.value && controllerData.value.timestamp) {
                  const timeSinceActivation = Date.now() -
                    controllerData.value.timestamp;
                  if (timeSinceActivation > CLIENT_GRACE_PERIOD_MS / 2) {
                    console.log(
                      `Controller has been active for ${timeSinceActivation}ms, running cleanup`,
                    );
                    // Now clean up any inactive clients (those not connected to any controller)
                    await cleanupBasedOnWebRTCConnections();
                  } else {
                    console.log(
                      `Controller recently activated (${timeSinceActivation}ms ago), skipping cleanup`,
                    );
                  }
                } else {
                  // If we can't determine the activation time, still run cleanup
                  await cleanupBasedOnWebRTCConnections();
                }
              } else {
                // If this controller isn't the active one, still run cleanup
                await cleanupBasedOnWebRTCConnections();
              }
            }
            break;

          case "request-active-controller":
            // Client is requesting the current active controller ID
            console.log(
              `Client ${clientId} requested current active controller`,
            );

            if (clientId) {
              try {
                // Try to get the current active controller from new endpoint via fetch
                // Use absolute URL to avoid path resolution issues
                const baseUrl = new URL(requestUrl).origin;
                const response = await fetch(
                  `${baseUrl}/api/controller/status`,
                );
                if (response.ok) {
                  const data = await response.json();

                  // Send the active controller ID to the client
                  socket.send(JSON.stringify({
                    type: "active-controller",
                    controllerId: data.activeController,
                    requestedByClient: true,
                    timestamp: Date.now(),
                  }));

                  console.log(
                    `Sent active controller ${data.activeController} to client ${clientId} (requested via new API)`,
                  );
                } else {
                  // Fall back to legacy method
                  const activeControllerId = await getActiveController();

                  socket.send(JSON.stringify({
                    type: "active-controller",
                    controllerId: activeControllerId,
                    requestedByClient: true,
                    timestamp: Date.now(),
                  }));

                  console.log(
                    `Sent active controller ${activeControllerId} to client ${clientId} (requested via legacy method)`,
                  );
                }
              } catch (error) {
                console.error(
                  `Error handling active controller request:`,
                  error,
                );

                // Fall back to legacy method if fetch fails
                const activeControllerId = await getActiveController();

                socket.send(JSON.stringify({
                  type: "active-controller",
                  controllerId: activeControllerId,
                  requestedByClient: true,
                  error: true,
                }));
              }
            }
            break;

          case "heartbeat":
            // Client is sending a heartbeat to keep the connection alive
            if (clientId) {
              // Update the lastSeen timestamp
              const connectionKey = getConnectionKey(clientId);
              const existingData = await kv.get(connectionKey);

              if (existingData.value) {
                // Update the lastSeen timestamp but preserve original connection timestamp
                const connectionTimestamp =
                  existingData.value.connectionTimestamp || Date.now();
                await kv.set(connectionKey, {
                  ...existingData.value,
                  lastSeen: Date.now(),
                  connectionTimestamp, // Preserve the original connection time
                }, { expireIn: CLIENT_TTL_MS });

                console.log(`Updated heartbeat for client ${clientId}`);
              }

              // Send heartbeat acknowledgment back to client
              socket.send(JSON.stringify({
                type: "heartbeat_ack",
                timestamp: Date.now(),
              }));
            }
            break;

          case "connection_verify":
            // Client is verifying if their connection is still alive and valid
            if (clientId) {
              try {
                console.log(
                  `[SERVER] Received connection verification request from ${clientId}`,
                );

                // Send immediate confirmation back to client
                socket.send(JSON.stringify({
                  type: "connection_confirm",
                  request_timestamp: message.timestamp,
                  timestamp: Date.now(),
                  clientId: clientId,
                }));

                console.log(
                  `[SERVER] Sent connection verification confirmation to ${clientId}`,
                );
              } catch (error) {
                console.error(
                  `[SERVER] Error sending verification confirmation to ${clientId}:`,
                  error,
                );
              }
            }
            break;

          case "offer":
          case "answer":
          case "ice-candidate":
            if (!clientId) {
              console.error("Client not registered");
              return;
            }

            const targetId = message.target;

            // Try local delivery first (if target is connected to this instance)
            const targetSocket = activeConnections.get(targetId);
            if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
              targetSocket.send(JSON.stringify({
                type: message.type,
                data: message.data,
                source: clientId,
              }));
              console.log(`Direct delivery to ${targetId}`);
            } else {
              // Otherwise, queue the message in KV
              await queueMessage(targetId, {
                type: message.type,
                data: message.data,
                source: clientId,
              });
            }
            break;

          default:
            console.log(`Unknown message type: ${message.type}`);
        }
      } catch (error) {
        console.error("Error handling WebSocket message:", error);
      }
    };

    socket.onclose = async () => {
      await unregisterConnection(clientId);
      console.log(`Client disconnected: ${clientId}`);
    };

    return response;
  },
};
