import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  appendUserMessage,
  classifyBlock,
  createConversation,
  displayTurns,
  handleAssistantResponse,
  summaryBlock,
} from "./conversation.js";
import { createConversationDb } from "./conversation_db.js";
import { createMemoryBackend } from "../../tuning_log_db.js";
import { AI_FILTERS_SCHEMA } from "./conversation_db.js";
import { FILTER_TOOL_NAME } from "./filter_tool.js";
import { AI_FILTERS_SYSTEM_PROMPT } from "./system_prompt.js";

const settings = () => ({
  lpf1: { type: 1, staticHz: 90, dynMinHz: 0, dynMaxHz: 0 },
  lpf2: { type: 0, staticHz: 0 },
  notch1: { hz: 0, cutoff: 0 },
  notch2: { hz: 0, cutoff: 0 },
  dynNotch: { enabled: false, count: 2, q: 25, minHz: 20, maxHz: 120 },
  rpm: { enabled: false, minHz: 20, preset: 0, source: [[], [], []].map(() => new Array(16).fill(0)), center: [[], [], []].map(() => new Array(16).fill(0)), q: [[], [], []].map(() => new Array(16).fill(0)) },
});

const toolUse = (id, input) => ({ type: "tool_use", id, name: FILTER_TOOL_NAME, input });

describe("conversation model", () => {
  test("context blocks round-trip through classifyBlock", () => {
    const b = summaryBlock("peaks: 41.5 Hz", { file: "a.bbl" });
    expect(classifyBlock(b)).toEqual({ kind: "summary", attrs: { file: "a.bbl" }, text: "peaks: 41.5 Hz" });
    expect(classifyBlock({ type: "text", text: "hello" })).toEqual({ kind: "text", text: "hello" });
  });

  test("a valid suggestion becomes a config, its tool result is owed to the next message", () => {
    const record = createConversation({ craftName: "M4" });
    appendUserMessage(record, "Too much noise around 80 Hz", { summary: { text: "S" } });
    expect(record.title).toBe("Too much noise around 80 Hz");
    const r = handleAssistantResponse(
      record,
      {
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: "Lower LPF1." },
          toolUse("tu1", { name: "Step 1", summary: "s", changes: [{ parameter: "gyro_lpf1_static_hz", value: [70], reason: "r" }] }),
        ],
        stop_reason: "tool_use",
      },
      { baseSettings: settings(), costUsd: 0.01, usage: { requests: 1, inputTokens: 10, outputTokens: 5 } },
    );
    expect(r.followUp).toBe(false);
    expect(record.configs).toHaveLength(1);
    expect(record.configs[0].settings.lpf1.staticHz).toBe(70);
    expect(record.pendingToolResults[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu1" });
    // thinking blocks are kept unchanged for the next request
    expect(record.messages[1].content[0]).toEqual({ type: "thinking", thinking: "", signature: "sig" });

    appendUserMessage(record, "applied", {});
    const next = record.messages.at(-1).content;
    expect(next[0].type).toBe("tool_result"); // owed results come first
    expect(next.at(-1)).toEqual({ type: "text", text: "applied" });
    expect(record.pendingToolResults).toEqual([]);

    const turns = displayTurns(record);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(turns[0].chips[0].kind).toBe("summary");
    expect(turns[1].parts.map((p) => p.kind)).toEqual(["text", "config"]);
  });

  test("a rejected suggestion is sent straight back so Claude can fix it", () => {
    const record = createConversation({});
    appendUserMessage(record, "go", {});
    const r = handleAssistantResponse(
      record,
      { content: [toolUse("tu2", { name: "Bad", summary: "", changes: [{ parameter: "dyn_notch_max_hz", value: [900], reason: "" }] })], stop_reason: "tool_use" },
      { baseSettings: settings() },
    );
    expect(r.followUp).toBe(true);
    expect(record.messages.at(-1).role).toBe("user");
    expect(record.messages.at(-1).content[0]).toMatchObject({ type: "tool_result", is_error: true });
    expect(record.configs[0].errors.length).toBeGreaterThan(0);
  });

  test("system prompt names the tool and every parameter", () => {
    expect(AI_FILTERS_SYSTEM_PROMPT).toContain(FILTER_TOOL_NAME);
    expect(AI_FILTERS_SYSTEM_PROMPT).toContain("gyro_rpm_notch_center_yaw");
    expect(AI_FILTERS_SYSTEM_PROMPT).toContain("dyn_notch_q: Dynamic Filter · Notch Q; 10–100");
  });

  test("conversation db lists per craft, newest first", async () => {
    const db = createConversationDb(createMemoryBackend(AI_FILTERS_SCHEMA));
    const a = createConversation({ craftName: "M4", title: "A" });
    a.updatedAt = "2026-01-01";
    const b = createConversation({ craftName: "m4 ", title: "B" });
    b.updatedAt = "2026-02-01";
    const c = createConversation({ craftName: "TRON", title: "C" });
    await db.put(a);
    await db.put(b);
    await db.put(c);
    expect((await db.list("M4")).map((x) => x.title)).toEqual(["B", "A"]);
    expect((await db.get(c.id)).title).toBe("C");
  });
});

