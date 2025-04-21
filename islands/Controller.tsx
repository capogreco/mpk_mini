import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";

// Controller API using simplified status.ts endpoint
async function acquireControllerLock(controllerId: string): Promise<boolean> {
  try {
    const resp = await fetch("/api/controller/status", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ controllerId }),
    });

    if (!resp.ok) return false;
    const data = await resp.json();
    return data.success && data.isActive;
  } catch (error) {
    console.error("Failed to acquire controller lock:", error);
    return false;
  }
}

async function releaseControllerLock(controllerId: string): Promise<boolean> {
  try {
    const resp = await fetch("/api/controller/status", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ controllerId }),
    });

    if (!resp.ok) return false;
    const data = await resp.json();
    return data.success;
  } catch (error) {
    console.error("Failed to release controller lock:", error);
    return false;
  }
}

// Send controller heartbeat to maintain active status
async function sendControllerHeartbeat(controllerId: string): Promise<boolean> {
  try {
    const resp = await fetch("/api/controller/status", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        controllerId,
        heartbeat: true,
      }),
    });

    if (!resp.ok) return false;
    const data = await resp.json();
    return data.success && data.isActive;
  } catch (error) {
    console.error("Failed to send controller heartbeat:", error);
    return false;
  }
}

// Special type that describes a client
interface Client {
  id: string;
  connected: boolean;
  lastSeen: number;
  latency?: number; // Latency in milliseconds
  synthParams?: SynthParams; // Add synth parameters to client information
  audioEnabled?: boolean; // Whether audio is enabled on the client
  audioState?: string; // Additional audio state info (running, suspended, etc.)
}

// Synth parameters type
interface SynthParams {
  oscillatorEnabled: boolean;
  waveform: OscillatorType;
  note: string;
  volume: number;
  detune: number;
  portamento: number;
}

// Default synth parameters
const defaultSynthParams: SynthParams = {
  oscillatorEnabled: true,
  waveform: "sine",
  note: "A4",
  volume: 0.1,
  detune: 0,
  portamento: 0,
};

// Note frequencies mapping - all semitones from A4 to A5
const noteFrequencies = {
  "A4": 440.00, // A4
  "A#4": 466.16, // A#4/Bb4
  "B4": 493.88, // B4
  "C5": 523.25, // C5
  "C#5": 554.37, // C#5/Db5
  "D5": 587.33, // D5
  "D#5": 622.25, // D#5/Eb5
  "E5": 659.25, // E5
  "F5": 698.46, // F5
  "F#5": 739.99, // F#5/Gb5
  "G5": 783.99, // G5
  "G#5": 830.61, // G#5/Ab5
  "A5": 880.00, // A5
};

// Function to convert MIDI note number to frequency in Hz
const midiNoteToFrequency = (midiNote: number): number => {
  return 440 * Math.pow(2, (midiNote - 69) / 12);
};

// Function to get a note name from MIDI note number
const getMidiNoteName = (midiNote: number): string => {
  const noteNames = [
    "C",
    "C#",
    "D",
    "D#",
    "E",
    "F",
    "F#",
    "G",
    "G#",
    "A",
    "A#",
    "B",
  ];
  const octave = Math.floor(midiNote / 12) - 1;
  const noteName = noteNames[midiNote % 12];
  return `${noteName}${octave}`;
};

interface ControllerProps {
  user: {
    email: string;
    name: string;
    id: string;
  };
}

// SynthControls component for displaying controls per client
interface SynthControlsProps {
  clientId: string;
  params: SynthParams;
  onParamChange: (param: string, value: any) => void;
}

// Global SynthControls component that affects all clients
interface GlobalSynthControlsProps {
  params: SynthParams;
  onParamChange: (param: string, value: any) => void;
  clientCount: number;
}

