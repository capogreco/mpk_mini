import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";

// Audio context for the synth
let audioContext: AudioContext | null = null;
let oscillator: OscillatorNode | null = null;
let filterNode: BiquadFilterNode | null = null;
let gainNode: GainNode | null = null;

export default function WebRTC() {
  // State management
  const id = useSignal(""); // Will be set by server
  const idType = useSignal("synth"); // Default client type
  const idLoaded = useSignal(false); // Track if we've received our ID from the server
  const targetId = useSignal("");
  const connected = useSignal(false);
  const message = useSignal("");
  const logs = useSignal<string[]>([]);
  const connection = useSignal<RTCPeerConnection | null>(null);
  const dataChannel = useSignal<RTCDataChannel | null>(null);
  const socket = useSignal<WebSocket | null>(null);
  const activeController = useSignal<string | null>(null);
  const connectedControllerId = useSignal<string | null>(null); // Track which controller we're connected to
  const lastControllerChangeTime = useSignal<number>(0); // Track when controller was last changed
  const autoConnectAttempted = useSignal(false);

  // Audio context state
  const audioEnabled = useSignal(false);
  const audioState = useSignal<string>("suspended");
  const showAudioButton = useSignal(true);
  const showResumeAudioButton = useSignal(false);
  const reconnectAttemptInterval = useSignal<number | null>(null);
  
  // Global parameters state
  const globalParams = useSignal<{
    portamento: number;
    filterCutoff: number;
    filterResonance: number;
    [key: string]: any;
  }>({
    portamento: 0,
    filterCutoff: 2000,
    filterResonance: 0.5
  });

  // Connection health monitoring
  const lastMessageReceivedTime = useSignal<number>(0);
  const iceConnectionState = useSignal<string>("new");
  const connectionHealthy = useSignal<boolean>(false);
  const heartbeatInterval = useSignal<number | null>(null);

  // WebSocket connection status
  const wsConnected = useSignal(false);
  const wsReconnecting = useSignal(false);
  const wsReconnectAttempts = useSignal<number>(0);

  // Format timestamp
  const formatTime = () => {
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, "0");
    const minutes = now.getMinutes().toString().padStart(2, "0");
    const seconds = now.getSeconds().toString().padStart(2, "0");
    return `${hours}:${minutes}:${seconds}`;
  };

  // Add a log entry
  const addLog = (text: string) => {
    const maxLogs = 50;
    logs.value = [...logs.value, `${formatTime()}: ${text}`].slice(-maxLogs);

    // Scroll to bottom
    setTimeout(() => {
      const logEl = document.querySelector(".log");
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    }, 0);
  };

  // Request a server-generated client ID
  const requestClientId = async () => {
    try {
      console.log("[SYNTH] Requesting client ID from server");
      addLog("Requesting client ID from server...");

      const response = await fetch("/api/client-id", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ type: idType.value }),
      });

      if (!response.ok) {
        addLog("Failed to get client ID");
        return false;
      }

      const data = await response.json();

      if (data.success && data.clientId) {
        id.value = data.clientId;
        idLoaded.value = true;
        addLog(`Received client ID: ${data.clientId}`);
        return true;
      } else {
        addLog("Invalid client ID response");
        return false;
      }
    } catch (error) {
      addLog(`Error requesting client ID: ${error.message}`);
      return false;
    }
  };

  // Fetch ICE servers from Twilio
  const fetchIceServers = async () => {
    try {
      const response = await fetch("/api/twilio-ice");
      if (!response.ok) {
        console.error("Failed to fetch ICE servers from Twilio");
        // Fallback to Google's STUN server
        return [{ urls: "stun:stun.l.google.com:19302" }];
      }

      const data = await response.json();
      return data.iceServers;
    } catch (error) {
      console.error("Error fetching ICE servers:", error);
      // Fallback to Google's STUN server
      return [{ urls: "stun:stun.l.google.com:19302" }];
    }
  };

  // Initialize WebRTC connection
  const initRTC = async (targetControllerId: string, isReconnect = false) => {
    if (!wsConnected.value) {
      addLog("WebSocket not connected. Connect to signaling server first.");
      await connectWebSocket();
      if (!wsConnected.value) {
        addLog(
          "Failed to connect to signaling server. Cannot establish WebRTC connection.",
        );
        return;
      }
    }

    // If there's an existing connection and it's not a reconnect, close it
    if (connection.value && !isReconnect) {
      addLog("Closing existing connection before creating a new one");
      cleanupConnection();
    }

    // Get ICE servers from Twilio
    const iceServers = await fetchIceServers();
    console.log("[SYNTH] Using ICE servers:", iceServers);

    const peerConnection = new RTCPeerConnection({
      iceServers,
    });

    connection.value = peerConnection;
    connected.value = false;
    connectionHealthy.value = false;

    // Set up ICE candidate handling
    peerConnection.onicecandidate = (event) => {
      if (
        event.candidate && socket.value &&
        socket.value.readyState === WebSocket.OPEN
      ) {
        socket.value.send(JSON.stringify({
          type: "ice-candidate",
          target: targetControllerId,
          data: event.candidate,
        }));
      }
    };

    // Track ICE connection state
    peerConnection.oniceconnectionstatechange = () => {
      const state = peerConnection.iceConnectionState;
      console.log(`[SYNTH] ICE connection state: ${state}`);
      iceConnectionState.value = state;

      // Update connection health based on ICE state
      if (state === "connected" || state === "completed") {
        connectionHealthy.value = true;
      } else if (
        state === "disconnected" || state === "failed" || state === "closed"
      ) {
        connectionHealthy.value = false;

        // Try reconnection if disconnected or failed
        if (
          (state === "disconnected" || state === "failed") &&
          activeController.value
        ) {
          addLog(`ICE connection ${state}. Will attempt reconnection.`);
          // Use a short delay before attempting reconnection
          setTimeout(() => {
            if (!connected.value && activeController.value) {
              attemptReconnection();
            }
          }, 2000);
        }
      }
    };

    // Handle data channel
    peerConnection.ondatachannel = (event) => {
      setupDataChannel(event.channel);
    };

    // Create offer (if we're the synth client reconnecting)
    if (isReconnect) {
      try {
        // Create and set up data channel first
        const channel = peerConnection.createDataChannel("synthChannel");
        setupDataChannel(channel);

        // Create offer
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        // Send offer to controller
        if (socket.value && socket.value.readyState === WebSocket.OPEN) {
          socket.value.send(JSON.stringify({
            type: "offer",
            target: targetControllerId,
            data: offer,
          }));
          addLog(`Sent reconnection offer to controller ${targetControllerId}`);
        } else {
          addLog("WebSocket not connected. Cannot send offer.");
        }
      } catch (error) {
        addLog(`Error creating offer: ${error.message}`);
      }
    }

    // Track the controller we're trying to connect to
    connectedControllerId.value = targetControllerId;

    // Start connection health monitoring
    startConnectionMonitoring();
  };

  // Set up data channel
  const setupDataChannel = (channel: RTCDataChannel) => {
    dataChannel.value = channel;
    console.log(`[SYNTH] Data channel ${channel.label} created/received`);

    channel.onopen = () => {
      addLog("Data channel opened");
      connected.value = true;
      connectionHealthy.value = true;
      lastMessageReceivedTime.value = Date.now();

      // Report audio status to controller
      sendAudioStatus();

      // Request global parameters from controller
      requestGlobalParameters();
    };

    channel.onclose = () => {
      addLog("Data channel closed");
      connected.value = false;
      connectionHealthy.value = false;

      // Attempt reconnection to active controller if we have one
      if (activeController.value) {
        setTimeout(() => attemptReconnection(), 2000);
      }
    };

    channel.onmessage = (event) => {
      console.log(`[SYNTH] Received message:`, event.data);
      lastMessageReceivedTime.value = Date.now();

      try {
        // Try to parse as JSON first
        const data = JSON.parse(event.data);
        handleJsonMessage(data);
      } catch (e) {
        // If not JSON, treat as a regular message
        addLog(`Received: ${event.data}`);
      }
    };
  };

  // Handle JSON messages
  const handleJsonMessage = (data: any) => {
    // Handle synth parameter updates
    if (data.type === "synth_param") {
      handleSynthParamUpdate(data.param, data.value);
    } // Handle global parameter bundle updates
    else if (data.type === "global_params_bundle") {
      handleGlobalParamsBundle(data.params, data.version);
    } // Handle ping requests
    else if (data.type === "ping") {
      sendPong(data.timestamp);
    } // Handle verification ping responses (pong)
    else if (data.type === "verification_pong") {
      handleVerificationPong(data);
    } // Handle verification ping requests (respond with pong)
    else if (data.type === "verification_ping") {
      // Respond with a verification pong
      if (dataChannel.value && dataChannel.value.readyState === "open") {
        dataChannel.value.send(JSON.stringify({
          type: "verification_pong",
          pingId: data.pingId,
          timestamp: Date.now(),
          originalTimestamp: data.timestamp,
          respondingClientId: id.value,
        }));
      }
    } // Handle regular messages
    else {
      addLog(`Received: ${JSON.stringify(data)}`);
    }
  };

  // Handle synth parameter updates
  const handleSynthParamUpdate = (param: string, value: any) => {
    switch (param) {
      case "oscillatorEnabled":
        if (audioContext && gainNode) {
          if (!audioEnabled.value) {
            // Initialize audio if not already done
            initAudio();
          }

          // Just control gain to enable/disable sound
          if (value) {
            // Unmute by setting gain to normal value
            gainNode.gain.value = 0.1; // Default volume
            addLog("Note on - gain unmuted");
          } else {
            // Mute by setting gain to 0
            gainNode.gain.value = 0;
            addLog("Note off - gain muted");
          }
        }
        break;
      case "frequency":
        if (oscillator && audioContext) {
          const currentTime = audioContext.currentTime;
          const currentFrequency = oscillator.frequency.value;
          const portamentoTime = globalParams.value.portamento || 0;
          
          // If portamento is 0 or very small, set value immediately
          if (portamentoTime < 0.005) {
            oscillator.frequency.value = value;
          } else {
            // Apply portamento - cancel any scheduled changes first
            oscillator.frequency.cancelScheduledValues(currentTime);
            
            // Set current frequency explicitly at current time as starting point
            oscillator.frequency.setValueAtTime(currentFrequency, currentTime);
            
            // Schedule exponential ramp to new value
            oscillator.frequency.exponentialRampToValueAtTime(
              value, 
              currentTime + portamentoTime
            );
          }
        }
        break;
      case "portamento":
        // Store portamento value in global params
        globalParams.value = {
          ...globalParams.value,
          portamento: value
        };
        break;
      case "filterCutoff":
        if (filterNode) {
          // Apply filter cutoff frequency
          filterNode.frequency.value = value;
        }
        // Store in global params
        globalParams.value = {
          ...globalParams.value,
          filterCutoff: value
        };
        break;
      case "filterResonance":
        if (filterNode) {
          // Apply filter resonance (Q value)
          filterNode.Q.value = value;
        }
        // Store in global params
        globalParams.value = {
          ...globalParams.value,
          filterResonance: value
        };
        break;
      case "waveform":
        if (oscillator) {
          oscillator.type = value;
        }
        break;
      case "volume":
        if (gainNode && audioEnabled.value) {
          // Only update gain if oscillator is enabled
          gainNode.gain.value = value;
        }
        break;
      case "detune":
        if (oscillator) {
          oscillator.detune.value = value;
        }
        break;
    }
  };

  // Handle global parameter bundle updates
  const handleGlobalParamsBundle = (
    params: Record<string, any>,
    version: number,
  ) => {
    // Log receipt of parameter bundle
    addLog(
      `Received global params bundle with ${
        Object.keys(params).length
      } parameters (v${version})`,
    );

    // Initialize audio if needed and not already done
    if (!audioEnabled.value && audioContext === null) {
      initAudio();
    }
    
    // Update our local tracking of global parameters
    if (params.portamento !== undefined) {
      globalParams.value = {
        ...globalParams.value,
        portamento: params.portamento
      };
    }

    // Process each parameter in the bundle
    Object.entries(params).forEach(([param, value]) => {
      // Reuse existing parameter handler for individual updates
      handleSynthParamUpdate(param, value);
    });

    // Send acknowledgement back to controller
    if (dataChannel.value && dataChannel.value.readyState === "open") {
      dataChannel.value.send(JSON.stringify({
        type: "params_bundle_ack",
        timestamp: Date.now(),
        version: version,
        clientId: id.value,
      }));
    }
  };

  // Send a pong response to a ping
  const sendPong = (timestamp: number) => {
    if (dataChannel.value && dataChannel.value.readyState === "open") {
      const pongMessage = {
        type: "pong",
        originalTimestamp: timestamp,
        timestamp: Date.now(),
      };
      dataChannel.value.send(JSON.stringify(pongMessage));
    }
  };

  // Clean up the existing WebRTC connection
  const cleanupConnection = () => {
    // Clean up data channel
    if (dataChannel.value) {
      try {
        dataChannel.value.close();
      } catch (e) {
        console.error("[SYNTH] Error closing data channel:", e);
      }
      dataChannel.value = null;
    }

    // Clean up peer connection
    if (connection.value) {
      try {
        connection.value.close();
      } catch (e) {
        console.error("[SYNTH] Error closing peer connection:", e);
      }
      connection.value = null;
    }

    // Reset connection state
    connected.value = false;
    connectionHealthy.value = false;
    connectedControllerId.value = null;
  };

  // Connect to the WebSocket signaling server
  const connectWebSocket = async () => {
    if (socket.value && socket.value.readyState !== WebSocket.CLOSED) {
      addLog("WebSocket already connected or connecting");
      return;
    }

    // Check if we have a client ID
    if (!idLoaded.value) {
      const success = await requestClientId();
      if (!success) {
        addLog("Failed to get client ID, cannot connect to signaling server");
        return;
      }
    }

    wsReconnecting.value = true;

    // Get WebSocket URL from the current location
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/signal`;

    addLog(`Connecting to signaling server at ${wsUrl}...`);
    const ws = new WebSocket(wsUrl);
    socket.value = ws;

    ws.onopen = () => {
      addLog("Connected to signaling server");
      wsConnected.value = true;
      wsReconnecting.value = false;
      wsReconnectAttempts.value = 0;

      // Register with the signaling server
      ws.send(JSON.stringify({
        type: "register",
        id: id.value,
        clientType: idType.value,
      }));
      addLog(`Registering as ${idType.value} client with ID ${id.value}`);
    };

    ws.onclose = (event) => {
      addLog(
        `WebSocket disconnected (${event.code}${
          event.reason ? ": " + event.reason : ""
        })`,
      );
      wsConnected.value = false;

      // Don't try to reconnect if we deliberately closed the connection
      if (socket.value) {
        wsReconnecting.value = true;
        wsReconnectAttempts.value += 1;

        // Use exponential backoff for reconnection
        const delay = Math.min(
          1000 * Math.pow(1.5, wsReconnectAttempts.value),
          10000,
        );
        setTimeout(connectWebSocket, delay);
      } else {
        wsReconnecting.value = false;
      }
    };

    ws.onerror = (error) => {
      console.error("[SYNTH] WebSocket error:", error);
      addLog("WebSocket error. Will try to reconnect...");
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        switch (message.type) {
          case "registration-confirmed":
            addLog(
              `Registered with signaling server${
                message.isReconnection ? " (reconnected)" : ""
              }`,
            );

            // Request current active controller on registration
            if (socket.value && socket.value.readyState === WebSocket.OPEN) {
              socket.value.send(JSON.stringify({
                type: "request-active-controller",
              }));
            }
            break;

          case "active-controller":
            handleActiveControllerUpdate(message.controllerId);
            break;

          case "offer":
            handleOffer(message);
            break;

          case "answer":
            handleAnswer(message);
            break;

          case "ice-candidate":
            handleIceCandidate(message);
            break;

          default:
            console.log("[SYNTH] Received message of type:", message.type);
        }
      } catch (error) {
        console.error("[SYNTH] Error parsing WebSocket message:", error);
        addLog(`Error handling WebSocket message: ${error.message}`);
      }
    };
  };

  // Handle receiving the active controller ID
  const handleActiveControllerUpdate = (controllerId: string | null) => {
    const previousController = activeController.value;

    // Update active controller
    activeController.value = controllerId;
    lastControllerChangeTime.value = Date.now();

    // Log the update
    if (controllerId) {
      addLog(`Active controller: ${controllerId}`);

      // If we're not connected to this controller but it is available, connect
      if (controllerId !== connectedControllerId.value && wsConnected.value) {
        // If we were connected to a different controller, disconnect first
        if (connected.value && connectedControllerId.value !== controllerId) {
          addLog(
            `Disconnecting from previous controller ${connectedControllerId.value}`,
          );
          cleanupConnection();
        }

        // Connect to the new controller
        addLog(`Connecting to new active controller ${controllerId}`);
        autoConnectAttempted.value = true;
        initRTC(controllerId, false);
      }
    } else {
      addLog("No active controller available");

      // If we were connected and now there's no controller, clean up
      if (connected.value) {
        addLog("Disconnecting since there's no active controller");
        cleanupConnection();
      }
    }
  };

  // Handle an offer from a controller
  const handleOffer = async (message: any) => {
    addLog(`Received offer from ${message.source}`);

    // If we have an active controller and it doesn't match the source, ignore
    if (activeController.value && activeController.value !== message.source) {
      addLog(`Ignoring offer from non-active controller ${message.source}`);
      return;
    }

    // If we're already connected to this controller, ignore the offer
    if (connected.value && connectedControllerId.value === message.source) {
      addLog(`Already connected to ${message.source}, ignoring offer`);
      return;
    }

    // Initialize a new connection if needed
    if (!connection.value) {
      await initRTC(message.source, false);
    }

    try {
      if (connection.value) {
        // Set remote description from the offer
        await connection.value.setRemoteDescription(
          new RTCSessionDescription(message.data),
        );

        // Create answer
        const answer = await connection.value.createAnswer();
        await connection.value.setLocalDescription(answer);

        // Send answer back
        if (socket.value && socket.value.readyState === WebSocket.OPEN) {
          socket.value.send(JSON.stringify({
            type: "answer",
            target: message.source,
            data: answer,
          }));
          addLog(`Sent answer to ${message.source}`);
        } else {
          addLog("WebSocket not connected. Cannot send answer.");
        }
      }
    } catch (error) {
      addLog(`Error handling offer: ${error.message}`);
    }
  };

  // Handle an answer to our offer
  const handleAnswer = async (message: any) => {
    addLog(`Received answer from ${message.source}`);

    try {
      if (connection.value) {
        await connection.value.setRemoteDescription(
          new RTCSessionDescription(message.data),
        );
        addLog("Remote description set from answer");
      }
    } catch (error) {
      addLog(`Error handling answer: ${error.message}`);
    }
  };

  // Handle an ICE candidate
  const handleIceCandidate = async (message: any) => {
    try {
      if (connection.value) {
        await connection.value.addIceCandidate(
          new RTCIceCandidate(message.data),
        );
      }
    } catch (error) {
      addLog(`Error adding ICE candidate: ${error.message}`);
    }
  };

  // Attempt reconnection to the controller
  const attemptReconnection = async () => {
    if (!activeController.value) {
      addLog("No active controller to reconnect to");
      return;
    }

    if (connected.value && connectionHealthy.value) {
      console.log("[SYNTH] Already connected, skipping reconnection");
      return;
    }

    addLog(`Attempting reconnection to controller ${activeController.value}`);

    // Initialize a new connection with reconnect flag
    await initRTC(activeController.value, true);
  };

  // Connect to target ID (manual action)
  const connect = async () => {
    if (!targetId.value) {
      addLog("Please enter a target ID");
      return;
    }

    await initRTC(targetId.value, false);
  };

  // Disconnect
  const disconnect = () => {
    addLog("Disconnecting...");
    cleanupConnection();
  };

  // Track verification pings for connection health
  const verificationPings = new Map<string, number>();
  const PING_TIMEOUT_MS = 5000; // 5 seconds timeout for ping responses

  // Send a verification ping to the controller
  const sendVerificationPing = () => {
    if (!dataChannel.value || dataChannel.value.readyState !== "open") {
      return false;
    }

    try {
      const pingId = crypto.randomUUID().substring(0, 8);
      const now = Date.now();

      // Store this ping id and timestamp
      verificationPings.set(pingId, now);

      // Send the verification ping
      dataChannel.value.send(JSON.stringify({
        type: "verification_ping",
        pingId: pingId,
        timestamp: now,
        clientId: id.value,
      }));

      addLog(`Sent verification ping ${pingId}`);

      // Set a timeout to check if we got a response
      setTimeout(() => {
        if (verificationPings.has(pingId)) {
          // No response received within timeout
          console.log(`[SYNTH] No response to verification ping ${pingId}`);
          verificationPings.delete(pingId);
          connectionHealthy.value = false;

          // If we haven't gotten responses to verification pings,
          // that's a strong indicator we need to reconnect
          if (connected.value && activeController.value) {
            addLog("Connection verification failed - attempting reconnection");
            attemptReconnection();
          }
        }
      }, PING_TIMEOUT_MS);

      return true;
    } catch (error) {
      console.error("[SYNTH] Error sending verification ping:", error);
      return false;
    }
  };

  // Handle verification pong response
  const handleVerificationPong = (data: any) => {
    const { pingId, timestamp } = data;

    if (verificationPings.has(pingId)) {
      // Calculate round-trip time
      const rtt = Date.now() - verificationPings.get(pingId);
      addLog(`Received verification pong for ${pingId} (RTT: ${rtt}ms)`);

      // Remove this ping from tracking
      verificationPings.delete(pingId);

      // Update connection health - this is a strong positive signal
      connectionHealthy.value = true;
      lastMessageReceivedTime.value = Date.now();
    }
  };

  // Start monitoring connection health
  const startConnectionMonitoring = () => {
    // Clear any existing interval
    if (heartbeatInterval.value !== null) {
      clearInterval(heartbeatInterval.value);
    }

    // Start a new interval to check connection health
    heartbeatInterval.value = setInterval(() => {
      // If we're not connected, don't bother checking health
      if (!connected.value) return;

      const now = Date.now();

      // Check if we've received a message recently
      const messageAge = now - lastMessageReceivedTime.value;
      const isMessageRecent = messageAge < 30000; // 30 seconds

      // Check if ICE connection is good
      const isIceHealthy = iceConnectionState.value === "connected" ||
        iceConnectionState.value === "completed";

      // Update overall health status based on message recency and ICE state
      connectionHealthy.value = isIceHealthy && isMessageRecent;

      // Send a verification ping every other heartbeat interval
      if (now % 20000 < 10000) {
        sendVerificationPing();
      } // On alternate intervals, send a regular heartbeat
      else if (dataChannel.value && dataChannel.value.readyState === "open") {
        try {
          dataChannel.value.send(JSON.stringify({
            type: "heartbeat",
            timestamp: now,
          }));
        } catch (error) {
          console.error("[SYNTH] Error sending heartbeat:", error);
        }
      }

      // If connection is unhealthy and attempts to validate have failed, try reconnection
      if (!connectionHealthy.value && activeController.value) {
        attemptReconnection();
      }
    }, 10000); // Check every 10 seconds
  };

  // Start audio - now just initializes audio and unmutes gain
  const startAudio = () => {
    // Initialize if not already done
    if (!audioContext) {
      initAudio();
    } else if (audioContext.state === "suspended") {
      audioContext.resume();
      audioState.value = audioContext.state;
    }

    // Unmute gain to hear sound
    if (gainNode) {
      gainNode.gain.value = 0.1; // Default volume
    }

    // Send audio status to controller
    sendAudioStatus();
  };

  // Stop audio - now just mutes gain without stopping oscillator
  const stopAudio = () => {
    if (gainNode) {
      // Just mute the gain without stopping oscillator
      gainNode.gain.value = 0;
      addLog("Audio muted (oscillator still running)");

      // Send audio status to controller
      sendAudioStatus();
    }
  };

  // Initialize audio context
  const initAudio = () => {
    try {
      // Initialize audio context if not already created
      if (!audioContext) {
        audioContext =
          new (window.AudioContext || (window as any).webkitAudioContext)();

        // Create the filter node
        filterNode = audioContext.createBiquadFilter();
        filterNode.type = "lowpass";
        filterNode.frequency.value = globalParams.value.filterCutoff; // Initial cutoff
        filterNode.Q.value = globalParams.value.filterResonance; // Initial resonance
        
        // Create the gain node (initially muted)
        gainNode = audioContext.createGain();
        gainNode.gain.value = 0; // Start muted
        
        // Create and start a single oscillator that runs continuously
        oscillator = audioContext.createOscillator();
        oscillator.type = "sine"; // Default waveform
        oscillator.frequency.value = 440; // Default frequency (A4)
        
        // Connect the audio chain: oscillator -> filter -> gain -> output
        oscillator.connect(filterNode);
        filterNode.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        // Start the oscillator immediately and let it run continuously
        // We'll control sound with the gain node
        oscillator.start();

        audioState.value = audioContext.state;
        addLog(
          `Audio initialized with filter (${audioState.value})`,
        );
      }

      // Resume audio context if needed
      if (audioContext.state === "suspended") {
        audioContext.resume();
        audioState.value = audioContext.state;
        addLog(`Audio context resumed (${audioState.value})`);
      }

      audioEnabled.value = true;

      // Hide the initial audio button after initialization
      showAudioButton.value = false;
    } catch (e) {
      console.error("[SYNTH] Error initializing audio:", e);
      addLog(`Error initializing audio: ${e.message}`);
    }
  };

  // Resume audio context
  const resumeAudio = async () => {
    if (audioContext && audioContext.state === "suspended") {
      try {
        await audioContext.resume();
        audioState.value = audioContext.state;
        showResumeAudioButton.value = false;
        addLog(`Audio resumed (${audioContext.state})`);

        // Send updated audio status to controller
        sendAudioStatus();
      } catch (e) {
        console.error("[SYNTH] Error resuming audio context:", e);
        addLog(`Error resuming audio: ${e.message}`);
      }
    }
  };

  // Send audio status to controller
  const sendAudioStatus = () => {
    if (dataChannel.value && dataChannel.value.readyState === "open") {
      try {
        dataChannel.value.send(JSON.stringify({
          type: "audio_status",
          enabled: audioEnabled.value,
          state: audioContext ? audioContext.state : "none",
          noteOn: gainNode ? gainNode.gain.value > 0 : false,
        }));
      } catch (error) {
        console.error("[SYNTH] Error sending audio status:", error);
      }
    }
  };

  // Request global parameters from controller
  const requestGlobalParameters = () => {
    if (dataChannel.value && dataChannel.value.readyState === "open") {
      try {
        console.log("[SYNTH] Requesting global parameters from controller");
        dataChannel.value.send(JSON.stringify({
          type: "request_global_params",
          clientId: id.value,
          timestamp: Date.now(),
        }));
        addLog("Requested global parameters from controller");
      } catch (error) {
        console.error("[SYNTH] Error requesting global parameters:", error);
      }
    }
  };

  // Send a message to the controller
  const sendMessage = () => {
    if (!dataChannel.value || dataChannel.value.readyState !== "open") {
      addLog("Data channel not open");
      return;
    }

    dataChannel.value.send(message.value);
    addLog(`Sent: ${message.value}`);
    message.value = "";
  };

  // Initialize when component mounts
  useEffect(() => {
    console.log("[SYNTH] Component mounted");

    // Request a client ID
    (async () => {
      const success = await requestClientId();
      if (success) {
        // Connect to WebSocket signaling server after getting ID
        await connectWebSocket();
      }
    })();

    // Add event listener for visibility change to handle browser tab switching
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Cleanup on unmount
    return () => {
      cleanupConnection();

      // Close WebSocket
      if (socket.value) {
        socket.value.close();
        socket.value = null;
      }

      // Clean up audio
      if (oscillator) {
        try {
          oscillator.stop();
        } catch (e) {
          // Ignore errors when stopping already stopped oscillator
        }
      }

      // Stop intervals
      if (heartbeatInterval.value !== null) {
        clearInterval(heartbeatInterval.value);
      }

      if (reconnectAttemptInterval.value !== null) {
        clearInterval(reconnectAttemptInterval.value);
      }

      // Remove visibility change listener
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  // Handle browser tab visibility changes
  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      console.log("[SYNTH] Tab is now visible, checking connection");

      // If WebSocket is closed/closing but we think it's connected, reconnect
      if (
        socket.value &&
        (socket.value.readyState === WebSocket.CLOSED ||
          socket.value.readyState === WebSocket.CLOSING) &&
        wsConnected.value
      ) {
        console.log("[SYNTH] WebSocket appears disconnected, reconnecting");
        wsConnected.value = false;
        connectWebSocket();
      }

      // Check if WebRTC connection is still healthy
      if (
        connected.value && !connectionHealthy.value && activeController.value
      ) {
        console.log(
          "[SYNTH] Connection unhealthy after visibility change, attempting reconnection",
        );
        attemptReconnection();
      }
    }
  };

  return (
    <div class="container">
      <h1>WebRTC Synth</h1>

      <div class="control-section">
        <div class="id-section">
          <p>
            Your Client ID:{" "}
            <span class="client-id">{id.value || "Loading..."}</span>
          </p>

          {/* Controller info */}
          <div class="controller-info">
            <p>
              Active Controller: {activeController.value
                ? (
                  <span class="active-controller">
                    {activeController.value}
                  </span>
                )
                : <span class="no-controller">None</span>}
            </p>

            <div class="connection-status">
              {connected.value
                ? (
                  <span class="status-connected">
                    Connected to {connectedControllerId.value}
                    {connectionHealthy.value ? " (Healthy)" : " (Unstable)"}
                  </span>
                )
                : <span class="status-disconnected">Disconnected</span>}
            </div>
          </div>
        </div>

        {/* Connection and chat sections removed for cleaner interface */}

        <div class="audio-controls">
          <h3>Audio Controls</h3>

          {/* Initial audio button */}
          {showAudioButton.value && (
            <button onClick={initAudio} class="audio-button">
              Enable Audio
            </button>
          )}

          {/* Resume audio button (when suspended) */}
          {(!showAudioButton.value && showResumeAudioButton.value) && (
            <button onClick={resumeAudio} class="audio-button">
              Resume Audio
            </button>
          )}

          {/* Audio status display */}
          {!showAudioButton.value && (
            <div class="audio-status">
              <p>
                Audio Context: {audioContext
                  ? (
                    <span
                      class={audioState.value === "running"
                        ? "audio-enabled"
                        : "audio-suspended"}
                    >
                      {audioState.value}
                    </span>
                  )
                  : <span class="audio-disabled">Not initialized</span>}
              </p>

              <p>
                Note: {gainNode && gainNode.gain.value > 0
                  ? <span class="audio-enabled">Playing</span>
                  : <span class="audio-note-off">Silent</span>}
              </p>

              <div class="audio-buttons">
                <button
                  onClick={initAudio}
                  disabled={audioEnabled.value}
                  class="audio-control-button"
                >
                  Initialize Audio
                </button>
                {audioContext && audioContext.state === "suspended" && (
                  <button
                    onClick={resumeAudio}
                    class="audio-control-button"
                  >
                    Resume Audio
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div class="status-section">
        <div class="connection-info">
          <h3>Connection Info</h3>

          {/* WebSocket status */}
          <div class="ws-status">
            <span
              class={`status-indicator ${
                wsConnected.value ? "connected" : "disconnected"
              }`}
            >
              Signaling Server: {wsConnected.value
                ? "Connected"
                : (wsReconnecting.value ? "Reconnecting..." : "Disconnected")}
            </span>

            {!wsConnected.value && (
              <button
                onClick={connectWebSocket}
                disabled={wsReconnecting.value}
                class="reconnect-button"
              >
                Connect
              </button>
            )}
          </div>

          {/* WebRTC status */}
          <div class="rtc-status">
            <span
              class={`status-indicator ${
                connected.value
                  ? (connectionHealthy.value ? "healthy" : "unhealthy")
                  : "disconnected"
              }`}
            >
              WebRTC: {connected.value
                ? (connectionHealthy.value
                  ? "Connected"
                  : "Connected (Unstable)")
                : "Disconnected"}
            </span>

            {activeController.value && !connected.value && (
              <button
                onClick={attemptReconnection}
                class="reconnect-button"
              >
                Reconnect
              </button>
            )}
          </div>

          {/* ICE state */}
          <div class="ice-status">
            <span class="status-detail">
              ICE State: {iceConnectionState.value}
            </span>
          </div>
        </div>
      </div>

      <div class="log-section">
        <h3>Log</h3>
        <div class="log">
          {logs.value.map((log, index) => (
            <div key={index} class="log-entry">
              {log}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
