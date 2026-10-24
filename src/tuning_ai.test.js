import { describe, it, expect, vi } from "vitest";
import {
  buildHistoryMessages,
  buildPromptText,
  estimateCostUsd,
  extractInstructions,
  notesAlreadySent,
  summariseUsage,
} from "./tuning_ai.js";

function makeLog(count) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      id: `e${i}`,
      timestamp: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      image: "data:image/png;base64,AAAA",
      config: `p: ${i}`,
      notes: "",
    });
  }
  return { entries };
}

function imageCount(message) {
  return message.content.filter((block) => block.type === "image").length;
}

describe("buildHistoryMessages", () => {
  it("sends every image when no limit is given", () => {
    const messages = buildHistoryMessages(makeLog(4));
    expect(messages.map(imageCount)).toEqual([1, 1, 1, 1]);
  });

  it("sends every image for a negative limit", () => {
    const messages = buildHistoryMessages(makeLog(3), null, -1);
    expect(messages.map(imageCount)).toEqual([1, 1, 1]);
  });

  it("keeps only the most recent images, sending older entries as text", () => {
    const messages = buildHistoryMessages(makeLog(5), null, 2);
    expect(messages.map(imageCount)).toEqual([0, 0, 0, 1, 1]);
    expect(messages[0].content[0].text).toContain("graph omitted");
    expect(messages[0].content[0].text).toContain("p: 0");
  });

  it("sends no images for a limit of 0", () => {
    const messages = buildHistoryMessages(makeLog(3), null, 0);
    expect(messages.map(imageCount)).toEqual([0, 0, 0]);
  });

  it("applies the limit after excluding the entry being asked about", () => {
    const messages = buildHistoryMessages(makeLog(4), "e3", 2);
    expect(messages).toHaveLength(3);
    expect(messages.map(imageCount)).toEqual([0, 1, 1]);
  });

  it("leaves out entries with the same config as the previous one, unless they have an AI conversation or notes", () => {
    const log = makeLog(5);
    log.entries[1].config = "p: 0";
    log.entries[2].config = "p: 0";
    log.entries[2].ai = { conversation: [{ role: "user", content: "q" }, { role: "assistant", content: "answer" }] };
    log.entries[3].config = "p: 0";
    log.entries[3].notes = "windy";
    const messages = buildHistoryMessages(log, null, 0);
    expect(messages.map((m) => (m.role === "user" ? m.content[0].text.match(/p: \d|unchanged since/)[0] : m.content))).toEqual([
      "p: 0",
      "unchanged since",
      "answer",
      "unchanged since",
      "p: 4",
    ]);
  });

  it("sends the first entry's whole config, then only what changed", () => {
    const log = makeLog(3);
    log.entries[0].config = 'Log start datetime: "a"\nrollPID: [45,60,20]\ngyro_lowpass_hz: 100';
    log.entries[1].config = 'Log start datetime: "b"\nrollPID: [50,60,20]\ngyro_lowpass_hz: 100';
    log.entries[2].config = 'Log start datetime: "c"\nrollPID: [50,60,20]\ngyro_lowpass_hz: 100\nyaw_tta: 10';
    const texts = buildHistoryMessages(log, null, 0).map((m) => m.content[0].text);

    expect(texts[0]).toContain("gyro_lowpass_hz: 100");
    expect(texts[1]).toContain("Configuration changes since the previous entry");
    expect(texts[1]).toContain("rollPID: [50,60,20] (was [45,60,20])");
    expect(texts[1]).not.toContain("gyro_lowpass_hz");
    expect(texts[1]).not.toContain("Log start datetime");
    expect(texts[2]).toContain("yaw_tta: 10 (new)");
    expect(texts[2]).not.toContain("rollPID");
  });

  it("drops older images a few at a time, so the history stays the same as entries are added", () => {
    const firstImage = (count) => buildHistoryMessages(makeLog(count), null, 10).findIndex((m) => imageCount(m));
    // Images start at entry 0 up to 10 entries, then 5 drop at once and stay dropped for 5 entries.
    expect([10, 11, 12, 15, 16].map(firstImage)).toEqual([0, 5, 5, 5, 10]);
    // Never more than the limit.
    for (let count = 1; count < 30; count++) {
      expect(buildHistoryMessages(makeLog(count), null, 10).filter(imageCount).length).toBeLessThanOrEqual(10);
    }
  });

  it("keeps each entry's last AI answer as an assistant message", () => {
    const log = makeLog(2);
    log.entries[0].ai = { conversation: [{ role: "user", content: "q" }, { role: "assistant", content: "answer" }] };
    const messages = buildHistoryMessages(log, null, 0);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[1].content).toBe("answer");
  });

  it("sends an entry's isolated flight as a stats summary, not the raw CSV", () => {
    const log = makeLog(1);
    log.entries[0].slice = {
      workspace: "Tracking",
      range: { offsetMs: 2000 },
      durationMs: 3000,
      sampleRateHz: 100,
      fields: [{ name: "gyroADC[0]", label: "Gyro [roll]", unit: "°/s" }],
      stats: { "gyroADC[0]": { min: -10, max: 12, mean: 1, rms: 4 } },
      csv: "t_ms,gyroADC[0]\n0,1",
    };
    const text = buildHistoryMessages(log, null, 0)[0].content.find((block) => block.type === "text").text;
    expect(text).toContain("Gyro [roll]: min -10, max 12, mean 1, rms 4 °/s");
    expect(text).not.toContain("t_ms,");
  });
});

