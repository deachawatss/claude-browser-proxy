// Ask the bridge a question and wait for its own answer.
//
// Do NOT use the retained `claude/browser/status` topic to decide whether the
// bridge is alive. Measured 2026-08-31: it published `"subscribed": false` for
// 100 seconds straight while answering every command, because a repeat
// subscribe in mqtt.js returns `granted: []` and background.js reads an empty
// array as failure. A flag can be wrong. A round trip cannot.
import mqtt from 'mqtt';

const BROKER = process.env.MQTT_URL || 'ws://localhost:9001';
const TOPICS = {
  command: 'claude/browser/command',
  response: 'claude/browser/response',
};

/**
 * Publish `get_url` and resolve with the matching response, or null on timeout.
 * The id is unique per call, so a retained or stale message can never pass for
 * a live answer.
 */
export async function probeBridge({ timeoutMs = 8000, broker = BROKER } = {}) {
  const id = `probe-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const client = mqtt.connect(broker, {
    clientId: `bridge-probe-${Math.random().toString(16).slice(2, 8)}`,
    clean: true,
    connectTimeout: Math.min(timeoutMs, 5000),
    reconnectPeriod: 0,
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end(true, () => resolve(value));
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    client.on('error', () => finish(null));
    client.on('connect', () => {
      client.subscribe(TOPICS.response, { qos: 1 }, (err) => {
        if (err) return finish(null);
        client.publish(
          TOPICS.command,
          JSON.stringify({ id, action: 'get_url', ts: Date.now() }),
          { qos: 1 },
        );
      });
    });
    client.on('message', (topic, payload) => {
      let msg;
      try {
        msg = JSON.parse(payload.toString());
      } catch {
        return; // not ours
      }
      if (msg.id === id) finish(msg);
    });
  });
}

// Run directly: `node bridge-probe.mjs` -> prints the answer, exits 0 if alive.
if (import.meta.url === `file://${process.argv[1]}`) {
  const answer = await probeBridge();
  if (answer) {
    console.log('bridge ALIVE:', JSON.stringify(answer));
    process.exit(0);
  }
  console.log('bridge SILENT (no answer within the timeout)');
  process.exit(1);
}
