import { describe, it, expect } from "vitest";
import { buildHistoryMessages } from "./tuning_ai.js";

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
});