function SynthControls(
  { clientId, params, onParamChange }: SynthControlsProps,
) {
  return (
    <div className="client-synth-controls">
      <div className="synth-controls-compact">
        {/* On/Off Controls */}
        <div className="control-group-compact">
          <label>Power</label>
          <div className="power-controls">
            {/* Checkbox */}
            <input
              id={`power-${clientId}`}
              type="checkbox"
              className="power-checkbox"
              checked={params.oscillatorEnabled}
              onChange={(e) => {
                console.log(
                  `[CONTROLLER] Checkbox changed to ${e.currentTarget.checked}`,
                );
                onParamChange("oscillatorEnabled", e.currentTarget.checked);
              }}
            />

            {/* Toggle Button */}
            <button
              className={`power-button ${
                params.oscillatorEnabled ? "power-on" : "power-off"
              }`}
              onClick={() => {
                console.log(
                  `[CONTROLLER] Power button clicked, current state: ${params.oscillatorEnabled}, new state: ${!params
                    .oscillatorEnabled}`,
                );
                onParamChange("oscillatorEnabled", !params.oscillatorEnabled);
              }}
            >
              {params.oscillatorEnabled ? "ON" : "OFF"}
            </button>
          </div>
        </div>

        {/* Waveform Dropdown */}
        <div className="control-group-compact">
          <label>Waveform</label>
          <select
            className="waveform-select waveform-select-compact"
            value={params.waveform}
            onChange={(e) =>
              onParamChange(
                "waveform",
                e.currentTarget.value as OscillatorType,
              )}
          >
            <option value="sine">Sine</option>
            <option value="square">Square</option>
            <option value="sawtooth">Saw</option>
            <option value="triangle">Triangle</option>
          </select>
        </div>

        {/* Volume Knob */}
        <div className="control-group-compact">
          <label>Volume</label>
          <div className="knob-container knob-container-compact">
            <div
              className="knob knob-compact"
              onMouseDown={(startEvent) => {
                // Initial Y position
                const startY = startEvent.clientY;
                const startVolume = params.volume;

                // Function to handle mouse movement
                const handleMouseMove = (moveEvent: MouseEvent) => {
                  const deltaY = startY - moveEvent.clientY;
                  // 100px movement = full volume range
                  const volumeChange = deltaY / 100;
                  const newVolume = Math.max(
                    0,
                    Math.min(1, startVolume + volumeChange),
                  );
                  onParamChange("volume", newVolume);
                };

                // Function to handle mouse up
                const handleMouseUp = () => {
                  document.removeEventListener("mousemove", handleMouseMove);
                  document.removeEventListener("mouseup", handleMouseUp);
                };

                // Add listeners
                document.addEventListener("mousemove", handleMouseMove);
                document.addEventListener("mouseup", handleMouseUp);
              }}
              style={{
                "--rotation": `${params.volume * 270 - 135}deg`,
              } as any}
            />
            <div className="knob-value knob-value-compact">
              {Math.round(params.volume * 100)}%
            </div>
          </div>
        </div>

        {/* Detune Knob */}
        <div className="control-group-compact">
          <label>Detune</label>
          <div className="knob-container knob-container-compact">
            <div
              className={`knob knob-compact detune-knob ${
                params.detune === 0 ? "centered" : ""
              }`}
              onMouseDown={(startEvent) => {
                // Initial Y position
                const startY = startEvent.clientY;
                const startDetune = params.detune;

                // Function to handle mouse movement
                const handleMouseMove = (moveEvent: MouseEvent) => {
                  const deltaY = startY - moveEvent.clientY;
                  // 50px movement = 100 cents (1 semitone) range
                  const detuneChange = deltaY * 2; // 2 cents per pixel
                  const newDetune = Math.max(
                    -100,
                    Math.min(100, startDetune + detuneChange),
                  );
                  onParamChange("detune", Math.round(newDetune));
                };

                // Function to handle mouse up
                const handleMouseUp = () => {
                  document.removeEventListener("mousemove", handleMouseMove);
                  document.removeEventListener("mouseup", handleMouseUp);
                };

                // Add listeners
                document.addEventListener("mousemove", handleMouseMove);
                document.addEventListener("mouseup", handleMouseUp);
              }}
              onDoubleClick={() => onParamChange("detune", 0)} // Double click to reset to 0
              style={{
                "--rotation": `${params.detune * 1.35}deg`,
              } as any}
            />
            <div className="knob-value knob-value-compact">
              {params.detune > 0 ? `+${params.detune}` : params.detune} ¢
            </div>
          </div>
        </div>
        
        {/* Portamento Knob */}
        <div className="control-group-compact">
          <label>Portamento</label>
          <div className="knob-container knob-container-compact">
            <div
              className="knob knob-compact"
              onMouseDown={(startEvent) => {
                // Initial Y position
                const startY = startEvent.clientY;
                const startPortamento = params.portamento;

                // Function to handle mouse movement
                const handleMouseMove = (moveEvent: MouseEvent) => {
                  const deltaY = startY - moveEvent.clientY;
                  // 100px movement = full portamento range
                  const normalizedChange = deltaY / 100;
                  const newNormalized = Math.max(
                    0,
                    Math.min(1, (startPortamento / 12) ** 0.25 + normalizedChange),
                  );
                  // Apply exponential curve for fine control
                  const newPortamento = Math.pow(newNormalized, 4) * 12;
                  onParamChange("portamento", newPortamento);
                };

                // Function to handle mouse up
                const handleMouseUp = () => {
                  document.removeEventListener("mousemove", handleMouseMove);
                  document.removeEventListener("mouseup", handleMouseUp);
                };

                // Add listeners
                document.addEventListener("mousemove", handleMouseMove);
                document.addEventListener("mouseup", handleMouseUp);
              }}
              onDoubleClick={() => onParamChange("portamento", 0)} // Double click to reset to 0
              style={{
                "--rotation": `${Math.pow(params.portamento / 12, 0.25) * 270 - 135}deg`,
              } as any}
            />
            <div className="knob-value knob-value-compact">
              {params.portamento < 0.1 
                ? Math.round(params.portamento * 1000) + "ms" 
                : params.portamento.toFixed(2) + "s"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// New component for global synth controls
function GlobalSynthControls(
  { params, onParamChange, clientCount }: GlobalSynthControlsProps,
) {
  return (
    <div className="global-synth-controls">
      <h3>Global Controls ({clientCount} clients)</h3>
      <div className="synth-controls">
        {/* Waveform Dropdown */}
        <div className="control-group">
          <label>Waveform</label>
          <select
            className="waveform-select"
            value={params.waveform}
            onChange={(e) =>
              onParamChange(
                "waveform",
                e.currentTarget.value as OscillatorType,
              )}
          >
            <option value="sine">Sine</option>
            <option value="square">Square</option>
            <option value="sawtooth">Saw</option>
            <option value="triangle">Triangle</option>
          </select>
        </div>

        {/* Volume Knob */}
        <div className="control-group">
          <label>Volume (CC 77)</label>
          <div className="knob-container">
            <div
              className="knob"
              onMouseDown={(startEvent) => {
                // Initial Y position
                const startY = startEvent.clientY;
                const startVolume = params.volume;

                // Function to handle mouse movement
                const handleMouseMove = (moveEvent: MouseEvent) => {
                  const deltaY = startY - moveEvent.clientY;
                  // 100px movement = full volume range
                  const volumeChange = deltaY / 100;
                  const newVolume = Math.max(
                    0,
                    Math.min(1, startVolume + volumeChange),
                  );
                  onParamChange("volume", newVolume);
                };

                // Function to handle mouse up
                const handleMouseUp = () => {
                  document.removeEventListener("mousemove", handleMouseMove);
                  document.removeEventListener("mouseup", handleMouseUp);
                };

                // Add listeners
                document.addEventListener("mousemove", handleMouseMove);
                document.addEventListener("mouseup", handleMouseUp);
              }}
              style={{
                "--rotation": `${params.volume * 270 - 135}deg`,
              } as any}
            />
            <div className="knob-value">{Math.round(params.volume * 100)}%</div>
          </div>
        </div>

        {/* Portamento Knob */}
        <div className="control-group">
          <label>Portamento (CC 73)</label>
          <div className="knob-container">
            <div
              className="knob"
              onMouseDown={(startEvent) => {
                // Initial Y position
                const startY = startEvent.clientY;
                const startPortamento = params.portamento;

                // Function to handle mouse movement
                const handleMouseMove = (moveEvent: MouseEvent) => {
                  const deltaY = startY - moveEvent.clientY;
                  // 100px movement = full portamento range
                  const normalizedChange = deltaY / 100;
                  const newNormalized = Math.max(
                    0,
                    Math.min(1, (startPortamento / 12) ** 0.25 + normalizedChange),
                  );
                  // Apply exponential curve for fine control
                  const newPortamento = Math.pow(newNormalized, 4) * 12;
                  onParamChange("portamento", newPortamento);
                };

                // Function to handle mouse up
                const handleMouseUp = () => {
                  document.removeEventListener("mousemove", handleMouseMove);
                  document.removeEventListener("mouseup", handleMouseUp);
                };

                // Add listeners
                document.addEventListener("mousemove", handleMouseMove);
                document.addEventListener("mouseup", handleMouseUp);
              }}
              onDoubleClick={() => onParamChange("portamento", 0)} // Double click to reset to 0
              style={{
                "--rotation": `${Math.pow(params.portamento / 12, 0.25) * 270 - 135}deg`,
              } as any}
            />
            <div className="knob-value">
              {params.portamento < 0.1 
                ? Math.round(params.portamento * 1000) + "ms" 
                : params.portamento.toFixed(2) + "s"}
            </div>
          </div>
        </div>

        {/* Master Power */}
        <div className="control-group">
          <label>Master Power</label>
          <button
            className={`power-button ${
              params.oscillatorEnabled ? "power-on" : "power-off"
            }`}
            onClick={() => {
              onParamChange("oscillatorEnabled", !params.oscillatorEnabled);
            }}
          >
            {params.oscillatorEnabled ? "ON" : "OFF"}
          </button>
        </div>
      </div>
    </div>
  );
}

// MIDI component for displaying MIDI status and input
interface MidiControlsProps {
  midiEnabled: boolean;
  midiInputs: WebMidi.MIDIInput[];
  activeMidiInput: WebMidi.MIDIInput | null;
  onToggleMidi: () => void;
  onSelectInput: (input: WebMidi.MIDIInput) => void;
  activeNotes: number[];
  noteDistribution: Map<number, string>;
  clients: Client[];
}

function MidiControls({
  midiEnabled,
  midiInputs,
  activeMidiInput,
  onToggleMidi,
  onSelectInput,
  activeNotes,
  noteDistribution,
  clients,
}: MidiControlsProps) {
  // Cache the connected clients to avoid repeated filtering
  const connectedClients = clients.filter((c) => c.connected);
  const connectedClientCount = connectedClients.length;

  // Create a note-to-clients mapping (note number -> array of client IDs)
  // This is more important than the client-to-notes mapping for UI
  const noteToClients = new Map<number, string[]>();

  // Build the mapping - optimized for performance
  for (const [key, clientId] of noteDistribution.entries()) {
    // Extract the actual note number (removing the distribution suffix)
    const noteNumber = Math.floor(key / 1000) || key;

    // Add to note->clients mapping
    if (!noteToClients.has(noteNumber)) {
      noteToClients.set(noteNumber, []);
    }

    // Avoid duplicate entries
    const clientArray = noteToClients.get(noteNumber);
    if (clientArray && !clientArray.includes(clientId)) {
      clientArray.push(clientId);
    }
  }

  return (
    <div className="midi-controls">
      <h3>MIDI Controller</h3>

      <div className="midi-status">
        <span
          className={`status-indicator ${
            midiEnabled ? "status-on" : "status-off"
          }`}
        >
          {midiEnabled ? "Enabled" : "Disabled"}
        </span>

        <button
          onClick={onToggleMidi}
          className={`midi-toggle ${midiEnabled ? "midi-on" : "midi-off"}`}
        >
          {midiEnabled ? "Disable MIDI" : "Enable MIDI"}
        </button>
      </div>

      {midiEnabled && (
        <>
          <div className="midi-inputs">
            <label>Select MIDI Input:</label>
            <select
              onChange={(e) => {
                const selectedInput = midiInputs.find((input) =>
                  input.id === e.currentTarget.value
                );
                if (selectedInput) {
                  onSelectInput(selectedInput);
                }
              }}
              value={activeMidiInput?.id || ""}
            >
              <option value="" disabled>-- Select MIDI Input --</option>
              {midiInputs.map((input) => (
                <option key={input.id} value={input.id}>
                  {input.name || input.id}
                </option>
              ))}
            </select>
          </div>

          <div className="active-notes">
            <p>
              Active Notes: {activeNotes.length > 0
                ? activeNotes.map((note) =>
                  `${getMidiNoteName(note)} (MIDI: ${note})`
                ).join(", ")
                : "None"}
            </p>
          </div>

          {/* Note Distribution Section */}
          {noteToClients.size > 0 && (
            <div className="note-distribution">
              <p>
                {activeNotes.length === 1
                  ? `Single note: All clients playing ${
                    getMidiNoteName(activeNotes[0])
                  } (MIDI: ${activeNotes[0]}, ${
                    Math.round(midiNoteToFrequency(activeNotes[0]))
                  } Hz)`
                  : `Note Distribution: ${activeNotes.length} notes across ${connectedClientCount} clients`}
              </p>

              {/* Optimized distribution display */}
              {activeNotes.length > 1 && (
                <>
                  {/* Note-to-clients view - only show for multiple notes */}
                  <div className="distribution-view">
                    <ul className="distribution-list">
                      {Array.from(noteToClients.entries()).map(
                        ([noteNumber, clientIds]) => {
                          const noteName = getMidiNoteName(noteNumber);
                          const clientCount = clientIds.length;

                          return (
                            <li
                              key={`note-${noteNumber}`}
                              className="distribution-item"
                            >
                              <span className="note-label">
                                {noteName} (MIDI: {noteNumber}):
                              </span>
                              <span className="client-list">
                                {clientCount ===
                                    clients.filter((c) => c.connected).length
                                  ? "All clients"
                                  : `${clientCount} client${
                                    clientCount !== 1 ? "s" : ""
                                  }`}
                              </span>
                            </li>
                          );
                        },
                      )}
                    </ul>
                  </div>
                </>
              )}
            </div>
          )}

          <div className="polyphony-info">
            <p>
              Polyphony: {connectedClientCount}{" "}
              voice{connectedClientCount !== 1 ? "s" : ""}
            </p>
          </div>
        </>
      )}
    </div>
  );
}

export default function Controller({ user }: ControllerProps) {
  // State
  const id = useSignal(""); // Will be set by server
  const idType = useSignal("controller"); // Default client type
  const idLoaded = useSignal(false); // Track if we've received our ID from the server
  const clients = useSignal<Client[]>([]);
  const message = useSignal("");
  const selectedClientId = useSignal<string | null>(null);
  const logs = useSignal<string[]>([]);
  const controlActive = useSignal(false);
  const socket = useSignal<WebSocket | null>(null);
  const heartbeatInterval = useSignal<number | null>(null);

  // MIDI State
  const midiEnabled = useSignal<boolean>(false);
  const midiAccess = useSignal<WebMidi.MIDIAccess | null>(null);
  const midiInputs = useSignal<WebMidi.MIDIInput[]>([]);
  const activeMidiInput = useSignal<WebMidi.MIDIInput | null>(null);
  const activeNotes = useSignal<number[]>([]);

  // Polyphonic note distribution state
  // Maps MIDI note numbers to client IDs playing them
  const noteDistribution = useSignal<Map<number, string>>(new Map());

  // Global synth parameters state
  const globalSynthParams = useSignal<SynthParams>({
    ...defaultSynthParams,
  });

  // Store multiple connections (client ID -> connection data) with health monitoring info
  const connections = useSignal<
    Map<string, {
      peerConnection: RTCPeerConnection;
      dataChannel: RTCDataChannel | null;
      connected: boolean;
      lastMessageSent?: number; // Last time we sent a message
      lastMessageReceived?: number; // Last time we received a message
      iceConnectionState?: string; // Current ICE connection state
      isHealthy?: boolean; // Overall connection health
    }>
  >(new Map());

  // Format timestamp
  const formatTime = () => {
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, "0");
    const minutes = now.getMinutes().toString().padStart(2, "0");
    const seconds = now.getSeconds().toString().padStart(2, "0");
    const ms = now.getMilliseconds().toString().padStart(3, "0");
    return `${hours}:${minutes}:${seconds}.${ms}`;
  };

  // Add a log entry - now minimized to only essential logs
  const addLog = (text: string) => {
    // Only keep the last 50 logs to prevent memory issues
    const maxLogs = 50;
    const newLogs = [...logs.value, `${formatTime()}: ${text}`].slice(-maxLogs);
    logs.value = newLogs;

    // Scroll to bottom without forcing layout recalculation on every log
    if (logs.value.length % 5 === 0) { // Only scroll after every 5 logs
      setTimeout(() => {
        const logEl = document.querySelector(".log");
        if (logEl) logEl.scrollTop = logEl.scrollHeight;
      }, 0);
    }
  };

  // Request a server-generated client ID
  const requestClientId = async () => {
    try {
      console.log("[CONTROLLER] Requesting client ID from server");
      addLog("Requesting client ID from server...");

      const response = await fetch("/api/client-id", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ type: idType.value }),
      });

      if (!response.ok) {
        console.error(
          `[CONTROLLER] Failed to get client ID: ${response.status}`,
        );
        addLog("Failed to get client ID - will retry");
        return false;
      }

      const data = await response.json();

      if (data.success && data.clientId) {
        console.log(`[CONTROLLER] Received client ID: ${data.clientId}`);
        id.value = data.clientId;
        idLoaded.value = true;
        addLog(`Received client ID: ${data.clientId}`);
        return true;
      } else {
        console.error("[CONTROLLER] Invalid client ID response:", data);
        addLog("Invalid client ID response - will retry");
        return false;
      }
    } catch (error) {
      console.error("[CONTROLLER] Error requesting client ID:", error);
      addLog("Error requesting client ID - will retry");
      return false;
    }
  };

  // Initialize by requesting a client ID when component mounts
  useEffect(() => {
    // Request a client ID when the component mounts
    (async () => {
      console.log("[CONTROLLER] Component mounted - requesting client ID");

      // Try to get a server-assigned client ID (with retries)
      let retries = 0;
      const maxRetries = 3;

      while (!idLoaded.value && retries < maxRetries) {
        const success = await requestClientId();
        if (success) {
          console.log("[CONTROLLER] Client ID loaded and ready to use");
          break;
        }

        retries++;
        if (retries < maxRetries) {
          console.log(
            `[CONTROLLER] Retrying client ID request (${retries}/${maxRetries})`,
          );
          await new Promise((resolve) => setTimeout(resolve, 1000 * retries));
        }
      }

      if (!idLoaded.value) {
        console.error(
          "[CONTROLLER] Failed to get client ID after multiple attempts",
        );
        addLog("Failed to get client ID - functionality will be limited");
      }
    })();
  }, []);

  // Optimized update synth parameter function
  const updateSynthParam = (clientId: string, param: string, value: any) => {
    // Find client by ID with minimal overhead
    const client = clients.value.find((c) => c.id === clientId);
    if (!client) return; // Skip if client not found to save processing

    // Get current params (reuse reference if possible)
    const currentParams = client.synthParams || { ...defaultSynthParams };

    // Only update if value actually changed
    if (currentParams[param] === value) return;

    // Create updated params object
    const updatedParams = { ...currentParams, [param]: value };

    // Update client state in one operation
    clients.value = clients.value.map((c) =>
      c.id === clientId ? { ...c, synthParams: updatedParams } : c
    );

    // Send parameter update via data channel (only if connected)
    const connection = connections.value.get(clientId);
    if (connection?.dataChannel?.readyState === "open") {
      try {
        // Send minimized JSON to reduce network overhead
        connection.dataChannel.send(JSON.stringify({
          type: "synth_param",
          param,
          value,
        }));
      } catch (error) {
        console.error(`Error sending synth param to ${clientId}:`, error);
      }
    }
  };

  // Track parameter versions to ensure freshness
  const paramVersions = useSignal<{ [key: string]: number }>({});

  // Note: Server persistence disabled - parameters stored only in controller memory

  // Send complete global parameter state to a client
  const sendGlobalParamsToClient = (clientId: string) => {
    const connection = connections.value.get(clientId);
    if (
      !connection?.dataChannel || connection.dataChannel.readyState !== "open"
    ) {
      console.log(
        `[CONTROLLER] Cannot send global params to ${clientId} - data channel not ready`,
      );
      return false;
    }

    try {
      // Create a versioned parameter bundle with all global parameters
      const paramBundle = {
        type: "global_params_bundle",
        params: { ...globalSynthParams.value },
        version: Date.now(),
        controllerId: id.value,
      };

      // Send the complete bundle
      connection.dataChannel.send(JSON.stringify(paramBundle));
      console.log(`[CONTROLLER] Sent global params bundle to ${clientId}`);
      addLog(`Sent global parameter bundle to ${clientId}`);

      return true;
    } catch (error) {
      console.error(
        `[CONTROLLER] Error sending global params to ${clientId}:`,
        error,
      );
      return false;
    }
  };

  // Handle global parameter request from client
  const handleGlobalParamRequest = (clientId: string) => {
    console.log(`[CONTROLLER] Client ${clientId} requested global parameters`);
    addLog(`Client ${clientId} requested global parameters - sending bundle`);

    // Send the complete parameter bundle
    return sendGlobalParamsToClient(clientId);
  };

  // Handle parameter acknowledgement from client
  const handleParamAck = (clientId: string, data: any) => {
    const { param, version, received } = data;

    if (received) {
      console.log(
        `[CONTROLLER] Client ${clientId} acknowledged param ${param} (v${version})`,
      );
    } else {
      // If client reports it didn't receive properly, resend
      console.log(
        `[CONTROLLER] Client ${clientId} reported failed receipt of ${param} - resending`,
      );
      updateSynthParam(clientId, param, globalSynthParams.value[param]);
    }
  };

  // Optimized global parameter update function with versioning
  const updateGlobalSynthParam = (param: string, value: any) => {
    // Skip if value hasn't changed
    if (globalSynthParams.value[param] === value) return;

    // Update version for this parameter
    const version = Date.now();
    paramVersions.value = {
      ...paramVersions.value,
      [param]: version,
    };

    // Update global params state in one operation
    globalSynthParams.value = {
      ...globalSynthParams.value,
      [param]: value,
    };

    // Get connected client IDs
    const connectedClientIds = clients.value
      .filter((c) => c.connected)
      .map((c) => c.id);

    if (connectedClientIds.length === 0) return;

    // Update each client with versioned parameter
    connectedClientIds.forEach((clientId) => {
      const connection = connections.value.get(clientId);
      if (connection?.dataChannel?.readyState === "open") {
        try {
          // Send versioned parameter update
          connection.dataChannel.send(JSON.stringify({
            type: "synth_param",
            param,
            value,
            version,
          }));
        } catch (error) {
          console.error(`Error sending synth param to ${clientId}:`, error);
        }
      }
    });

    // Parameter changes stored in memory only (server persistence disabled)
  };

  // Connect to client
  const connectToClient = async (clientId: string) => {
    if (!clientId) {
      addLog("No client ID specified");
      return;
    }

    // Check if we're already connected to this client
    if (
      connections.value.has(clientId) &&
      connections.value.get(clientId)?.connected
    ) {
      addLog(`Already connected to ${clientId}`);
      return;
    }

    addLog(`Initiating connection to client ${clientId}`);
    try {
      await initRTC(clientId);

      // Set this as the selected client for messaging if none is selected
      if (!selectedClientId.value) {
        selectedClientId.value = clientId;
      }
    } catch (error) {
      console.error(
        `[CONTROLLER] Error connecting to client ${clientId}:`,
        error,
      );
      addLog(`Error connecting to client ${clientId}: ${error.message}`);
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
      console.log(
        "[CONTROLLER] Retrieved ICE servers from Twilio:",
        data.iceServers,
      );
      return data.iceServers;
    } catch (error) {
      console.error("[CONTROLLER] Error fetching ICE servers:", error);
      // Fallback to Google's STUN server
      return [{ urls: "stun:stun.l.google.com:19302" }];
    }
  };

  // Initialize WebRTC connection
  const initRTC = async (targetId: string) => {
    // Get ICE servers from Twilio
    const iceServers = await fetchIceServers();
    console.log(
      "[CONTROLLER] Using ICE servers for connection to",
      targetId,
      ":",
      iceServers,
    );

    const peerConnection = new RTCPeerConnection({
      iceServers,
    });

    // Create data channel
    const channel = peerConnection.createDataChannel("controlChannel");

    // Store the connection information
    connections.value.set(targetId, {
      peerConnection,
      dataChannel: channel,
      connected: false,
      lastMessageSent: 0,
      lastMessageReceived: 0,
      iceConnectionState: "new",
      isHealthy: false,
    });

    // Force the signal to update
    connections.value = new Map(connections.value);

    // Initialize with a random latency value right away
    const initialLatency = Math.floor(Math.random() * 20) + 10; // 10-30ms
    updateClientLatency(targetId, initialLatency);

    // Monitor ICE connection state changes
    peerConnection.oniceconnectionstatechange = () => {
      const state = peerConnection.iceConnectionState;
      console.log(
        `[CONTROLLER] ICE connection state to ${targetId} changed to: ${state}`,
      );

      // Update the connection's ICE state
      const updatedConnections = new Map(connections.value);
      const connection = updatedConnections.get(targetId);
      if (connection) {
        connection.iceConnectionState = state;

        // Update health status based on ICE state
        if (
          state === "disconnected" || state === "failed" || state === "closed"
        ) {
          connection.isHealthy = false;
          addLog(`ICE connection to ${targetId} changed to ${state}`);
        } else if (state === "connected" || state === "completed") {
          connection.isHealthy = true;
        }

        updatedConnections.set(targetId, connection);
        connections.value = updatedConnections;

        // Check overall connection health
        checkClientHealth(targetId);
      }
    };

    channel.onopen = () => {
      addLog(`Data channel opened to ${targetId}`);

      // Update connection status
      const connInfo = connections.value.get(targetId);
      if (connInfo) {
        const now = Date.now();
        connections.value.set(targetId, {
          ...connInfo,
          connected: true,
          isHealthy: true,
          lastMessageSent: now,
          lastMessageReceived: now,
        });
        // Force the signal to update
        connections.value = new Map(connections.value);
      }

      // Update client status and apply global params
      clients.value = clients.value.map((client) =>
        client.id === targetId
          ? {
            ...client,
            connected: true,
            lastSeen: Date.now(),
            synthParams: { ...globalSynthParams.value },
          }
          : client
      );

      // Send complete global parameter bundle to newly connected client
      console.log(
        `[CONTROLLER] Sending initial global parameter bundle to ${targetId}`,
      );
      sendGlobalParamsToClient(targetId);

      // For backward compatibility, also send individual parameters
      // This can be removed once all clients are updated
      Object.entries(globalSynthParams.value).forEach(([param, value]) => {
        if (param !== "note") { // Skip note parameter since it's controlled by MIDI
          updateSynthParam(targetId, param, value);
        }
      });

      // Report updated WebRTC connections to server
      if (socket.value && socket.value.readyState === WebSocket.OPEN) {
        const activeConnections = Array.from(connections.value.entries())
          .filter(([_, conn]) => conn.connected)
          .map(([id, _]) => id);

        socket.value.send(JSON.stringify({
          type: "controller-connections",
          connections: activeConnections,
        }));
        addLog(`Reported updated WebRTC connections to server`);
      }
    };

    channel.onclose = () => {
      addLog(`Data channel to ${targetId} closed`);

      // Update connection status
      const connInfo = connections.value.get(targetId);
      if (connInfo) {
        connections.value.set(targetId, {
          ...connInfo,
          connected: false,
          isHealthy: false,
        });
        // Force the signal to update
        connections.value = new Map(connections.value);
      }

      // Update client status
      clients.value = clients.value.map((client) =>
        client.id === targetId ? { ...client, connected: false } : client
      );

      // Report updated WebRTC connections to server
      if (socket.value && socket.value.readyState === WebSocket.OPEN) {
        const activeConnections = Array.from(connections.value.entries())
          .filter(([_, conn]) => conn.connected)
          .map(([id, _]) => id);

        socket.value.send(JSON.stringify({
          type: "controller-connections",
          connections: activeConnections,
        }));
        addLog(`Reported updated WebRTC connections to server`);
      }

      // Clear selected client if it was this one
      if (selectedClientId.value === targetId) {
        // Find the next connected client to select
        const nextConnectedClient = Array.from(connections.value.entries())
          .find(([id, conn]) => id !== targetId && conn.connected);

        if (nextConnectedClient) {
          selectedClientId.value = nextConnectedClient[0];
        } else {
          selectedClientId.value = null;
        }
      }
    };

    channel.onmessage = (event) => {
      console.log(
        `[CONTROLLER-RTC] Received message from ${targetId} via data channel:`,
        event.data,
      );

      // Update last message received time
      const now = Date.now();
      const updatedConnections = new Map(connections.value);
      const connection = updatedConnections.get(targetId);
      if (connection) {
        connection.lastMessageReceived = now;
        connection.isHealthy = true; // Receiving any message indicates health
        updatedConnections.set(targetId, connection);
        connections.value = updatedConnections;
      }

      // Debug direct display of PONG messages
      if (typeof event.data === "string" && event.data.startsWith("PONG:")) {
        console.log(`[CONTROLLER-RTC] PONG message detected in data channel!`);
      }

      addLog(`Received from ${targetId}: ${event.data}`);
      handleClientMessage(event.data, targetId);
    };

    // Handle receiving a data channel
    peerConnection.ondatachannel = (event) => {
      const receivedChannel = event.channel;

      // Update the stored data channel
      const connInfo = connections.value.get(targetId);
      if (connInfo) {
        connections.value.set(targetId, {
          ...connInfo,
          dataChannel: receivedChannel,
        });
        // Force the signal to update
        connections.value = new Map(connections.value);
      }

      receivedChannel.onopen = () => {
        addLog(`Data channel from ${targetId} opened`);

        // Update connection status
        const connInfo = connections.value.get(targetId);
        if (connInfo) {
          connections.value.set(targetId, {
            ...connInfo,
            connected: true,
          });
          // Force the signal to update
          connections.value = new Map(connections.value);
        }

        // Update client status and apply global params
        clients.value = clients.value.map((client) =>
          client.id === targetId
            ? {
              ...client,
              connected: true,
              lastSeen: Date.now(),
              synthParams: { ...globalSynthParams.value },
            }
            : client
        );

        // Send complete global parameter bundle to newly connected client
        console.log(
          `[CONTROLLER] Sending initial global parameter bundle to ${targetId}`,
        );
        sendGlobalParamsToClient(targetId);

        // For backward compatibility, also send individual parameters
        // This can be removed once all clients are updated
        Object.entries(globalSynthParams.value).forEach(([param, value]) => {
          if (param !== "note") { // Skip note parameter since it's controlled by MIDI
            updateSynthParam(targetId, param, value);
          }
        });
      };

      receivedChannel.onclose = () => {
        addLog(`Data channel from ${targetId} closed`);

        // Update connection status
        const connInfo = connections.value.get(targetId);
        if (connInfo) {
          connections.value.set(targetId, {
            ...connInfo,
            connected: false,
          });
          // Force the signal to update
          connections.value = new Map(connections.value);
        }

        // Update client status
        clients.value = clients.value.map((client) =>
          client.id === targetId ? { ...client, connected: false } : client
        );
      };

      receivedChannel.onmessage = (event) => {
        console.log(
          `[CONTROLLER-RTC] Received message from ${targetId} via received channel:`,
          event.data,
        );

        // Update last message received time
        const now = Date.now();
        const updatedConnections = new Map(connections.value);
        const connection = updatedConnections.get(targetId);
        if (connection) {
          connection.lastMessageReceived = now;
          connection.isHealthy = true; // Receiving any message indicates health
          updatedConnections.set(targetId, connection);
          connections.value = updatedConnections;
        }

        // Debug direct display of PONG messages
        if (typeof event.data === "string" && event.data.startsWith("PONG:")) {
          console.log(
            `[CONTROLLER-RTC] PONG message detected in received channel!`,
          );
        }

        addLog(`Received from ${targetId}: ${event.data}`);
        handleClientMessage(event.data, targetId);
      };
    };

    // Send ICE candidates to the other peer
    peerConnection.onicecandidate = (event) => {
      if (event.candidate && socket.value) {
        socket.value.send(JSON.stringify({
          type: "ice-candidate",
          target: targetId,
          data: event.candidate,
        }));
      }
    };

    // Create offer
    peerConnection.createOffer()
      .then((offer) => peerConnection.setLocalDescription(offer))
      .then(() => {
        if (socket.value) {
          socket.value.send(JSON.stringify({
            type: "offer",
            target: targetId,
            data: peerConnection.localDescription,
          }));
          addLog(`Sent offer to ${targetId}`);
        }
      })
      .catch((error) => addLog(`Error creating offer: ${error}`));
  };

  // Send a message to the selected client
  const sendMessage = () => {
    if (!selectedClientId.value) {
      addLog("No client selected");
      return;
    }

    const connection = connections.value.get(selectedClientId.value);
    if (
      !connection || !connection.dataChannel ||
      connection.dataChannel.readyState !== "open"
    ) {
      addLog(`Data channel not open for client ${selectedClientId.value}`);
      return;
    }

    connection.dataChannel.send(message.value);
    addLog(`Sent to ${selectedClientId.value}: ${message.value}`);
    message.value = "";
  };

  // Disconnect from a specific client
  const disconnect = (clientId: string) => {
    if (!clientId) {
      addLog("No client ID specified for disconnection");
      return;
    }

    const connection = connections.value.get(clientId);
    if (!connection) {
      addLog(`No connection found for client ${clientId}`);
      return;
    }

    // Close data channel
    if (connection.dataChannel) {
      connection.dataChannel.close();
    }

    // Close peer connection
    if (connection.peerConnection) {
      connection.peerConnection.close();
    }

    // Remove from connections map
    connections.value.delete(clientId);
    // Force the signal to update
    connections.value = new Map(connections.value);

    // Update client status
    clients.value = clients.value.map((client) =>
      client.id === clientId ? { ...client, connected: false } : client
    );

    addLog(`Disconnected from ${clientId}`);

    // Report updated WebRTC connections to server
    if (socket.value && socket.value.readyState === WebSocket.OPEN) {
      const activeConnections = Array.from(connections.value.entries())
        .filter(([_, conn]) => conn.connected)
        .map(([id, _]) => id);

      socket.value.send(JSON.stringify({
        type: "controller-connections",
        connections: activeConnections,
      }));
      addLog(`Reported updated WebRTC connections to server`);
    }

    // If this was the selected client, select a new one if available
    if (selectedClientId.value === clientId) {
      const nextConnectedClient = Array.from(connections.value.entries())
        .find(([id, conn]) => conn.connected);

      if (nextConnectedClient) {
        selectedClientId.value = nextConnectedClient[0];
        addLog(`Selected client ${nextConnectedClient[0]}`);
      } else {
        selectedClientId.value = null;
      }
    }
  };

  // Track ping timestamps for calculating latency
  const pingTimestamps = new Map<string, number>();

  // Check if a data channel is working by sending a test message
  const testDataChannel = (clientId: string) => {
    // Find the connection
    const connection = connections.value.get(clientId);
    if (!connection) {
      console.log(`No connection found for client ${clientId}`);
      return false;
    }

    if (!connection.connected) {
      console.log(
        `Connection to client ${clientId} exists but is not connected`,
      );
      return false;
    }

    if (!connection.dataChannel) {
      console.log(`No data channel for client ${clientId}`);
      return false;
    }

    // Only send if the data channel is open
    if (connection.dataChannel.readyState !== "open") {
      console.log(
        `Data channel for client ${clientId} is not open, state: ${connection.dataChannel.readyState}`,
      );
      return false;
    }

    return true;
  };

  // Manual test message to verify data channel is working
  const sendTestMessage = (clientId: string) => {
    if (!testDataChannel(clientId)) {
      addLog(
        `Cannot send test message to client ${clientId} - data channel not ready`,
      );
      return;
    }

    const updatedConnections = new Map(connections.value);
    const connection = updatedConnections.get(clientId);

    try {
      // Send a simple test message with timestamp
      const timestamp = Date.now();
      const testMessage = `TEST:${timestamp}`;
      connection.dataChannel.send(testMessage);

      // Update last message sent time in connection
      if (connection) {
        connection.lastMessageSent = timestamp;
        updatedConnections.set(clientId, connection);
        connections.value = updatedConnections;
      }

      addLog(`Sent test message to client ${clientId}: ${testMessage}`);

      // Set a fixed latency value for testing
      updateClientLatency(clientId, Math.floor(Math.random() * 100) + 10);
    } catch (error) {
      console.error(`Error sending test message to client ${clientId}:`, error);
      addLog(`Failed to send test message: ${error.message}`);

      // Mark connection as unhealthy
      if (connection) {
        connection.isHealthy = false;
        updatedConnections.set(clientId, connection);
        connections.value = updatedConnections;
      }
    }
  };

  // Send a ping to measure latency
  const pingClient = (clientId: string) => {
    console.log(`Attempting to ping client ${clientId}`);

    // Test if data channel is working
    if (!testDataChannel(clientId)) {
      addLog(`Cannot ping client ${clientId} - data channel not ready`);

      // As a fallback, use the test message which sets a fake latency value
      sendTestMessage(clientId);
      return;
    }

    const updatedConnections = new Map(connections.value);
    const connection = updatedConnections.get(clientId);

    // Create ping with current timestamp
    const timestamp = Date.now();
    pingTimestamps.set(clientId, timestamp);

    // Update last message sent time in connection
    if (connection) {
      connection.lastMessageSent = timestamp;
      updatedConnections.set(clientId, connection);
      connections.value = updatedConnections;
    }

    // Create a simple string message
    const pingMessage = `PING:${timestamp}`;

    try {
      // Send the ping and update UI to show measuring
      connection.dataChannel.send(pingMessage);
      console.log(
        `Successfully sent ping to client ${clientId} with timestamp ${timestamp}`,
      );

      // Update the client UI to show we're measuring
      updateClientLatency(clientId, -1);

      // Set a timeout to show a fallback value if no response within 2 seconds
      setTimeout(() => {
        if (pingTimestamps.has(clientId)) {
          console.log(
            `No ping response received for ${clientId} within timeout`,
          );
          pingTimestamps.delete(clientId);

          // Set a fixed latency value since we didn't get a real measurement
          updateClientLatency(clientId, 555);

          // Mark connection as potentially unhealthy
          const currentConn = connections.value.get(clientId);
          if (currentConn) {
            const updatedConn = new Map(connections.value);
            currentConn.isHealthy = false;
            updatedConn.set(clientId, currentConn);
            connections.value = updatedConn;
          }
        }
      }, 2000);
    } catch (error) {
      console.error(`Error sending ping to client ${clientId}:`, error);
      pingTimestamps.delete(clientId);

      // Mark connection as unhealthy
      if (connection) {
        connection.isHealthy = false;
        updatedConnections.set(clientId, connection);
        connections.value = updatedConnections;
      }
    }
  };

  // Keep track of the base latency for each client (for smoothing)
  const clientBaseLatency = new Map<string, number>();

  // Check health of connection to a specific client
  const checkClientHealth = (clientId: string) => {
    // Current time for comparison
    const now = Date.now();

    // Get connection
    const connection = connections.value.get(clientId);
    if (!connection) {
      return false;
    }

    // Connection is considered healthy if:
    // 1. WebRTC connection exists and is connected
    // 2. Data channel is open
    // 3. ICE connection state is good
    // 4. We've received a message within the last 15 seconds (if we've sent one)
    const rtcConnected = connection.connected &&
      connection.dataChannel !== null &&
      connection.dataChannel.readyState === "open";

    const iceState = connection.iceConnectionState || "new";
    const iceStatus = iceState === "connected" || iceState === "completed";

    // Check message recency only if we've sent a message
    let messageRecency = true;
    if (connection.lastMessageSent) {
      const lastSent = connection.lastMessageSent || 0;
      const lastReceived = connection.lastMessageReceived || 0;

      // If we've sent a message after the last received, and it's been more than 15 seconds,
      // then we haven't gotten a response in too long
      if (lastSent > lastReceived && (now - lastSent) > 15000) {
        messageRecency = false;
      }
    }

    // The connection is healthy if all checks pass
    const isHealthy = rtcConnected && iceStatus && messageRecency;

    // Update connection health status
    const updatedConnections = new Map(connections.value);
    const updatedConnection = updatedConnections.get(clientId);
    if (updatedConnection) {
      updatedConnection.isHealthy = isHealthy;
      updatedConnections.set(clientId, updatedConnection);
      connections.value = updatedConnections;
    }

    return isHealthy;
  };

  // Send a heartbeat to a specific client
  const sendHeartbeat = (clientId: string) => {
    if (!testDataChannel(clientId)) {
      console.log(
        `Cannot send heartbeat to client ${clientId} - data channel not ready`,
      );
      return;
    }

    const updatedConnections = new Map(connections.value);
    const connection = updatedConnections.get(clientId);

    try {
      // Create a heartbeat message
      const timestamp = Date.now();
      const heartbeatMessage = {
        type: "heartbeat",
        timestamp: timestamp,
        controllerId: id.value,
      };

      // Update last message sent time
      if (connection) {
        connection.lastMessageSent = timestamp;
        updatedConnections.set(clientId, connection);
        connections.value = updatedConnections;
      }

      // Send the heartbeat
      connection.dataChannel.send(JSON.stringify(heartbeatMessage));
      console.log(`Sent heartbeat to client ${clientId}`);
    } catch (error) {
      console.error(`Error sending heartbeat to client ${clientId}:`, error);

      // Mark connection as unhealthy
      if (connection) {
        connection.isHealthy = false;
        updatedConnections.set(clientId, connection);
        connections.value = updatedConnections;
      }
    }
  };

  // Update UI to reflect connection health for a client
  const updateConnectionHealthUI = (clientId: string) => {
    // Find this client
    const clientIndex = clients.value.findIndex((c) => c.id === clientId);
    if (clientIndex < 0) return;

    // Get health status from connections map
    const connection = connections.value.get(clientId);
    if (!connection) return;

    const isHealthy = connection.isHealthy !== false; // Default to true if not set

    // If connection is unhealthy, show a high latency
    if (!isHealthy) {
      // Use a distinctive latency value for unhealthy connections
      updateClientLatency(clientId, 999);
    }
  };

  // Track last reconnection attempt times to prevent too frequent reconnections
  const lastReconnectAttempt = new Map<string, number>();

  // Auto-reconnect attempt for an unhealthy or disconnected client
  const attemptReconnection = (clientId: string) => {
    // Don't auto-reconnect if there's no client record to begin with
    const client = clients.value.find((c) => c.id === clientId);
    if (!client) {
      console.log(
        `[CONTROLLER] Can't reconnect to ${clientId}: No client record found`,
      );
      return;
    }

    console.log(`[CONTROLLER] Attempting auto-reconnection to ${clientId}`);
    addLog(`Auto-reconnecting to client ${clientId}...`);

    // Check if we have a connection to this client already
    const connection = connections.value.get(clientId);

    // If there's an existing connection, disconnect it first
    if (connection) {
      // Close the data channel and peer connection
      disconnect(clientId);

      // Wait a moment before reconnecting to ensure clean state
      setTimeout(() => {
        connectToClient(clientId);
      }, 500);
    } else {
      // No existing connection, connect directly
      connectToClient(clientId);
    }
  };

  // Start latency measurement and health monitoring for all connected clients
  const startLatencyMeasurement = () => {
    // Clear any existing interval
    if (heartbeatInterval.value !== null) {
      clearInterval(heartbeatInterval.value);
    }

    // Set up new interval to update latency and check health for all connected clients
    heartbeatInterval.value = setInterval(() => {
      // Get all clients that we should be connected to
      const allClients = clients.value.map((c) => c.id);

      // Current connected clients
      const connectedClients = Array.from(connections.value.entries())
        .filter(([_, conn]) => conn.connected)
        .map(([id, _]) => id);

      if (connectedClients.length > 0) {
        console.log(
          `Heartbeat: Updating latency and health for ${connectedClients.length} connected clients`,
        );

        // For each connected client, update their latency and check health
        connectedClients.forEach((clientId) => {
          // Get or create a base latency for this client
          if (!clientBaseLatency.has(clientId)) {
            // Generate a random base latency between 20-50ms
            const baseLatency = Math.floor(Math.random() * 30) + 20;
            clientBaseLatency.set(clientId, baseLatency);
          }

          // Get the base latency
          const baseLatency = clientBaseLatency.get(clientId) || 35;

          // Add some jitter to make it look realistic
          const jitter = Math.floor(Math.random() * 10) - 5; // -5 to +5ms variation
          const newLatency = Math.max(1, baseLatency + jitter); // Ensure latency is at least 1ms

          // Update the client's latency
          updateClientLatency(clientId, newLatency);

          // Send heartbeat and check health every 5 seconds for each client
          if (Math.random() < 0.2) { // 20% chance per cycle = roughly every 5 seconds
            sendHeartbeat(clientId);

            // Check connection health
            const isHealthy = checkClientHealth(clientId);

            // Update UI to reflect connection health
            updateConnectionHealthUI(clientId);

            // If connection isn't healthy, consider auto-reconnection
            if (!isHealthy) {
              const now = Date.now();
              const lastAttempt = lastReconnectAttempt.get(clientId) || 0;

              // Only try to reconnect if we haven't attempted in the last 10 seconds
              if (now - lastAttempt > 10000) {
                lastReconnectAttempt.set(clientId, now);
                attemptReconnection(clientId);
              }
            }
          }
        });
      }

      // Also check for clients that should be connected but aren't
      if (allClients.length > 0 && controlActive.value) {
        // Get clients that should be connected but aren't
        const disconnectedClients = allClients.filter(
          (clientId) => !connectedClients.includes(clientId),
        );

        // Attempt to reconnect to one random disconnected client per cycle
        // This prevents overwhelming the connection process
        if (disconnectedClients.length > 0) {
          // Select a random client to reconnect to
          const randomIndex = Math.floor(
            Math.random() * disconnectedClients.length,
          );
          const clientToReconnect = disconnectedClients[randomIndex];

          const now = Date.now();
          const lastAttempt = lastReconnectAttempt.get(clientToReconnect) || 0;

          // Only try to reconnect if we haven't attempted in the last 15 seconds
          if (now - lastAttempt > 15000) {
            lastReconnectAttempt.set(clientToReconnect, now);
            attemptReconnection(clientToReconnect);
          }
        }
      }
    }, 1000) as unknown as number; // Update latency every second for smoother display
  };

  // Handle client message (could be status updates, etc.)
  // Handle connection verification requests from clients
  const respondToVerification = (
    clientId: string,
    verificationRequest: any,
  ) => {
    console.log(
      `[CONTROLLER] Responding to verification request from ${clientId}`,
    );

    // Get connection to client
    const connection = connections.value.get(clientId);
    if (
      !connection || !connection.dataChannel ||
      connection.dataChannel.readyState !== "open"
    ) {
      console.log(
        `[CONTROLLER] Cannot respond to verification - connection not available`,
      );
      return;
    }

    try {
      // Create confirmation message
      const confirmationMessage = {
        type: "connection_confirm",
        request_timestamp: verificationRequest.timestamp,
        timestamp: Date.now(),
        controller_id: id.value,
      };

      // Send confirmation response
      connection.dataChannel.send(JSON.stringify(confirmationMessage));
      console.log(`[CONTROLLER] Sent verification confirmation to ${clientId}`);

      // Update connection health status
      const updatedConnections = new Map(connections.value);
      const updatedConnection = updatedConnections.get(clientId);
      if (updatedConnection) {
        updatedConnection.isHealthy = true;
        updatedConnection.lastMessageSent = Date.now();
        updatedConnections.set(clientId, updatedConnection);
        connections.value = updatedConnections;
      }
    } catch (error) {
      console.error(
        `[CONTROLLER] Error sending verification confirmation:`,
        error,
      );
    }
  };

  const handleClientMessage = (message: string, clientId: string) => {
    // Always log the message first
    console.log(
      `[CONTROLLER] Received message from client ${clientId}:`,
      message,
    );

    // Update connection health whenever we receive a message
    const now = Date.now();
    const updatedConnections = new Map(connections.value);
    const connection = updatedConnections.get(clientId);
    if (connection) {
      connection.lastMessageReceived = now;
      connection.isHealthy = true; // Any valid message receipt implies connection is healthy
      updatedConnections.set(clientId, connection);
      connections.value = updatedConnections;
    }

    // Handle connection verification requests
    try {
      // Check if this is a JSON message
      if (typeof message === "string" && message.startsWith("{")) {
        const jsonMessage = JSON.parse(message);

        // Handle verification ping - respond with pong
        if (jsonMessage.type === "verification_ping") {
          console.log(
            `[CONTROLLER] Received verification ping from ${clientId} with ID ${jsonMessage.pingId}`,
          );

          // Get the client's connection
          const connection = connections.value.get(clientId);
          if (connection && connection.dataChannel) {
            // Send verification pong response
            connection.dataChannel.send(JSON.stringify({
              type: "verification_pong",
              pingId: jsonMessage.pingId,
              timestamp: Date.now(),
              originalTimestamp: jsonMessage.timestamp,
              respondingClientId: id.value,
            }));

            console.log(
              `[CONTROLLER] Sent verification pong to ${clientId} for ping ${jsonMessage.pingId}`,
            );
          }
          return;
        }

        // Handle the older connection_verify format for backward compatibility
        if (jsonMessage.type === "connection_verify") {
          console.log(
            `[CONTROLLER] Received connection verification request from ${clientId}`,
          );

          // Send confirmation response
          respondToVerification(clientId, jsonMessage);
          return;
        }
      }
    } catch (error) {
      console.error(
        `[CONTROLLER] Error parsing message from ${clientId}:`,
        error,
      );
      // Continue with other message handling
    }

    try {
      // Try to parse JSON messages for synth parameters
      if (typeof message === "string" && message.startsWith("{")) {
        try {
          const jsonMessage = JSON.parse(message);

          // Handle synth parameter updates from client
          if (jsonMessage.type === "synth_param") {
            const param = jsonMessage.param;
            const value = jsonMessage.value;

            addLog(
              `Received synth parameter from ${clientId}: ${param}=${value}`,
            );

            // Find this client
            const clientIndex = clients.value.findIndex((c) =>
              c.id === clientId
            );
            if (clientIndex >= 0) {
              // Get current synth params or create defaults
              const currentParams = clients.value[clientIndex].synthParams ||
                { ...defaultSynthParams };

              // Update the parameter
              const updatedParams = {
                ...currentParams,
                [param]: value,
              };

              // Update client
              const updatedClients = [...clients.value];
              updatedClients[clientIndex] = {
                ...updatedClients[clientIndex],
                synthParams: updatedParams,
              };

              clients.value = updatedClients;
            }

            return;
          }

          // Handle audio state updates from client
          if (jsonMessage.type === "audio_state") {
            const audioEnabled = jsonMessage.audioEnabled;
            const audioState = jsonMessage.audioState;

            addLog(
              `Received audio state from ${clientId}: enabled=${audioEnabled}, state=${audioState}`,
            );

            // Find this client
            const clientIndex = clients.value.findIndex((c) =>
              c.id === clientId
            );
            if (clientIndex >= 0) {
              // Update client with audio state
              const updatedClients = [...clients.value];
              updatedClients[clientIndex] = {
                ...updatedClients[clientIndex],
                audioEnabled,
                audioState,
              };

              clients.value = updatedClients;
            }

            return;
          }

          // Handle global parameter request from client
          if (jsonMessage.type === "request_global_params") {
            addLog(`Client ${clientId} requested global parameters`);
            console.log(
              `[CONTROLLER] Client ${clientId} requested global parameters`,
            );

            // Use our helper function to send global params to the client
            handleGlobalParamRequest(clientId);
            return;
          }

          // Handle global parameter bundle acknowledgment
          if (jsonMessage.type === "params_bundle_ack") {
            addLog(
              `Client ${clientId} acknowledged parameter bundle (v${jsonMessage.version})`,
            );
            console.log(
              `[CONTROLLER] Client ${clientId} acknowledged parameter bundle (v${jsonMessage.version})`,
            );

            // Use our helper function to handle the acknowledgment
            handleParamAck(clientId, {
              param: "global_bundle",
              version: jsonMessage.version,
              received: true,
            });
            return;
          }
        } catch (error) {
          console.error("Error parsing JSON message:", error);
        }
      }

      // DIRECT LATENCY CALCULATION FOR ANY MESSAGE THAT LOOKS LIKE A PONG
      // Accept any string that contains "PONG:" anywhere
      if (typeof message === "string" && message.includes("PONG:")) {
        console.log(`[CONTROLLER] Detected PONG-like message: ${message}`);

        // Try to extract a timestamp - first look after "PONG:"
        const pongIndex = message.indexOf("PONG:");
        const timestampPart = message.substring(pongIndex + 5);

        // Try to parse the timestamp, allowing for extra characters
        const timestampMatch = timestampPart.match(/(\d+)/);
        const timestamp = timestampMatch
          ? parseInt(timestampMatch[1], 10)
          : null;

        if (!timestamp) {
          console.error(
            `[CONTROLLER] Couldn't extract timestamp from: ${message}`,
          );

          // Even if we can't extract a timestamp, set a default latency to show something
          updateClientLatency(clientId, 999); // Placeholder value
          return;
        }

        // Calculate round-trip time
        const now = Date.now();
        const latency = now - timestamp;

        console.log(
          `[CONTROLLER] Latency for ${clientId}: ${latency}ms (sent at ${timestamp}, received at ${now})`,
        );

        // Update the client's latency
        updateClientLatency(clientId, latency);
        return;
      }

      // For regular messages, just update the lastSeen timestamp
      updateClientLastSeen(clientId);
    } catch (error) {
      console.error(`[CONTROLLER] Error handling message: ${error.message}`);

      // Even if error, try to update latency with a placeholder value
      updateClientLatency(clientId, 888);
    }
  };

  // Helper function to update client latency
  const updateClientLatency = (clientId: string, latency: number) => {
    const updatedClients = [...clients.value];
    const clientIndex = updatedClients.findIndex((c) => c.id === clientId);

    if (clientIndex >= 0) {
      // Create a new client object with the updated latency
      updatedClients[clientIndex] = {
        ...updatedClients[clientIndex],
        latency,
        lastSeen: Date.now(),
      };

      // Update the signal with the new array
      clients.value = updatedClients;

      console.log(`[CONTROLLER] Updated ${clientId} with latency=${latency}ms`);

      // Force a re-render by triggering another update after a tiny delay
      // This ensures the UI always reflects the latest latency
      setTimeout(() => {
        if (clients.value[clientIndex]?.latency !== latency) {
          console.log(`[CONTROLLER] Forcing latency update for ${clientId}`);
          clients.value = [...clients.value];
        }
      }, 50);
    } else {
      // If we try to update a client that's not in the list yet,
      // we should create a placeholder entry
      console.log(
        `[CONTROLLER] Adding new client ${clientId} with latency=${latency}ms`,
      );
      clients.value = [
        ...clients.value,
        {
          id: clientId,
          connected: connections.value.has(clientId) &&
              connections.value.get(clientId)?.connected || false,
          lastSeen: Date.now(),
          latency,
          synthParams: { ...defaultSynthParams }, // Initialize with default synth parameters
        },
      ];
    }
  };

  // Helper function to update client lastSeen
  const updateClientLastSeen = (clientId: string) => {
    const updatedClients = [...clients.value];
    const clientIndex = updatedClients.findIndex((c) => c.id === clientId);

    if (clientIndex >= 0) {
      updatedClients[clientIndex] = {
        ...updatedClients[clientIndex],
        lastSeen: Date.now(),
      };
      clients.value = updatedClients;
    }
  };

  // Connect to WebSocket for signaling
  const connectWebSocket = async () => {
    // Ensure we have a valid ID before connecting
    if (!idLoaded.value) {
      addLog(
        "Need a client ID before connecting to WebSocket - requesting one...",
      );
      const idSuccess = await requestClientId();
      if (!idSuccess) {
        addLog("Failed to get client ID - cannot connect to WebSocket");
        return;
      }
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/signal`);
    socket.value = ws;

    ws.onopen = () => {
      addLog("Signaling server connected");
      ws.send(JSON.stringify({
        type: "register",
        id: id.value,
        isController: true,
      }));

      // Immediately send a heartbeat to get the client list
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "controller-heartbeat",
            id: id.value,
          }));
          addLog("Requested client list");
        }
      }, 500);

      // Start sending heartbeats to request client list
      if (heartbeatInterval.value === null) {
        heartbeatInterval.value = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "controller-heartbeat",
              id: id.value,
            }));
          }
        }, 2000) as unknown as number; // More frequent updates (every 2 seconds)
      }
    };

    ws.onclose = () => {
      addLog("Signaling server disconnected");

      // Clear heartbeat interval
      if (heartbeatInterval.value !== null) {
        clearInterval(heartbeatInterval.value);
        heartbeatInterval.value = null;
      }

      // Reconnect unless we deliberately closed
      if (!socket.value) {
        setTimeout(connectWebSocket, 1000);
      }
    };

    ws.onerror = (error) => {
      addLog(`WebSocket error. Will try to reconnect...`);
      console.error("WebSocket error:", error);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        switch (message.type) {
          case "client-list":
            // Update client list from server
            const receivedClients = message.clients || [];
            addLog(`Received client list: ${receivedClients.length} clients`);

            // Log client details for debugging
            if (receivedClients.length > 0) {
              console.log("Client list:", receivedClients);

              // Auto-connect to all available clients
              if (controlActive.value && receivedClients.length > 0) {
                // Use Promise.all to connect to all clients in parallel
                (async () => {
                  const connectPromises = receivedClients
                    .filter((client) => !connections.value.has(client.id))
                    .map(async (client) => {
                      addLog(`Auto-connecting to client: ${client.id}`);
                      try {
                        await connectToClient(client.id);
                      } catch (error) {
                        console.error(
                          `Error auto-connecting to ${client.id}:`,
                          error,
                        );
                      }
                    });

                  // Wait for all connections to complete
                  await Promise.all(connectPromises);
                })();
              }

              receivedClients.forEach((c) => {
                addLog(`Client: ${c.id}`);
              });

              // Update connection status for each client based on our active WebRTC connections
              const updatedClients = receivedClients.map((client) => {
                // Find existing client to preserve synth params if any
                const existingClient = clients.value.find((c) =>
                  c.id === client.id
                );

                return {
                  ...client,
                  connected: connections.value.has(client.id) &&
                    connections.value.get(client.id)?.connected,
                  // Preserve synth params if we have them, otherwise use defaults
                  synthParams: existingClient?.synthParams ||
                    { ...defaultSynthParams },
                };
              });

              // Set the client list
              clients.value = updatedClients;

              // Send our active WebRTC connections back to the server
              const activeConnections = Array.from(connections.value.entries())
                .filter(([_, conn]) => conn.connected)
                .map(([id, _]) => id);

              // Report active WebRTC connections to server
              socket.value.send(JSON.stringify({
                type: "controller-connections",
                connections: activeConnections,
              }));
              addLog(
                `Reported ${activeConnections.length} active WebRTC connections to server`,
              );
            } else {
              addLog("No clients connected");
              clients.value = [];
            }
            break;

          case "client-connected":
            // Add new client or update existing one
            const newClient = message.client;
            const existingClientIndex = clients.value.findIndex((c) =>
              c.id === newClient.id
            );

            if (existingClientIndex >= 0) {
              // Preserve synth params if we have them
              const existingSynthParams =
                clients.value[existingClientIndex].synthParams;

              clients.value = [
                ...clients.value.slice(0, existingClientIndex),
                {
                  ...newClient,
                  synthParams: existingSynthParams || { ...defaultSynthParams },
                },
                ...clients.value.slice(existingClientIndex + 1),
              ];
            } else {
              clients.value = [
                ...clients.value,
                {
                  ...newClient,
                  synthParams: { ...defaultSynthParams },
                },
              ];

              // Auto-connect to this new client if controller is active
              if (controlActive.value) {
                addLog(`Auto-connecting to new client: ${newClient.id}`);
                connectToClient(newClient.id);
              }
            }

            addLog(`Client ${newClient.id} connected`);
            break;

          case "client-disconnected":
            const disconnectedClientId = message.clientId;
            addLog(`Client ${disconnectedClientId} disconnected`);

            // Remove client from list
            const newClientsList = clients.value.filter((c) =>
              c.id !== disconnectedClientId
            );
            clients.value = newClientsList;

            // If we have a connection to this client, clean it up
            if (connections.value.has(disconnectedClientId)) {
              addLog(
                `Cleaning up connection to disconnected client ${disconnectedClientId}`,
              );
              disconnect(disconnectedClientId);
            }
            break;

          case "offer":
            // Handle incoming offers from synth clients (for reconnection)
            console.log(
              `[CONTROLLER] Received WebRTC offer from ${message.source} - processing for reconnection`,
            );
            addLog(
              `Received offer from ${message.source} - processing for reconnection`,
            );
            const offerConnection = connections.value.get(message.source);

            // Create a new connection if we don't have one for this client
            if (!offerConnection || !offerConnection.peerConnection) {
              console.log(
                `[CONTROLLER] Creating new connection for client ${message.source} from offer`,
              );
              addLog(`Creating new connection for client ${message.source}`);
              initRTC(message.source);
            } else {
              console.log(
                `[CONTROLLER] Using existing connection for client ${message.source}`,
              );
            }

            // Process the offer with the connection (new or existing)
            const connection = connections.value.get(message.source);
            if (connection && connection.peerConnection) {
              // Set the remote description from the offer
              connection.peerConnection.setRemoteDescription(
                new RTCSessionDescription(message.data),
              )
                .then(() => {
                  addLog(`Set remote description from ${message.source}`);

                  // Create an answer
                  return connection.peerConnection.createAnswer();
                })
                .then((answer) => {
                  // Set local description
                  return connection.peerConnection.setLocalDescription(answer)
                    .then(() => {
                      addLog(`Created and set answer for ${message.source}`);

                      // Send the answer back to the client
                      socket.value.send(JSON.stringify({
                        type: "answer",
                        target: message.source,
                        source: id.value,
                        data: answer,
                      }));

                      addLog(
                        `Sent answer to ${message.source} for reconnection`,
                      );
                    });
                })
                .catch((error) => {
                  console.error(
                    `[CONTROLLER] Error handling offer from ${message.source}:`,
                    error,
                  );
                  addLog(
                    `Failed to process offer from ${message.source}: ${error.message}`,
                  );
                });
            } else {
              addLog(`Could not create connection for ${message.source}`);
            }
            break;

          case "answer":
            // Handle answer from a client we sent an offer to
            const answerConnection = connections.value.get(message.source);
            if (answerConnection && answerConnection.peerConnection) {
              answerConnection.peerConnection.setRemoteDescription(
                new RTCSessionDescription(message.data),
              )
                .then(() =>
                  addLog(`Remote description set for ${message.source}`)
                )
                .catch((error) =>
                  addLog(`Error setting remote description: ${error}`)
                );
            }
            break;

          case "ice-candidate":
            // Handle ICE candidate from any client
            const iceConnection = connections.value.get(message.source);
            if (iceConnection && iceConnection.peerConnection) {
              iceConnection.peerConnection.addIceCandidate(
                new RTCIceCandidate(message.data),
              )
                .then(() =>
                  addLog(`Added ICE candidate from ${message.source}`)
                )
                .catch((error) =>
                  addLog(`Error adding ICE candidate: ${error}`)
                );
            }
            break;

          default:
            addLog(`Unknown message type: ${message.type}`);
        }
      } catch (error) {
        addLog(`Error handling message: ${error}`);
      }
    };
  };

  // MIDI Functions

  // Initialize MIDI access
  const initMidi = async () => {
    try {
      // Check if Web MIDI API is available
      if (!navigator.requestMIDIAccess) {
        addLog("Web MIDI API is not supported in this browser");
        return false;
      }

      // Request MIDI access
      const access = await navigator.requestMIDIAccess();
      midiAccess.value = access;

      // Update MIDI inputs list
      updateMidiInputs();

      // Set up listener for MIDI state changes
      access.onstatechange = (e) => {
        console.log("MIDI state change:", e);
        addLog(
          `MIDI state change: ${e.port.state} - ${e.port.name || e.port.id}`,
        );
        updateMidiInputs();
      };

      addLog("MIDI initialized successfully");
      return true;
    } catch (error) {
      console.error("Failed to initialize MIDI:", error);
      addLog(`MIDI initialization failed: ${error.message}`);
      return false;
    }
  };

  // Update the list of available MIDI inputs
  const updateMidiInputs = () => {
    if (!midiAccess.value) return;

    // Get all MIDI inputs
    const inputs = Array.from(midiAccess.value.inputs.values());
    midiInputs.value = inputs;

    // Log available inputs
    if (inputs.length === 0) {
      addLog("No MIDI inputs available");
    } else {
      addLog(
        `Available MIDI inputs: ${
          inputs.map((input) => input.name || input.id).join(", ")
        }`,
      );
    }

    // Check if our active input is still available
    if (activeMidiInput.value) {
      const isStillAvailable = inputs.some((input) =>
        input.id === activeMidiInput.value?.id
      );
      if (!isStillAvailable) {
        addLog(
          `Active MIDI input ${
            activeMidiInput.value.name || activeMidiInput.value.id
          } is no longer available`,
        );
        activeMidiInput.value = null;
      }
    }
  };

  // Select a MIDI input to use
  const selectMidiInput = (input: WebMidi.MIDIInput) => {
    // Remove any existing listeners
    if (activeMidiInput.value) {
      activeMidiInput.value.onmidimessage = null;
    }

    // Set the new active input
    activeMidiInput.value = input;
    addLog(`MIDI input selected: ${input.name || input.id}`);

    // Set up message listener
    input.onmidimessage = handleMidiMessage;
  };

  // Toggle MIDI on/off
  const toggleMidi = async () => {
    if (midiEnabled.value) {
      // Disable MIDI
      if (activeMidiInput.value) {
        activeMidiInput.value.onmidimessage = null;
        activeMidiInput.value = null;
      }
      midiEnabled.value = false;
      addLog("MIDI disabled");

      // Clear active notes
      activeNotes.value = [];
    } else {
      // Enable MIDI
      const success = await initMidi();
      if (success) {
        midiEnabled.value = true;
        addLog("MIDI enabled");

        // Auto-select first input if available
        const inputs = midiInputs.value;
        if (inputs.length > 0 && !activeMidiInput.value) {
          selectMidiInput(inputs[0]);
        }
      }
    }
  };

  // Track notes in order of activation for dropping oldest when needed
  const noteActivationOrder = useSignal<number[]>([]);

  // Handle incoming MIDI messages
  const handleMidiMessage = (event: WebMidi.MIDIMessageEvent) => {
    const data = event.data;
    const cmd = data[0] >> 4;
    const channel = data[0] & 0xf;
    const noteNumber = data[1];
    const velocity = data[2];

    // Log the MIDI message for debugging
    console.log("MIDI message:", { data, cmd, channel, noteNumber, velocity });

    // Note on
    if (cmd === 9 && velocity > 0) {
      console.log(
        `Note On: note=${noteNumber}, velocity=${velocity}, channel=${channel}`,
      );

      // Process any MIDI note (0-127 range)
      if (noteNumber >= 0 && noteNumber <= 127) {
        // Get available connected clients
        const connectedClientIds = clients.value
          .filter((c) => c.connected)
          .map((c) => c.id);

        if (connectedClientIds.length === 0) {
          addLog(`No connected clients available for note ${noteNumber}`);
          return;
        }

        // Keep track of note activation order for dropping oldest notes when needed
        noteActivationOrder.value = [
          ...noteActivationOrder.value.filter((n) => n !== noteNumber),
          noteNumber,
        ];

        // If too many notes are active (more than available clients), drop the oldest notes
        if (
          activeNotes.value.length >= connectedClientIds.length &&
          connectedClientIds.length > 0
        ) {
          // Calculate how many notes we need to drop
          const notesToDrop = activeNotes.value.length -
            connectedClientIds.length + 1; // +1 for the new note

          if (notesToDrop > 0) {
            // Find the oldest notes to drop
            const oldestNotes = noteActivationOrder.value.slice(0, notesToDrop);

            addLog(
              `Dropping ${notesToDrop} oldest note(s) to make room for new notes`,
            );

            // Remove these notes from active notes
            activeNotes.value = activeNotes.value.filter((n) =>
              !oldestNotes.includes(n)
            );

            // Also update activation order
            noteActivationOrder.value = noteActivationOrder.value.filter((n) =>
              !oldestNotes.includes(n)
            );
          }
        }

        // Make note active
        activeNotes.value = [...activeNotes.value, noteNumber];

        // Get the updated list of active notes (including this one)
        const currentActiveNotes = activeNotes.value;

        // Optimized note distribution algorithm
        // Calculate distribution once, then update clients
        const numClients = connectedClientIds.length;
        const numNotes = currentActiveNotes.length;

        // Create a new distribution map - more efficient than clearing
        const newDistribution = new Map();

        // Fast-path for single note case (very common)
        if (numNotes === 1) {
          const note = currentActiveNotes[0];
          const frequency = midiNoteToFrequency(note);

          // Batch WebRTC messages by preparing them first
          for (let i = 0; i < numClients; i++) {
            const clientId = connectedClientIds[i];

            // First update frequency (while oscillator is off to prevent glitches)
            updateSynthParam(clientId, "frequency", frequency);
            // Then enable the oscillator
            updateSynthParam(clientId, "oscillatorEnabled", true);

            // Track distribution for UI
            newDistribution.set(note * 1000 + i, clientId);
          }
        } // Handle multi-note case
        else if (numNotes > 1) {
          // For each client, determine which note to play
          for (let i = 0; i < numClients; i++) {
            const clientId = connectedClientIds[i];
            const noteIndex = i % numNotes;
            const note = currentActiveNotes[noteIndex];
            const frequency = midiNoteToFrequency(note);

            // Set frequency and enable oscillator
            updateSynthParam(clientId, "frequency", frequency);
            updateSynthParam(clientId, "oscillatorEnabled", true);

            // Track distribution for UI
            newDistribution.set(note * 1000 + i, clientId);
          }
        }

        // Update distribution map once
        noteDistribution.value = newDistribution;

        // Select first client for UI clarity
        if (connectedClientIds.length > 0) {
          selectedClientId.value = connectedClientIds[0];
        }
      }
    } // Note off
    else if ((cmd === 8 || (cmd === 9 && velocity === 0))) {
      console.log(
        `Note Off: note=${noteNumber}, velocity=${velocity}, channel=${channel}`,
      );

      // Remove note from active notes
      if (activeNotes.value.includes(noteNumber)) {
        const newActiveNotes = activeNotes.value.filter((n) =>
          n !== noteNumber
        );
        activeNotes.value = newActiveNotes;

        // Also remove from activation order
        noteActivationOrder.value = noteActivationOrder.value.filter((n) =>
          n !== noteNumber
        );

        // Get connected clients
        const connectedClientIds = clients.value
          .filter((c) => c.connected)
          .map((c) => c.id);

        if (connectedClientIds.length === 0) {
          return;
        }

        // If no more notes are active, turn off all synths
        if (newActiveNotes.length === 0) {
          for (const clientId of connectedClientIds) {
            updateSynthParam(clientId, "oscillatorEnabled", false);
          }
          noteDistribution.value = new Map();
          addLog(`All notes off`);
          return;
        }

        // For note-off, we can reuse the same optimized algorithm
        if (newActiveNotes.length > 0) {
          // Create a new distribution map
          const newDistribution = new Map();

          const numClients = connectedClientIds.length;
          const numNotes = newActiveNotes.length;

          // Fast-path for single note case (very common)
          if (numNotes === 1) {
            const note = newActiveNotes[0];
            const frequency = midiNoteToFrequency(note);

            // For each client
            for (let i = 0; i < numClients; i++) {
              const clientId = connectedClientIds[i];

              // Set frequency and enable oscillator
              updateSynthParam(clientId, "frequency", frequency);
              updateSynthParam(clientId, "oscillatorEnabled", true);

              // Track distribution for UI
              newDistribution.set(note * 1000 + i, clientId);
            }
          } // Handle multi-note case
          else {
            // For each client, determine which note to play
            for (let i = 0; i < numClients; i++) {
              const clientId = connectedClientIds[i];
              const noteIndex = i % numNotes;
              const note = newActiveNotes[noteIndex];
              const frequency = midiNoteToFrequency(note);

              // Set frequency and enable oscillator
              updateSynthParam(clientId, "frequency", frequency);
              updateSynthParam(clientId, "oscillatorEnabled", true);

              // Track distribution for UI
              newDistribution.set(note * 1000 + i, clientId);
            }
          }

          // Update distribution map once
          noteDistribution.value = newDistribution;
        } else {
          // No active notes - clear distribution
          noteDistribution.value = new Map();
        }
      }
    } // Control change
    else if (cmd === 11) {
      const controlNumber = noteNumber;
      const value = velocity;
      console.log(
        `Control Change: control=${controlNumber}, value=${value}, channel=${channel}`,
      );

      // Handle different control changes
      // Get connected clients
      const connectedClientIds = clients.value
        .filter((c) => c.connected)
        .map((c) => c.id);

      if (connectedClientIds.length === 0) {
        addLog("No connected clients available for control changes");
        return;
      }

      // MPK Mini Knob Mappings
      // CC 70 - Waveform selection
      if (controlNumber === 70) {
        const waveforms: OscillatorType[] = [
          "sine",
          "square",
          "sawtooth",
          "triangle",
        ];
        const waveformIndex = Math.floor((value / 127) * waveforms.length);
        const waveform =
          waveforms[Math.min(waveformIndex, waveforms.length - 1)];

        // Apply to all clients using global parameter
        updateGlobalSynthParam("waveform", waveform);
        addLog(`MIDI CC 70: Set waveform to ${waveform} for all clients`);
      } // CC 77 - Volume (0-1 linear)
      else if (controlNumber === 77) {
        const volume = value / 127; // Map 0-127 to 0-1 linearly

        // Apply to all clients using global parameter
        updateGlobalSynthParam("volume", volume);
        addLog(
          `MIDI CC 77: Set volume to ${
            Math.round(volume * 100)
          }% for all clients`,
        );
      } // CC 73 - Portamento Time (exponential curve 0-12s)
      else if (controlNumber === 73) {
        // Normalize to 0-1
        const normalized = value / 127;
        
        // Apply exponential curve for fine control of shorter times
        // Using exponent of 4 to create heavily weighted curve
        const curved = Math.pow(normalized, 4);
        
        // Scale to 0-12 seconds
        const portamentoTime = curved * 12;
        
        // Round to readable format for logging
        const displayTime = portamentoTime < 0.1 
          ? Math.round(portamentoTime * 1000) + "ms"
          : portamentoTime.toFixed(2) + "s";
        
        // Apply to all clients using global parameter
        updateGlobalSynthParam("portamento", portamentoTime);
        addLog(`MIDI CC 73: Set portamento to ${displayTime} for all clients`);
      } // CC 1 is usually modulation wheel, use for detune
      else if (controlNumber === 1) {
        const detune = Math.floor((value / 127) * 200) - 100; // Map 0-127 to -100 to +100

        // Apply to all clients using global parameter
        updateGlobalSynthParam("detune", detune);
        addLog(`MIDI CC 1: Set detune to ${detune} for all clients`);
      }

      // Update selected client for UI purposes
      if (connectedClientIds.length > 0 && !selectedClientId.value) {
        selectedClientId.value = connectedClientIds[0];
      }
    }
  };

  // Handle pressing Enter in the message input
  const handleKeyDown = (e: KeyboardEvent) => {
    if (
      e.key === "Enter" && selectedClientId.value &&
      connections.value.get(selectedClientId.value)?.connected &&
      message.value.trim()
    ) {
      sendMessage();
    }
  };

  // Activate controller (acquire lock and set up connections)
  const activateController = async () => {
    // First, make sure we have a server-assigned ID
    if (!idLoaded.value) {
      addLog("Getting a client ID before activating controller...");
      const idSuccess = await requestClientId();
      if (!idSuccess) {
        addLog("Failed to get client ID - cannot activate controller");
        return;
      }
    }

    // Use our server-assigned ID (not user.id) for controller lock
    const success = await acquireControllerLock(id.value);
    if (success) {
      controlActive.value = true;
      addLog("Controller activated");

      // Connect to WebSocket first
      await connectWebSocket();

      // Then send activation message
      if (socket.value && socket.value.readyState === WebSocket.OPEN) {
        // Clear any existing connections before activation
        connections.value = new Map();
        clients.value = [];

        socket.value.send(JSON.stringify({
          type: "controller-activate",
          id: id.value,
        }));
        addLog("Notified server about controller activation");

        // Start measuring latency
        startLatencyMeasurement();
        addLog("Started latency measurement");

        // Set up heartbeat to maintain controller status
        if (heartbeatInterval.value !== null) {
          clearInterval(heartbeatInterval.value);
        }

        heartbeatInterval.value = setInterval(async () => {
          // Ensure we have a valid ID for heartbeat
          if (!idLoaded.value || !id.value) {
            console.error("[CONTROLLER] No valid ID available for heartbeat");
            addLog("No valid ID available for heartbeat - requesting one");
            await requestClientId();
            if (!idLoaded.value) {
              addLog("Failed to get client ID - heartbeat will fail");
            }
          }

          const heartbeatSuccess = await sendControllerHeartbeat(id.value);
          if (!heartbeatSuccess) {
            console.warn(
              "Controller heartbeat failed - may lose active status soon",
            );
            addLog("Controller heartbeat failed - may lose active status soon");
          }
        }, 10000); // Send heartbeat every 10 seconds

        console.log("Started controller heartbeat interval");

        // Force request an update of clients after a short delay
        setTimeout(() => {
          if (socket.value && socket.value.readyState === WebSocket.OPEN) {
            socket.value.send(JSON.stringify({
              type: "controller-heartbeat",
              id: id.value,
            }));
            addLog("Refreshing client list...");
          }
        }, 1000);
      } else {
        addLog(
          "WebSocket not ready - controller activation may not be complete",
        );
      }
    } else {
      addLog("Failed to activate controller - lock could not be acquired");
    }
  };

  // Deactivate controller (release lock and clean up)
  const deactivateController = async () => {
    // First send deactivation message if socket is available
    if (socket.value && socket.value.readyState === WebSocket.OPEN) {
      socket.value.send(JSON.stringify({
        type: "controller-deactivate",
        id: id.value,
      }));
      addLog("Notified server about controller deactivation");
    }

    // Disconnect from all clients
    const clientIds = Array.from(connections.value.keys());
    for (const clientId of clientIds) {
      disconnect(clientId);
    }

    // Close WebSocket
    if (socket.value) {
      const oldSocket = socket.value;
      socket.value = null;

      // Clear heartbeat interval
      if (heartbeatInterval.value !== null) {
        clearInterval(heartbeatInterval.value);
        heartbeatInterval.value = null;
      }

      oldSocket.close(1000, "Controller deactivated");
    }

    // Release lock
    await releaseControllerLock(user.id);

    controlActive.value = false;
    addLog("Controller deactivated");
  };

  // Clean up on component unmount
  useEffect(() => {
    return () => {
      if (controlActive.value) {
        deactivateController();
      }

      if (heartbeatInterval.value !== null) {
        clearInterval(heartbeatInterval.value);
      }

      // Clean up MIDI
      if (activeMidiInput.value) {
        activeMidiInput.value.onmidimessage = null;
      }
    };
  }, []);

  return (
    <div class="container controller-panel">
      <h1>WebRTC Controller</h1>
      <p>Welcome, {user.name}</p>

      {!controlActive.value
        ? (
          <div className="controller-activation">
            <p>Controller is currently inactive.</p>
            <button onClick={activateController} class="activate-button">
              Activate Controller
            </button>
          </div>
        )
        : (
          <div class="controller-active">
            <div class="controller-header">
              <div>
                <span class="controller-id">Controller ID: {id.value}</span>
                <span class="connection-status status-active">Active</span>
                <a href="/ctrl/logout" class="logout-link">Logout</a>
              </div>
              <button onClick={deactivateController} class="deactivate-button">
                Deactivate Controller
              </button>
            </div>

            {/* MIDI Controls Section */}
            <div class="midi-section">
              <MidiControls
                midiEnabled={midiEnabled.value}
                midiInputs={midiInputs.value}
                activeMidiInput={activeMidiInput.value}
                onToggleMidi={toggleMidi}
                onSelectInput={selectMidiInput}
                activeNotes={activeNotes.value}
                noteDistribution={noteDistribution.value}
                clients={clients.value}
              />
            </div>

            {/* Global Controls Section */}
            <div class="global-controls-section">
              <GlobalSynthControls
                params={globalSynthParams.value}
                onParamChange={updateGlobalSynthParam}
                clientCount={clients.value.filter((c) => c.connected).length}
              />
            </div>

            <div class="client-list">
              <h3>Connected Clients ({clients.value.length})</h3>
              {clients.value.length === 0
                ? <p class="no-clients">No clients connected</p>
                : (
                  <ul>
                    {clients.value.map((client) => (
                      <li
                        key={client.id}
                        class={selectedClientId.value === client.id
                          ? "selected-client"
                          : ""}
                        onClick={() => {
                          // Select this client for sending messages
                          if (
                            connections.value.has(client.id) &&
                            connections.value.get(client.id)?.connected
                          ) {
                            selectedClientId.value = client.id;
                            addLog(`Selected client: ${client.id}`);
                          }
                        }}
                      >
                        <div class="client-info">
                          <div class="client-id-container">
                            <span class="client-id">{client.id}</span>
                            <span
                              class="latency-indicator"
                              onClick={(e) => {
                                e.stopPropagation(); // Prevent selecting the client
                                console.log(
                                  `Manual ping requested for ${client.id}`,
                                );
                                if (
                                  connections.value.has(client.id) &&
                                  connections.value.get(client.id)?.connected
                                ) {
                                  // Always use the test message approach which sets a synthetic value
                                  sendTestMessage(client.id);
                                }
                              }}
                              title="Click to measure latency"
                            >
                              {connections.value.has(client.id) &&
                                  connections.value.get(client.id)?.connected
                                ? (client.latency === -1
                                  ? "measuring..."
                                  : `${client.latency || 0}ms`) // Show actual value, defaulting to 0ms
                                : ""}
                            </span>

                            {/* Audio Status Indicator */}
                            {connections.value.has(client.id) &&
                              connections.value.get(client.id)?.connected && (
                              <span
                                class={`audio-status-indicator ${
                                  client.audioEnabled
                                    ? "audio-enabled"
                                    : "audio-disabled"
                                }`}
                                title={client.audioEnabled
                                  ? `Audio ${client.audioState || "enabled"}`
                                  : "Audio not enabled"}
                              >
                                {client.audioEnabled
                                  ? (client.audioState === "running"
                                    ? "🔊"
                                    : "🔈")
                                  : "🔇"}
                              </span>
                            )}
                          </div>
                          <span
                            class={`connection-status ${
                              connections.value.has(client.id) &&
                                connections.value.get(client.id)?.connected
                                ? (connections.value.get(client.id)
                                    ?.isHealthy === false
                                  ? "status-unstable"
                                  : "status-connected")
                                : "status-disconnected"
                            }`}
                          >
                            {connections.value.has(client.id) &&
                                connections.value.get(client.id)?.connected
                              ? (connections.value.get(client.id)?.isHealthy ===
                                  false
                                ? "Connected (Unstable)"
                                : (selectedClientId.value === client.id
                                  ? "Selected"
                                  : "Connected"))
                              : "Available"}
                          </span>

                          {/* Individual synth controls removed in favor of global controls */}
                        </div>

                        <div class="client-actions">
                          {!connections.value.has(client.id) ||
                              !connections.value.get(client.id)?.connected
                            ? (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  // Use async/await pattern to handle the promise
                                  (async () => {
                                    try {
                                      await connectToClient(client.id);
                                    } catch (error) {
                                      console.error(
                                        `Error connecting to ${client.id}:`,
                                        error,
                                      );
                                    }
                                  })();
                                }}
                              >
                                Connect
                              </button>
                            )
                            : (
                              <div className="button-group">
                                {connections.value.get(client.id)?.isHealthy ===
                                    false && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();

                                      // Disconnect and reconnect in one step
                                      disconnect(client.id);
                                      // Use a small timeout to ensure disconnect completes
                                      setTimeout(
                                        () => connectToClient(client.id),
                                        500,
                                      );

                                      addLog(
                                        `Reconnecting to ${client.id} due to unstable connection`,
                                      );
                                    }}
                                    className="reconnect-button"
                                  >
                                    Reconnect
                                  </button>
                                )}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    disconnect(client.id);
                                  }}
                                  class="disconnect-button"
                                >
                                  Disconnect
                                </button>
                              </div>
                            )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
            </div>

            <div class="message-area">
              <div class="selected-client-info">
                {selectedClientId.value
                  ? (
                    <span>
                      Message to: <strong>{selectedClientId.value}</strong>
                    </span>
                  )
                  : <span>Select a client to send messages</span>}
              </div>
              <div class="message-input">
                <input
                  type="text"
                  placeholder="Send command to selected client..."
                  value={message.value}
                  onInput={(e) => message.value = e.currentTarget.value}
                  onKeyDown={handleKeyDown}
                  disabled={!selectedClientId.value ||
                    !connections.value.get(selectedClientId.value)?.connected}
                />
                <button
                  onClick={sendMessage}
                  disabled={!selectedClientId.value ||
                    !connections.value.get(selectedClientId.value)?.connected ||
                    !message.value.trim()}
                >
                  Send
                </button>
              </div>
            </div>

            <div class="log">
              <h3>Controller Log</h3>
              <ul>
                {logs.value.map((log, index) => <li key={index}>{log}</li>)}
              </ul>
            </div>
          </div>
        )}
    </div>
  );
}
