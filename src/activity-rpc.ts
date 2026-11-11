import { Rpc } from "@opencode/plugin/rpc";

/** UI-only diagnostics: never conversation messages or model input. */
export interface ActivityEntry {
  id: string;
  time: number;
  sessionID: string;
  kind: "images" | "budget" | "attachments" | "summary" | "recovery";
  message: string;
}

export interface PayloadStatus {
  bytes: number;
  budget: number;
  time: number;
}

export const FactoryActivity = Rpc.define({
  id: "opencode-factory.activity",
  methods: {
    list: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false },
      output: { type: "object", properties: { entries: { type: "array", items: { type: "object" } }, payload: { type: "object" } }, required: ["entries"] },
    },
  },
  events: {
    updated: {
      schema: {
        type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false,
      },
    },
  },
});
