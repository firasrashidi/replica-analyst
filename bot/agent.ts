import { defineAgent } from "@grok/agent-sdk";

export default defineAgent({
  model: {
    id: "grok-4.7",
    params: [
      { id: "reasoning_effort", value: "high" },
      { id: "fast", value: "true" },
    ],
  },
  // No shell and no file tools, so the chat cannot read host credentials
  // or open its own database connection. query_replica is the only path.
  tools: [],
  hosting: {
    secretNames: ["ANALYST_REPLICA_URL"],
  },
});
