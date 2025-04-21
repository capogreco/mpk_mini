import { Handlers } from "$fresh/server.ts";

// Open the KV store
const kv = await Deno.openKv();

// Constants
const CONTROLLER_CLIENT_PREFIX = "controller";
const SYNTH_CLIENT_PREFIX = "synth";
const CLIENT_ID_KEY_PREFIX = ["webrtc", "client_ids"];
const CLIENT_ID_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours TTL for client IDs

// Generate a unique client ID
function generateUniqueId(clientType: string): string {
  const randomPart = crypto.randomUUID().substring(0, 8);
  return `${clientType}-${randomPart}`;
}

export const handler: Handlers = {
  // Generate a new client ID
  async POST(req) {
    try {
      const body = await req.json();
      const clientType = body.type || "synth"; // Default to synth if not specified

      // Validate client type
      if (clientType !== "controller" && clientType !== "synth") {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Invalid client type. Must be 'controller' or 'synth'",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Generate a prefix-based ID
      const prefix = clientType === "controller"
        ? CONTROLLER_CLIENT_PREFIX
        : SYNTH_CLIENT_PREFIX;

      // Generate a unique ID
      const clientId = generateUniqueId(prefix);

      // Store the client ID in KV with expiration
      await kv.set(
        [...CLIENT_ID_KEY_PREFIX, clientId],
        {
          id: clientId,
          type: clientType,
          createdAt: Date.now(),
          lastActive: Date.now(),
        },
        { expireIn: CLIENT_ID_TTL_MS },
      );

      console.log(`[CLIENT-ID] Generated new ${clientType} ID: ${clientId}`);

      return new Response(
        JSON.stringify({
          success: true,
          clientId: clientId,
          type: clientType,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    } catch (error) {
      console.error("[CLIENT-ID] Error generating client ID:", error);
      return new Response(
        JSON.stringify({ success: false, error: "Server error" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  },

  // Check if a client ID is valid or get information about it
  async GET(req) {
    try {
      const url = new URL(req.url);
      const clientId = url.searchParams.get("id");

      if (!clientId) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Missing client ID parameter",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Check if the client ID exists in KV
      const clientInfo = await kv.get([...CLIENT_ID_KEY_PREFIX, clientId]);

      if (!clientInfo.value) {
        return new Response(
          JSON.stringify({
            success: false,
            exists: false,
            error: "Client ID not found",
          }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Update last active timestamp
      await kv.set(
        [...CLIENT_ID_KEY_PREFIX, clientId],
        {
          ...clientInfo.value,
          lastActive: Date.now(),
        },
        { expireIn: CLIENT_ID_TTL_MS },
      );

      return new Response(
        JSON.stringify({
          success: true,
          exists: true,
          clientInfo: {
            id: clientInfo.value.id,
            type: clientInfo.value.type,
            createdAt: clientInfo.value.createdAt,
            lastActive: Date.now(),
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    } catch (error) {
      console.error("[CLIENT-ID] Error checking client ID:", error);
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
