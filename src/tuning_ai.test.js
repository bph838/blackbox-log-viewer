import { describe, it, expect, vi } from "vitest";
import { buildHistoryMessages, buildPromptText, extractInstructions } from "./tuning_ai.js";

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