describe("AI Filters store with a fake Claude", () => {
  let streams;

  // A stand-in for the SDK's message stream: records handlers and the request params
  function makeStream(params) {
    const handlers = {};
    const stream = {
      params,
      handlers,
      on(event, handler) {
        (handlers[event] ||= []).push(handler);
        return this;
      },
      emit(event, ...args) {
        for (const h of handlers[event] || []) h(...args);
      },
      abort() {
        this.emit("abort");
      },
    };
    streams.push(stream);
    return stream;
  }

  beforeEach(() => {
    streams = [];
    vi.resetModules();
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        constructor() {
          this.beta = { messages: { stream: (params) => makeStream(params) } };
        }
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock("@anthropic-ai/sdk");
  });

  test("send → suggestion card → apply runs Imagine → result goes with the next message", async () => {
    setActivePinia(createPinia());
    const { useSettingsStore } = await import("../../stores/settings.js");
    const { useImagineStore } = await import("../imagine_store.js");
    const { useAiFiltersStore, setConversationDb } = await import("./ai_filters_store.js");
    const conv = await import("./conversation_db.js");
    const tdb = await import("../../tuning_log_db.js");
    setConversationDb(conv.createConversationDb(tdb.createMemoryBackend(conv.AI_FILTERS_SCHEMA)));

    useSettingsStore().userSettings.aiApiKey = "test-key";
    useSettingsStore().userSettings.aiModel = "claude-sonnet-5-5";
    const imagine = useImagineStore();
    // a small synthetic log: 4 s at 500 Hz, a 42 Hz tone plus a little noise
    const n = 2000;
    const tone = (a, f) => Float64Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / 500) + 0.3 * Math.sin(i * 1.7));
    imagine.data = {
      count: n,
      time: Float64Array.from({ length: n }, (_, i) => i * 2000),
      raw: [tone(10, 42), tone(5, 42), tone(2, 42)],
      logged: [tone(1, 42), tone(1, 42), tone(1, 42)],
      headspeed: new Float64Array(n).fill(2520),
      tailspeed: null,
      hasHeadspeed: true,
      hasTailspeed: false,
      motorisedTail: false,
    };
    imagine.rates = { gyroRateHz: 4000, filterRateHz: 2000, pidRateHz: 2000, logRateHz: 500, upsampleRatio: 4 };
    imagine.sysConfig = { "Craft name": "Test heli" };
    imagine.firmware = { status: "match", message: "Rotorflight 4.6.0", version: "4.6.0" };
    imagine.logSettings = settings();
    imagine.applySettings(settings());
    imagine.status = "ready";

    const ai = useAiFiltersStore();
    ai.send("What should I change?");
    expect(streams).toHaveLength(1);
    const req = streams[0].params;
    expect(req.model).toBe("claude-sonnet-5-5");
    expect(req.tools[0].name).toBe(FILTER_TOOL_NAME);
    expect(req.system[0].text).toBe(AI_FILTERS_SYSTEM_PROMPT);
    expect(req.fallbacks).toBe("default");
    expect(req.betas).toContain("server-side-fallback-2026-07-01");
    expect(req.messages[0].content[0].text).toMatch(/^<log_summary file=/);
    expect(req.messages[0].content[0].text).toContain("main rotor ×1");

    streams[0].emit("finalMessage", {
      content: [
        { type: "text", text: "The 42 Hz main rotor peak is strong. Turn on the RPM filter." },
        toolUse("tu1", {
          name: "Step 1: RPM filter on",
          summary: "Notch the main rotor",
          changes: [
            { parameter: "feature_RPM_FILTER", value: [1], reason: "42 Hz peak" },
            { parameter: "gyro_rpm_notch_source_roll", value: [11], reason: "x1" },
            { parameter: "gyro_rpm_notch_q_roll", value: [50], reason: "Q 5" },
          ],
        }),
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 2000, output_tokens: 300 },
    });
    expect(ai.busy).toBe(false);
    const config = ai.current.configs[0];
    expect(config.changes.map((c) => c.parameter)).toEqual(["feature_RPM_FILTER", "gyro_rpm_notch_source_roll", "gyro_rpm_notch_q_roll"]);
    expect(ai.current.costUsd).toBeGreaterThan(0);

    await ai.applyConfig(config.id);
    expect(imagine.settings.rpm.enabled).toBe(true);
    expect(imagine.imagined).not.toBeNull();
    expect(config.result.text).toMatch(/Imagine result for "Step 1: RPM filter on"/);
    expect(ai.configCli(config.id)).toContain("feature RPM_FILTER");

    ai.sendResult(config.id);
    expect(streams).toHaveLength(2);
    const second = streams[1].params.messages.at(-1).content;
    expect(second[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu1" });
    expect(second.some((b) => b.type === "text" && b.text.startsWith("<imagine_result"))).toBe(true);
    // the panel now differs from what Claude last saw, so the change is described too
    expect(second.some((b) => b.type === "text" && b.text.startsWith("<current_settings>"))).toBe(true);
    // the first message (with the log summary) is not repeated
    expect(streams[1].params.messages.filter((m) => m.role === "user" && m.content.some((b) => b.text?.startsWith("<log_summary")))).toHaveLength(1);

    // a failed request is undone: no dangling message, result unsent again
    streams[1].emit("error", new Error("overloaded"));
    expect(ai.error).toBe("overloaded");
    expect(ai.current.messages.at(-1).role).toBe("assistant");
    expect(config.result.sent).toBe(false);
    expect(ai.current.pendingToolResults[0].tool_use_id).toBe("tu1");
  }, 60000);
});