describe("buildPromptText", () => {
  it("mentions the attached isolated flight data only when there is some", () => {
    expect(buildPromptText({ configSummary: "", hasSlice: true })).toContain("CSV data for a block of the flight");
    expect(buildPromptText({ configSummary: "" })).not.toContain("CSV data");
  });

  it("includes the user's notes, without them being taken as instructions", () => {
    const text = buildPromptText({ configSummary: "", notes: " raised roll D ", instructions: "help" });
    expect(text).toContain("notes for this flight");
    expect(text).toContain("raised roll D");
    expect(extractInstructions(text)).toBe("help");
    expect(buildPromptText({ configSummary: "" })).not.toContain("notes for this flight");
  });

  it("knows when notes are already in a conversation", () => {
    const conversation = [{ role: "user", content: [{ type: "text", text: buildPromptText({ configSummary: "", notes: "a" }) }] }];
    expect(notesAlreadySent(conversation, " a ")).toBe(true);
    expect(notesAlreadySent(conversation, "a, then b")).toBe(false);
    expect(notesAlreadySent(conversation, "")).toBe(true);
  });

  it("includes the heli description only when one is given", () => {
    expect(buildPromptText({ configSummary: "", heliDescription: " Goblin 700, 12S " })).toContain(
      "describes the helicopter as follows",
    );
    expect(buildPromptText({ configSummary: "", heliDescription: "Goblin 700, 12S" })).toContain("Goblin 700, 12S");
    expect(buildPromptText({ configSummary: "", heliDescription: "  " })).not.toContain("describes the helicopter");
  });
});

describe("usage and cost", () => {
  it("prices cache reads at the model's own rate, or a tenth of input", () => {
    const usage = { cache_read_input_tokens: 1e6 };
    expect(estimateCostUsd("claude-opus-5-5", usage)).toBeCloseTo(0.2);
    expect(estimateCostUsd("claude-sonnet-5-5", usage)).toBeCloseTo(0.2);
    expect(estimateCostUsd("claude-haiku-4-5", usage)).toBeCloseTo(0.1);
  });

  it("summarises a response's usage, counting code-execution steps", () => {
    const response = {
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
      content: [{ type: "server_tool_use" }, { type: "bash_code_execution_tool_result" }, { type: "server_tool_use" }, { type: "text" }],
    };
    expect(summariseUsage(response)).toEqual({
      requests: 1,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
      codeSteps: 2,
    });
  });
});

describe("extractInstructions", () => {
  it("returns what the user typed, including multiple lines", () => {
    const text = buildPromptText({ configSummary: "p: 1", instructions: "  what do you see?\n\nsecond line  " });
    expect(extractInstructions(text)).toBe("what do you see?\n\nsecond line");
  });

  it("returns an empty string when no instructions were given", () => {
    expect(extractInstructions(buildPromptText({ configSummary: "p: 1", instructions: "", expertMode: true }))).toBe("");
  });
});

describe("cancelling a request", () => {
  // A stand-in for the SDK's message stream: records handlers, and abort() emits "abort" like the
  // real one does
  function makeStream() {
    const handlers = {};
    return {
      handlers,
      aborted: false,
      on(event, handler) {
        handlers[event] = handler;
        return this;
      },
      abort() {
        this.aborted = true;
        handlers.abort?.();
      },
    };
  }

  it("aborts the stream and suppresses any later result or error", async () => {
    const stream = makeStream();
    vi.resetModules();
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        constructor() {
          this.beta = { messages: { stream: () => stream } };
        }
      },
    }));
    const { ask } = await import("./tuning_ai.js");

    const onResult = vi.fn();
    const onError = vi.fn();
    const onChunk = vi.fn();
    const cancel = ask({ apiKey: "k", question: "why?", onChunk }, onResult, onError);

    cancel();
    expect(stream.aborted).toBe(true);

    stream.handlers.text("x", "partial");
    stream.handlers.finalMessage({ content: [{ type: "text", text: "late" }], usage: {} });
    stream.handlers.error(new Error("boom"));
    expect(onChunk).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    vi.doUnmock("@anthropic-ai/sdk");
  });

  it("returns a harmless cancel function when the request never starts", async () => {
    const { ask } = await import("./tuning_ai.js");
    const onError = vi.fn();
    const cancel = ask({ apiKey: "" }, vi.fn(), onError);
    expect(onError).toHaveBeenCalled();
    expect(() => cancel()).not.toThrow();
  });
});
